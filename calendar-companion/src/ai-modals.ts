import { App, Modal, Setting } from "obsidian";
import { AiPreferences, DEFAULT_OPENAI_OPTIONS } from "./ai-preferences";
import { OpenAiSession, type OpenAiDraft, type OpenAiOptions, type OpenAiReview } from "./openai";
import { type RecordSnapshot } from "./protocol";
import { saveAiDraft, type NoteStore } from "./notes";

export interface AiContext {
  session: OpenAiSession; preferences: AiPreferences; current(): boolean;
}

/** Configuration is local only. Saving a key or model never tests it against OpenAI. */
export class OpenAiSettingsModal extends Modal {
  private alive = false;
  private busy = true;
  private message = "";
  private configured = false;
  private options = { ...DEFAULT_OPENAI_OPTIONS };
  private keyInput: HTMLInputElement | null = null;
  constructor(app: App, private readonly ai: AiContext, private readonly closed: () => void) { super(app); }
  onOpen(): void { this.alive = true; this.contentEl.classList.add("calendar-companion"); this.render(); void this.load(); }
  onClose(): void { this.alive = false; if (this.keyInput) this.keyInput.value = ""; this.keyInput = null; this.closed(); }
  private current = () => this.alive && this.ai.current();
  private async load(): Promise<void> {
    try { this.options = await this.ai.preferences.read(); this.configured = await this.ai.preferences.hasKey(); }
    catch { this.message = "Local OpenAI settings could not be read. Obsidian secret storage is required."; }
    finally { this.busy = false; if (this.current()) this.render(); }
  }
  private async change(action: () => Promise<void>): Promise<void> {
    if (!this.current() || this.busy) return;
    this.busy = true; this.ai.session.enableForSession(false);
    if (this.keyInput) this.keyInput.value = "";
    this.render();
    try { await action(); if (!this.current()) return; this.configured = await this.ai.preferences.hasKey(); this.message = "Saved locally. No API request was sent. Enable OpenAI only when you want to use it."; }
    catch { if (this.current()) this.message = "Could not save locally. Check the model, token limit and secret storage. No API request was sent."; }
    finally { this.busy = false; if (this.current()) this.render(); }
  }
  private render(): void {
    if (!this.current()) return;
    if (this.keyInput) this.keyInput.value = "";
    const el = this.contentEl; el.empty(); el.createEl("h2", { text: "OpenAI (optional)" });
    el.createEl("p", { text: "Calendar import is free and works with OpenAI off. Generation sends only your selected records and prompt to OpenAI and may incur API charges on your OpenAI account." });
    el.createEl("p", { text: "OpenAI starts off after each plugin load. Settings, key storage and the enable switch make no API calls. There are no automatic requests, key checks or retries." });
    if (this.message) el.createEl("p", { text: this.message, cls: "calendar-companion-status", attr: { role: "status" } });
    new Setting(el).setName("Model ID").setDesc("Enter a Responses API text model available to your account. No model list is fetched.")
      .addText(input => input.setPlaceholder("Model ID").setValue(this.options.model).setDisabled(this.busy).onChange(value => { this.options.model = value.trim(); }));
    new Setting(el).setName("Maximum output tokens").setDesc("128–4096; default 512. Includes reasoning tokens. This limits output, not the monetary cost of a request.")
      .addText(input => { input.inputEl.type = "number"; input.inputEl.min = "128"; input.inputEl.max = "4096"; input.setValue(String(this.options.maxOutputTokens)).setDisabled(this.busy).onChange(value => { this.options.maxOutputTokens = Number(value); }); });
    new Setting(el).addButton(button => button.setButtonText("Save model settings").setDisabled(this.busy).onClick(() => void this.change(() => this.ai.preferences.save({ ...this.options }))));
    new Setting(el).setName(this.configured ? "API key saved locally" : "No API key saved").setDesc("Stored through Obsidian secret storage, outside this plugin's vault files. Other trusted plugins share Obsidian's trust boundary.")
      .addText(input => { this.keyInput = input.inputEl; input.inputEl.type = "password"; input.inputEl.autocomplete = "off"; input.inputEl.setAttribute("aria-label", "OpenAI API key"); input.setPlaceholder("Your own API key").setDisabled(this.busy); });
    new Setting(el)
      .addButton(button => button.setButtonText("Save key locally").setDisabled(this.busy).onClick(() => { const value = this.keyInput?.value ?? ""; void this.change(() => this.ai.preferences.saveKey(value)); }))
      .addButton(button => button.setButtonText("Remove saved key").setDisabled(this.busy || !this.configured).onClick(() => void this.change(() => this.ai.preferences.clearKey())));
    new Setting(el).setName("Enable OpenAI for this session").setDesc("Still requires reviewing and confirming each request. Disabling cannot recall an already-sent request.")
      .addToggle(toggle => toggle.setValue(this.ai.session.enabled).setDisabled(this.busy || !this.configured).onChange(value => this.ai.session.enableForSession(value)));
  }
}

