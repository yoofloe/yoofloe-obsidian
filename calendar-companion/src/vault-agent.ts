import { allowedPath, closedObject, safeOutbound, textField, vaultPath, type TaskPolicy } from "./agent-policy";
import { inputDigest } from "./question-input";
import { safeNoteMarkdown } from "./note-context";
import { noteTerms, rankNote } from "./note-workspace";
import { agentTools } from "./agent-protocol";
export interface AgentFile { identity: object; path: string; title: string; size: number }
export interface JournalOp { kind: "edit" | "create" | "rename" | "trash" | "folder"; path: string; target?: string; backup?: string; beforeHash: string; afterHash: string; previousHash: string; status: "pending" | "done" | "undone" }
export interface WorkJournal { id: string; createdAt: number; status: "running" | "complete" | "interrupted" | "undone"; operations: JournalOp[] }
export function validateJournal(value: unknown): asserts value is WorkJournal {
  closedObject(value, ["id", "createdAt", "status", "operations"]);
  if (!/^[0-9a-f-]{36}$/.test(textField(value.id)) || !Number.isFinite(value.createdAt) || !["running", "complete", "interrupted", "undone"].includes(textField(value.status)) || !Array.isArray(value.operations) || value.operations.length > 200) throw Error("Invalid recovery record.");
  for (const op of value.operations as unknown[]) {
    if (!op || typeof op !== "object" || Array.isArray(op)) throw Error("Invalid recovery action.");
    const item = op as Record<string, unknown>;
    if (Object.keys(item).some(key => !["kind", "path", "target", "backup", "beforeHash", "afterHash", "previousHash", "status"].includes(key))) throw Error("Invalid recovery fields.");
    const kind = textField(item.kind); if (!["edit", "create", "rename", "trash", "folder"].includes(kind) || !["pending", "done", "undone"].includes(textField(item.status))) throw Error("Invalid recovery action.");
    vaultPath(textField(item.path), kind === "folder");
    if (kind === "rename") vaultPath(textField(item.target));
    if (item.backup !== undefined && !/^Yoofloe AI\/Backups\/[0-9a-f-]{36}\.md$/.test(textField(item.backup))) throw Error("Invalid recovery backup.");
    for (const key of ["beforeHash", "afterHash", "previousHash"]) if (!/^(?:[a-f0-9]{64})?$/.test(textField(item[key]))) throw Error("Invalid recovery digest.");
    if (["edit", "trash"].includes(kind) && !item.backup) throw Error("Missing original backup.");
  }
}
export interface AgentHost {
  files(): AgentFile[]; read(file: AgentFile): Promise<string | null>; replace(file: AgentFile, expected: string, text: string): Promise<void>;
  create(path: string, text: string): Promise<AgentFile>; rename(file: AgentFile, path: string): Promise<void>; folder(path: string): Promise<boolean>;
  properties(file: AgentFile, expected: string, values: Record<string, unknown>): Promise<void>; affected(path: string): string[];
  trash(file: AgentFile): Promise<void>; backup(path: string, text: string): Promise<string>; readBackup(path: string): Promise<string>;
  persist(journal: WorkJournal): Promise<void>;
}
interface Ref { file: AgentFile; version?: string; complete?: boolean; range?: { from: number; to: number }; allowedRange?: { from: number; to: number } }
const encoder = new TextEncoder();
const limitBytes = 32768;
function list(value: unknown, maximum = 16): unknown[] { if (!Array.isArray(value) || !value.length || value.length > maximum) throw Error("Choose a bounded set of notes."); return value; }
/** The model only requests typed work. Scope, source versions and recovery are enforced locally. */
export class VaultAgent {
  readonly journal: WorkJournal = { id: crypto.randomUUID(), createdAt: Date.now(), status: "running", operations: [] };
  readonly sent: { title: string; path: string; bytes: number }[] = [];
  readonly pendingTrash: { reference: string; title: string; version: string }[] = [];
  private refs = new Map<string, Ref>();
  private next = 2;
  constructor(readonly host: AgentHost, readonly policy: TaskPolicy, private readonly current: () => boolean) {
    const source = host.files().find(file => file.path === policy.sourcePath);
    if (source) this.refs.set("N1", { file: source, allowedRange: policy.readScope === "current" ? policy.selection : undefined });
  }
  private guard() { if (!this.current()) throw Error("This task stopped or the vault changed. No further file action is allowed."); }
  private ref(reference: unknown): Ref { const r = this.refs.get(textField(reference)); if (!r) throw Error("Read a reference returned by this task's search first."); return r; }
  private reference(file: AgentFile): string {
    for (const [id, ref] of this.refs) if (ref.file.identity === file.identity && ref.file.path === file.path) return id;
    const id = `N${this.next++}`; this.refs.set(id, { file }); return id;
  }
  private async read(ref: Ref): Promise<string> {
    this.guard(); if (!allowedPath(this.policy, ref.file.path, "read")) throw Error("This note is outside the permitted data scope.");
    const text = await this.host.read(ref.file); this.guard(); if (text === null) throw Error("The note was renamed, deleted or replaced."); return text;
  }
  private async excerpt(ref: Ref, fromLine = 1, throughLine = 0) {
    const original = await this.read(ref), version = await inputDigest(original); this.guard();
    let from = 0, to = original.length;
    if (ref.allowedRange) ({ from, to } = ref.allowedRange);
    else {
      if (!Number.isInteger(fromLine) || !Number.isInteger(throughLine) || fromLine < 1 || throughLine < 0) throw Error("Use positive line numbers, or zero through_line for a bounded first excerpt.");
      const lines = original.split("\n"), start = Math.min(fromLine - 1, lines.length), end = throughLine ? Math.min(throughLine, lines.length) : lines.length;
      if (end < start) throw Error("The line range is reversed.");
      from = lines.slice(0, start).reduce((n, line) => n + line.length + 1, 0); to = Math.min(original.length, lines.slice(0, end).reduce((n, line) => n + line.length + 1, 0));
    }
    let text = original.slice(from, to);
    if (encoder.encode(text).length > limitBytes) { text = new TextDecoder().decode(encoder.encode(text).slice(0, limitBytes - 4)); if (text.endsWith("�")) text = text.slice(0, -1); to = from + text.length; }
    safeOutbound(ref.file.title + "\n" + text); ref.version = version; ref.complete = from === 0 && to === original.length; ref.range = { from, to };
    this.sent.push({ title: ref.file.title, path: ref.file.path, bytes: encoder.encode(text).length });
    return { reference: this.reference(ref.file), title: ref.file.title, path: ref.file.path, version, text, from_line: original.slice(0, from).split("\n").length,
      through_line: original.slice(0, to).split("\n").length, total_lines: original.split("\n").length, partial: !ref.complete, selection_only: !!ref.allowedRange };
  }
  async initialContext(): Promise<unknown> { const source = this.refs.get("N1"); return source ? await this.excerpt(source) : { source: "New document. No existing note is attached." }; }
  async finish(): Promise<void> { this.journal.status = "complete"; if (this.journal.operations.length) await this.host.persist(this.journal); }
  private async prepareEdit(file: AgentFile, before: string, afterHash: string): Promise<JournalOp> {
    this.guard(); const beforeHash = await inputDigest(before); this.guard();
    let op = this.journal.operations.find(op => ["edit", "create"].includes(op.kind) && op.path === file.path && op.status !== "undone");
    if (!op) { const backup = await this.host.backup(file.path, before); this.guard(); op = { kind: "edit", path: file.path, backup, beforeHash, afterHash, previousHash: beforeHash, status: "pending" }; this.journal.operations.push(op); }
    else { op.previousHash = beforeHash; op.afterHash = afterHash; op.status = "pending"; }
    await this.host.persist(this.journal); this.guard(); return op;
  }
  async execute(name: string, args: unknown): Promise<unknown> {
    this.guard(); if (!agentTools(this.policy.mode).some(tool => tool.name === name)) throw Error("That action is not enabled in this task's mode.");
    if (name === "search_notes") {
      closedObject(args, ["query", "limit"]); const terms = noteTerms(textField(args.query, 4000)); const count = Number(args.limit);
      if (!Number.isInteger(count) || count < 1 || count > 32) throw Error("Search returns 1–32 note references.");
      const allowed = this.host.files().filter(file => allowedPath(this.policy, file.path, "read"));
      const candidates = allowed.slice(0, 2000).map(file => ({ file, score: rankNote(file.title, terms) * 10 })).sort((a, b) => b.score - a.score).slice(0, 32);
      const hits = []; let scanned = 0;
      for (const item of candidates) {
        this.guard(); if (!terms.length && !item.score && item.file.path !== this.policy.sourcePath) continue;
        let score = item.score;
        if (terms.length && item.file.size <= 131072) { const text = await this.host.read(item.file); this.guard(); scanned++; if (text !== null) score += rankNote(text.slice(0, 32768), terms); }
        if (!score && item.file.path !== this.policy.sourcePath) continue;
        safeOutbound(item.file.title + "\n" + item.file.path); hits.push({ reference: this.reference(item.file), title: item.file.title, path: item.file.path, score });
      }
      return { notes: hits.sort((a, b) => b.score - a.score).slice(0, count), inspected: candidates.length, content_scanned: scanned, permitted_total: allowed.length, partial: allowed.length > candidates.length };
    }
    if (name === "read_notes") {
      closedObject(args, ["notes"]); const output = [];
      for (const item of list(args.notes, 4)) { closedObject(item, ["reference", "from_line", "through_line"]); output.push(await this.excerpt(this.ref(item.reference), Number(item.from_line), Number(item.through_line))); }
      return { notes: output };
    }
    if (name === "read_outline") {
      closedObject(args, ["reference"]); const ref = this.ref(args.reference), text = await this.read(ref), visible = ref.allowedRange ? text.slice(ref.allowedRange.from, ref.allowedRange.to) : text;
      const headings = []; let fence = false;
      for (const [index, line] of visible.split("\n").entries()) { if (/^\s*(`{3,}|~{3,})/.test(line)) fence = !fence; if (!fence && /^#{1,6} /.test(line)) headings.push({ line: index + 1, text: line.slice(0, 180) }); }
      safeOutbound(JSON.stringify(headings)); return { title: ref.file.title, headings: headings.slice(0, 200), total_lines: visible.split("\n").length, selection_only: !!ref.allowedRange, partial: headings.length > 200 };
    }
    if (name === "apply_changes") {
      closedObject(args, ["changes"]); const plans = [], seen = new Set<string>();
      for (const change of list(args.changes)) {
        closedObject(change, ["reference", "version", "action", "markdown"]); const ref = this.ref(change.reference), before = await this.read(ref);
        if (!allowedPath(this.policy, ref.file.path, "edit")) throw Error("This note is outside the permitted edit scope.");
        if (seen.has(ref.file.path)) throw Error("Use one change per note in a batch."); seen.add(ref.file.path);
        if (!ref.version || change.version !== ref.version || await inputDigest(before) !== ref.version) throw Error("The note changed. Read its new version before editing.");
        const markdown = safeNoteMarkdown(textField(change.markdown, 4 * 1024 * 1024)); let after: string;
        if (change.action === "replace" && ref.complete) after = markdown;
        else if (change.action === "append" && !ref.allowedRange) after = before + (before.endsWith("\n\n") || !before ? "" : before.endsWith("\n") ? "\n" : "\n\n") + markdown + "\n";
        else if (change.action === "replace_selection" && ref.range) after = before.slice(0, ref.range.from) + markdown + before.slice(ref.range.to);
        else throw Error("Read the complete note before replacing it, or replace only the reviewed selection.");
        plans.push({ ref, before, after, hash: await inputDigest(after) });
      }
      const ops = []; for (const plan of plans) ops.push(await this.prepareEdit(plan.ref.file, plan.before, plan.hash));
      for (const [index, plan] of plans.entries()) { this.guard(); await this.host.replace(plan.ref.file, plan.before, plan.after); plan.ref.version = plan.hash; plan.ref.complete = false; plan.ref.range = undefined; ops[index].status = "done"; await this.host.persist(this.journal); }
      return { status: "applied", notes: plans.map(plan => ({ reference: this.reference(plan.ref.file), path: plan.ref.file.path, version: plan.hash })), undo_available: true };
    }
    if (name === "create_note") {
      closedObject(args, ["path", "markdown"]); const path = vaultPath(textField(args.path));
      if (!allowedPath(this.policy, path, "create")) throw Error("Create the note inside the permitted output folder.");
      if (this.host.files().some(file => file.path === path)) throw Error("That filename already exists. Choose another name.");
      const markdown = safeNoteMarkdown(textField(args.markdown, 4 * 1024 * 1024)); const hash = await inputDigest(markdown);
      const op: JournalOp = { kind: "create", path, beforeHash: "", afterHash: hash, previousHash: "", status: "pending" }; this.journal.operations.push(op); await this.host.persist(this.journal); this.guard();
      const file = await this.host.create(path, markdown); op.status = "done"; await this.host.persist(this.journal); const ref = this.reference(file); this.refs.get(ref)!.version = hash;
      return { status: "created", reference: ref, path, version: hash, undo_available: true };
    }
    if (name === "update_properties") {
      closedObject(args, ["reference", "version", "properties"]); const ref = this.ref(args.reference), before = await this.read(ref);
      if (!allowedPath(this.policy, ref.file.path, "edit") || ref.allowedRange) throw Error("Properties require the complete note's edit permission.");
      if (!ref.version || args.version !== ref.version || await inputDigest(before) !== ref.version) throw Error("Read the current note version first.");
      const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const item of list(args.properties, 32)) { closedObject(item, ["key", "value"]); const key = textField(item.key, 80); if (!key || ["__proto__", "constructor", "prototype"].includes(key)) throw Error("Invalid property name."); values[key] = JSON.parse(textField(item.value, 8192)) as unknown; }
      const op = await this.prepareEdit(ref.file, before, ""); await this.host.properties(ref.file, before, values); const after = await this.read(ref); op.afterHash = await inputDigest(after); op.status = "done"; ref.version = op.afterHash; ref.complete = false; await this.host.persist(this.journal);
      return { status: "updated", reference: this.reference(ref.file), version: ref.version };
    }
    if (name === "rename_note") {
      closedObject(args, ["reference", "version", "path"]); const ref = this.ref(args.reference), before = await this.read(ref), path = vaultPath(textField(args.path));
      if (!allowedPath(this.policy, ref.file.path, "organize") || !allowedPath(this.policy, path, "create") || ref.allowedRange) throw Error("Rename/move must stay inside the permitted organize scope.");
      if (!ref.version || args.version !== ref.version || await inputDigest(before) !== ref.version) throw Error("Read the current note version first.");
      const affected = this.host.affected(ref.file.path).filter(item => item !== ref.file.path);
      if (affected.some(item => !allowedPath(this.policy, item, "edit"))) throw Error("Backlinks outside the edit scope may change. Expand the scope explicitly before renaming.");
      const oldPath = ref.file.path, op: JournalOp = { kind: "rename", path: oldPath, target: path, beforeHash: ref.version, afterHash: ref.version, previousHash: ref.version, status: "pending" };
      this.journal.operations.push(op); await this.host.persist(this.journal); this.guard(); await this.host.rename(ref.file, path); op.status = "done";
      if (this.policy.sourcePath === oldPath) this.policy.sourcePath = path;
      ref.version = await inputDigest(await this.read(ref)); await this.host.persist(this.journal); return { status: "renamed", reference: this.reference(ref.file), path, version: ref.version, links_to_review: affected, meaning: "Links are not changed automatically. Search/read their notes and apply version-checked edits within the permitted scope." };
    }
    if (name === "create_folder") {
      closedObject(args, ["path"]); const path = vaultPath(textField(args.path), true); if (!allowedPath(this.policy, path, "organize")) throw Error("The folder is outside the organize scope.");
      const created = await this.host.folder(path); if (created) { this.journal.operations.push({ kind: "folder", path, beforeHash: "", afterHash: "", previousHash: "", status: "done" }); await this.host.persist(this.journal); } return { status: created ? "created" : "existing", path };
    }
    if (name === "propose_trash") {
      closedObject(args, ["references"]);
      for (const value of list(args.references)) { const ref = this.ref(value), before = await this.read(ref); if (!allowedPath(this.policy, ref.file.path, "organize") || ref.allowedRange) throw Error("This note cannot be proposed for Trash in the current scope."); this.pendingTrash.push({ reference: textField(value), title: ref.file.title, version: await inputDigest(before) }); }
      return { status: "awaiting_user_choice", notes: this.pendingTrash.map(item => ({ reference: item.reference, title: item.title })) };
    }
    throw Error("Unknown workspace tool.");
  }
  async confirmTrash(): Promise<void> {
    this.guard();
    for (const item of this.pendingTrash) { const ref = this.ref(item.reference), before = await this.read(ref); if (await inputDigest(before) !== item.version) throw Error("A proposed note changed. Review it again before moving it to Trash."); const backup = await this.host.backup(ref.file.path, before); const op: JournalOp = { kind: "trash", path: ref.file.path, backup, beforeHash: item.version, afterHash: "", previousHash: item.version, status: "pending" }; this.journal.operations.push(op); await this.host.persist(this.journal); this.guard(); await this.host.trash(ref.file); op.status = "done"; await this.host.persist(this.journal); }
    this.pendingTrash.length = 0;
  }
  async undo(journal: WorkJournal = this.journal): Promise<{ restored: number; kept: number }> {
    this.guard(); validateJournal(journal); let restored = 0, kept = 0;
    for (const op of [...journal.operations].reverse()) {
      if (op.status === "undone" || op.kind === "folder") continue;
      if (op.status === "pending" && op.kind !== "edit") { kept++; continue; }
      try {
        const path = op.kind === "rename" ? op.target! : op.path; vaultPath(path); const file = this.host.files().find(file => file.path === path);
        const original = op.backup ? await this.host.readBackup(op.backup) : null;
        if (original !== null && await inputDigest(original) !== op.beforeHash) throw Error("The backup changed. Existing notes are kept.");
        if (op.kind === "trash") { if (file || original === null) throw Error("A new file occupies this name."); await this.host.create(op.path, original); }
        else {
          if (!file) throw Error("The file no longer exists."); const current = await this.host.read(file); if (current === null) throw Error("File changed"); const hash = await inputDigest(current);
          if (hash === op.beforeHash && op.kind === "edit") { op.status = "undone"; continue; }
          if (!op.afterHash || hash !== op.afterHash && hash !== op.previousHash) throw Error("Newer edits are kept.");
          this.guard();
          if (op.kind === "create") await this.host.trash(file);
          else if (op.kind === "rename") { if (this.host.files().some(file => file.path === op.path)) throw Error("The old name is occupied."); await this.host.rename(file, op.path); }
          else { if (original === null) throw Error("No original backup"); await this.host.replace(file, current, original); }
        }
        op.status = "undone"; restored++;
      } catch { kept++; }
      await this.host.persist(journal);
    }
    journal.status = kept ? "interrupted" : "undone"; await this.host.persist(journal); return { restored, kept };
  }
}
