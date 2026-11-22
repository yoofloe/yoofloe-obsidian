import { readCompaction, type CompactionItem } from "./conversation-context";

const outputAdded = "response.output_item.added";
const outputDone = "response.output_item.done";
const maxItemEventLength = 512 * 1024;
const maxIndexedItems = 1024;

interface StreamState {
  positions: Map<string, number | null>;
  compactionReported: boolean;
  itemEventSkipped?: boolean;
  compaction?: { index: number; item: CompactionItem };
}

export interface StreamResult { text: string; compactionReported: boolean; itemEventSkipped?: boolean }

const terminalStatus = new Map([
  ["response.completed", "completed"], ["response.incomplete", "incomplete"],
  ["response.failed", "failed"], ["response.cancelled", "cancelled"],
]);

function unconfirmed(): Error {
  return Error("The OpenAI stream ended before the result was confirmed. No retry was made by the plugin. The request may still incur charges.");
}

function itemIdentity(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return;
  const { type, id, call_id } = raw as { type?: unknown; id?: unknown; call_id?: unknown };
  const identifier = type === "function_call" ? call_id : id;
  if (typeof type === "string" && type.length <= 60 && typeof identifier === "string" && identifier.length > 0 && identifier.length <= 200)
    return type + ":" + identifier;
}

function restoreCompaction(output: unknown[], state: StreamState): void {
  const compact = state.compaction;
  if (!compact || output.some(readCompaction)) return;
  const compactIdentity = itemIdentity(compact.item);
  if (!compactIdentity || state.positions.get(compactIdentity) !== compact.index) return;
  let slot = output.length, replace = 0, previous = -1;
  for (const [index, item] of output.entries()) {
    const identity = itemIdentity(item);
    const position = identity && state.positions.get(identity);
    // The streamed index is relative to all emitted items. The terminal array may omit some.
    if (typeof position !== "number" || position <= previous) return;
    if (position === compact.index) {
      if (identity !== compactIdentity) return;
      slot = index;
      replace = 1;
    } else if (position > compact.index && slot === output.length) slot = index;
    previous = position;
  }
  output.splice(slot, replace, compact.item);
}

function finalEvent(name: string, lines: string[], state: StreamState): StreamResult | undefined {
  if (!lines.length) return;
  let event: { type?: string; response?: { status?: string; output?: unknown }; code?: unknown; item?: unknown; output_index?: unknown } | null;
  const payload = lines.join("\n");
  if ((name === outputAdded || name === outputDone) && payload.length > maxItemEventLength) {
    if (name === outputDone) state.itemEventSkipped = true;
    return;
  }
  try { event = JSON.parse(payload) as typeof event; }
  catch { if (name === "error" || terminalStatus.has(name)) throw unconfirmed(); else return; }
  const kind = event?.type;
  if ((kind === outputAdded || kind === outputDone) && (!name || name === kind)) {
    const index = event?.output_index, item = event?.item;
    const hasIndex = typeof index === "number" && Number.isSafeInteger(index) && index >= 0;
    const identity = itemIdentity(item);
    if (identity && hasIndex) {
      const prior = state.positions.get(identity);
      if (prior !== undefined || state.positions.size < maxIndexedItems)
        state.positions.set(identity, prior === undefined || prior === index ? index : null);
      else state.itemEventSkipped = true;
    }
    if (kind === outputDone && item && typeof item === "object" && (item as { type?: unknown }).type === "compaction") {
      state.compactionReported = true;
      const compact = readCompaction(item);
      if (compact && hasIndex && index >= (state.compaction?.index ?? 0)) state.compaction = { index, item: compact };
    }
    return;
  }
  if (kind === "error" && (!name || name === kind))
    return { text: JSON.stringify({ status: "failed", error: { code: event?.code } }), compactionReported: false };
  if (!kind || !terminalStatus.has(kind)) {
    if (terminalStatus.has(name)) throw unconfirmed();
    return;
  }
  const response = event?.response;
  if ((name && name !== kind) || response?.status !== terminalStatus.get(kind)) throw unconfirmed();
  const completed = response?.status === "completed";
  // Tool calls must come from the terminal reply.
  if (completed && Array.isArray(response.output)) restoreCompaction(response.output, state);
  return { text: JSON.stringify(response), compactionReported: completed && state.compactionReported,
    itemEventSkipped: completed && state.itemEventSkipped };
}

