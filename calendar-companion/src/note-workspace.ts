import { safeNoteMarkdown } from "./note-context";

export interface WorkspaceDocument {
  reference: string; title: string; path: string; text: string;
  read(): Promise<string | null>;
  replace(expected: string, markdown: string): Promise<void>;
}
export interface NoteWorkspace {
  search(question: string): Promise<{ documents: WorkspaceDocument[]; scanned: number; total: number }>;
  backup(path: string, original: string): Promise<string>;
}
export interface NoteProposal { target: string; action: "append" | "replace" | "create"; title: string; markdown: string }
export interface NoteAnswer { reply: string; changes: NoteProposal[] }
export interface NoteExtra {
  documents?: readonly { reference: string; title: string; text: string }[];
  history?: readonly { request: string; answer: string }[];
  proposeEdits?: boolean;
}

/** References are generated locally. The model never chooses filesystem paths or calls write tools. */
export function noteAnswerFormat(references: readonly string[]): Record<string, unknown> {
  return { type: "json_schema", name: "obsidian_note_changes", strict: true, schema: {
    type: "object", additionalProperties: false, required: ["reply", "changes"], properties: {
      reply: { type: "string" }, changes: { type: "array", items: {
        type: "object", additionalProperties: false, required: ["target", "action", "title", "markdown"], properties: {
          target: { type: "string", enum: [...references, "new"] }, action: { type: "string", enum: ["append", "replace", "create"] },
          title: { type: "string" }, markdown: { type: "string" },
        },
      } },
    },
  } };
}
export const NOTE_CHANGE_INSTRUCTION = "Return a JSON object with reply (Markdown explanation) and changes (proposed file contents). Use only supplied N references as targets, or new to create a note beside the current note. Never include paths, delete/rename operations or actions on Calendar. Each change has target, action append/replace/create, title (filename without extension) and markdown. Existing targets may append or replace; new targets must create. For replace, return the complete replacement for exactly the supplied scope: a selection replaces only that selection; a full note replaces that note. Preserve unrelated content when replacing a complete note. Prefer append for a draft unless the user requests rewriting. A question may have no changes. For multiple documents use one change per existing target, at most eight changes. Diagrams/charts/tables/math belong inside the Markdown, not as separately executed tools. The application shows changes for explicit user application; do not claim anything has been saved. Previous assistant answers are context, not proof that any edit was applied.";

export function parseNoteAnswer(raw: string, references: readonly string[]): NoteAnswer {
  const value: unknown = JSON.parse(raw);
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  if (!object(value) || Object.keys(value).sort().join() !== "changes,reply" || typeof value.reply !== "string" || !Array.isArray(value.changes) || value.changes.length > 8) throw Error("The proposed edits could not be verified. The original response is kept for copying.");
  const seen = new Set<string>(), changes: NoteProposal[] = [];
  for (const change of value.changes) {
    if (!object(change) || Object.keys(change).sort().join() !== "action,markdown,target,title" || typeof change.target !== "string" ||
      typeof change.title !== "string" || change.title.length > 200 || typeof change.markdown !== "string" || !change.markdown.trim() ||
      !["append", "replace", "create"].includes(String(change.action)) ||
      (change.target === "new" ? change.action !== "create" : !references.includes(change.target) || change.action === "create" || seen.has(change.target))) throw Error("A proposed file target or action is invalid. No file has been changed.");
    if (change.target !== "new") seen.add(change.target);
    changes.push({ target: change.target, action: change.action as NoteProposal["action"], title: change.title, markdown: safeNoteMarkdown(change.markdown) });
  }
  return { reply: safeNoteMarkdown(value.reply), changes };
}

/** A compact line diff for review, bounded in time and space on phones. */
export function noteDiff(before: string, after: string): string {
  const a = before.split("\n"), b = after.split("\n"); let prefix = 0, suffix = 0;
  while (prefix < Math.min(a.length, b.length) && a[prefix] === b[prefix]) prefix++;
  while (suffix < Math.min(a.length, b.length) - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  const removed = a.slice(prefix, a.length - suffix), added = b.slice(prefix, b.length - suffix);
  const limit = 120;
  return [`@@ line ${prefix + 1} @@`, ...removed.slice(0, limit).map(line => `- ${line}`), ...(removed.length > limit ? ["… more removed lines; review the complete source above"] : []),
    ...added.slice(0, limit).map(line => `+ ${line}`), ...(added.length > limit ? ["… more added lines; review the complete draft above"] : [])].join("\n");
}

/** Bounded Unicode keyword ranking; no embeddings, model call or title-only fallback to all data. */
export function noteTerms(question: string): string[] {
  const stop = new Set("the and this that with from into your have will about please of for on to as an in at is are it be my me can all using note notes document documents create write edit update make summarize refine diagram chart graph mermaid markdown 문서 노트 작성 수정 요약 그래프 다이어그램 만들어 주세요 그리고 관련 내용을 기존 teraz proszę notatka dokument oraz dla jest".split(" "));
  return [...new Set((question.toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]+/gu) ?? []).filter(term => !stop.has(term)))].slice(0, 16);
}
export function rankNote(text: string, terms: readonly string[]): number {
  const lower = text.toLocaleLowerCase(); return terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0);
}
