import type { WorkMode, WriteScope } from "./agent-policy";
import type { AiDraft } from "./ai-session";
import { parseOpenAiDraft } from "./openai";
import { emptyOnlineUsage, sourceList, sourceLink, publicUrl, withSources, type WebSource, type OnlineUsage } from "./research";
import type { PendingGeneratedFile } from "./generated-files";
import { readCompaction } from "./conversation-context";
import { workText } from "./work-activity";
export interface AgentCall { id: string; name: string; arguments: string }
export interface AgentReply { output: Record<string, unknown>[]; calls: AgentCall[]; text: string; summaries: string[]; incomplete: boolean; sources: WebSource[]; citations: WebSource[]; generated: PendingGeneratedFile[]; online: OnlineUsage; usage: { input: number; output: number; reasoning: number } }
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : 0;
export function parseAgentReply(status: number, raw: string, superseded = false): AgentReply {
  if (status < 200 || status >= 300) { parseOpenAiDraft(status, raw); throw Error("OpenAI did not return a usable response."); }
  if (new TextEncoder().encode(raw).length > 32 * 1024 * 1024) throw Error("The response is too large for this device.");
  const data: unknown = JSON.parse(raw); if (!obj(data) || !Array.isArray(data.output) || !["completed", "incomplete"].includes(String(data.status))) throw Error("OpenAI did not complete this step. No retry was made.");
  const output = data.output.filter(obj), calls: AgentCall[] = []; const texts: string[] = [], summaries: string[] = [], candidates: unknown[] = [], citations: unknown[] = [], generated = new Map<string, PendingGeneratedFile>(), online = emptyOnlineUsage();
  for (const item of output) {
    if (item.type === "web_search_call") { online.search++; if (obj(item.action) && Array.isArray(item.action.sources)) candidates.push(...item.action.sources as unknown[]); }
    if (item.type === "code_interpreter_call") online.analysis++;
    if (item.type === "image_generation_call") {
      online.image++;
      if (typeof item.id === "string" && item.id.length <= 200 && typeof item.result === "string" && item.result) {
        const origin = "image:" + item.id; generated.set(origin, { origin, name: `Generated image ${online.image}.png`, base64: item.result });
      }
    }
    if (item.type === "reasoning" && Array.isArray(item.summary)) for (const part of item.summary) {
      if (summaries.length < 8 && obj(part) && part.type === "summary_text" && typeof part.text === "string" && part.text.trim()) summaries.push(workText(part.text));
    }
    if (item.type === "function_call" && !superseded) {
      if (typeof item.call_id !== "string" || item.call_id.length > 200 || typeof item.name !== "string" || typeof item.arguments !== "string" || item.arguments.length > 4 * 1024 * 1024) throw Error("An invalid tool request was returned.");
      calls.push({ id: item.call_id, name: item.name, arguments: item.arguments });
    }
    if (item.type === "message" && item.role === "assistant" && Array.isArray(item.content)) for (const part of item.content) if (obj(part) && part.type === "output_text" && typeof part.text === "string") {
      const chars = Array.from(part.text), replacements: { start: number; end: number; value: string }[] = [];
      if (Array.isArray(part.annotations)) for (const annotation of part.annotations.slice(0, 200)) {
        if (!obj(annotation)) continue;
        if (annotation.type === "url_citation") {
          const url = publicUrl(annotation.url); if (!url) continue;
          const source = { url, title: typeof annotation.title === "string" ? annotation.title : new URL(url).hostname }; citations.push(source);
          const start = annotation.start_index, end = annotation.end_index;
          if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && (start as number) >= 0 && (end as number) > (start as number) && (end as number) <= chars.length) {
            const original = chars.slice(start as number, end as number).join("");
            replacements.push({ start: start as number, end: end as number, value: sourceLink({ url, title: /[\uE000-\uF8FF]|https?:|\]\(/.test(original) ? source.title : original }) });
          }
        }
        if (annotation.type === "container_file_citation" && typeof annotation.container_id === "string" && typeof annotation.file_id === "string" && typeof annotation.filename === "string") {
          const origin = annotation.container_id + ":" + annotation.file_id;
          generated.set(origin, { origin, name: annotation.filename, container: annotation.container_id, file: annotation.file_id });
        }
      }
      let last = chars.length;
      for (const replacement of replacements.sort((a,b) => b.start - a.start)) if (replacement.end <= last) { chars.splice(replacement.start, replacement.end - replacement.start, replacement.value); last = replacement.start; }
      texts.push(chars.join(""));
    }
  }
  if (calls.length > 16 || generated.size > 16 || (!superseded && !calls.length && !texts.length && !generated.size)) throw Error("No text or supported work was returned.");
  const usage = obj(data.usage) ? data.usage : {}, details = obj(usage.output_tokens_details) ? usage.output_tokens_details : {};
  const cited = sourceList(citations), sources = sourceList([...citations, ...candidates]);
  const replay = output.flatMap(item => {
    if (item.type === "compaction") {
      const compaction = readCompaction(item);
      return compaction ? [compaction] : [];
    }
    return ["message", "reasoning", "function_call", "web_search_call", "code_interpreter_call", "image_generation_call"].includes(String(item.type))
      ? [item.type === "image_generation_call" ? { ...item, result: null } : item] : [];
  });
  return { output: replay, calls,
    text: texts.length ? withSources(texts.join("\n\n"), cited) : "", summaries, incomplete: data.status === "incomplete", sources, citations: cited, generated: [...generated.values()], online,
    usage: { input: num(usage.input_tokens), output: num(usage.output_tokens), reasoning: num(details.reasoning_tokens) } };
}
const str = { type: "string" }, integer = { type: "integer" };
const array = (items: unknown) => ({ type: "array", items });
const object = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const tool = (name: string, description: string, properties: Record<string, unknown>) => ({ type: "function", name, description, strict: true, parameters: object(properties) });
export function agentTools(mode: WorkMode, writeScope?: WriteScope) {
  const read = [tool("search_notes", "Find relevant Markdown notes inside the permitted data scope. Returns references, titles and relative paths, not entire bodies. Start offset at 0; use next_offset for another bounded search page when coverage is partial.", { query: str, limit: integer, offset: integer }),
    tool("read_notes", "Read permitted notes or line ranges. Use returned versions for edits. Partial notes must be read further before a full replacement.", { notes: array(object({ reference: str, from_line: integer, through_line: integer })) }),
    tool("read_outline", "Inspect headings and line numbers before reading a large note.", { reference: str })];
  if (mode === "ask") return read;
  const edit = [tool("apply_changes", "Apply requested edits to reviewed references using exact versions. A partial source can only replace its reviewed selection. Creates verified original backups.", { changes: array(object({ reference: str, version: str, action: { type: "string", enum: ["replace", "append", "replace_selection"] }, markdown: str })) }),
    tool("create_note", "Create a new Markdown note in the permitted output folder. Existing files are never replaced.", { path: str, markdown: str }),
    tool("save_generated_file", "Save a returned generated-file reference from this task's local cache to the permitted output folder. Use its exact extension and a new path. Embed saved images with ![[the confirmed vault path]]. This cannot download an arbitrary URL or overwrite an existing file.", { reference: str, path: str }),
    tool("update_properties", "Update requested YAML properties, preserving other keys. Each value is a JSON string.", { reference: str, version: str, properties: array(object({ key: str, value: str })) })];
  const rename = tool("rename_note", "Change the Markdown filename and document/tab title, rather than just a heading inside its body. Write and edit mode permits same-folder renaming; organizing modes may also move a note. Links are not changed automatically. Review returned in-scope backlinks separately.", { reference: str, version: str, path: str });
  const allowedEdits = writeScope === "current" ? edit.filter(item => item.name !== "create_note" && item.name !== "save_generated_file") : edit;
  if (mode !== "organize" && mode !== "all") return [...read, ...allowedEdits, rename];
  return [...read, ...allowedEdits, rename,
    ...(writeScope === "current" ? [] : [tool("create_folder", "Create a folder within the permitted output folder.", { path: str })]),
    tool("propose_trash", "Propose moving notes to Trash. This never deletes; the user must select the concrete Trash action.", { references: array(str) })];
}
export function asDraft(text: string, usage: AgentReply["usage"], incomplete = false): AiDraft { return { text, incomplete, inputTokens: usage.input, outputTokens: usage.output, thinkingTokens: usage.reasoning }; }
