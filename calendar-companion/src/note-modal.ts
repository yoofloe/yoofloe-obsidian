import { App, Modal, Notice, Setting, type ButtonComponent } from "obsidian";
import { NOTE_ACTIONS, NoteWork, type NoteAction } from "./note-work";
import { safeNoteMarkdown } from "./note-context";
import { AREA_LABELS, PERIOD_LABELS, QUERY_AREAS, type QueryArea, type QueryPeriod } from "./question-query";

/** One view of a longer-lived work item, using the host theme and a single scroll region. */
export class NoteModal extends Modal {
  private unsubscribe: (() => void) | null = null;
  private stopViewport: (() => void) | null = null;
  private alive = false;
  private sourceEl: HTMLDetailsElement | null = null;
  private wide = false;
  constructor(app: App, readonly work: NoteWork, private readonly options: {
    closed(): void; settings(): void; startNew(): void; nextTitle(): string | null;
  }) { super(app); }
  onOpen(): void {
    this.alive = true; this.modalEl.classList.add("calendar-note-modal");
    this.modalEl.parentElement?.classList.add("calendar-note-container");
    this.contentEl.classList.add("calendar-note");
    this.unsubscribe = this.work.subscribe(() => this.render());
    const viewport = this.contentEl.ownerDocument.defaultView?.visualViewport;
    const resize = () => {
      if (!this.alive) return;
      if (viewport) this.modalEl.style.setProperty("--ycc-viewport-height", `${viewport.height}px`);
      const wide = this.modalEl.getBoundingClientRect().width >= 740;
      if (wide !== this.wide && this.sourceEl) this.sourceEl.open = wide;
      this.wide = wide;
    };
    viewport?.addEventListener("resize", resize); resize();
    this.stopViewport = () => viewport?.removeEventListener("resize", resize);
    this.render(); void this.work.refreshSettings();
  }
  onClose(): void {
    this.alive = false; this.unsubscribe?.(); this.unsubscribe = null; this.stopViewport?.(); this.stopViewport = null;
    this.modalEl.parentElement?.classList.remove("calendar-note-container"); this.options.closed();
  }
  private button(el: HTMLElement, text: string, action: () => void, disabled = false, primary = false): ButtonComponent {
    let control!: ButtonComponent;
    new Setting(el).addButton(button => { control = button; button.setButtonText(text).setDisabled(disabled).onClick(action); if (primary) button.setCta(); });
    return control;
  }
  private render(): void {
    if (!this.alive || !this.work.current) return;
    const work = this.work, el = this.contentEl; el.empty();
    const header = el.createDiv({ cls: "calendar-note-header" });
    header.createEl("h2", { text: "Note AI" });
    this.button(header, "Hide", () => this.close());
    const scroll = el.createDiv({ cls: "calendar-note-scroll" });
    scroll.createEl("p", { text: work.target.title, cls: "calendar-note-title" });
    scroll.createEl("p", { text: `${work.source?.scope === "selection" ? "Selected text" : work.source?.scope === "section" ? "Current section" : "Current note"} · ${work.delivery ? `+ ${work.delivery.records.length} Calendar excerpt(s)` : "Note only"}`, cls: "calendar-note-meta" });
    if (work.message) scroll.createEl("p", { text: work.message, cls: "calendar-note-status", attr: { role: "status", "aria-live": "polite" } });
    if (!work.source && !work.busy) this.button(scroll, "Use current section", () => void work.initialize(true));
    const grid = scroll.createDiv({ cls: "calendar-note-grid" });
    const source = grid.createEl("details", { cls: "calendar-note-source" }); this.sourceEl = source; source.open = this.wide;
    source.createEl("summary", { text: "Source text" }); source.createEl("pre", { text: work.source?.text ?? "No text selected yet." });
    const result = grid.createEl("section", { cls: "calendar-note-result" });
    if (work.draft) { result.createEl("h3", { text: "Your draft" }); result.createEl("pre", { text: safeNoteMarkdown(work.draft.text) }); }
    else result.createEl("p", { text: work.busy ? "Working… You can hide this sheet and return from the note’s AI action." : "Ask about this text, or choose an action below. Nothing is sent until you generate.", cls: "calendar-note-meta" });

    if (!work.used) {
      const calendar = scroll.createEl("details", { cls: "calendar-note-calendar" }); calendar.createEl("summary", { text: "Add Calendar context (optional)" });
      calendar.createEl("p", { text: "Requires Yoofloe Calendar 1.8.5+ on this Android device. Only the relevant excerpts you approve are added. The note stays here.", cls: "calendar-note-meta" });
      if (!work.requestId) {
        new Setting(calendar).setName("Find context for").addTextArea(input => {
          input.inputEl.rows = 2; input.inputEl.maxLength = 4000; input.inputEl.setAttribute("aria-label", "Calendar context question");
          input.setPlaceholder("My study progress this week").setValue(work.calendarQuestion).setDisabled(work.locked).onChange(value => { work.calendarQuestion = value; });
        });
        const advanced = calendar.createEl("details"); advanced.createEl("summary", { text: "Adjust search" });
        new Setting(advanced).setName("Workspace").addDropdown(control => {
          control.addOption("auto", "From my question"); for (const area of QUERY_AREAS) control.addOption(area, AREA_LABELS[area]);
          control.setValue(work.area).setDisabled(work.locked).onChange(value => { work.area = value as QueryArea | "auto"; });
        });
        new Setting(advanced).setName("Period").addDropdown(control => {
          control.addOption("auto", "From my question"); for (const period of ["today", "tomorrow", "this_week", "last_week", "last_7_days", "next_7_days", "last_30_days"] as const) control.addOption(period, PERIOD_LABELS[period]);
          control.setValue(work.period).setDisabled(work.locked).onChange(value => { work.period = value as QueryPeriod | "auto"; });
        });
        this.button(calendar, "Find relevant records", () => { void work.findCalendar().then(url => { if (url && work.current) this.contentEl.ownerDocument.defaultView?.open(url, "_blank"); }); }, work.locked);
      } else {
        if (!work.delivery) this.button(calendar, "Check Calendar reply", () => void work.receive(work.requestId ?? ""), work.locked);
        this.button(calendar, "Remove Calendar context", () => void work.removeCalendar(), work.locked);
      }
    }
    const review = scroll.createEl("details", { cls: "calendar-note-review" }); review.createEl("summary", { text: "Exactly what will be sent" });
    const preview = review.createEl("pre");
    const updatePreview = () => { try { preview.textContent = work.input || "Choose an action or write a request."; return !!work.input; } catch (error) { preview.textContent = error instanceof Error ? error.message : "Shorten the request."; return false; } };
    const validInput = updatePreview();
    scroll.createEl("p", { text: `${work.model || "Choose a model"} · ${work.configured ? "Key saved locally" : "Key needed"}`, cls: "calendar-note-meta" });
    this.button(scroll, "AI settings", () => this.options.settings(), work.busy);
    if (work.used && !work.draft) scroll.createEl("p", { text: "This request is finished. No automatic retry. Start a new request only when you are ready to send again.", cls: "calendar-note-meta" });

    const footer = el.createDiv({ cls: "calendar-note-composer" });
    if (!work.used) {
      const chips = footer.createDiv({ cls: "calendar-note-actions", attr: { "aria-label": "AI actions" } });
      for (const [action, option] of Object.entries(NOTE_ACTIONS)) {
        const button = chips.createEl("button", { text: option.label, attr: { type: "button", "aria-pressed": String(work.action === action) } });
        button.disabled = work.locked; button.addEventListener("click", () => work.choose(action as NoteAction));
      }
      let generate: ButtonComponent | null = null;
      new Setting(footer).addTextArea(input => {
        input.inputEl.rows = 2; input.inputEl.maxLength = 4000; input.inputEl.setAttribute("aria-label", "Request for this note");
        input.setPlaceholder("Ask about this note…").setValue(work.prompt).setDisabled(work.locked).onChange(value => { work.setPrompt(value); generate?.setDisabled(!updatePreview() || work.locked || !work.source || !work.configured || !work.model); });
      });
      footer.createEl("p", { text: "Uses your OpenAI key · API charges apply · one request", cls: "calendar-note-cost" });
      generate = this.button(footer, "Generate once", () => void work.generate(), !validInput || work.locked || !work.source || !work.configured || !work.model, true);
    } else if (work.draft) {
      const buttons = footer.createDiv({ cls: "calendar-note-output-actions" });
      this.button(buttons, work.source?.scope === "selection" ? "Add below selection" : "Append to note", () => void work.apply(work.source?.scope === "selection" ? "below" : "append"), work.busy || work.applied, true);
      const more = footer.createEl("details"); more.createEl("summary", { text: "More actions" });
      if (work.source?.scope === "selection") this.button(more, "Replace selected text", () => void work.apply("replace"), work.busy || work.applied);
      this.button(more, "Save as new note", () => void work.saveNew(), work.busy || work.saved);
      this.button(more, "Copy result", () => {
        const clipboard = this.contentEl.ownerDocument.defaultView?.navigator.clipboard;
        if (!clipboard || !work.draft) { new Notice("Clipboard unavailable. Select and copy the draft text."); return; }
        void clipboard.writeText(safeNoteMarkdown(work.draft.text)).then(() => work.report("Result copied."), () => work.report("Clipboard unavailable. Select and copy the draft text."));
      }, work.busy);
    }
    const next = this.options.nextTitle();
    if (next || work.used) this.button(footer, next ? `Discard and start for ${next}` : "New request (discard this result)", () => this.options.startNew(), work.busy);
  }
}