export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const maxFrameLength = MAX_RESPONSE_BYTES + 64 * 1024;

export class OpenAiStreamLimitError extends Error {
  constructor() { super("The OpenAI response is too large for this device."); }
}

/** Accept a terminal event as soon as its blank-line delimiter arrives. */
export class OpenAiEventDecoder {
  private readonly state: StreamState = { positions: new Map(), compactionReported: false };
  private first = true;
  private skipLF = false;
  private lineParts: string[] = [];
  private lineSize = 0;
  private name = "";
  private data: string[] = [];
  private dataSize = 0;
  private skipped = false;

  push(chunk: string): StreamResult | undefined {
    if (!chunk.length) return;
    let offset = (this.first && chunk.charCodeAt(0) === 0xfeff) || (this.skipLF && chunk[0] === "\n") ? 1 : 0;
    this.first = false;
    this.skipLF = false;
    const breaks = /\r\n|[\r\n]/g;
    breaks.lastIndex = offset;
    let end: RegExpExecArray | null;
    while ((end = breaks.exec(chunk))) {
      this.appendPart(chunk.slice(offset, end.index));
      const result = !this.skipped || this.lineSize === 0 ?
        this.acceptLine(this.lineParts.length === 1 ? this.lineParts[0] : this.lineParts.join("")) : undefined;
      this.lineParts = []; this.lineSize = 0;
      if (result) return result;
      offset = breaks.lastIndex;
      this.skipLF = end[0] === "\r" && offset === chunk.length;
    }
    if (offset < chunk.length) this.appendPart(chunk.slice(offset));
  }

  private appendPart(part: string): void {
    if (!part.length) return;
    this.lineSize += part.length;
    if (this.skipped) return;
    if (this.name && this.name !== "error" && !terminalStatus.has(this.name) && this.lineSize > maxItemEventLength + 6) {
      if (this.name === outputDone) this.state.itemEventSkipped = true;
      this.lineParts = []; this.data = []; this.skipped = true;
      return;
    }
    if (this.lineSize > maxFrameLength) throw new OpenAiStreamLimitError();
    this.lineParts.push(part);
  }

  private acceptLine(line: string): StreamResult | undefined {
    if (!line.length) {
      const result = this.skipped ? undefined : finalEvent(this.name, this.data, this.state);
      this.name = ""; this.data = []; this.dataSize = 0; this.skipped = false;
      return result;
    }
    if (line.startsWith("event:")) { this.name = line.slice(6).trim(); return; }
    if (this.skipped || !line.startsWith("data:")) return;
    const item = this.name === outputAdded || this.name === outputDone;
    if (this.name && !item && this.name !== "error" && !terminalStatus.has(this.name)) return;
    const value = line.slice(line[5] === " " ? 6 : 5);
    this.dataSize += value.length + (this.data.length ? 1 : 0);
    if (item && this.dataSize > maxItemEventLength) {
      if (this.name === outputDone) this.state.itemEventSkipped = true;
      this.data = []; this.skipped = true;
      return;
    }
    if (this.dataSize > maxFrameLength) throw new OpenAiStreamLimitError();
    this.data.push(value);
  }

  finish(): never { throw unconfirmed(); }
}

/** Older WebViews can still return a buffered SSE body or a complete JSON response. */
export function openAiStreamResult(raw: string): StreamResult {
  if (raw.trimStart().startsWith("{")) return { text: raw, compactionReported: false };
  const decoder = new OpenAiEventDecoder();
  return decoder.push(raw) ?? decoder.finish();
}
