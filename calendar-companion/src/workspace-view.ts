import { Component, ItemView, MarkdownRenderer, Notice, Platform, setIcon, type WorkspaceLeaf } from "obsidian";
import { AiWorkspace } from "./workspace";
import { MODE_LABELS, SCOPE_LABELS } from "./agent-policy";
import { EFFORT_LABELS, resolveEffort, supportedEfforts } from "./effort";
import { modelCatalog } from "./ai-models";
import { AREA_LABELS, PERIOD_LABELS } from "./question-query";
import { safeNoteMarkdown } from "./note-context";
import { VaultFolderPicker } from "./folder-picker";
import { availableViewHeight } from "./view-bounds";
import { DATA_FLOW_NOTICE, LOCAL_DATA_NOTICE, OPENAI_DATA_NOTICE, CONTROL_NOTICE, PRIVACY_URL, OPENAI_DATA_URL } from "./privacy-copy";
import { customRequestLimit, requestLimitLabel } from "./request-limit";

export const AI_VIEW = "yoofloe-ai";
const STORE = "https://play.google.com/store/apps/details?id=com.yoofloe.calendar";
type ViewOptions = { settings(): void; hide(): void };
/** One compact, theme-native surface shared by desktop and mobile. No data is read on view construction. */
export class YoofloeAiView extends ItemView {
  private unsubscribe: (() => void) | null = null;
  private stopViewport: (() => void) | null = null;
  private rendering: Component | null = null;
  private saveTimer: number | undefined;
  private openDetails = new Set<string>();
  private chatVisible = 10;
  private lastChatCount = 0;
  private followChat = false;
  constructor(leaf: WorkspaceLeaf, readonly work: AiWorkspace, private readonly options: ViewOptions) { super(leaf); }
  getViewType(): string { return AI_VIEW; }
  getDisplayText(): string { return "Yoofloe AI"; }
  getIcon(): string { return "sparkles"; }
  async onOpen(): Promise<void> {
    this.contentEl.classList.add("yoofloe-ai"); this.unsubscribe = this.work.subscribe(() => this.render());
    this.stopViewport = this.watchViewport(); this.render(); await this.work.initialize();
  }
  async onClose(): Promise<void> {
    this.unsubscribe?.(); this.stopViewport?.(); this.rendering?.unload();
    if (this.saveTimer !== undefined) this.contentEl.ownerDocument.defaultView?.clearTimeout(this.saveTimer);
    await this.work.persist().catch(() => {});
  }
  private saveSoon(): void {
    const win = this.contentEl.ownerDocument.defaultView; if (!win) return;
    win.clearTimeout(this.saveTimer); this.saveTimer = win.setTimeout(() => { void this.work.persist().catch(() => new Notice("The draft could not be saved locally. Keep this view open.")); }, 400);
  }
  private button(el: HTMLElement, text: string, action: () => void, disabled = false, cls = ""): HTMLButtonElement {
    const b = el.createEl("button", { text, cls, attr: { type: "button" } }); b.disabled = disabled; b.addEventListener("click", action); return b;
  }
  private details(el: HTMLElement, key: string, title: string): HTMLDetailsElement {
    const d = el.createEl("details", { cls: "y-ai-details" }); d.open = this.openDetails.has(key); d.createEl("summary", { text: title });
    d.addEventListener("toggle", () => { if (d.open) this.openDetails.add(key); else this.openDetails.delete(key); }); return d;
  }
  private select<T extends string>(el: HTMLElement, label: string, values: Record<T, string>, selected: T, change: (value: T) => void, allowPaused = false): HTMLSelectElement {
    const wrap = el.createEl("label", { cls: "y-ai-field" }); wrap.createSpan({ text: label });
    const select = wrap.createEl("select", { attr: { "aria-label": label } });
    for (const [value, text] of Object.entries(values)) select.createEl("option", { text: String(text), value }); select.value = selected; select.disabled = this.work.busy || !allowPaused && this.work.canContinue;
    select.addEventListener("change", () => { change(select.value as T); this.work.preview = ""; this.saveSoon(); }); return select;
  }
  private actionReady(): boolean {
    const w = this.work; return !w.busy && w.ready && w.configured && !w.limitProblem && (w.canContinue ? w.canResumeWithLimit : !!w.prompt.trim());
  }
  private refreshLimitDisclosure(): void {
    const w = this.work, label = requestLimitLabel(w.maximum);
    this.contentEl.querySelectorAll<HTMLElement>(".y-ai-limit-caption").forEach(el => el.setText(label));
    this.contentEl.querySelector<HTMLElement>(".y-ai-privacy-short")?.setText(`OpenAI · paid · ${label}`);
    const run = this.contentEl.querySelector<HTMLButtonElement>(".y-ai-send");
    if (run && !w.busy) run.title = `Send permitted data directly to OpenAI · API charges · ${label}`;
  }
  private limitControl(el: HTMLElement): void {
    const w = this.work, presets = { "1": "1", "2": "2", "4": "4 (default)", "6": "6", "10": "10", custom: "Custom…", none: "No request-count limit" };
    const selected = w.customMaximum !== null ? "custom" : w.maximum === "none" ? "none" : String(w.maximum) in presets ? String(w.maximum) : "custom";
    this.select(el, "API request limit", presets, selected, value => {
      if (value === "none") { w.maximum = "none"; w.customMaximum = null; }
      else if (value === "custom") { w.customMaximum = String(w.maximum === "none" ? 4 : w.maximum); w.maximum = Number(w.customMaximum); }
      else { w.maximum = Number(value); w.customMaximum = null; }
      this.render();
    }, true);
    if (selected === "custom") {
      const wrap = el.createEl("label", { cls: "y-ai-field" }); wrap.createSpan({ text: "Custom request count" });
      const input = wrap.createEl("input", { value: w.customMaximum ?? String(w.maximum), attr: { inputmode: "numeric", pattern: "[0-9]*", placeholder: "E.g. 20", "aria-label": "Custom request count" } }); input.maxLength = 32; input.disabled = w.busy;
      const error = wrap.createSpan({ text: w.limitProblem, cls: "y-ai-limit-error", attr: { role: "status", "aria-live": "polite" } });
      input.addEventListener("input", () => {
        w.customMaximum = input.value; const count = customRequestLimit(input.value); if (count !== null) w.maximum = count;
        w.preview = ""; error.textContent = w.limitProblem; input.setAttribute("aria-invalid", String(!!w.limitProblem));
        const run = this.contentEl.querySelector<HTMLButtonElement>(".y-ai-send"); if (run) run.disabled = !this.actionReady();
        this.refreshLimitDisclosure(); this.saveSoon();
      });
      wrap.createEl("small", { text: "Positive whole numbers, such as 20 or 50. This counts API requests, not questions or output tokens.", cls: "y-ai-hint" });
    }
    el.createEl("p", { text: w.maximum === "none" ? "No request-count limit: the task continues until it finishes or you stop it. API charges can accumulate. Context, rate and account limits still apply; repeated failures stop locally." : "One task may use several paid OpenAI requests. A finite limit pauses the task so you can choose whether to continue.", cls: "y-ai-hint" });
  }
  private markdown(el: HTMLElement, text: string, sourcePath = this.work.source?.path ?? ""): void {
    if (!this.rendering) return;
    const result = el.createDiv({ cls: "y-ai-result markdown-rendered" }); result.inert = true;
    void MarkdownRenderer.render(this.app, safeNoteMarkdown(text), result, sourcePath, this.rendering).then(() => {
      if (!result.isConnected) return; result.querySelectorAll<HTMLInputElement>("input").forEach(input => { input.disabled = true; });
      result.querySelectorAll("table").forEach(table => { const wrap = result.createDiv({ cls: "y-ai-table" }); table.before(wrap); wrap.append(table); }); result.inert = false;
      for (const link of Array.from(result.querySelectorAll<HTMLAnchorElement>("a.internal-link"))) {
        link.addEventListener("click", event => { const target = link.dataset.href || link.getAttribute("href"); if (!target) return; event.preventDefault(); event.stopPropagation(); void this.app.workspace.openLinkText(target, sourcePath, event.ctrlKey || event.metaKey); });
      }
      const scroll = this.contentEl.querySelector(".y-ai-scroll"); if (this.followChat && scroll) scroll.scrollTop = scroll.scrollHeight;
    }).catch(() => { if (result.isConnected) { result.empty(); result.createEl("pre", { text }); result.inert = false; } });
  }
  private conversation(el: HTMLElement): void {
    const w = this.work;
    if (w.chat.length > this.chatVisible) this.button(el, `Show ${Math.min(10, w.chat.length - this.chatVisible)} earlier task(s)`, () => { this.chatVisible += 10; this.render(); });
    const conversation = el.createDiv({ cls: "y-ai-chat", attr: { "aria-label": "Conversation" } });
    const labels: Record<string, string> = { edit: "Updated", create: "Created", rename: "Renamed", folder: "Created folder", trash: "Moved to trash", properties: "Updated properties" };
    for (const turn of w.chat.slice(-this.chatVisible)) {
      const exchange = conversation.createEl("article", { cls: "y-ai-exchange" });
      if (turn.request) { const user = exchange.createDiv({ cls: "y-ai-message y-ai-user" }); user.createEl("strong", { text: "You", cls: "y-ai-message-label" }); user.createEl("p", { text: turn.request, cls: "y-ai-request-text" }); }
      const assistant = exchange.createDiv({ cls: "y-ai-message y-ai-assistant" }); assistant.createEl("strong", { text: "Yoofloe AI", cls: "y-ai-message-label" });
      const status = turn.status === "running" ? w.stopping ? "Stopping…" : "Working…" : turn.status === "paused" ? "Paused at request limit" : turn.status === "completed" ? "Completed" : turn.status === "stopped" ? "Stopped" : "Could not finish";
      assistant.createEl("p", { text: `${status}${turn.requests ? ` · ${turn.requests} request(s)` : ""}${turn.model ? ` · ${turn.model}` : ""}`, cls: "y-ai-hint" });
      if (turn.actions.length) { const actions = assistant.createDiv({ cls: "y-ai-chat-actions" }); for (const action of turn.actions) actions.createEl("p", { text: `${labels[action.kind] ?? "Changed"}: ${action.path}${action.target ? ` → ${action.target}` : ""}`, cls: "y-ai-hint" }); }
      if ((turn.actionTotal ?? 0) > turn.actions.length) assistant.createEl("p", { text: `${turn.actionTotal} confirmed operations in total. Recent actions are shown here; all recovery segments are kept under changed files and recovery.`, cls: "y-ai-hint" });
      else if (!turn.actions.length && turn.status === "completed" && turn.actionsKnown) assistant.createEl("p", { text: "No file changes were recorded for this task.", cls: "y-ai-hint" });
      if (turn.answer) this.markdown(assistant, turn.answer, turn.sourcePath ?? "");
      if (turn.requestTruncated || turn.answerTruncated) this.button(assistant, "Load full local conversation", () => void w.loadFullChat(turn.id));
    }
    if (w.chat.length) el.createEl("p", { text: "Recent conversations are saved on this device. Only limited recent context and permitted relevant excerpts are sent with a new task.", cls: "y-ai-hint" });
  }
  private render(): void {
    if (!this.work.current) return;
    const w = this.work, el = this.contentEl, previousScroll = el.querySelector<HTMLElement>(".y-ai-scroll"), oldScroll = previousScroll?.scrollTop ?? 0, oldRootScroll = el.scrollTop;
    const follow = !previousScroll && w.chat.length > 0 || w.busy && w.chat.length > this.lastChatCount || !!previousScroll && previousScroll.scrollTop + previousScroll.clientHeight >= previousScroll.scrollHeight - 32; this.lastChatCount = w.chat.length; this.followChat = follow;
    this.rendering?.unload(); this.rendering = new Component(); this.rendering.load(); el.empty();
    const header = el.createDiv({ cls: "y-ai-header" }), title = header.createDiv({ cls: "y-ai-heading" });
    title.createEl("h2", { text: "Yoofloe AI" }); title.createEl("p", { text: w.title, attr: { title: w.source?.path ?? "Create a document without opening a note" } });
    const settings = this.button(header, "", () => this.options.settings(), w.settingsLocked, "clickable-icon"); settings.setAttribute("aria-label", "Yoofloe AI settings"); setIcon(settings, "settings-2");
    const hide = this.button(header, "", () => this.options.hide(), false, "clickable-icon"); hide.setAttribute("aria-label", "Hide Yoofloe AI"); setIcon(hide, "panel-right-close");
    const scroll = el.createDiv({ cls: "y-ai-scroll" });
    scroll.addEventListener("wheel", () => { this.followChat = false; }, { passive: true }); scroll.addEventListener("touchstart", () => { this.followChat = false; }, { passive: true });
    if (!w.configured && w.ready) {
      const intro = scroll.createDiv({ cls: "y-ai-setup" }), copy = intro.createDiv({ cls: "y-ai-setup-copy" });
      copy.createEl("strong", { text: "Connect OpenAI" }); copy.createEl("p", { text: "Your key · API charges apply" });
      this.button(intro, "Set up", () => this.options.settings(), false, "mod-cta");
    }
    if (w.nextSource) this.button(scroll, `New task for ${w.nextSource.path.split("/").at(-1)}`, () => void w.newTask(w.nextSource), w.busy, "y-ai-next");
    const models = scroll.createDiv({ cls: "y-ai-models" }), choices: Record<string, string> = {};
    for (const model of modelCatalog("openai").models) choices[model.id] = model.label;
    if (w.model.model && !choices[w.model.model]) choices[w.model.model] = `Custom · ${w.model.model}`;
    choices.__custom__ = "Custom model…";
    const model = this.select(models, "Model", choices, w.model.model, value => { if (value === "__custom__") this.options.settings(); else void w.setModel({ model: value }); });
    model.title = choices[w.model.model] ?? w.model.model;
    const efforts: Record<string, string> = { default: EFFORT_LABELS.default };
    for (const effort of supportedEfforts(w.model.model)) efforts[effort] = EFFORT_LABELS[effort];
    this.select(models, "Thinking depth", efforts, w.model.effort ?? resolveEffort(w.model.model) ?? "default", value => { void w.setModel({ ...w.model, effort: value }); });
    models.createEl("p", { text: w.model.model, cls: "y-ai-model-id", attr: { "aria-label": "Selected model ID" } });
    if (w.canContinue) {
      const pause = scroll.createDiv({ cls: "y-ai-card" }); pause.createEl("strong", { text: `Paused · ${w.task?.requests ?? 0} request(s) used` });
      pause.createEl("p", { text: `Continue with the original model (${w.task?.modelId ?? w.model.model}) and original data/change scopes. Earlier tool results and completed changes are reused, not replayed. Continuation is available while this vault session stays open.`, cls: "y-ai-hint" });
      this.limitControl(pause); this.button(pause, "Finish here", () => void w.finishHere(), w.busy); this.button(pause, "New task", () => void w.newTask(), w.busy);
    }
    const scope = this.details(scroll, "scope", `${MODE_LABELS[w.mode]} · data: ${w.readScope === "current" && !w.source ? "No attached note" : SCOPE_LABELS[w.readScope]}${w.source?.selection && w.readScope === "current" ? " selection" : ""}`);
    this.select(scope, "Allowed actions", MODE_LABELS, w.mode, value => { w.mode = value; this.render(); });
    if (w.mode === "all") scope.createEl("p", { text: "All supported actions: write, edit, update properties, create folders, rename, move and propose trash. Choose the data and change scopes below.", cls: "y-ai-hint" });
    this.select(scope, "Data sent to OpenAI", SCOPE_LABELS, w.readScope, value => { w.readScope = value; this.render(); });
    if (w.source?.selection) this.button(scope, "Use whole attached note", () => { if (!w.source) return; delete w.source.selection; delete w.source.selectionVersion; w.preview = ""; this.saveSoon(); this.render(); }, w.settingsLocked);
    if (w.mode !== "ask") this.select(scope, "Notes AI can change", SCOPE_LABELS, w.writeScope, value => { w.writeScope = value; });
    const folderLabel = scope.createDiv({ cls: "y-ai-field" }); folderLabel.createSpan({ text: "Working / output folder" });
    const folder = this.button(folderLabel, "", () => {
      if (w.settingsLocked || !w.current) return;
      new VaultFolderPicker(this.app, () => w.current && !w.settingsLocked && folder.isConnected,
        () => w.excluded.split("\n").map(path => path.trim()).filter(Boolean),
        path => { w.outputFolder = path; w.preview = ""; this.saveSoon(); this.render(); }, w.outputFolder).open();
    }, w.settingsLocked, "y-ai-folder");
    folder.setAttribute("aria-label", `Choose working and output folder: ${w.outputFolder || "Vault root"}`);
    folder.title = "Choose a folder inside this vault";
    setIcon(folder.createSpan({ cls: "y-ai-folder-icon" }), "folder");
    folder.createSpan({ text: w.outputFolder || "Vault root · /", cls: "y-ai-folder-path" });
    setIcon(folder.createSpan({ cls: "y-ai-folder-icon" }), "chevron-down");
    scope.createEl("p", { text: "Folder scope includes its subfolders. Current note limits reads and edits to the attached note; new notes may be created in the output folder. The agent reads relevant excerpts as needed, rather than uploading every note.", cls: "y-ai-hint" });
    if (!w.canContinue) this.limitControl(scope);
    const exclusions = scope.createEl("label", { cls: "y-ai-field" }); exclusions.createSpan({ text: "Excluded folders · one vault path per line" });
    const excluded = exclusions.createEl("textarea", { text: w.excluded, attr: { rows: "2", "aria-label": "Excluded folders" } }); excluded.disabled = w.settingsLocked;
    excluded.addEventListener("input", () => { w.excluded = excluded.value; this.saveSoon(); });
    scope.createEl("p", { text: "Thinking depth changes model reasoning cost, not file permissions or response length. Settings, hidden folders, recovery files and detected API keys are excluded. Key detection is not a complete secret scanner.", cls: "y-ai-hint" });
    this.button(scope, "Preview data", () => { el.querySelector<HTMLTextAreaElement>(".y-ai-compose textarea")?.blur(); void w.review(); }, w.settingsLocked);
    scope.createEl("p", { text: "Local initial preview · no API request. Later relevant excerpts may also be sent within your chosen data scope.", cls: "y-ai-hint" });
    const data = this.details(scroll, "privacy", "Privacy and data use");
    for (const text of [DATA_FLOW_NOTICE, LOCAL_DATA_NOTICE, OPENAI_DATA_NOTICE, CONTROL_NOTICE]) data.createEl("p", { text, cls: "y-ai-hint" });
    data.createEl("a", { text: "Privacy and local data controls ↗", href: PRIVACY_URL, attr: { target: "_blank", rel: "noopener noreferrer" } });
    data.createEl("p").createEl("a", { text: "OpenAI data policy ↗", href: OPENAI_DATA_URL, attr: { target: "_blank", rel: "noopener noreferrer" } });
    const calendar = this.details(scroll, "calendar", w.delivery ? `Calendar · ${w.delivery.records.length} excerpt(s)` : "Add Yoofloe Calendar context (optional)");
    if (!Platform.isAndroidApp) {
      calendar.createEl("p", { text: "Yoofloe AI works here without Calendar. Direct Calendar lookup requires both apps on the same Android phone or tablet and user profile. Existing Markdown snapshots can be used as notes." });
    } else {
      calendar.createEl("p", { text: "Local lookup makes no AI request. Calendar remembers the approved inbox in shared storage. Review the returned excerpts before sending to OpenAI.", cls: "y-ai-hint" });
      if (!w.requestId) {
        const query = calendar.createEl("textarea", { text: w.calendarQuestion, attr: { rows: "2", placeholder: "E.g. Study and project plans for next week", "aria-label": "Calendar question" } }); query.disabled = w.settingsLocked;
        query.addEventListener("input", () => { w.calendarQuestion = query.value; });
        this.select(calendar, "Calendar workspace", { auto: "Automatic · relevant workspaces", ...AREA_LABELS }, w.area, value => { w.area = value; });
        const periods = { auto: "Automatic · from question", ...PERIOD_LABELS }; delete (periods as Partial<typeof periods>).custom;
        this.select(calendar, "Calendar period", periods, w.period, value => { w.period = value; });
        this.button(calendar, "Find relevant Calendar records", () => { void w.findCalendar().then(url => { if (url) this.contentEl.ownerDocument.defaultView?.open(url, "_self"); }); }, w.settingsLocked);
      } else if (!w.delivery) this.button(calendar, "Check Calendar reply", () => { if (w.requestId) void w.receiveCalendar(w.requestId); }, w.settingsLocked);
      if (w.requestId) this.button(calendar, w.delivery ? "Remove Calendar context" : "Cancel Calendar request", () => void w.removeCalendar(), w.settingsLocked);
      if (w.delivery) {
        calendar.createEl("p", { text: `${w.delivery.context.scope.areas.map(a => AREA_LABELS[a]).join(", ")} · ${w.delivery.context.from ?? "any date"} → ${w.delivery.context.through ?? "any date"}${w.delivery.context.partial ? " · partial coverage" : ""}` });
        for (const record of w.delivery.records) { const item = calendar.createEl("details"); item.createEl("summary", { text: record.title }); item.createEl("pre", { text: record.text }); }
      }
    }
    calendar.createEl("a", { text: "Discover Yoofloe Calendar ↗", href: STORE, attr: { target: "_blank", rel: "noopener noreferrer" } });
    if (w.message || w.task?.message) scroll.createEl("p", { text: w.busy && w.task?.busy ? w.task.message : w.message, cls: "y-ai-status", attr: { role: "status", "aria-live": "polite" } });
    if (w.chat.length) this.conversation(scroll);
    else if (w.result) this.markdown(scroll, w.result);
    if (w.result) {
      const resultActions = scroll.createDiv({ cls: "y-ai-row" });
      this.button(resultActions, "Copy Markdown", () => { void navigator.clipboard.writeText(w.result).then(() => new Notice("Markdown copied"), () => new Notice("Copy was unavailable; the result is kept.")); });
      this.button(resultActions, "New task", () => void w.newTask(), w.busy);
    }
    if (w.agent?.pendingTrash.length) {
      const trash = scroll.createDiv({ cls: "y-ai-card" }); trash.createEl("strong", { text: "Review before moving to trash" });
      for (const item of w.agent.pendingTrash) trash.createEl("p", { text: item.title });
      this.button(trash, `Move ${w.agent.pendingTrash.length} note(s) to Trash`, () => void w.confirmTrash(), w.settingsLocked, "mod-warning");
    }
    if (w.task?.events.length) {
      const activity = this.details(scroll, "activity", `Activity · ${w.task.requests} request(s) · ${w.task.usage.input + w.task.usage.output} tokens`);
      for (const event of w.task.events) activity.createEl("p", { text: event.text, cls: "y-ai-hint" });
      if (w.agent) for (const sent of w.agent.sent) activity.createEl("p", { text: `Read for OpenAI: ${sent.path} · ${sent.bytes} bytes`, cls: "y-ai-hint" });
    }
    if (w.history.length) {
      const history = this.details(scroll, "history", "Changed files and recovery");
      for (const journal of w.history.slice(0, 10)) {
        const item = history.createDiv({ cls: "y-ai-card" }); item.createEl("strong", { text: `${new Date(journal.createdAt).toLocaleString()} · ${journal.status}` });
        for (const op of journal.operations) item.createEl("p", { text: `${op.kind}: ${op.path}${op.target ? ` → ${op.target}` : ""} · ${op.status}`, cls: "y-ai-hint" });
        this.button(item, "Undo this task", () => void w.undo(journal), w.settingsLocked || journal.status === "undone");
      }
    }
    if (w.preview) { const preview = this.details(scroll, "preview", "Data to be sent · initial preview"); preview.open = true; preview.createEl("pre", { text: w.preview }); }
    const dock = el.createDiv({ cls: "y-ai-dock" });
    const compose = dock.createDiv({ cls: "y-ai-compose" });
    const prompt = compose.createEl("textarea", { text: w.prompt, attr: { rows: "3", "aria-label": "Ask Yoofloe AI", placeholder: w.source ? "What should we do with your notes?" : "Describe a document to create…" } }); prompt.disabled = w.settingsLocked; prompt.maxLength = 32000;
    const privacy = dock.createEl("p", { cls: "y-ai-hint" });
    const full = privacy.createSpan({ cls: "y-ai-privacy-full" }); full.appendText("OpenAI · API charges · "); full.createSpan({ text: requestLimitLabel(w.maximum), cls: "y-ai-limit-caption" }); full.appendText(`. ${w.mode === "ask" ? "Read only" : `Edits: ${SCOPE_LABELS[w.writeScope]}`}.`);
    privacy.createSpan({ text: `OpenAI · paid · ${requestLimitLabel(w.maximum)}`, cls: "y-ai-privacy-short" });
    const tiny = privacy.createSpan({ text: "OpenAI · paid", cls: "y-ai-privacy-tiny" });
    if (w.task?.requests) { full.appendText(` ${w.busy || w.canContinue ? "Used" : "Last task"} ${w.task.requests} · ${w.task.usage.input + w.task.usage.output} tokens.`); if (w.busy || w.canContinue) tiny.createSpan({ text: ` · ${w.task.requests} used`, cls: "y-ai-usage-tiny" }); }
    privacy.setAttribute("title", "Data goes directly to OpenAI, including relevant note excerpts within the permitted scope. Local key storage does not make AI local. New notes may be created in the output folder.");
    const controls = dock.createDiv({ cls: "y-ai-row" });
    const run = this.button(controls, w.busy ? w.canStop ? "Stop" : w.stopping ? "Stopping…" : "Finishing…" : w.canContinue ? "Continue" : "Send", () => { if (w.busy) w.stop(); else { prompt.blur(); void w.run(); } }, w.busy ? !w.canStop : !this.actionReady(), `y-ai-send ${w.busy ? "mod-warning" : "mod-cta"}`);
    run.title = w.busy ? "Stop future requests and file actions; keep completed work and any already-sent answer" : `Send permitted data directly to OpenAI · API charges · ${requestLimitLabel(w.maximum)}`;
    prompt.addEventListener("input", () => { w.setPrompt(prompt.value); run.disabled = !this.actionReady(); this.saveSoon(); });
    prompt.addEventListener("keydown", event => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !run.disabled && !w.busy) { event.preventDefault(); run.click(); } });
    scroll.scrollTop = follow ? scroll.scrollHeight : oldScroll; el.scrollTop = oldRootScroll;
  }
  private watchViewport(): () => void {
    const root = this.contentEl, doc = root.ownerDocument, win = doc.defaultView; if (!win) return () => {};
    const viewport = win.visualViewport; let timer = 0, settleTimer = 0, frame = 0;
    const chrome = Array.from(doc.querySelectorAll<HTMLElement>(".mobile-navbar, .status-bar"));
    const resize = () => {
      const keyboard = parseFloat(win.getComputedStyle(doc.body).getPropertyValue("--keyboard-height")) || 0;
      const visual = !!viewport && win.innerHeight - viewport.height > 80;
      root.classList.toggle("y-ai-keyboard", keyboard > 50 || visual);
      const bounds = root.getBoundingClientRect(), bottom = viewport ? viewport.offsetTop + viewport.height : win.innerHeight;
      const overlays = chrome.filter(el => { const style = win.getComputedStyle(el); return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0; }).map(el => el.getBoundingClientRect());
      const available = availableViewHeight(bounds, root.parentElement?.getBoundingClientRect().bottom ?? bottom, bottom - (visual ? 0 : keyboard), overlays);
      const height = `${available}px`; if (root.style.maxHeight !== height) root.style.maxHeight = height;
      root.classList.toggle("y-ai-compact", available < 340);
      root.classList.toggle("y-ai-short", available < 340 && !(keyboard > 50 || visual));
      root.classList.toggle("y-ai-tiny", available < 190 && (keyboard > 50 || visual));
      if (root.classList.contains("y-ai-tiny")) root.scrollTop = 0;
      win.clearTimeout(timer); timer = win.setTimeout(() => { const active = doc.activeElement; if (active !== null && active.instanceOf(HTMLElement) && root.contains(active) && active.matches("textarea,input,select")) active.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" }); }, 350);
    };
    const focus = () => { const active = doc.activeElement; root.classList.toggle("y-ai-editing-scope", active !== null && active.instanceOf(HTMLElement) && !!active.closest(".y-ai-scroll") && active.matches("input,textarea")); resize(); };
    const settledResize = () => { resize(); win.clearTimeout(settleTimer); settleTimer = win.setTimeout(resize, 350); };
    const observer = new win.MutationObserver(settledResize); observer.observe(doc.body, { attributes: true, attributeFilter: ["style", "class"] }); observer.observe(doc.documentElement, { attributes: true, attributeFilter: ["style"] });
    for (const el of chrome) observer.observe(el, { attributes: true, attributeFilter: ["class", "style"] });
    const geometry = new win.ResizeObserver(() => { win.cancelAnimationFrame(frame); frame = win.requestAnimationFrame(settledResize); });
    for (const el of [root, root.parentElement, ...chrome]) if (el) geometry.observe(el);
    viewport?.addEventListener("resize", settledResize); viewport?.addEventListener("scroll", settledResize); win.addEventListener("resize", settledResize); root.addEventListener("focusin", focus); root.addEventListener("focusout", focus); settledResize();
    return () => { observer.disconnect(); geometry.disconnect(); win.cancelAnimationFrame(frame); viewport?.removeEventListener("resize", settledResize); viewport?.removeEventListener("scroll", settledResize); win.removeEventListener("resize", settledResize); root.removeEventListener("focusin", focus); root.removeEventListener("focusout", focus); win.clearTimeout(timer); win.clearTimeout(settleTimer); };
  }
}

/** Keep old layout state recoverable while offering the single current workspace. No legacy network code is loaded. */
export class LegacyYoofloeView extends ItemView {
  private savedState: Record<string, unknown> = {};
  constructor(leaf: WorkspaceLeaf, private readonly legacyType: string, private readonly openAi: () => void) { super(leaf); }
  getViewType(): string { return this.legacyType; }
  getDisplayText(): string { return "Yoofloe AI"; }
  getIcon(): string { return "sparkles"; }
  getState(): Record<string, unknown> { return this.savedState; }
  setState(state: Record<string, unknown>): Promise<void> { this.savedState = state; return Promise.resolve(); }
  onOpen(): Promise<void> {
    const el = this.contentEl; el.empty(); el.classList.add("yoofloe-ai"); const card = el.createDiv({ cls: "y-ai-card" });
    card.createEl("h3", { text: "Yoofloe AI" }); card.createEl("p", { text: "Writer and capture are now one workspace. Existing Markdown, settings and this panel’s saved state are kept." });
    const b = card.createEl("button", { text: "Open Yoofloe AI", cls: "mod-cta" }); b.addEventListener("click", () => this.openAi()); return Promise.resolve();
  }
}
