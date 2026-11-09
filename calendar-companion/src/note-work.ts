import type { AiSession, AiDraft } from "./ai-session";
import type { AiPreferences } from "./ai-preferences";
import type { CalendarSession } from "./session";
import type { DeliveryV3 } from "./protocol";
import { planQuestion, type QueryArea, type QueryPeriod } from "./question-query";
import { applyNote, buildNoteInput, captureNote, safeNoteMarkdown, type NoteApply, type NoteCapture, type NoteTarget } from "./note-context";
import { parseNoteAnswer, type NoteExtra, type NoteProposal, type NoteWorkspace, type WorkspaceDocument } from "./note-workspace";

export type NoteAction = "ask" | "summary" | "refine" | "tasks" | "diagram" | "chart" | "table" | "math" | "new";
export const NOTE_ACTIONS: Record<NoteAction, { label: string; prompt: string }> = {
  ask: { label: "Ask", prompt: "" }, summary: { label: "Summarize", prompt: "Summarize this text concisely, preserving its important facts." },
  refine: { label: "Refine", prompt: "Refine this text for clarity while preserving its meaning and language." },
  tasks: { label: "To-do list", prompt: "Extract the actionable tasks from this text as a Markdown task list. Do not invent deadlines." },
  diagram: { label: "Diagram", prompt: "Create a clear Mermaid diagram explaining the supplied note and relevant sources. Add it to the note with a short explanation." },
  chart: { label: "Chart", prompt: "Create a native Mermaid chart from the numerical facts in the supplied sources. Label units and cite sources. If no suitable data exists, explain what is missing instead of inventing values." },
  table: { label: "Table", prompt: "Organize the supplied information into a useful Markdown table. Preserve facts and cite sources." },
  math: { label: "Math", prompt: "Explain the mathematical relationships in this note using Obsidian LaTeX math and a worked example based only on the supplied values." },
  new: { label: "New document", prompt: "Create a new, well-structured Markdown document from the supplied notes and relevant Calendar sources. Choose a clear title and preserve the source language." },
};

