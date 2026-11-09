import { App, Modal, Platform, Setting, type ButtonComponent } from "obsidian";
import { INBOX, type DeliveryV3 } from "./protocol";
import { CalendarSession, type TransferStore } from "./session";
import { AREA_LABELS, PERIOD_LABELS, QUERY_AREAS, planQuestion, resolvePeriod, type QueryArea, type QueryPeriod, type QuestionQuery } from "./question-query";
import { buildQuestionInput, inputDigest } from "./question-input";
import { type AiContext } from "./ai-modals";
import type { AiDraft } from "./ai-session";
import { saveAiDraft, type NoteStore } from "./notes";
import { recordLabel } from "./record-types";
import { keepModalInputsVisible } from "./modal-inputs";

/** Question-first local retrieval. No records, keys or networks are read while opening the modal. */
export class QuestionModal extends Modal {
  private alive = false;
  private busy = false;
  private message = "";
  private question = "";
  private area: QueryArea | "auto" = "auto";
  private period: QueryPeriod | "auto" = "auto";
  private topic: string | null = null;
  private query: QuestionQuery | null = null;
  private session: CalendarSession | null = null;
  private delivery: DeliveryV3 | null = null;
  private outbound: { input: string; digest: string; model: string; configured: boolean } | null = null;
  private draft: AiDraft | null = null;
  private used = false;
  private saved = false;
  private generation = 0;
  private stopKeyboard: (() => void) | null = null;
  private owner = this.app.vault;
  constructor(app: App, private readonly options: {
    live(): boolean; closed(): void; ai(): AiContext; openAiSettings(): void; manualImport(): void; notes: NoteStore; requirements: string;
  }) { super(app); }
  private current = () => this.alive && this.options.live() && this.app.vault === this.owner;
  get requestId() { return this.session?.requestId ?? null; }
  onOpen(): void {
    this.alive = true; this.contentEl.classList.add("calendar-companion", "calendar-question");
    this.stopKeyboard?.(); this.stopKeyboard = keepModalInputsVisible(this.contentEl, this.current);
    if (Platform.isAndroidApp && !this.session) {
      const adapter = this.owner.adapter;
      const store: TransferStore = { exists: path => adapter.exists(path), mkdir: path => adapter.mkdir(path), write: (path, text) => adapter.write(path, text),
        read: path => adapter.read(path), size: async path => { const value = await adapter.stat(path); return value?.type === "file" ? value.size : null; }, remove: path => adapter.remove(path) };
      this.session = new CalendarSession({ store, vaultName: () => this.app.vault.getName(), allowed: () => this.current() && Platform.isAndroidApp });
    }
    this.render();
  }
  onClose(): void {
    this.alive = false; this.generation++; this.stopKeyboard?.(); this.stopKeyboard = null;
    if (this.used) this.options.ai().session.enableForSession(false);
    void this.session?.dispose(); this.session = null; this.outbound = null; this.delivery = null; this.options.closed();
  }
  private planned(): QuestionQuery | null {
    return planQuestion(this.question, { ...(this.area !== "auto" ? { areas: [this.area] } : {}), ...(this.period !== "auto" ? { period: this.period } : {}),
      ...(this.topic !== null ? { terms: [...new Set(this.topic.split(",").map(term => term.trim().normalize("NFC").toLowerCase()).filter(Boolean))] } : {}) }).query;
  }
  private renderScope(el: HTMLElement, button: ButtonComponent): void {
    el.empty();
    try {
      const query = this.planned();
      if (!query) { el.createEl("p", { text: "Choose a workspace below, or name it in your question.", cls: "calendar-companion-hint" }); button.setDisabled(true); return; }
      const dates = resolvePeriod(query, Date.now());
      el.createEl("p", { text: `${query.areas.map(area => AREA_LABELS[area]).join(" + ")} · ${PERIOD_LABELS[query.period]}${dates.from ? ` · ${dates.from} – ${dates.through}` : ""}`, cls: "calendar-query-scope" });
      el.createEl("p", { text: `Only matching records and linked notes. Up to ${query.maxRecords} short excerpts; unrelated workspaces stay on your device.`, cls: "calendar-companion-hint" });
      if (query.terms.length) el.createEl("p", { text: `Topic: ${query.terms.join(", ")}. Adjust search if this is not the topic you meant.`, cls: "calendar-companion-hint" });
      button.setDisabled(this.busy);
    } catch (error) { el.createEl("p", { text: error instanceof Error ? error.message : "Enter a question.", cls: "calendar-companion-hint" }); button.setDisabled(true); }
  }
  private render(): void {
    if (!this.current()) return;
    const el = this.contentEl; el.empty(); el.createEl("h2", { text: "Ask Calendar" });
    if (!Platform.isAndroidApp) { el.createEl("p", { text: this.options.requirements }); el.createEl("p", { text: "Your imported notes remain ordinary Markdown on this device." }); return; }
    el.createEl("p", { text: `${this.owner.getName()} · local connection`, cls: "calendar-companion-hint" });
    if (this.message) el.createEl("p", { text: this.message, cls: "calendar-companion-status", attr: { role: "status" } });
    const pending = Boolean(this.session?.requestId);
    let scope: HTMLElement | null = null, find: ButtonComponent | null = null;
    const questionField = el.createDiv({ cls: "calendar-question-field" });
    new Setting(questionField).setName("Your question").addTextArea(input => {
      input.inputEl.rows = 3; input.inputEl.maxLength = 4000; input.inputEl.setAttribute("aria-label", "Your Calendar question");
      input.setPlaceholder("Summarize my study and focus time this week").setValue(this.question).setDisabled(this.busy || pending).onChange(value => { this.question = value; if (scope && find) this.renderScope(scope, find); });
    });
    if (!pending) {
      scope = el.createDiv();
      const advanced = el.createEl("details", { cls: "calendar-query-options" }); advanced.createEl("summary", { text: "Adjust search" });
      new Setting(advanced).setName("Workspace").addDropdown(control => {
        control.addOption("auto", "From my question"); for (const area of QUERY_AREAS) control.addOption(area, AREA_LABELS[area]);
        control.setValue(this.area).setDisabled(this.busy).onChange(value => { this.area = value as QueryArea | "auto"; if (scope && find) this.renderScope(scope, find); });
      });
      new Setting(advanced).setName("Period").addDropdown(control => {
        control.addOption("auto", "From my question");
        for (const period of ["today", "tomorrow", "this_week", "last_week", "last_7_days", "next_7_days", "last_30_days"] as const) control.addOption(period, PERIOD_LABELS[period]);
        control.setValue(this.period).setDisabled(this.busy).onChange(value => { this.period = value as QueryPeriod | "auto"; if (scope && find) this.renderScope(scope, find); });
      });
      new Setting(advanced).setName("Topic words (optional)").setDesc("Leave automatic, or enter up to 8 topic words separated by commas. Clear the field to search the chosen workspace and dates without a topic filter.").addText(input => {
        input.setPlaceholder("Automatic from question").setValue(this.topic ?? "").setDisabled(this.busy).onChange(value => { this.topic = value; if (scope && find) this.renderScope(scope, find); });
      });
      new Setting(advanced).addButton(button => button.setButtonText("Use automatic topic").setDisabled(this.busy).onClick(() => { this.topic = null; this.render(); }));
      new Setting(el).addButton(button => { find = button; button.setButtonText("Find relevant records").setCta().setDisabled(true).onClick(() => void this.start()); });
      this.renderScope(scope, find!);
      el.createEl("p", { text: "Search happens on your phone. Calendar remembers the approved inbox; first connection may need one folder choice. No API call is made by this search.", cls: "calendar-companion-hint" });
      new Setting(el).setName("Advanced").addButton(button => button.setButtonText("Import complete records manually").setDisabled(this.busy).onClick(() => { this.close(); this.options.manualImport(); }));
      return;
    }
    if (!this.delivery) {
      el.createEl("p", { text: "Continue in Yoofloe Calendar. Confirm the local search, then approve the relevant excerpts to return here. The first connection may require choosing this vault’s inbox." });
      new Setting(el).addButton(button => button.setButtonText("Check reply").setDisabled(this.busy).onClick(() => void this.receive(this.requestId ?? "")));
    } else {
      const delivery = this.delivery, context = delivery.context;
      el.createEl("p", { text: `${delivery.records.length} relevant excerpt(s) · ${context.from ? `${context.from} – ${context.through}` : "Matching topic"}`, cls: "calendar-query-scope" });
      el.createEl("p", { text: context.partial ? "Partial results. Totals cover only observed matches; narrow the question for a fuller answer." : "Results are a bounded snapshot of the requested workspaces and dates.", cls: "calendar-companion-hint" });
      if (!delivery.records.length) el.createEl("p", { text: "No matching records. Change the dates, topic or workspace. Nothing was sent to OpenAI." });
      if (delivery.records.length) {
        const sources = el.createEl("details"); sources.createEl("summary", { text: `Sources · ${delivery.records.length}` });
        delivery.records.forEach((record, i) => { const row = sources.createEl("section"); row.createEl("h3", { text: `C${i + 1} · ${record.title || "Untitled"}` }); row.createEl("p", { text: recordLabel(record.kind), cls: "calendar-companion-hint" }); row.createEl("pre", { text: record.text }); });
        const outbound = this.outbound;
        if (outbound) {
          const review = el.createEl("details"); review.createEl("summary", { text: "Exact input sent to OpenAI" }); review.createEl("pre", { text: outbound.input }); review.createEl("p", { text: `SHA-256 ${outbound.digest}`, cls: "calendar-companion-hint" });
          el.createEl("p", { text: `${outbound.model} · ${new TextEncoder().encode(outbound.input).length.toLocaleString()} input bytes · ${outbound.configured ? "key saved locally" : "save your own key in AI settings"}`, cls: "calendar-companion-hint" });
          if (!this.used) {
            el.createEl("p", { text: "Generate sends this input once to OpenAI using your key. By choosing generate, you approve this transmission and any OpenAI API charges.", cls: "calendar-companion-hint" });
            new Setting(el).addButton(button => button.setButtonText("AI settings").setDisabled(this.busy).onClick(() => this.options.openAiSettings()))
              .addButton(button => button.setButtonText("Refresh model and key status").setDisabled(this.busy).onClick(() => void this.prepareOutbound()));
            new Setting(el).addButton(button => button.setButtonText("Generate once with OpenAI").setCta().setDisabled(this.busy || !outbound.configured).onClick(() => void this.generate()));
          }
        }
      }
      if (this.draft) {
        const result = el.createEl("section"); result.createEl("h3", { text: "Draft" }); result.createEl("pre", { text: this.draft.text });
        if (this.draft.inputTokens !== null && this.draft.outputTokens !== null) result.createEl("p", { text: `OpenAI usage: ${this.draft.inputTokens} input · ${this.draft.outputTokens} output tokens`, cls: "calendar-companion-hint" });
        if (this.draft.incomplete) result.createEl("p", { text: "The provider returned a partial draft. No retry was made." });
        new Setting(el).addButton(button => button.setButtonText(this.saved ? "Draft saved" : "Save draft as new note").setDisabled(this.busy || this.saved).onClick(() => void this.save()));
      }
    }
    new Setting(el).addButton(button => button.setButtonText("Change question").setDisabled(this.busy).onClick(() => void this.reset()));
  }
  private async start(): Promise<void> {
    if (this.busy || !this.current() || !this.session) return;
    try { this.query = this.planned(); } catch { this.query = null; }
    if (!this.query) return;
    this.busy = true; this.message = ""; this.render();
    try {
      const vaultId = await this.options.ai().preferences.vaultId(); if (!this.current()) return;
      const url = await this.session.start({ vaultId, query: this.query, inboxHint: this.owner.adapter.getResourcePath(INBOX) });
      if (!this.current()) return; this.contentEl.ownerDocument.defaultView?.open(url, "_blank");
    } catch { this.message = "Calendar could not be opened. Update Calendar and use a vault in shared device storage, then retry."; }
    finally { this.busy = false; this.render(); }
  }
  async receive(id: string): Promise<void> {
    if (!this.current() || this.busy || !this.session || this.delivery) return;
    this.busy = true;
    try { const result = await this.session.receive(id); if (result.version !== 3) throw Error("Unsupported reply"); this.delivery = result; this.message = "Local search complete. Nothing has been sent to OpenAI."; await this.prepareOutbound(); }
    catch { this.message = "A current reply could not be verified. Update Calendar, check the Inbox, or change the question to start again."; }
    finally { this.busy = false; this.render(); }
  }
  private async prepareOutbound(): Promise<void> {
    const delivery = this.delivery, token = ++this.generation; this.outbound = null;
    if (!delivery?.records.length) return;
    const wasBusy = this.busy; this.busy = true; this.render();
    try {
      const ai = this.options.ai(), options = await ai.preferences.read("openai"), configured = await ai.preferences.hasKey("openai");
      const input = buildQuestionInput(delivery, this.question), digest = await inputDigest(input);
      if (!this.current() || token !== this.generation || this.delivery !== delivery || this.used) return;
      this.session?.assertCanSave(delivery); this.outbound = Object.freeze({ input, digest, model: options.model, configured });
    } catch { this.message = "Local results are ready. Reopen AI settings or start a fresh question before generating."; }
    finally { if (token === this.generation) this.busy = wasBusy; this.render(); }
  }
  private async generate(): Promise<void> {
    const delivery = this.delivery, outbound = this.outbound, session = this.session;
    if (!this.current() || this.busy || this.used || !delivery || !outbound?.configured || !session) return;
    this.busy = true; this.render(); const ai = this.options.ai();
    const sourceCurrent = () => { try { if (!this.current() || this.delivery !== delivery || this.outbound !== outbound) return false; session.assertCanSave(delivery); return true; } catch { return false; } };
    try {
      if ((await ai.preferences.read("openai")).model !== outbound.model) throw Error("The model changed. Refresh model and key status before generating.");
      ai.session.enableForSession(true);
      const review = await ai.session.prepareQuestion(delivery, this.question, { model: outbound.model }, sourceCurrent);
      if (review.input !== outbound.input || review.digest !== outbound.digest || !sourceCurrent()) throw Error("The approved input changed. Start a new question.");
      this.used = true; this.draft = await ai.session.generate(review, true); this.message = "Draft ready. Review it before saving.";
    } catch (error) { this.message = error instanceof Error ? error.message : "Generation failed. It was not retried."; }
    finally { ai.session.enableForSession(false); this.busy = false; this.render(); }
  }
  private async save(): Promise<void> {
    if (!this.draft || this.busy || this.saved || !this.current()) return; this.busy = true;
    try { await saveAiDraft(this.draft, this.options.notes, () => { if (!this.current()) throw Error("Vault changed"); }, "openai", this.delivery ? { question: this.question, delivery: this.delivery } : undefined); this.saved = true; this.message = "Saved a new draft note. Your Calendar records are unchanged."; }
    catch { this.message = "The draft could not be saved. Existing notes were kept."; }
    finally { this.busy = false; this.render(); }
  }
  private async reset(): Promise<void> {
    if (this.busy) return; this.busy = true; this.generation++; this.options.ai().session.enableForSession(false); this.outbound = null; this.render();
    try { await this.session?.cancel(); this.delivery = null; this.draft = null; this.used = false; this.saved = false; this.message = ""; }
    finally { this.busy = false; this.render(); }
  }
}