/** A draft is prepared, explicitly approved, then sent once; all source records remain unchanged. */
export class OpenAiDraftModal extends Modal {
  private alive = false;
  private busy = false;
  private options: OpenAiOptions | null = null;
  private message = "";
  private selected = new Set<number>();
  private prompt = "";
  private review: OpenAiReview | null = null;
  private confirmed = false;
  private result: OpenAiDraft | null = null;
  private saved = false;
  constructor(app: App, private readonly ai: AiContext, private readonly records: readonly RecordSnapshot[], private readonly store: NoteStore,
    private readonly sourceCurrent: () => boolean, private readonly closed: () => void) { super(app); }
  private current = () => this.alive && this.ai.current() && this.sourceCurrent();
  onOpen(): void { this.alive = true; this.contentEl.classList.add("calendar-companion"); this.render(); void this.load(); }
  onClose(): void { this.alive = false; this.review = null; this.closed(); }
  private async load(): Promise<void> {
    try { const options = await this.ai.preferences.read(); if (this.current()) this.options = options; }
    catch { this.message = "OpenAI settings could not be read. Reopen OpenAI settings first."; }
    if (this.current()) this.render();
  }
  private render(): void {
    if (!this.current()) return;
    const el = this.contentEl; el.empty(); el.createEl("h2", { text: "Optional OpenAI draft" });
    el.createEl("p", { text: "Choose only the records to send. Generation may incur OpenAI API charges. Saving an imported Calendar note does not require this feature." });
    if (this.message) el.createEl("p", { text: this.message, cls: "calendar-companion-status", attr: { role: "status" } });
    if (this.result) {
      el.createEl("p", { text: this.result.incomplete ? "The output limit was reached; this draft may be incomplete." : "Review this AI-generated draft before saving." });
      if (this.result.inputTokens !== null && this.result.outputTokens !== null) el.createEl("p", { text: `Reported usage: ${this.result.inputTokens} input and ${this.result.outputTokens} output tokens.` });
      el.createEl("pre", { text: this.result.text });
      new Setting(el).addButton(button => button.setButtonText(this.saved ? "Draft saved" : "Save draft as new note").setDisabled(this.busy || this.saved).onClick(() => void this.save()));
      return;
    }
    if (this.review) {
      el.createEl("p", { text: `Destination: OpenAI. Model: ${this.review.model}. Maximum output: ${this.review.maxOutputTokens} tokens. ${this.review.recordCount} selected record(s).` });
      el.createEl("p", { text: "This is the prompt and Calendar content that will be sent. Record IDs and the vault name are omitted." });
      el.createEl("pre", { text: JSON.stringify(JSON.parse(this.review.input), null, 2), cls: "calendar-companion-request" });
      new Setting(el).setName("I approve this transmission and any OpenAI API charges").addToggle(toggle => toggle.setValue(this.confirmed).setDisabled(this.busy).onChange(value => { this.confirmed = value; this.render(); }));
      new Setting(el)
        .addButton(button => button.setButtonText(this.busy ? "Generating…" : "Generate once with OpenAI").setCta().setDisabled(this.busy || !this.confirmed).onClick(() => void this.generate()))
        .addButton(button => button.setButtonText("Back to selection").setDisabled(this.busy).onClick(() => { this.review = null; this.confirmed = false; this.render(); }));
      el.createEl("p", { text: "No automatic retry. Closing this window cannot recall an already-sent request or its possible charge." });
      return;
    }
    const list = el.createDiv({ cls: "calendar-companion-records" });
    this.records.forEach((record, index) => new Setting(list).setName(record.title || "Untitled").setDesc(`${record.kind}${record.date ? ` · ${record.date}` : ""}`)
      .addToggle(toggle => toggle.setValue(this.selected.has(index)).onChange(value => { if (value) this.selected.add(index); else this.selected.delete(index); })));
    new Setting(el).setName("Your request").addTextArea(input => { input.inputEl.rows = 4; input.inputEl.maxLength = 4000; input.inputEl.setAttribute("aria-label", "Your request to OpenAI"); input.setPlaceholder("What would you like to draft?").setValue(this.prompt).onChange(value => { this.prompt = value; }); });
    el.createEl("p", { text: "Select 1–10 records; maximum 16 KiB of prompt and content. Configure a model and enable OpenAI in settings first." });
    new Setting(el).addButton(button => button.setButtonText("Review request").setDisabled(!this.options).onClick(() => this.prepare()));
  }
  private prepare(): void {
    if (!this.current() || !this.options) return;
    try { this.review = this.ai.session.prepare(this.records.filter((_, index) => this.selected.has(index)), this.prompt, this.options, this.current); this.confirmed = false; this.message = ""; }
    catch (error) { this.message = error instanceof Error ? error.message : "The request could not be prepared."; }
    this.render();
  }
  private async generate(): Promise<void> {
    const review = this.review;
    if (!this.current() || !review || this.busy || !this.confirmed) return;
    this.busy = true; this.message = ""; this.render();
    try { const result = await this.ai.session.generate(review, this.confirmed); if (this.current()) this.result = result; }
    catch (error) { if (this.current()) this.message = error instanceof Error ? error.message : "The request failed. It was not retried."; }
    finally { this.busy = false; this.review = null; this.confirmed = false; if (this.current()) this.render(); }
  }
  private async save(): Promise<void> {
    if (!this.result || !this.current() || this.busy || this.saved) return;
    this.busy = true; this.render();
    try { await saveAiDraft(this.result, this.store, () => { if (!this.current()) throw Error("Vault or preview changed"); }); if (this.current()) { this.saved = true; this.message = "Saved as a new note in Yoofloe Calendar/AI drafts."; } }
    catch { if (this.current()) this.message = "The draft could not be saved. Existing notes were kept."; }
    finally { this.busy = false; if (this.current()) this.render(); }
  }
}
