import type { AiSession, AiDraft } from "./ai-session";
import type { AiPreferences } from "./ai-preferences";
import type { CalendarSession } from "./session";
import type { DeliveryV3 } from "./protocol";
import { planQuestion, type QueryArea, type QueryPeriod } from "./question-query";
import { applyNote, buildNoteInput, captureNote, safeNoteMarkdown, type NoteApply, type NoteCapture, type NoteTarget } from "./note-context";

export type NoteAction = "ask" | "summary" | "refine" | "tasks";
export const NOTE_ACTIONS: Record<NoteAction, { label: string; prompt: string }> = {
  ask: { label: "Ask", prompt: "" }, summary: { label: "Summarize", prompt: "Summarize this text concisely, preserving its important facts." },
  refine: { label: "Refine", prompt: "Refine this text for clarity while preserving its meaning and language." },
  tasks: { label: "To-do list", prompt: "Extract the actionable tasks from this text as a Markdown task list. Do not invent deadlines." },
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
  delivery: DeliveryV3 | null = null;
  calendarQuestion = "";
  area: QueryArea | "auto" = "auto";
  period: QueryPeriod | "auto" = "auto";
  private alive = true;
  private revision = 0;
  private listeners = new Set<() => void>();
  constructor(readonly target: NoteTarget, private readonly selection: { from: number; to: number }, private readonly options: {
    current(): boolean; ai: AiSession; preferences: AiPreferences; calendar(): CalendarSession; inboxHint(): string;
    save(path: string, text: string): Promise<void>;
  }) {}
  private session: CalendarSession | null = null;
  get current() { return this.alive && this.options.current(); }
  get requestId() { return this.session?.requestId ?? null; }
  get locked() { return this.busy || this.used; }
  get input(): string { return this.source && this.prompt.trim() ? buildNoteInput(this.source, this.prompt, this.delivery ?? undefined) : ""; }
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
    if (!this.current || this.locked || !this.source || !this.configured || !this.model || !this.prompt.trim()) return;
    this.busy = true; this.message = "Generating once. You can hide this sheet; the result will remain here."; this.changed();
    const revision = this.revision, source = this.source;
    try {
      if (this.delivery) this.session?.assertCanSave(this.delivery);
      this.options.ai.enableForSession(true);
      const review = await this.options.ai.prepareNote(source, this.prompt, { model: this.model }, () => this.current && revision === this.revision, this.delivery ?? undefined);
      this.used = true;
      this.draft = await this.options.ai.generate(review, true);
      this.message = this.draft.incomplete ? "Partial result received. You can keep or copy it. No retry was made." : "Result ready. Review it before adding it to your note.";
    } catch (error) { this.message = error instanceof Error ? error.message : "The request could not finish. No retry was made."; }
    finally { this.options.ai.enableForSession(false); this.busy = false; this.changed(); }
  }
  async apply(mode: NoteApply): Promise<void> {
    if (!this.current || this.busy || !this.draft || !this.source || this.applied) return;
    this.busy = true;
    try { await applyNote(this.source, this.draft.text, mode, () => this.current); this.applied = true; this.message = "Added to the original note. Use Obsidian Undo to revert this edit."; }
    catch (error) { this.message = error instanceof Error ? error.message : "The note was kept. Copy or save the result instead."; }
    finally { this.busy = false; this.changed(); }
  }
  async saveNew(): Promise<void> {
    if (!this.current || this.busy || !this.draft || this.saved) return;
    this.busy = true;
    try {
      const folder = this.target.path.includes("/") ? this.target.path.slice(0, this.target.path.lastIndexOf("/") + 1) : "";
      const title = this.target.title.replace(/[\\/:*?"<>|#^[\]]/g, " ").trim().slice(0, 70) || "Note";
      const path = `${folder}${title} - AI ${crypto.randomUUID().slice(0, 8)}.md`;
      const sources = this.delivery ? `\n\n---\nCalendar excerpts: ${this.delivery.records.map((_, i) => `C${i + 1}`).join(", ")} · as of ${new Date(this.delivery.exportedAt).toISOString()}` : "";
      if (!this.current) return;
      await this.options.save(path, `# ${safeNoteMarkdown(title)} — AI draft\n\n${safeNoteMarkdown(this.draft.text)}${sources}\n`);
      this.saved = true; this.message = "Saved as a new note beside the source. The original note is kept.";
    } catch { this.message = "Could not create the new note. Your result is kept; copy it or try saving again."; }
    finally { this.busy = false; this.changed(); }
  }
  report(message: string): void { this.message = message; this.changed(); }
  dispose(): void { this.alive = false; this.revision++; this.options.ai.enableForSession(false); this.listeners.clear(); void this.session?.dispose(); }
}
