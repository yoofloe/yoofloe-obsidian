import { App, Modal, Notice, Setting, type ButtonComponent } from "obsidian";
import { AiPreferences, DEFAULT_OPENAI_OPTIONS } from "./ai-preferences";
import { AiSession, type AiDraft, type AiModelOptions, type AiOptions, type AiProvider, type AiReview } from "./ai-session";
import { CUSTOM_MODEL_CHOICE, findAiModel, isAiModelId, isAiProviderEnabled, modelCatalog, providerLabel, PUBLIC_AI_PROVIDERS } from "./ai-models";
import { type RecordSnapshot } from "./protocol";
import { saveAiDraft, type NoteStore } from "./notes";
import { keepModalInputsVisible } from "./modal-inputs";
import { recordLabel } from "./record-types";
import { EFFORT_LABELS, resolveEffort, supportedEfforts, type EffortSetting } from "./effort";

export interface AiContext { session: AiSession; preferences: AiPreferences; current(): boolean }

/** Shared provider/model/key settings. All actions here are local and never validate keys remotely. */
export class AiSettingsModal extends Modal {
  private alive = false;
  private busy = true;
  private message = "";
  private keyMessage = "";
  private configured = false;
  private provider: AiProvider = "openai";
  private options: AiModelOptions = { ...DEFAULT_OPENAI_OPTIONS };
  private modelChoice: string = DEFAULT_OPENAI_OPTIONS.model;
  private customModel = "";
  private readonly keyDrafts = new Map<AiProvider, string>();
  private readonly modelDrafts = new Map<AiProvider, { options: AiModelOptions; modelChoice: string; customModel: string }>();
  private saveModelButton: ButtonComponent | null = null;
  private keyInput: HTMLInputElement | null = null;
  private stopKeyboard: (() => void) | null = null;
  constructor(app: App, private readonly ai: AiContext, private readonly closed: () => void, private readonly manualDrafts = true) { super(app); }
  private current = () => this.alive && this.ai.current();
  onOpen(): void { this.alive = true; this.contentEl.classList.add("calendar-companion"); this.stopKeyboard?.(); this.stopKeyboard = keepModalInputsVisible(this.contentEl, this.current); this.render(); void this.load(); }
  onClose(): void { this.alive = false; this.stopKeyboard?.(); this.stopKeyboard = null; if (this.keyInput) this.keyInput.value = ""; this.keyInput = null; this.keyDrafts.clear(); this.modelDrafts.clear(); this.closed(); }
  private async loadModel(): Promise<void> {
    const draft = this.modelDrafts.get(this.provider);
    this.options = draft ? { ...draft.options } : await this.ai.preferences.read(this.provider);
    this.modelChoice = draft?.modelChoice ?? (findAiModel(this.provider, this.options.model) ? this.options.model : CUSTOM_MODEL_CHOICE);
    this.customModel = draft?.customModel ?? (this.modelChoice === CUSTOM_MODEL_CHOICE ? this.options.model : "");
    this.configured = await this.ai.preferences.hasKey(this.provider);
  }
  private async load(): Promise<void> {
    try { const saved = await this.ai.preferences.readProvider(); this.provider = isAiProviderEnabled(saved) ? saved : "openai"; await this.loadModel(); }
    catch { this.message = "Local AI settings could not be read. Obsidian secret storage is required."; }
    finally { this.busy = false; if (this.current()) this.render(); }
  }
  private async chooseProvider(provider: AiProvider): Promise<void> {
    if (!this.current() || this.busy || !isAiProviderEnabled(provider) || provider === this.provider) return;
    this.keyDrafts.set(this.provider, this.keyInput?.value ?? "");
    this.modelDrafts.set(this.provider, { options: { ...this.options }, modelChoice: this.modelChoice, customModel: this.customModel });
    if (this.keyInput) this.keyInput.value = "";
    this.busy = true; this.ai.session.enableForSession(false); this.provider = provider;
    this.configured = false; this.message = ""; this.keyMessage = ""; this.options = { model: modelCatalog(provider).defaultModel }; this.modelChoice = this.options.model; this.customModel = ""; this.render();
    try { await this.ai.preferences.selectProvider(provider); if (!this.current()) return; await this.loadModel(); }
    catch { this.message = "Provider settings could not be read or saved locally. No API request was sent."; }
    finally { this.busy = false; if (this.current()) this.render(); }
  }
  private async change(action: () => Promise<void>, clearKeyOnSuccess = false): Promise<void> {
    if (!this.current() || this.busy) return;
    this.busy = true; this.ai.session.enableForSession(false);
    this.keyDrafts.set(this.provider, this.keyInput?.value ?? ""); this.render();
    try {
      await action(); if (!this.current()) return;
      if (clearKeyOnSuccess) this.keyDrafts.delete(this.provider);
      this.configured = await this.ai.preferences.hasKey(this.provider);
      this.message = "Saved locally. No API request was sent. Your key is used only when you start an AI task.";
      if (clearKeyOnSuccess) {
        this.keyMessage = this.configured ? "Key saved on this device. API access is checked only when you generate." : "Saved key removed from this device.";
        new Notice(this.configured ? `${providerLabel(this.provider)} key saved locally` : "Saved key removed");
      }
    } catch { if (this.current()) this.message = "Could not save locally. Check the model, provider key format and secret storage. No API request was sent."; }
    finally { this.busy = false; if (this.current()) this.render(); }
  }
  private updateModelSave(): void { this.saveModelButton?.setDisabled(this.busy || !isAiModelId(this.provider, this.options.model)); }
  private modelDetails(el: HTMLElement): void {
    el.empty(); const preset = findAiModel(this.provider, this.options.model), example = modelCatalog(this.provider).defaultModel;
    if (this.modelChoice === CUSTOM_MODEL_CHOICE) {
      const hint = el.createEl("p", { text: `Example: ${example}. Enter an API model ID, not a chat display name or an API key.`, cls: "calendar-companion-hint" });
      new Setting(el).setName("Custom model ID").addText(input => {
        input.inputEl.maxLength = 128; input.inputEl.setAttribute("aria-label", `Custom ${providerLabel(this.provider)} model ID`);
        input.setPlaceholder(`e.g. ${example}`).setValue(this.customModel).setDisabled(this.busy).onChange(value => {
          this.customModel = value; this.options.model = value.trim();
          hint.textContent = value.trim() && !isAiModelId(this.provider, value.trim())
            ? `Use an exact API model ID without spaces. Example: ${example}.`
            : `Example: ${example}. Enter an API model ID, not a chat display name or an API key.`;
          this.updateModelSave();
        });
      });
    } else if (preset) {
      el.createEl("p", { text: preset.description, cls: "calendar-companion-hint" });
      el.createEl("p", { text: `Model ID: ${preset.id}`, cls: "calendar-companion-hint" });
    }
    if (this.provider === "openai") new Setting(el).setName("Thinking depth").setDesc("Higher depth may improve difficult reasoning and cost more. This does not change file permissions or output length.").addDropdown(dropdown => {
      dropdown.addOption("default", EFFORT_LABELS.default);
      for (const effort of supportedEfforts(this.options.model)) dropdown.addOption(effort, EFFORT_LABELS[effort]);
      dropdown.setValue(this.options.effort ?? resolveEffort(this.options.model) ?? "default").setDisabled(this.busy);
      dropdown.selectEl.setAttribute("aria-label", "Thinking depth");
      dropdown.onChange(value => { this.options.effort = value as EffortSetting; });
    });
    this.updateModelSave();
  }
  private render(): void {
    if (!this.current()) return;
    if (this.keyInput) this.keyInput.value = "";
    const el = this.contentEl, name = providerLabel(this.provider), catalog = modelCatalog(this.provider);
    el.empty(); el.createEl("h2", { text: "Yoofloe AI settings" });
    el.createEl("p", { text: "Use your own OpenAI key. Starting a task sends permitted note text, your prompt and context directly to OpenAI. Relevant excerpts may be read and sent during the task. API charges apply; one task may make multiple requests." });
    if (PUBLIC_AI_PROVIDERS.length > 1) new Setting(el).setName("AI provider").setDesc("Your key is stored separately for each provider. Switching providers turns AI off.").addDropdown(dropdown => {
      for (const provider of PUBLIC_AI_PROVIDERS) dropdown.addOption(provider, providerLabel(provider));
      dropdown.setValue(this.provider).setDisabled(this.busy);
      dropdown.selectEl.setAttribute("aria-label", "AI provider");
      dropdown.onChange(value => { if (isAiProviderEnabled(value)) void this.chooseProvider(value); });
    });
    el.createEl("p", { text: "Settings and local key storage make no API calls. Yoofloe AI sends nothing until you start a task. Local storage does not make AI local. Requests use store: false; this does not mean zero retention at OpenAI." });
    if (this.message) el.createEl("p", { text: this.message, cls: "calendar-companion-status", attr: { role: "status" } });
    const modelSetting = new Setting(el).setName("Model").setDesc("Not sure? Start with economy (recommended). Selecting a model sends no API request.");
    const details = el.createDiv({ cls: "calendar-companion-model-details" });
    modelSetting.addDropdown(dropdown => {
      for (const model of catalog.models) dropdown.addOption(model.id, model.label);
      dropdown.addOption(CUSTOM_MODEL_CHOICE, "Custom · enter a model ID").setValue(this.modelChoice).setDisabled(this.busy);
      dropdown.selectEl.setAttribute("aria-label", `${name} model`);
      dropdown.onChange(value => {
        if (value !== CUSTOM_MODEL_CHOICE && !findAiModel(this.provider, value)) return;
        this.modelChoice = value; this.options.model = value === CUSTOM_MODEL_CHOICE ? this.customModel.trim() : value; delete this.options.effort; this.modelDetails(details);
      });
    });
    this.modelDetails(details);
    const links = el.createEl("p", { cls: "calendar-companion-hint" });
    links.appendText(`Choices checked ${catalog.checked}. Access depends on your ${name} account. `);
    links.createEl("a", { text: "Models", href: catalog.url, attr: { target: "_blank", rel: "noopener noreferrer" } }); links.appendText(" · ");
    links.createEl("a", { text: "Pricing", href: catalog.pricing, attr: { target: "_blank", rel: "noopener noreferrer" } });
    el.createEl("p", { text: `Response length: model default. No plugin output-token cap is sent. ${name}'s own limits still apply; longer responses and thinking tokens can cost more.`, cls: "calendar-companion-hint" });
    new Setting(el).addButton(button => { this.saveModelButton = button; button.setButtonText("Save model settings").onClick(() => void this.change(() => this.ai.preferences.save({ ...this.options }, this.provider))); }); this.updateModelSave();
    new Setting(el).setName(this.configured ? "API key saved locally" : "No API key saved").setDesc(`${name} only. Stored through Obsidian secret storage, outside this plugin's vault files. Other trusted plugins share Obsidian's trust boundary.`)
      .addText(input => { this.keyInput = input.inputEl; input.inputEl.type = "password"; input.inputEl.autocomplete = "off"; input.inputEl.setAttribute("aria-label", `${name} API key`); input.setPlaceholder("Your own API key").setValue(this.keyDrafts.get(this.provider) ?? "").setDisabled(this.busy); });
    if (this.keyMessage || this.configured) el.createEl("p", { text: this.keyMessage || "A key is stored on this device. API access is checked only when you generate.", cls: "calendar-companion-status", attr: { role: "status", "aria-live": "polite" } });
    new Setting(el)
      .addButton(button => button.setButtonText("Save key locally").setDisabled(this.busy).onClick(() => { const value = this.keyInput?.value ?? ""; void this.change(() => this.ai.preferences.saveKey(value, this.provider), true); }))
      .addButton(button => button.setButtonText("Remove saved key").setDisabled(this.busy || !this.configured).onClick(() => void this.change(() => this.ai.preferences.clearKey(this.provider), true)));
    if (this.manualDrafts) new Setting(el).setName(`Enable ${name} for this session`).setDesc("For advanced manual-import drafts only. The Yoofloe AI workspace starts with its send button. Disabling cannot recall an already-sent request.")
      .addToggle(toggle => toggle.setValue(this.ai.session.enabled).setDisabled(this.busy || !this.configured).onChange(value => this.ai.session.enableForSession(value)));
  }
}
export { AiSettingsModal as OpenAiSettingsModal };

