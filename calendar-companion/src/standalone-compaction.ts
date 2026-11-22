import { MAX_AI_INPUT_BYTES } from "./ai-session";
import { responseUsage, type AgentReply } from "./agent-protocol";
import { inspectCompaction, type CompactionItem, type CompactionProblem } from "./conversation-context";
import { MAX_RESPONSE_BYTES } from "./openai-stream";

type Item = Record<string, unknown>;
const isItem = (value: unknown): value is Item => !!value && typeof value === "object" && !Array.isArray(value);

export class CompactionWindowError extends Error {
  constructor(readonly problem: CompactionProblem) { super("OpenAI did not return a usable compacted context."); }
}

function historyKey(item: Item): string {
  const { id: _id, status: _status, ...fields } = item;
  fields.type ??= "message";
  if (fields.type === "message") {
    if (fields.role !== "user" && fields.role !== "assistant") throw new CompactionWindowError("invalid_window");
    const textType = fields.role === "user" ? "input_text" : "output_text";
    const parts: unknown = typeof fields.content === "string" ? [{ type: textType, text: fields.content }] : fields.content;
    if (!Array.isArray(parts)) throw new CompactionWindowError("invalid_window");
    fields.content = parts.map((part: unknown) => {
      if (!isItem(part)) throw new CompactionWindowError("invalid_window");
      if (part.type === "input_image") return { detail: "auto", ...part };
      if (part.type === "output_text") return { annotations: [], ...part };
      return part;
    });
  } else if (fields.role !== undefined) throw new CompactionWindowError("invalid_window");
  // All inputs have already passed through the JSON transport. Object key order is not significant.
  return JSON.stringify(fields, (_key, value: unknown) => isItem(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
}

export function readCompactionResponse(raw: string): { output: unknown; usage: AgentReply["usage"] } {
  if (raw.length > MAX_RESPONSE_BYTES || new TextEncoder().encode(raw).length > MAX_RESPONSE_BYTES)
    throw new CompactionWindowError("content_too_large");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new CompactionWindowError("invalid_window"); }
  if (!isItem(value) || value.object !== "response.compaction") throw new CompactionWindowError("invalid_window");
  return { output: value.output, usage: responseUsage(value.usage) };
}

export function readCompactedWindow(output: unknown, previous: Item[]): { items: Item[]; checkpoint: CompactionItem | null } {
  if (!Array.isArray(output)) throw new CompactionWindowError("invalid_window");
  if (new TextEncoder().encode(JSON.stringify(output)).length > MAX_AI_INPUT_BYTES) throw new CompactionWindowError("content_too_large");
  const submitted = previous.map(item => ({ key: historyKey(item), id: item.id, status: item.status }));
  let cursor = 0;
  function matchRetained(item: Item): void {
    const key = historyKey(item);
    while (cursor < submitted.length) {
      const prior = submitted[cursor++];
      const idMatches = prior.id == null ? item.id == null || typeof item.id === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(item.id) : prior.id === item.id;
      const statusMatches = prior.status == null ? item.status == null || item.status === "completed" : prior.status === item.status;
      if (prior.key === key && idMatches && statusMatches) return;
    }
    throw new CompactionWindowError("invalid_window");
  }
  const oldContent = new Set(previous.filter(item => item.type === "compaction").map(item => item.encrypted_content));
  let latest: CompactionItem | undefined;
  const items: Item[] = [];
  for (const item of output) {
    if (!isItem(item)) throw new CompactionWindowError("invalid_window");
    if (item.role !== undefined && (item.type ?? "message") !== "message")
      throw new CompactionWindowError("invalid_window");
    if (item.type === "compaction") {
      const checked = inspectCompaction(item);
      if (typeof checked === "string") throw new CompactionWindowError(checked);
      if (oldContent.has(checked.encrypted_content)) matchRetained(item);
      latest = checked;
    } else matchRetained(item);
    // This endpoint returns an ordered replacement window. Its retained items are history only.
    items.push(item);
  }
  if (!latest) throw new CompactionWindowError("missing_item");
  if (oldContent.has(latest.encrypted_content)) throw new CompactionWindowError("unchanged_window");
  return { items, checkpoint: items.length === 1 ? latest : null };
}
