import { App, Component, MarkdownRenderer, Modal, Notice, Setting, type ButtonComponent } from "obsidian";
import { NOTE_ACTIONS, NoteWork, type NoteAction } from "./note-work";
import { safeNoteMarkdown } from "./note-context";
import { noteDiff } from "./note-workspace";
import { AREA_LABELS, PERIOD_LABELS, QUERY_AREAS, type QueryArea, type QueryPeriod } from "./question-query";

/** One view of a longer-lived work item, using the host theme and a single scroll region. */
export class NoteModal extends Modal {
  private unsubscribe: (() => void) | null = null;
  private stopViewport: (() => void) | null = null;
  private alive = false;
  private sourceEl: HTMLDetailsElement | null = null;
  private wide = false;
  private rendering: Component | null = null;
  constructor(app: App, readonly work: NoteWork, private readonly options: {
    closed(): void; settings(): void; startNew(): void; nextTitle(): string | null;
  }) { super(app); }
  onOpen(): void {
    this.unsubscribe?.(); this.stopViewport?.();
    this.alive = true; this.modalEl.classList.add("calendar-note-modal");
    this.modalEl.parentElement?.classList.add("calendar-note-container");
    this.contentEl.classList.add("calendar-note");
    this.unsubscribe = this.work.subscribe(() => this.render());
    const view = this.contentEl.ownerDocument.defaultView, viewport = view?.visualViewport;
    let focusTimer: number | null = null;
    const keepFocusVisible = () => {
      if (focusTimer !== null) { view?.clearTimeout(focusTimer); focusTimer = null; }
      const focused = this.contentEl.ownerDocument.activeElement;
      if (!focused || !this.contentEl.contains(focused) || !focused.matches("input,textarea")) return;
      focusTimer = view?.setTimeout(() => {
        const active = this.contentEl.ownerDocument.activeElement;
        if (this.alive && active instanceof HTMLElement && this.contentEl.contains(active) && active.matches("input,textarea")) active.scrollIntoView({ block: "nearest", inline: "nearest" });
      }, 400) ?? null;
    };
    const focus = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.matches("input,textarea")) {
        this.contentEl.classList.toggle("calendar-note-editing-context", !!target.closest(".calendar-note-scroll")); keepFocusVisible();
      }
    };
    const resize = () => {
      if (!this.alive) return;
      if (viewport) this.modalEl.style.setProperty("--ycc-viewport-height", `${viewport.height}px`);
      const nativeKeyboard = view?.getComputedStyle ? parseFloat(view.getComputedStyle(this.contentEl.ownerDocument.body).getPropertyValue("--keyboard-height")) || 0 : 0;
      this.contentEl.classList.toggle("calendar-note-keyboard", nativeKeyboard > 50 || !!(view && viewport && view.innerHeight - viewport.height > 80));
      const wide = this.contentEl.getBoundingClientRect().width >= 740;
      if (wide !== this.wide && this.sourceEl) this.sourceEl.open = wide;
      this.wide = wide; keepFocusVisible();
    };
    viewport?.addEventListener("resize", resize); resize();
    this.contentEl.addEventListener("focusin", focus);
    const Observer = view?.MutationObserver, observer = Observer ? new Observer(resize) : null;
    observer?.observe(this.contentEl.ownerDocument.body, { attributes: true, attributeFilter: ["style"] });
    observer?.observe(this.contentEl.ownerDocument.documentElement, { attributes: true, attributeFilter: ["style"] });
    this.stopViewport = () => { viewport?.removeEventListener("resize", resize); this.contentEl.removeEventListener("focusin", focus); observer?.disconnect(); if (focusTimer !== null) view?.clearTimeout(focusTimer); };
    this.render(); void this.work.refreshSettings();
  }
  onClose(): void {
    this.alive = false; this.unsubscribe?.(); this.unsubscribe = null; this.stopViewport?.(); this.stopViewport = null;
    this.rendering?.unload(); this.rendering = null;
    this.modalEl.parentElement?.classList.remove("calendar-note-container"); this.options.closed();
  }
  private button(el: HTMLElement, text: string, action: () => void, disabled = false, primary = false): ButtonComponent {
    let control!: ButtonComponent;
    const setting = new Setting(el); setting.settingEl.classList.add("calendar-note-button");
    setting.addButton(button => { control = button; button.setButtonText(text).setDisabled(disabled).onClick(action); if (primary) button.setCta(); });
    return control;
  }
  private render(): void {
    if (!this.alive || !this.work.current) return;
    this.rendering?.unload(); this.rendering = new Component(); this.rendering.load();
    const work = this.work, el = this.contentEl; el.empty();
    const header = el.createDiv({ cls: "calendar-note-header" });
    const heading = header.createDiv(); heading.createEl("h2", { text: "Note AI" });
    heading.createEl("p", { text: work.target.title, cls: "calendar-note-title", attr: { title: work.target.title } });
    this.button(header, "Hide", () => this.close());
    const scroll = el.createDiv({ cls: "calendar-note-scroll" });
    scroll.createEl("p", { text: `${work.source?.scope === "selection" ? "Selected text" : work.source?.scope === "section" ? "Current section" : "Current note"} · ${work.delivery ? `+ ${work.delivery.records.length} Calendar excerpt(s)` : "Note only"}`, cls: "calendar-note-meta" });
    if (work.message) scroll.createEl("p", { text: work.message, cls: "calendar-note-status", attr: { role: "status", "aria-live": "polite" } });
    const next = this.options.nextTitle();
    if (next || work.used) this.button(scroll, next ? `Discard and start for ${next}` : "New request (discard this result)", () => this.options.startNew(), work.busy);
    if (!work.source && !work.busy) this.button(scroll, "Use current section", () => void work.initialize(true));
    if (work.proposals.length > 1) new Setting(scroll).setName("Proposed changes").addDropdown(control => {
      work.proposals.forEach((change, i) => { control.addOption(String(i), `${change.title || change.target} · ${change.action}`); });
      control.setValue(String(work.selectedProposal)).setDisabled(work.busy).onChange(value => work.selectProposal(Number(value)));
    });
    if (work.proposal) scroll.createEl("p", { text: `${work.proposal.target === "new" ? "New document" : work.proposal.target === "N1" ? work.target.title : work.related.find(doc => doc.reference === work.proposal?.target)?.title ?? work.proposal.target} · ${work.proposal.action}`, cls: "calendar-note-meta" });
    const grid = scroll.createDiv({ cls: "calendar-note-grid" });
    const source = grid.createEl("details", { cls: "calendar-note-source" }); this.sourceEl = source; source.open = this.wide;
    const before = work.proposal?.target === "new" ? "" : work.proposal && work.proposal.target !== "N1" ? work.related.find(doc => doc.reference === work.proposal?.target)?.text ?? "" : work.source?.text ?? "";
    source.createEl("summary", { text: "Source text" }); source.createEl("pre", { text: before || "New document · no existing file is replaced." });
    const result = grid.createEl("section", { cls: "calendar-note-result" });
    if (work.draft) {
      result.createEl("h3", { text: "Your draft" });
      const markdown = safeNoteMarkdown(work.draft.text), preview = result.createDiv({ cls: "calendar-note-markdown" });
      if (new TextEncoder().encode(markdown).length <= 131072) {
        preview.inert = true; preview.setAttribute("aria-busy", "true");
        void MarkdownRenderer.render(this.app, markdown, preview, work.target.path, this.rendering).then(() => {
          for (const table of Array.from(preview.querySelectorAll("table"))) {
            const wrapper = preview.createDiv({ cls: "calendar-note-table" });
            table.parentElement?.insertBefore(wrapper, table); wrapper.appendChild(table);
          }
          for (const checkbox of Array.from(preview.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))) { checkbox.disabled = true; checkbox.setAttribute("aria-readonly", "true"); }
          preview.inert = false; preview.setAttribute("aria-busy", "false");
        }).catch(() => { preview.empty(); preview.createEl("pre", { text: markdown }); preview.inert = false; preview.setAttribute("aria-busy", "false"); });
      } else { preview.createEl("p", { text: "Large draft shown as Markdown source. The full result is kept." }); preview.createEl("pre", { text: markdown }); }
    }
    else result.createEl("p", { text: work.busy ? "Working… You can hide this sheet and return from the note’s AI action." : "Ask about this text, or choose an action below. Nothing is sent until you generate.", cls: "calendar-note-meta" });
    if (work.proposal && work.draft) {
      const diff = scroll.createEl("details"); diff.createEl("summary", { text: "Review changes" });
      const after = work.proposal.action === "append" ? `${before}\n\n${work.draft.text}` : work.draft.text;
      diff.createEl("pre", { text: noteDiff(before, after), cls: "calendar-note-diff" });
      if (work.reply) scroll.createEl("p", { text: work.reply, cls: "calendar-note-meta" });
    }

    if (!work.used) {
      const related = scroll.createEl("details"); related.createEl("summary", { text: `Related Markdown notes${work.related.length ? ` · ${work.related.length}` : " (optional)"}` });
      related.createEl("p", { text: "Find up to four complete notes relevant to your request. Reads local titles, links and bounded text; no AI search charge or folder-by-folder setup.", cls: "calendar-note-meta" });
      for (const doc of work.related) { const item = related.createEl("details"); item.createEl("summary", { text: `${doc.reference} · ${doc.title}` }); item.createEl("pre", { text: doc.text }); }
      this.button(related, "Find relevant notes", () => void work.findRelated(), work.locked);
      if (work.related.length) this.button(related, "Remove related notes", () => work.removeRelated(), work.locked);
    }

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
    const updatePreview = () => { try { const input = work.input; preview.textContent = input || "Choose an action or write a request."; return !!input; } catch (error) { preview.textContent = error instanceof Error ? error.message : "Shorten the request."; return false; } };
    const validInput = updatePreview();
    scroll.createEl("p", { text: `${work.model || "Choose a model"} · ${work.configured ? "Key saved locally" : "Key needed"}`, cls: "calendar-note-meta" });
    this.button(scroll, "AI settings", () => this.options.settings(), work.busy);
    if (work.backupPath) scroll.createEl("p", { text: `Original saved: ${work.backupPath}`, cls: "calendar-note-meta" });
    if (work.previousTurns.length) {
      const history = scroll.createEl("details"); history.createEl("summary", { text: `Previous answers · ${work.previousTurns.length}` });
      for (const turn of work.previousTurns) { const item = history.createEl("details"); item.createEl("summary", { text: turn.request }); item.createEl("pre", { text: turn.answer }); }
    }
    if (work.used && !work.draft) scroll.createEl("p", { text: "This request is finished. No automatic retry. Start a new request only when you are ready to send again.", cls: "calendar-note-meta" });

    const footer = el.createDiv({ cls: "calendar-note-composer" });
    const submit = el.createDiv({ cls: "calendar-note-submit" });
    if (!work.used) {
      const chips = footer.createDiv({ cls: "calendar-note-actions", attr: { "aria-label": "AI actions" } });
      for (const action of ["ask", "summary", "refine", "tasks"] as const) {
        const option = NOTE_ACTIONS[action];
        const button = chips.createEl("button", { text: option.label, attr: { type: "button", "aria-pressed": String(work.action === action) } });
        button.disabled = work.locked; button.addEventListener("click", () => work.choose(action as NoteAction));
      }
      const advanced = new Setting(footer); advanced.settingEl.classList.add("calendar-note-input", "calendar-note-more");
      advanced.addDropdown(control => {
        control.selectEl.setAttribute("aria-label", "More writing actions"); control.addOption("", "Diagram, chart, table…");
        for (const action of ["diagram", "chart", "table", "math", "new"] as const) control.addOption(action, NOTE_ACTIONS[action].label);
        control.setValue(["diagram", "chart", "table", "math", "new"].includes(work.action) ? work.action : "").setDisabled(work.locked).onChange(value => { if (value) work.choose(value as NoteAction); });
      });
      let generate: ButtonComponent | null = null;
      const field = new Setting(footer); field.settingEl.classList.add("calendar-note-input");
      field.addTextArea(input => {
        input.inputEl.rows = 2; input.inputEl.maxLength = 4000; input.inputEl.setAttribute("aria-label", "Request for this note");
        input.setPlaceholder("Write, rewrite, diagram or ask about these notes…").setValue(work.prompt).setDisabled(work.locked).onChange(value => { work.setPrompt(value); generate?.setDisabled(!updatePreview() || work.locked || !work.source || !work.configured || !work.model); });
      });
      submit.createEl("p", { text: "Uses your OpenAI key · API charges apply · one request", cls: "calendar-note-cost" });
      generate = this.button(submit, "Generate once", () => void work.generate(), !validInput || work.locked || !work.source || !work.configured || !work.model || !!(work.requestId && !work.delivery), true);
    } else if (work.draft) {
      const buttons = submit.createDiv({ cls: "calendar-note-output-actions" });
      const proposal = work.proposal;
      if (proposal?.target === "new") {
        new Setting(scroll).setName("New note title").addText(control => control.setValue(proposal.title).setDisabled(work.busy || work.saved).onChange(value => { proposal.title = value; }));
        this.button(buttons, "Create new note", () => void work.saveNew(), work.busy || work.saved, true);
      } else if (proposal) {
        const title = proposal.target === "N1" ? work.target.title : work.related.find(doc => doc.reference === proposal.target)?.title ?? proposal.target;
        const label = proposal.action === "replace" ? proposal.target !== "N1" ? `Replace ${title}` : work.source?.scope === "selection" ? "Replace selected text" : work.source?.scope === "section" ? "Replace current section" : "Replace entire note" : proposal.target === "N1" ? work.source?.scope === "selection" ? "Add below selection" : "Append to note" : `Append to ${title}`;
        this.button(buttons, label, () => void work.applyProposal(), work.busy || work.applied, true);
      } else this.button(buttons, work.source?.scope === "selection" ? "Add below selection" : "Append to note", () => void work.apply(work.source?.scope === "selection" ? "below" : "append"), work.busy || work.applied, true);
      const more = footer.createEl("details"); more.createEl("summary", { text: "More actions" });
      if (!proposal && work.source?.scope === "selection") this.button(more, "Replace selected text", () => void work.apply("replace"), work.busy || work.applied);
      this.button(more, "Save as new note", () => void work.saveNew(), work.busy || work.saved);
      if (work.canUndo) this.button(more, "Undo last AI edit", () => void work.undo(), work.busy);
      this.button(more, "Continue with this answer", () => void work.followUp(), work.busy);
      this.button(more, "Copy result", () => {
        const clipboard = this.contentEl.ownerDocument.defaultView?.navigator.clipboard;
        if (!clipboard || !work.draft) { new Notice("Clipboard unavailable. Select and copy the draft text."); return; }
        void clipboard.writeText(safeNoteMarkdown(work.draft.text)).then(() => work.report("Result copied."), () => work.report("Clipboard unavailable. Select and copy the draft text."));
      }, work.busy);
    }
  }
}