/** A draft is prepared, explicitly approved, then sent once; all source records remain unchanged. */
export class AiDraftModal extends Modal {
  private alive = false;
  private busy = false;
  private options: AiOptions | null = null;
  private message = "";
  private selected = new Set<number>();
  private prompt = "";
  private review: AiReview | null = null;
  private confirmed = false;
  private result: AiDraft | null = null;
  private saved = false;
  private resultProvider: AiProvider = "openai";
  private stopKeyboard: (() => void) | null = null;
  constructor(app: App, private readonly ai: AiContext, private readonly records: readonly RecordSnapshot[], private readonly store: NoteStore,
    private readonly sourceCurrent: () => boolean, private readonly closed: () => void) { super(app); }
  private current = () => this.alive && this.ai.current() && this.sourceCurrent();
  onOpen(): void { this.alive = true; this.contentEl.classList.add("calendar-companion"); this.stopKeyboard?.(); this.stopKeyboard = keepModalInputsVisible(this.contentEl, this.current); this.render(); void this.load(); }
  onClose(): void { this.alive = false; this.stopKeyboard?.(); this.stopKeyboard = null; this.review = null; this.closed(); }
  private async load(): Promise<void> {
    try { const saved = await this.ai.preferences.readProvider(); const provider = isAiProviderEnabled(saved) ? saved : "openai"; const options = await this.ai.preferences.read(provider); if (this.current()) this.options = { ...options, provider }; }
    catch { this.message = "AI settings could not be read. Reopen AI settings first."; }
    if (this.current()) this.render();
  }
  private render(): void {
    if (!this.current()) return;
    const el = this.contentEl, name = providerLabel(this.options?.provider ?? "openai"); el.empty(); el.createEl("h2", { text: `Optional ${name} draft` });
    el.createEl("p", { text: "Choose only the records to send. Generation may incur API charges with your selected provider. Saving an imported Calendar note does not require this feature." });
    if (this.message) el.createEl("p", { text: this.message, cls: "calendar-companion-status", attr: { role: "status" } });
    if (this.result) {
      el.createEl("p", { text: this.result.incomplete ? `${providerLabel(this.resultProvider)} returned a partial draft. You can review and save it. No automatic retry was made.` : "Review this AI-generated draft before saving." });
      if (this.result.inputTokens !== null && this.result.outputTokens !== null) el.createEl("p", { text: `Reported usage: ${this.result.inputTokens} input and ${this.result.outputTokens} output tokens.` });
      if (this.result.thinkingTokens !== undefined && this.result.thinkingTokens !== null) el.createEl("p", { text: `Additional reported thinking tokens: ${this.result.thinkingTokens}. These may also incur API charges.` });
      el.createEl("pre", { text: this.result.text });
      new Setting(el).addButton(button => button.setButtonText(this.saved ? "Draft saved" : "Save draft as new note").setDisabled(this.busy || this.saved).onClick(() => void this.save()));
      return;
    }
    if (this.review) {
      const review = this.review;
      el.createEl("p", { text: `Destination: ${providerLabel(review.provider)} API. Model: ${review.model}. Output: model default, with no plugin token cap. ${review.recordCount} selected record(s).` });
      el.createEl("p", { text: "Review the prompt and selected record content below, including any related-record references. The vault name is not included." });
      el.createEl("pre", { text: JSON.stringify(JSON.parse(review.input), null, 2), cls: "calendar-companion-request" });
      new Setting(el).setName(`I approve this transmission and any ${providerLabel(review.provider)} API charges`).addToggle(toggle => toggle.setValue(this.confirmed).setDisabled(this.busy).onChange(value => { this.confirmed = value; this.render(); }));
      new Setting(el)
        .addButton(button => button.setButtonText(this.busy ? "Generating…" : `Generate once with ${providerLabel(review.provider)}`).setCta().setDisabled(this.busy || !this.confirmed).onClick(() => void this.generate()))
        .addButton(button => button.setButtonText("Back to selection").setDisabled(this.busy).onClick(() => { this.review = null; this.confirmed = false; this.render(); }));
      el.createEl("p", { text: "No automatic retry. Closing this window cannot recall an already-sent request or its possible charge." });
      return;
    }
    const list = el.createDiv({ cls: "calendar-companion-records" });
    this.records.forEach((record, index) => { new Setting(list).setName(record.title || "Untitled").setDesc(`${recordLabel(record.kind)}${record.date ? ` · ${record.date}` : ""}`)
      .addToggle(toggle => toggle.setValue(this.selected.has(index)).onChange(value => { if (value) this.selected.add(index); else this.selected.delete(index); })); });
    new Setting(el).setName("Your request").addTextArea(input => { input.inputEl.rows = 4; input.inputEl.maxLength = 4000; input.inputEl.setAttribute("aria-label", `Your request to ${name}`); input.setPlaceholder("What would you like to draft?").setValue(this.prompt).onChange(value => { this.prompt = value; }); });
    el.createEl("p", { text: "Select up to 50 records across workspaces, with at most 1 MiB of prompt and content. Larger selections can increase API charges. Configure a provider and model, then enable AI in settings first." });
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
    try { const result = await this.ai.session.generate(review, this.confirmed); if (this.current()) { this.result = result; this.resultProvider = review.provider; } }
    catch (error) { if (this.current()) this.message = error instanceof Error ? error.message : "The request failed. It was not retried."; }
    finally { this.busy = false; this.review = null; this.confirmed = false; if (this.current()) this.render(); }
  }
  private async save(): Promise<void> {
    if (!this.result || !this.current() || this.busy || this.saved) return;
    this.busy = true; this.render();
    try { await saveAiDraft(this.result, this.store, () => { if (!this.current()) throw Error("Vault or preview changed"); }, this.resultProvider); if (this.current()) { this.saved = true; this.message = "Saved as a new note in Yoofloe Calendar/AI drafts."; } }
    catch { if (this.current()) this.message = "The draft could not be saved. Existing notes were kept."; }
    finally { this.busy = false; if (this.current()) this.render(); }
  }
}

export { AiDraftModal as OpenAiDraftModal };
