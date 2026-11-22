import { readCompaction, type CompactionItem } from "./conversation-context";

const outputAdded = "response.output_item.added";
const outputDone = "response.output_item.done";
const maxItemEventLength = 512 * 1024;

interface StreamState {
  positions: Map<string, number | null>;
  compactionReported: boolean;
  itemEventSkipped?: boolean;
  compaction?: { index: number; item: CompactionItem };
}

interface StreamResult { text: string; compactionReported: boolean; itemEventSkipped?: boolean }

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
      state.positions.set(identity, prior === undefined || prior === index ? index : null);
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

/** Obsidian delivers the buffered SSE body. Only a complete terminal event authorizes tool work. */
export function openAiStreamResult(raw: string): StreamResult {
  if (raw.trimStart().startsWith("{")) return { text: raw, compactionReported: false };
  const lines = /\r\n|[\r\n]/g;
  let offset = raw.charCodeAt(0) === 0xfeff ? 1 : 0;
  lines.lastIndex = offset;
  const state: StreamState = { positions: new Map(), compactionReported: false };
  let type = "", data: string[] = [], end: RegExpExecArray | null;
  while ((end = lines.exec(raw))) {
    const length = end.index - offset;
    if (!length) {
      const result = finalEvent(type, data, state);
      if (result !== undefined) return result;
      type = ""; data = [];
    } else if (raw.startsWith("event:", offset)) {
      type = raw.slice(offset + 6, end.index).trim();
    } else if ((!type || type === "error" || type === outputAdded || type === outputDone || terminalStatus.has(type)) && raw.startsWith("data:", offset)) {
      const start = offset + 5;
      data.push(raw.slice(raw[start] === " " ? start + 1 : start, end.index));
    }
    offset = lines.lastIndex;
  }
  throw unconfirmed();
}
