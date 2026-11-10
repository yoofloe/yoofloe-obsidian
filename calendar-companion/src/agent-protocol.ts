import type { WorkMode } from "./agent-policy";
import type { AiDraft } from "./ai-session";
import { parseOpenAiDraft } from "./openai";
export interface AgentCall { id: string; name: string; arguments: string }
export interface AgentReply { output: Record<string, unknown>[]; calls: AgentCall[]; text: string; incomplete: boolean; usage: { input: number; output: number; reasoning: number } }
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : 0;
export function parseAgentReply(status: number, raw: string): AgentReply {
  if (status < 200 || status >= 300) { parseOpenAiDraft(status, raw); throw Error("OpenAI did not return a usable response."); }
  if (new TextEncoder().encode(raw).length > 8 * 1024 * 1024) throw Error("The response is too large for this device.");
  const data: unknown = JSON.parse(raw); if (!obj(data) || !Array.isArray(data.output) || !["completed", "incomplete"].includes(String(data.status))) throw Error("OpenAI did not complete this step. No retry was made.");
  const output = data.output.filter(obj), calls: AgentCall[] = []; const texts: string[] = [];
  for (const item of output) {
    if (item.type === "function_call") {
      if (typeof item.call_id !== "string" || item.call_id.length > 200 || typeof item.name !== "string" || typeof item.arguments !== "string" || item.arguments.length > 4 * 1024 * 1024) throw Error("An invalid tool request was returned.");
      calls.push({ id: item.call_id, name: item.name, arguments: item.arguments });
    }
    if (item.type === "message" && item.role === "assistant" && Array.isArray(item.content)) for (const part of item.content) if (obj(part) && part.type === "output_text" && typeof part.text === "string") texts.push(part.text);
  }
  if (calls.length > 16 || (!calls.length && !texts.length)) throw Error("No text or supported work was returned.");
  const usage = obj(data.usage) ? data.usage : {}, details = obj(usage.output_tokens_details) ? usage.output_tokens_details : {};
  return { output: output.filter(item => ["message", "reasoning", "function_call"].includes(String(item.type))), calls, text: texts.join("\n\n"), incomplete: data.status === "incomplete", usage: { input: num(usage.input_tokens), output: num(usage.output_tokens), reasoning: num(details.reasoning_tokens) } };
}
const str = { type: "string" }, integer = { type: "integer" };
const array = (items: unknown) => ({ type: "array", items });
const object = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const tool = (name: string, description: string, properties: Record<string, unknown>) => ({ type: "function", name, description, strict: true, parameters: object(properties) });
export function agentTools(mode: WorkMode) {
  const read = [tool("search_notes", "Find relevant Markdown notes inside the permitted data scope. Returns references, titles and relative paths, not entire bodies. Start offset at 0; use next_offset for another bounded search page when coverage is partial.", { query: str, limit: integer, offset: integer }),
    tool("read_notes", "Read permitted notes or line ranges. Use returned versions for edits. Partial notes must be read further before a full replacement.", { notes: array(object({ reference: str, from_line: integer, through_line: integer })) }),
    tool("read_outline", "Inspect headings and line numbers before reading a large note.", { reference: str })];
  if (mode === "ask") return read;
  const edit = [tool("apply_changes", "Apply requested edits to reviewed references using exact versions. A partial source can only replace its reviewed selection. Creates verified original backups.", { changes: array(object({ reference: str, version: str, action: { type: "string", enum: ["replace", "append", "replace_selection"] }, markdown: str })) }),
    tool("create_note", "Create a new Markdown note in the permitted output folder. Existing files are never replaced.", { path: str, markdown: str }),
    tool("update_properties", "Update requested YAML properties, preserving other keys. Each value is a JSON string.", { reference: str, version: str, properties: array(object({ key: str, value: str })) })];
  const rename = tool("rename_note", "Change the Markdown filename and document/tab title, rather than just a heading inside its body. Write and edit mode permits same-folder renaming; organizing modes may also move a note. Links are not changed automatically. Review returned in-scope backlinks separately.", { reference: str, version: str, path: str });
  if (mode !== "organize" && mode !== "all") return [...read, ...edit, rename];
  return [...read, ...edit, rename,
    tool("create_folder", "Create a folder within the allowed work scope.", { path: str }),
    tool("propose_trash", "Propose moving notes to Trash. This never deletes; the user must select the concrete Trash action.", { references: array(str) })];
}
export function asDraft(text: string, usage: AgentReply["usage"], incomplete = false): AiDraft { return { text, incomplete, inputTokens: usage.input, outputTokens: usage.output, thinkingTokens: usage.reasoning }; }
