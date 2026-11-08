import { App, Modal, Setting, type ButtonComponent } from "obsidian";
import { AiPreferences, DEFAULT_OPENAI_OPTIONS } from "./ai-preferences";
import { OpenAiSession, isOpenAiModelId, validateOpenAiOptions, type OpenAiDraft, type OpenAiOptions, type OpenAiReview } from "./openai";
import { CUSTOM_MODEL_CHOICE, DEFAULT_OPENAI_MODEL, findOpenAiModel, MODEL_CATALOG_CHECKED, MODEL_CATALOG_URL, MODEL_PRICING_URL, OPENAI_MODELS } from "./openai-models";
import { type RecordSnapshot } from "./protocol";
import { saveAiDraft, type NoteStore } from "./notes";
import { keepModalInputsVisible } from "./modal-inputs";

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
  private modelChoice: string = DEFAULT_OPENAI_MODEL;
  private customModel = "";
  private saveModelButton: ButtonComponent | null = null;
  private keyInput: HTMLInputElement | null = null;
  private stopKeyboard: (() => void) | null = null;
  constructor(app: App, private readonly ai: AiContext, private readonly closed: () => void) { super(app); }
  onOpen(): void { this.alive = true; this.contentEl.classList.add("calendar-companion"); this.stopKeyboard?.(); this.stopKeyboard = keepModalInputsVisible(this.contentEl, this.current); this.render(); void this.load(); }
  onClose(): void { this.alive = false; this.stopKeyboard?.(); this.stopKeyboard = null; if (this.keyInput) this.keyInput.value = ""; this.keyInput = null; this.closed(); }
  private current = () => this.alive && this.ai.current();
  private async load(): Promise<void> {
    try {
      this.options = await this.ai.preferences.read();
      this.modelChoice = findOpenAiModel(this.options.model) ? this.options.model : CUSTOM_MODEL_CHOICE;
      this.customModel = this.modelChoice === CUSTOM_MODEL_CHOICE ? this.options.model : "";
      this.configured = await this.ai.preferences.hasKey();
    }
    catch { this.message = "Local OpenAI settings could not be read. Obsidian secret storage is required."; }
    finally { this.busy = false; if (this.current()) this.render(); }
  }
  private async change(action: () => Promise<void>, clearKeyOnSuccess = false): Promise<void> {
    if (!this.current() || this.busy) return;
    this.busy = true; this.ai.session.enableForSession(false);
    let keyDraft = this.keyInput?.value ?? "";
    this.render(keyDraft);
    try { await action(); if (!this.current()) return; if (clearKeyOnSuccess) keyDraft = ""; this.configured = await this.ai.preferences.hasKey(); this.message = "Saved locally. No API request was sent. Enable OpenAI only when you want to use it."; }
    catch { if (this.current()) this.message = "Could not save locally. Check the model and secret storage. No API request was sent."; }
    finally { this.busy = false; if (this.current()) this.render(keyDraft); }
  }
  private updateModelSave(): void {
    let valid = true; try { validateOpenAiOptions(this.options); } catch { valid = false; }
    this.saveModelButton?.setDisabled(this.busy || !valid);
  }
  private modelDetails(el: HTMLElement): void {
    el.empty();
    const preset = findOpenAiModel(this.options.model);
    if (this.modelChoice === CUSTOM_MODEL_CHOICE) {
      const hint = el.createEl("p", { text: "Example: gpt-6-luna. Enter an API model ID, not a ChatGPT display name or an API key.", cls: "calendar-companion-hint" });
      new Setting(el).setName("Custom model ID").addText(input => {
        input.inputEl.maxLength = 128; input.inputEl.setAttribute("aria-label", "Custom OpenAI model ID");
        input.setPlaceholder("e.g. gpt-6-luna").setValue(this.customModel).setDisabled(this.busy).onChange(value => {
          this.customModel = value; this.options.model = value.trim();
          hint.textContent = value.trim() && !isOpenAiModelId(value.trim())
            ? "Use an exact API model ID without spaces. Example: gpt-6-luna."
            : "Example: gpt-6-luna. Enter an API model ID, not a ChatGPT display name or an API key.";
          this.updateModelSave();
        });
      });
    } else if (preset) {
      el.createEl("p", { text: preset.description, cls: "calendar-companion-hint" });
      el.createEl("p", { text: `Model ID: ${preset.id}`, cls: "calendar-companion-hint" });
    }
    this.updateModelSave();
  }
  private render(keyDraft = ""): void {
    if (!this.current()) return;
    if (this.keyInput) this.keyInput.value = "";
    const el = this.contentEl; el.empty(); el.createEl("h2", { text: "OpenAI (optional)" });
    el.createEl("p", { text: "Calendar import is free and works with OpenAI off. Generation sends only your selected records and prompt to OpenAI and may incur API charges on your OpenAI account." });
    el.createEl("p", { text: "OpenAI starts off after each plugin load. Settings, key storage and the enable switch make no API calls. There are no automatic requests, key checks or retries." });
    if (this.message) el.createEl("p", { text: this.message, cls: "calendar-companion-status", attr: { role: "status" } });
    const modelSetting = new Setting(el).setName("Model").setDesc("Not sure? Start with Economy (recommended). Selecting a model sends no API request.");
    const details = el.createDiv({ cls: "calendar-companion-model-details" });
    modelSetting.addDropdown(dropdown => {
      for (const model of OPENAI_MODELS) dropdown.addOption(model.id, model.label);
      dropdown.addOption(CUSTOM_MODEL_CHOICE, "Custom · Enter a model ID").setValue(this.modelChoice).setDisabled(this.busy);
      dropdown.selectEl.setAttribute("aria-label", "OpenAI model");
      dropdown.onChange(value => {
        if (value !== CUSTOM_MODEL_CHOICE && !findOpenAiModel(value)) return;
        this.modelChoice = value; this.options.model = value === CUSTOM_MODEL_CHOICE ? this.customModel.trim() : value;
        this.modelDetails(details);
      });
    });
    this.modelDetails(details);
    const catalog = el.createEl("p", { cls: "calendar-companion-hint" });
    catalog.appendText(`Choices checked ${MODEL_CATALOG_CHECKED}. Access depends on your OpenAI account. `);
    catalog.createEl("a", { text: "Models", href: MODEL_CATALOG_URL, attr: { target: "_blank", rel: "noopener noreferrer" } });
    catalog.appendText(" · ");
    catalog.createEl("a", { text: "Pricing", href: MODEL_PRICING_URL, attr: { target: "_blank", rel: "noopener noreferrer" } });
    el.createEl("p", { text: "Response length: model default. No plugin output-token cap is sent. OpenAI's own limits still apply; longer responses can cost more.", cls: "calendar-companion-hint" });
    new Setting(el).addButton(button => { this.saveModelButton = button; button.setButtonText("Save model settings").onClick(() => void this.change(() => this.ai.preferences.save({ ...this.options }))); });
    this.updateModelSave();
    new Setting(el).setName(this.configured ? "API key saved locally" : "No API key saved").setDesc("Stored through Obsidian secret storage, outside this plugin's vault files. Other trusted plugins share Obsidian's trust boundary.")
      .addText(input => { this.keyInput = input.inputEl; input.inputEl.type = "password"; input.inputEl.autocomplete = "off"; input.inputEl.setAttribute("aria-label", "OpenAI API key"); input.setPlaceholder("Your own API key").setValue(keyDraft).setDisabled(this.busy); });
    new Setting(el)
      .addButton(button => button.setButtonText("Save key locally").setDisabled(this.busy).onClick(() => { const value = this.keyInput?.value ?? ""; void this.change(() => this.ai.preferences.saveKey(value), true); }))
      .addButton(button => button.setButtonText("Remove saved key").setDisabled(this.busy || !this.configured).onClick(() => void this.change(() => this.ai.preferences.clearKey(), true)));
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
  private stopKeyboard: (() => void) | null = null;
  constructor(app: App, private readonly ai: AiContext, private readonly records: readonly RecordSnapshot[], private readonly store: NoteStore,
    private readonly sourceCurrent: () => boolean, private readonly closed: () => void) { super(app); }
  private current = () => this.alive && this.ai.current() && this.sourceCurrent();
  onOpen(): void { this.alive = true; this.contentEl.classList.add("calendar-companion"); this.stopKeyboard?.(); this.stopKeyboard = keepModalInputsVisible(this.contentEl, this.current); this.render(); void this.load(); }
  onClose(): void { this.alive = false; this.stopKeyboard?.(); this.stopKeyboard = null; this.review = null; this.closed(); }
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
      el.createEl("p", { text: this.result.incomplete ? "OpenAI returned a partial draft. You can review and save it. No automatic retry was made." : "Review this AI-generated draft before saving." });
      if (this.result.inputTokens !== null && this.result.outputTokens !== null) el.createEl("p", { text: `Reported usage: ${this.result.inputTokens} input and ${this.result.outputTokens} output tokens.` });
      el.createEl("pre", { text: this.result.text });
      new Setting(el).addButton(button => button.setButtonText(this.saved ? "Draft saved" : "Save draft as new note").setDisabled(this.busy || this.saved).onClick(() => void this.save()));
      return;
    }
    if (this.review) {
      el.createEl("p", { text: `Destination: OpenAI. Model: ${this.review.model}. Output: model default, with no plugin token cap. ${this.review.recordCount} selected record(s).` });
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