/** Vault-session work item. Hiding its view never cancels a paid response or discards the result. */
export class NoteWork {
  source: NoteCapture | null = null;
  prompt = "";
  action: NoteAction = "ask";
  model = "";
  configured = false;
  busy = false;
  used = false;
  applied = false;
  saved = false;
  message = "";
  draft: AiDraft | null = null;
  reply = "";
  proposals: NoteProposal[] = [];
  selectedProposal = 0;
  related: WorkspaceDocument[] = [];
  previousTurns: { request: string; answer: string }[] = [];
  private appliedProposals = new Set<number>();
  private savedProposals = new Set<number>();
  invalidProposals = false;
  private lastEdit: { before: string; after: string; restore(): Promise<void> } | null = null;
  backupPath: string | null = null;
  delivery: DeliveryV3 | null = null;
  calendarQuestion = "";
  area: QueryArea | "auto" = "auto";
  period: QueryPeriod | "auto" = "auto";
  private alive = true;
  private revision = 0;
  private listeners = new Set<() => void>();
  constructor(readonly target: NoteTarget, private readonly selection: { from: number; to: number }, private readonly options: {
    current(): boolean; ai: AiSession; preferences: AiPreferences; calendar(): CalendarSession; inboxHint(): string;
    save(path: string, text: string): Promise<void>; workspace?: NoteWorkspace;
  }) {}
  private session: CalendarSession | null = null;
  get current() { return this.alive && this.options.current(); }
  get requestId() { return this.session?.requestId ?? null; }
  get locked() { return this.busy || this.used; }
  private extra(): NoteExtra {
    const history = this.previousTurns.slice(-2).map(turn => ({ request: turn.request, answer: turn.answer.slice(0, 4000) + (turn.answer.length > 4000 ? "\n[Previous answer excerpt]" : "") }));
    return { documents: this.related, history, proposeEdits: true };
  }
  get input(): string { return this.source && this.prompt.trim() ? buildNoteInput(this.source, this.prompt, this.delivery ?? undefined, this.extra()) : ""; }
  get proposal(): NoteProposal | null { return this.proposals[this.selectedProposal] ?? null; }
  get canUndo() { return !!this.lastEdit; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private changed(): void { if (this.current) for (const listener of this.listeners) listener(); }
  async initialize(section = false): Promise<void> {
    if (!this.current || this.locked) return;
    const revision = ++this.revision; this.busy = true;
    try {
      const source = await captureNote(this.target, this.selection, section);
      if (!this.current || revision !== this.revision) return;
      this.source = source; this.message = "";
    } catch (error) { this.message = error instanceof Error ? error.message : "The note could not be read."; }
    finally { this.busy = false; this.changed(); }
    await this.refreshSettings();
  }
  async refreshSettings(): Promise<void> {
    if (!this.current || this.busy) return;
    try {
      const [options, configured] = await Promise.all([this.options.preferences.read("openai"), this.options.preferences.hasKey("openai")]);
      if (!this.current || this.busy) return;
      this.model = options.model; this.configured = configured;
    } catch { this.message = "Open AI settings to choose a model and save your key locally."; }
    this.changed();
  }
  setPrompt(value: string): void { if (!this.locked) { this.prompt = value; this.revision++; } }
  choose(action: NoteAction): void { if (this.locked) return; this.action = action; this.setPrompt(NOTE_ACTIONS[action].prompt); this.changed(); }
  async findRelated(): Promise<void> {
    if (!this.current || this.locked || !this.options.workspace) return;
    this.busy = true; this.changed();
    try {
      const result = await this.options.workspace.search(this.prompt);
      if (!this.current) return;
      this.related = result.documents; this.revision++;
      this.message = `${result.documents.length} relevant Markdown note(s) added. Searched ${result.scanned} of ${result.total} local notes; at most four complete notes are sent. Review the context below.`;
    } catch { this.message = "Related notes could not be read. The current note and request are kept."; }
    finally { this.busy = false; this.changed(); }
  }
  removeRelated(): void { if (!this.locked) { this.related = []; this.revision++; this.changed(); } }
  selectProposal(index: number): void {
    if (this.busy || !this.draft || !this.proposals[index]) return;
    this.selectedProposal = index; this.draft = { ...this.draft, text: this.proposals[index].markdown };
    this.applied = this.appliedProposals.has(index); this.saved = this.savedProposals.has(index); this.changed();
  }
  async followUp(): Promise<void> {
    if (!this.current || this.busy || !this.draft) return;
    const previous = { request: this.prompt, answer: this.reply + "\n" + this.proposals.map(change => change.markdown).join("\n\n") + (!this.proposals.length ? this.draft.text : "") };
    this.busy = true;
    try {
      const source = await captureNote(this.target, this.applied ? { from: 0, to: 0 } : this.selection);
      if (!this.current) return;
      this.source = source; this.previousTurns.push(previous);
      for (const doc of this.related) { const text = await doc.read(); if (text !== null) doc.text = text; }
      this.prompt = ""; this.action = "ask"; this.used = false; this.draft = null; this.reply = ""; this.proposals = []; this.selectedProposal = 0;
      this.appliedProposals.clear(); this.savedProposals.clear(); this.applied = false; this.saved = false; this.invalidProposals = false; this.revision++;
      this.message = "Continue with another request. Your previous answer is kept below; nothing is sent until you generate again.";
    } catch { this.message = "Reopen the original note to continue. The answer is kept here."; }
    finally { this.busy = false; this.changed(); }
  }
  async findCalendar(): Promise<string | null> {
    if (!this.current || this.locked || this.requestId) return null;
    this.busy = true; this.message = ""; this.changed();
    try {
      const query = planQuestion(this.calendarQuestion, { ...(this.area !== "auto" ? { areas: [this.area] } : {}), ...(this.period !== "auto" ? { period: this.period } : {}) }).query;
      if (!query) throw Error("Name a Calendar workspace in the question or choose one below.");
      this.session = this.options.calendar();
      const vaultId = await this.options.preferences.vaultId();
      if (!this.current) return null;
      return await this.session.start({ vaultId, query, inboxHint: this.options.inboxHint() });
    } catch (error) { this.message = error instanceof Error ? error.message : "Calendar could not be opened."; return null; }
    finally { this.busy = false; this.changed(); }
  }
  async receive(id: string): Promise<void> {
    if (!this.current || this.busy || !this.session || this.delivery || this.used) return;
    this.busy = true;
    try {
      const delivery = await this.session.receive(id);
      if (!this.current || delivery.version !== 3) return;
      this.delivery = delivery; this.revision++;
      this.message = delivery.records.length ? `Added ${delivery.records.length} relevant Calendar excerpt(s).` : "No matching Calendar excerpts. Remove Calendar context to use the note alone.";
    } catch { this.message = "No verified Calendar reply yet. Approve the local search in Calendar, then check again."; }
    finally { this.busy = false; this.changed(); }
  }
  async removeCalendar(): Promise<void> {
    if (this.locked) return;
    this.busy = true;
    try { await this.session?.dispose(); this.session = null; this.delivery = null; this.revision++; this.message = "Calendar context removed. Your note is kept."; }
    finally { this.busy = false; this.changed(); }
  }
  async generate(): Promise<void> {
    if (!this.current || this.locked || !this.source || !this.configured || !this.model || !this.prompt.trim() || (this.requestId && !this.delivery)) return;
    this.busy = true; this.message = "Generating once. You can hide this sheet; the result will remain here."; this.changed();
    const revision = this.revision, source = this.source;
    try {
      if (this.delivery) this.session?.assertCanSave(this.delivery);
      this.options.ai.enableForSession(true);
      if ((await this.options.preferences.read("openai")).model !== this.model) throw Error("The model changed. Reopen AI settings to refresh it before generating.");
      const review = await this.options.ai.prepareNote(source, this.prompt, { model: this.model }, () => this.current && revision === this.revision, this.delivery ?? undefined, this.extra());
      this.used = true;
      this.draft = await this.options.ai.generate(review, true);
      try {
        const answer = parseNoteAnswer(this.draft.text, ["N1", ...this.related.map(doc => doc.reference)]);
        this.reply = answer.reply; this.proposals = answer.changes;
        this.draft = { ...this.draft, text: answer.changes[0]?.markdown ?? answer.reply };
      } catch { this.invalidProposals = ["{", "["].includes(this.draft.text.trimStart()[0] ?? ""); }
      this.message = this.invalidProposals ? "The file proposals could not be verified. The response is kept for copying; no edit can be applied. No retry was made." :
        this.draft.incomplete ? "Partial result received. You can keep or copy it. No retry was made." : "Result ready. Review it before adding it to your note.";
    } catch (error) { this.message = error instanceof Error ? error.message : "The request could not finish. No retry was made."; }
    finally { this.options.ai.enableForSession(false); this.busy = false; this.changed(); }
  }
  async apply(mode: NoteApply): Promise<void> {
    if (!this.current || this.busy || !this.draft || !this.source || this.applied || this.invalidProposals) return;
    this.busy = true; this.message = "Checking the original note before applying this edit…"; this.changed();
    try {
      const before = this.target.read();
      await applyNote(this.source, this.draft.text, mode, () => this.current);
      const after = this.target.read();
      if (before !== null && after !== null) this.rememberSourceEdit(before, after);
      this.applied = true; this.appliedProposals.add(this.selectedProposal); this.message = "Added to the original note. Use Undo last AI edit or Obsidian Undo to revert it.";
    }
    catch (error) { this.message = error instanceof Error ? error.message : "The note was kept. Copy or save the result instead."; }
    finally { this.busy = false; this.changed(); }
  }
  private rememberSourceEdit(before: string, after: string): void {
    this.lastEdit = { before, after, restore: () => {
      if (!this.current || this.target.read() !== after) return Promise.reject(Error("The note changed after this edit. Your backup and result are kept."));
      this.target.change(0, after.length, before); return Promise.resolve();
    } };
  }
  async applyProposal(): Promise<void> {
    const change = this.proposal, source = this.source;
    if (!this.current || this.busy || !change || !source || this.applied || this.invalidProposals || change.target === "new") return;
    if (change.target === "N1" && (change.action !== "replace" || source.scope !== "note")) {
      await this.apply(change.action === "replace" ? "replace" : source.scope === "selection" ? "below" : "append"); return;
    }
    this.busy = true; this.message = "Verifying the original backup and saving this change…"; this.changed();
    try {
      const doc = this.related.find(doc => doc.reference === change.target);
      const before = change.target === "N1" ? this.target.read() : await doc?.read();
      const expected = change.target === "N1" ? source.text : doc?.text;
      if (!this.current || before == null || expected === undefined || before !== expected || (change.target === "N1" && source.scope !== "note")) throw Error("The complete original note changed or was not reviewed. Copy or save the proposal instead.");
      if (!this.options.workspace) throw Error("Reopen the note to prepare a recoverable edit.");
      this.backupPath = await this.options.workspace.backup(change.target === "N1" ? this.target.path : doc!.path, before);
      const after = change.action === "append" ? `${before.trimEnd()}\n\n${change.markdown}\n` : change.markdown;
      if (!this.current) throw Error("The vault changed.");
      if (change.target === "N1") {
        if (this.target.read() !== before) throw Error("The original note changed during backup. It was kept.");
        this.target.change(0, before.length, after); this.rememberSourceEdit(before, after);
      } else {
        await doc!.replace(before, after);
        this.lastEdit = { before, after, restore: () => { if (!this.current) return Promise.reject(Error("Vault changed")); return doc!.replace(after, before); } };
      }
      this.applied = true; this.appliedProposals.add(this.selectedProposal); this.message = `Applied to ${change.title || doc?.title || this.target.title}. Original backed up in AI backups. Undo is available.`;
    } catch (error) { this.message = error instanceof Error ? error.message : "Could not apply this proposal. The original and result are kept."; }
    finally { this.busy = false; this.changed(); }
  }
  async undo(): Promise<void> {
    if (!this.current || this.busy || !this.lastEdit) return;
    this.busy = true; this.message = "Checking for newer edits before restoring the original…"; this.changed();
    try { await this.lastEdit.restore(); this.lastEdit = null; this.message = "Restored the original note. Your AI answer is still available."; }
    catch (error) { this.message = error instanceof Error ? error.message : "Could not undo. The backup is kept."; }
    finally { this.busy = false; this.changed(); }
  }
  async saveNew(): Promise<void> {
    if (!this.current || this.busy || !this.draft || this.saved || this.invalidProposals) return;
    this.busy = true; this.message = "Creating and verifying the new note…"; this.changed();
    try {
      const folder = this.target.path.includes("/") ? this.target.path.slice(0, this.target.path.lastIndexOf("/") + 1) : "";
      const title = (this.proposal?.title || this.target.title).replace(/\.md$/i, "").replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/^\.+/, "").trim().slice(0, 70) || "Note";
      const path = this.proposal?.target === "new" ? `${folder}${title}.md` : `${folder}${title} - AI ${crypto.randomUUID().slice(0, 8)}.md`;
      const sources = this.delivery ? `\n\n---\nCalendar excerpts: ${this.delivery.records.map((_, i) => `C${i + 1}`).join(", ")} · as of ${new Date(this.delivery.exportedAt).toISOString()}` : "";
      if (!this.current) return;
      await this.options.save(path, this.proposal?.target === "new" ? `${safeNoteMarkdown(this.draft.text)}${sources}\n` : `# ${safeNoteMarkdown(title)} — AI draft\n\n${safeNoteMarkdown(this.draft.text)}${sources}\n`);
      this.saved = true; this.savedProposals.add(this.selectedProposal); this.message = "Saved as a new note beside the source. The original note is kept.";
    } catch { this.message = "Could not create the new note. An existing file or folder was kept; choose another title, or copy the result."; }
    finally { this.busy = false; this.changed(); }
  }
  report(message: string): void { this.message = message; this.changed(); }
  dispose(): void { this.alive = false; this.revision++; this.options.ai.enableForSession(false); this.listeners.clear(); void this.session?.dispose(); }
}
