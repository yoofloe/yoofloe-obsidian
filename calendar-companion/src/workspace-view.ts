import { Component, ItemView, MarkdownRenderer, Modal, Notice, Platform, setIcon, setTooltip, type WorkspaceLeaf } from "obsidian";
import { AiWorkspace } from "./workspace";
import { MODE_LABELS, SCOPE_LABELS, WRITE_SCOPE_LABELS } from "./agent-policy";
import { AREA_LABELS, PERIOD_LABELS } from "./question-query";
import { safeNoteMarkdown } from "./note-context";
import { VaultFolderPicker } from "./folder-picker";
import { availableViewHeight } from "./view-bounds";
import { DATA_FLOW_NOTICE, LOCAL_DATA_NOTICE, OPENAI_DATA_NOTICE, CONTROL_NOTICE, PRIVACY_URL, OPENAI_DATA_URL } from "./privacy-copy";
import { customRequestLimit, requestLimitLabel } from "./request-limit";
import { generatedCachePath } from "./generated-files";
import { ATTACHMENT_LIMIT_LABEL, PASTED_TEXT_THRESHOLD } from "./attachments";
import { FOLLOW_UP_LIMIT, FOLLOW_UP_TEXT_LIMIT, type FollowUpMode } from "./follow-ups";
import { formatWorkDuration } from "./work-activity";
import { AUTO_COMPACT_TOKENS } from "./conversation-context";
import { CONVERSATION_NAME_LIMIT, MAX_CONVERSATIONS, MAX_FOLDERS, turnConversation, type Conversation } from "./conversation-library";
import type { SharedVersionChoice } from "./shared-conversations";
import { CHAT_HISTORY_LIMIT, chatMatches, confirmedChangeCount, searchChatPreview, taskFailure, type ChatTurn } from "./chat-history";
import { selectionLabel } from "./selection-reference";
import { ReferenceModal } from "./reference-modal";
import { budgetLabel } from "./input-budget";
import { InputBudgetModal } from "./input-budget-modal";
import { calendarChangeCard, calendarChangeToggle, workspaceCalendarChangeToggle } from "./calendar-change-view";
import { renderCalendarWorkspacePanel } from "./calendar-workspace-panel";
import { renderChronoHudPanel } from "./chronohud-panel";
import { ChatCopyControls } from "./chat-copy-view";
import { ComposerOptions } from "./composer-options";

export const AI_VIEW = "yoofloe-ai";
const CALENDAR_STORE = "https://play.google.com/store/apps/details?id=com.yoofloe.calendar";
const CHRONOHUD_STORE = "https://play.google.com/store/apps/details?id=com.yoofloe.chronohud";
const FOLLOW_UP_LABELS = { queue: "Queue after this task", steer: "Steer the current task" };
const COMPOSER_ACTIONS = {
  send: { label: "Send", icon: "arrow-up" },
  continue: { label: "Continue", icon: "play" },
  stop: { label: "Stop", icon: "square" },
  stopping: { label: "Stopping…", icon: "loader-circle" },
  finishing: { label: "Finishing…", icon: "loader-circle" },
};
const WORK_STATUS = { running: "Working…", paused: "Paused at request limit", completed: "Completed", stopped: "Stopped", failed: "Could not finish" };
const ACTIVITY_ICON = { working: "loader-circle", done: "check", waiting: "clock-3", blocked: "triangle-alert" };
const ACTIVITY_LABEL = { working: "In progress", done: "Done", waiting: "Waiting", blocked: "Needs attention" };
const QUEUE_STATUS = { queued: "Queued", "steer-pending": "Waiting to steer", sending: "Sending", review: "Review before sending" };
type ViewOptions = { settings(): void; chooseNote(): void; hide(): void };
type ViewLayout = "chat" | "settings";
const nearLatest = (messages: HTMLElement) => messages.scrollHeight - messages.clientHeight - messages.scrollTop <= 8;
/** One compact, theme-native surface shared by desktop and mobile. No data is read on view construction. */
export class YoofloeAiView extends ItemView {
  private unsubscribe: (() => void) | null = null;
  private stopViewport: (() => void) | null = null;
  private rendering: Component | null = null;
  private saveTimer: number | undefined;
  private durationTimer: number | undefined;
  private budgetTimer: number | undefined;
  private budgetEpoch = 0;
  private followUpClosed = false;
  private composing = false;
  private pendingRender = false;
  private selectingText = false;
  private stopSelectionWatch: (() => void) | null = null;
  private readonly chatCopy: ChatCopyControls;
  private readonly composerOptions: ComposerOptions;
  private libraryOpen = false;
  private libraryEdit: { kind: "conversation" | "folder"; id: string | null; name: string } | null = null;
  private libraryError = "";
  private olderChats: ChatTurn[] = [];
  private olderOffset: number | null = 0;
  private loadingOlder = false;
  private lastConversationId = "";
  private queueSignature = "";
  private renderedTurn: ChatTurn | null = null;
  private openDetails = new Set<string>();
  private chatVisible = 10;
  private followChat = true;
  private renderedReady = false;
  private chatQuery = "";
  private searchResults: ChatTurn[] = [];
  private searchNext: number | null = null;
  private searching = false;
  private searchEpoch = 0;
  private searchTimer: number | undefined;
  private generatedVisible = new Map<string, number>();
  private layout: ViewLayout = "chat";
  private savedChatScroll = 0;
  private savedSearchScroll = 0;
  private savedSettingsScroll = 0;
  private readChatPosition: (() => void) | null = null;
  private stopOpeningChatFollow: (() => void) | null = null;
  private readonly settingsId = `yoofloe-settings-${crypto.randomUUID()}`;
  constructor(leaf: WorkspaceLeaf, readonly work: AiWorkspace, private readonly options: ViewOptions) {
    super(leaf);
    this.chatCopy = new ChatCopyControls(() => this.work, this.contentEl,
      () => [...this.olderChats, ...this.searchResults, ...this.work.chat], () => this.render());
    this.composerOptions = new ComposerOptions(this.app, this.contentEl, () => this.work, () => this.options.settings(), () => this.saveSoon());
  }
  getViewType(): string { return AI_VIEW; }
  getDisplayText(): string { return "Yoofloe"; }
  getIcon(): string { return "sparkles"; }
  async onOpen(): Promise<void> {
    this.contentEl.classList.add("yoofloe-ai"); this.unsubscribe = this.work.subscribe(change => {
      if (this.selectingText || this.chatCopy.selection()) { this.pendingRender = true; this.refreshComposer(); return; }
      if (change === "progress" || this.composing || this.followUpFocused()) {
        if (change === "state") this.pendingRender = true;
        this.refreshProgress();
      } else this.render();
    });
    const win = this.contentEl.ownerDocument.defaultView;
    if (win) {
      const doc = this.contentEl.ownerDocument;
      const restoreUpdates = () => {
        if (this.pendingRender && !this.selectingText && !this.chatCopy.selection() && !this.composing && !this.followUpFocused()) {
          this.pendingRender = false; this.render();
        }
      };
      const endSelection = () => { this.selectingText = false; restoreUpdates(); };
      doc.addEventListener("selectionchange", restoreUpdates);
      doc.addEventListener("pointerup", endSelection);
      doc.addEventListener("pointercancel", endSelection);
      this.stopSelectionWatch = () => {
        doc.removeEventListener("selectionchange", restoreUpdates);
        doc.removeEventListener("pointerup", endSelection);
        doc.removeEventListener("pointercancel", endSelection);
      };
      this.durationTimer = win.setInterval(() => this.updateElapsed(), 1000);
    }
    this.stopViewport = this.watchViewport(); this.render(); await this.work.initialize();
  }
  async onClose(): Promise<void> {
    this.composerOptions.close();
    this.stopSelectionWatch?.(); this.stopSelectionWatch = null; this.selectingText = false; this.chatCopy.reset();
    this.budgetEpoch++;
    this.contentEl.ownerDocument.defaultView?.clearTimeout(this.budgetTimer);
    this.searchEpoch++; if (this.searchTimer !== undefined) this.contentEl.ownerDocument.defaultView?.clearTimeout(this.searchTimer);
    this.unsubscribe?.(); this.stopViewport?.(); this.rendering?.unload();
    this.readChatPosition = null; this.stopOpeningChatFollow = null;
    this.contentEl.ownerDocument.defaultView?.clearInterval(this.durationTimer);
    if (this.saveTimer !== undefined) this.contentEl.ownerDocument.defaultView?.clearTimeout(this.saveTimer);
    await this.work.persist().catch(() => {});
  }
  private saveSoon(): void {
    this.scheduleBudget();
    const win = this.contentEl.ownerDocument.defaultView; if (!win) return;
    win.clearTimeout(this.saveTimer); this.saveTimer = win.setTimeout(() => { void this.work.persist().catch(() => new Notice("The draft could not be saved locally. Keep this view open.")); }, 400);
  }
  private scheduleBudget(): void {
    const win = this.contentEl.ownerDocument.defaultView;
    if (!win) return;
    win.clearTimeout(this.budgetTimer);
    const epoch = ++this.budgetEpoch;
    this.budgetTimer = win.setTimeout(() => {
      const button = this.contentEl.querySelector<HTMLButtonElement>(".y-ai-input-budget");
      if (!button || this.composing || !this.work.ready) return;
      void this.work.estimateRequest(this.showFollowUp).then(budget => {
        if (epoch !== this.budgetEpoch || !button.isConnected) return;
        button.setText(budgetLabel(budget));
        button.onclick = () => new InputBudgetModal(this.app, budget, this.work.task?.usage ?? { input: 0, output: 0 }).open();
        setTooltip(button, "Estimated input size. Click for details.");
      }).catch(error => {
        if (epoch !== this.budgetEpoch || !button.isConnected) return;
        button.setText("Review input");
        const message = error instanceof Error ? error.message : "The input preview is unavailable.";
        button.onclick = () => new Notice(message);
        setTooltip(button, message);
      });
    }, 350);
  }
  private button(el: HTMLElement, text: string, action: () => void, disabled = false, cls = ""): HTMLButtonElement {
    const b = el.createEl("button", { text, cls, attr: { type: "button" } }); b.disabled = disabled; b.addEventListener("click", action); return b;
  }
  private details(el: HTMLElement, key: string, title: string): HTMLDetailsElement {
    const d = el.createEl("details", { cls: "y-ai-details", attr: { "data-section": key } }); d.open = this.openDetails.has(key); d.createEl("summary", { text: title });
    d.addEventListener("toggle", () => { if (!d.isConnected) return; if (d.open) this.openDetails.add(key); else this.openDetails.delete(key); }); return d;
  }
  private settingSummary(details: HTMLDetailsElement, title: string, value: string, icon: string): void {
    const summary = details.querySelector("summary"); if (!summary) return; summary.empty();
    const symbol = summary.createSpan({ cls: "y-ai-setting-icon" }); setIcon(symbol, icon);
    const copy = summary.createSpan({ cls: "y-ai-setting-copy" }); copy.createEl("strong", { text: title }); if (value) setTooltip(copy.createEl("small", { text: value }), value);
    const chevron = summary.createSpan({ cls: "y-ai-setting-chevron" }); setIcon(chevron, "chevron-down");
  }
  private select<T extends string>(el: HTMLElement, label: string, values: Record<T, string>, selected: T, change: (value: T) => void, allowPaused = false): HTMLSelectElement {
    const wrap = el.createEl("label", { cls: "y-ai-field" }); wrap.createSpan({ text: label });
    const select = wrap.createEl("select", { attr: { "aria-label": label } });
    for (const [value, text] of Object.entries(values)) select.createEl("option", { text: String(text), value }); select.value = selected; select.disabled = this.work.busy || !allowPaused && this.work.canContinue;
    select.addEventListener("change", () => { change(select.value as T); this.work.preview = ""; this.saveSoon(); }); return select;
  }
  private actionReady(): boolean {
    const w = this.work; return !w.busy && !w.modelSaving && !w.addingAttachments && w.ready && w.configured && !w.limitProblem && (w.canContinue ? w.canResumeWithLimit : w.hasDraft);
  }
  private get settingsExpanded(): boolean { return this.layout === "settings"; }
  private showLayout(section: ViewLayout): void {
    if (this.layout !== section || this.libraryOpen) {
      this.layout = section;
      this.libraryOpen = false;
      this.render();
    }
    this.contentEl.querySelector<HTMLButtonElement>(`[data-view-layout="${section}"]`)?.focus({ preventScroll: true });
  }
  private tabId(section: ViewLayout): string { return `${this.settingsId}-tab-${section}`; }
  private viewTabs(parent: HTMLElement, chatId: string): void {
    const group = parent.createDiv({ cls: "y-ai-view-tabs", attr: { role: "tablist", "aria-label": "Workspace views" } });
    for (const section of ["chat", "settings"] as const) {
      const active = this.layout === section;
      const button = this.button(group, section === "chat" ? "Chat" : "Settings", () => this.showLayout(section));
      button.dataset.viewLayout = section;
      button.id = this.tabId(section);
      button.tabIndex = active ? 0 : -1;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", String(active));
      button.setAttribute("aria-controls", section === "chat" ? chatId : this.settingsId);
      button.addEventListener("keydown", event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        this.showLayout(event.key === "Home" ? "chat" : event.key === "End" ? "settings" : section === "chat" ? "settings" : "chat");
      });
    }
  }
  private refreshLimitDisclosure(): void {
    const w = this.work, label = requestLimitLabel(w.maximum);
    this.contentEl.querySelectorAll<HTMLElement>(".y-ai-limit-caption").forEach(el => el.setText(label));
    this.contentEl.querySelector<HTMLElement>(".y-ai-api-limit")?.setText(this.apiLimit());
    this.contentEl.querySelector(".y-ai-api > summary")?.setAttribute("aria-label", this.apiDisclosureLabel());

  }
  private limitControl(el: HTMLElement): void {
    const w = this.work, presets = { "1": "1 request", custom: "Custom…", none: "No limit" };
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
      wrap.createEl("small", { text: "Positive whole numbers, such as 20 or 50. This counts model responses and audio transcriptions. File transfer and cleanup requests are separate.", cls: "y-ai-hint" });
    }
    el.createEl("p", { text: w.maximum === "none" ? "No request-count limit: the task continues until it finishes or you stop it. API charges can accumulate. Context, rate and account limits still apply; repeated failures stop locally." : "One task may use several paid OpenAI requests. A finite limit pauses the task so you can choose whether to continue.", cls: "y-ai-hint" });
  }
  private onlineLimitControl(el: HTMLElement): void {
    const w = this.work, choices = { "1": "1 tool call", custom: "Custom…", none: "No limit" };
    const selected = w.customOnlineMaximum !== null ? "custom" : String(w.onlineMaximum) in choices ? String(w.onlineMaximum) : "custom";
    this.select(el, "Built-in tool calls per task", choices, selected, value => { w.customOnlineMaximum = value === "custom" ? String(w.onlineMaximum === "none" ? 8 : w.onlineMaximum) : null; w.onlineMaximum = value === "none" ? "none" : value === "custom" ? Number(w.customOnlineMaximum) : Number(value); this.render(); }, true);
    if (selected === "custom") {
      const label = el.createEl("label", { cls: "y-ai-field" }); label.createSpan({ text: "Custom tool count" });
      const input = label.createEl("input", { value: w.customOnlineMaximum ?? String(w.onlineMaximum), attr: { "aria-label": "Custom tool count", inputmode: "numeric", placeholder: "E.g. 20" } }); input.maxLength = 32; input.disabled = w.busy;
      const error = label.createSpan({ text: w.limitProblem, cls: "y-ai-limit-error", attr: { role: "status" } });
      input.addEventListener("input", () => { w.customOnlineMaximum = input.value; const count = customRequestLimit(input.value); if (count !== null) w.onlineMaximum = count; error.textContent = w.limitProblem; input.setAttribute("aria-invalid", String(!!w.limitProblem)); const send = this.contentEl.querySelector<HTMLButtonElement>(".y-ai-send"); if (send) send.disabled = !this.actionReady(); this.saveSoon(); });
    }
    el.createEl("p", { text: "Search, analysis and image calls are counted separately from API requests and have tool charges. Audio transcription uses an API request. Once the tool budget is spent, the model can finish using evidence already gathered.", cls: "y-ai-hint" });
  }
  private async searchConversation(more = false): Promise<void> {
    const query = this.chatQuery.trim(), epoch = ++this.searchEpoch;
    if (!query) { this.searchResults = []; this.searchNext = null; this.searching = false; this.render(); return; }
    const focused = this.contentEl.ownerDocument.activeElement === this.contentEl.querySelector(".y-ai-chat-search");
    if (!more) this.searchResults = this.work.chat.filter(turn => chatMatches(turn, query)).map(turn => searchChatPreview(turn, query));
    this.searching = true;
    try {
      const found = await this.work.searchChats(query, more ? this.searchNext ?? 0 : 0);
      if (epoch !== this.searchEpoch || !this.work.current) return;
      const ids = new Set(this.searchResults.map(turn => turn.id)); for (const turn of found.turns) if (!ids.has(turn.id)) { this.searchResults.push(turn); ids.add(turn.id); }
      this.searchNext = found.nextOffset;
      if (found.unavailable) this.work.message = "Some saved messages could not be verified. The available results are shown.";
    } catch { if (epoch === this.searchEpoch) this.work.message = "Some local conversations could not be searched. Existing files are kept."; }
    finally {
      if (epoch === this.searchEpoch && this.work.current) {
        this.searching = false;
        if (this.selectingText || this.chatCopy.selection()) this.pendingRender = true;
        else { this.render(); if (focused) { const input = this.contentEl.querySelector<HTMLInputElement>(".y-ai-chat-search"); input?.focus({ preventScroll: true }); input?.setSelectionRange(input.value.length, input.value.length); } }
      }
    }
  }
  private refreshConversationView(): void {
    if (this.selectingText || this.chatCopy.selection()) { this.pendingRender = true; this.refreshComposer(); }
    else this.render();
  }
  private highlight(el: HTMLElement): void {
    const query = this.chatQuery.trim().toLocaleLowerCase(); if (!query) return;
    const walker = el.ownerDocument.createTreeWalker(el, 4), nodes: Text[] = []; let node = walker.nextNode();
    while (node && nodes.length < 2000) { if (!node.parentElement?.closest("mark")) nodes.push(node as Text); node = walker.nextNode(); }
    for (const text of nodes) { const index = text.data.toLocaleLowerCase().indexOf(query); if (index < 0) continue; const after = text.splitText(index), tail = after.splitText(query.length), mark = el.createEl("mark", { text: after.data }); after.replaceWith(mark); void tail; }
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
      this.highlight(result);
    }).catch(() => { if (result.isConnected) { result.empty(); result.createEl("pre", { text }); result.inert = false; } });
  }
  private conversation(el: HTMLElement): void {
    const w = this.work;
    const visible = this.olderChats.length ? [...new Map([...this.olderChats, ...w.chat].map(turn => [turn.id, turn])).values()]
      .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0)) : w.chat;
    if (!this.chatQuery && this.olderOffset !== null && w.chat.length >= CHAT_HISTORY_LIMIT) {
      this.button(el, this.loadingOlder ? "Loading earlier messages…" : "Load earlier messages", () => void this.loadEarlierChats(), this.loadingOlder);
    }
    if (!this.chatQuery && visible.length > this.chatVisible) this.button(el, `Show ${Math.min(10, visible.length - this.chatVisible)} earlier task(s)`, () => { this.chatVisible += 10; this.render(); });
    if (this.chatQuery) { el.createEl("p", { text: `${this.searchResults.length} matching conversation(s)${this.searching ? " · searching…" : ""} · local search`, cls: "y-ai-hint", attr: { role: "status" } }); if (this.searchNext !== null) this.button(el, "Search more saved history", () => void this.searchConversation(true), this.searching); }
    const conversation = el.createDiv({ cls: "y-ai-chat", attr: { "aria-label": "Conversation" } });
    for (const turn of (this.chatQuery ? this.searchResults : visible.slice(-this.chatVisible))) this.renderTurn(conversation, turn);
  }
  private renderTurn(conversation: HTMLElement, turn: ChatTurn): HTMLElement {
    const w = this.work;
    const labels: Record<string, string> = { edit: "Updated", create: "Created", rename: "Renamed", folder: "Created folder", trash: "Moved to trash", properties: "Updated properties", asset: "Saved attachment" };
    const exchange = conversation.createEl("article", { cls: "y-ai-exchange", attr: { "data-turn-id": turn.id } });
    const owner = turnConversation(turn.conversationId);
    if (this.chatQuery && owner !== w.library.active) {
      const thread = w.library.conversations.find(item => item.id === owner);
      if (thread) this.button(exchange, thread.name || "Open conversation", () => void this.chooseConversation(thread), !w.canSwitchConversation, "y-ai-search-conversation");
    }
    if (turn.request || turn.attachments?.length) {
      const user = exchange.createDiv({ cls: "y-ai-message y-ai-user" }); user.createEl("strong", { text: "You", cls: "y-ai-message-label" }); user.createEl("p", { text: turn.request, cls: "y-ai-request-text" });
      if (turn.attachments?.length) { const files = user.createDiv({ cls: "y-ai-sent-files" }); for (const file of turn.attachments) files.createSpan({ text: file.name, cls: "y-ai-sent-file" }); this.button(files, "Attach again", () => w.useAttachments(turn.attachments!), w.settingsLocked); }
      if (turn.reference) {
        const reference = turn.reference;
        const source = this.button(user, selectionLabel(reference), () => new ReferenceModal(this.app, w, reference, {
          followUp: this.showFollowUp, snapshot: turn.referenceSnapshot,
        }).open(), false, "y-ai-sent-reference");
        setTooltip(source, "View the reference used for this message");
      }
      this.chatCopy.decorate(user, turn, "user");
    }
    const assistant = exchange.createDiv({ cls: "y-ai-message y-ai-assistant", attr: { "aria-label": "Assistant response" } });
    const metadata = this.details(assistant, "turn-" + turn.id, "");
    metadata.classList.add("y-ai-work");
    const summary = metadata.querySelector("summary")!;
    summary.createSpan({ cls: "y-ai-work-label" });
    summary.createSpan({ cls: "y-ai-work-duration", attr: { "aria-label": "Task duration" } });
    summary.createSpan({ cls: "y-ai-work-mode" });
    this.updateWorkHeading(metadata, turn);
    const progress = metadata.createDiv({ cls: "y-ai-work-progress" });
    this.renderWorkDetails(progress, turn);
    for (const file of turn.attachments ?? []) metadata.createEl("p", { text: `Attached: ${file.name}`, cls: "y-ai-hint" });
    if (turn.actions.length) { const actions = metadata.createDiv({ cls: "y-ai-chat-actions" }); for (const action of turn.actions) actions.createEl("p", { text: `${labels[action.kind] ?? "Changed"}: ${action.path}${action.target ? ` → ${action.target}` : ""}`, cls: "y-ai-hint" }); }
    if ((turn.actionTotal ?? 0) > turn.actions.length) assistant.createEl("p", { text: `${turn.actionTotal} confirmed operations in total. Recent actions are shown here; all recovery segments are kept under changed files and recovery.`, cls: "y-ai-hint" });
    else if (!turn.actions.length && turn.status === "completed" && turn.actionsKnown) metadata.createEl("p", { text: "No file changes were recorded for this task.", cls: "y-ai-hint" });
    if (turn.answer) this.markdown(assistant, turn.answer, turn.sourcePath ?? "");
    if (turn.sources?.length) { const sources = this.details(assistant, "sources-" + turn.id, `Sources · ${turn.sources.length}`); for (const source of turn.sources) sources.createEl("p").createEl("a", { text: source.title || source.url, href: source.url, attr: { target: "_blank", rel: "noopener noreferrer" } }); }
    const failure = taskFailure(turn);
    if (failure) assistant.createEl("p", { text: failure, cls: "y-ai-task-error" });
    const warnings = new Set(turn.fileWarnings);
    if (turn.uploadCleanupWarning) warnings.add(turn.uploadCleanupWarning);
    for (const warning of warnings) assistant.createEl("p", { text: warning, cls: "y-ai-file-warning", attr: { role: "status" } });
    const visibleFiles = this.generatedVisible.get(turn.id) ?? 4;
    if (turn.generated?.length) assistant.createEl("p", { text: "Generated files are cached locally. Save attachment copies a file to the output folder.", cls: "y-ai-hint" });
    for (const file of (turn.generated ?? []).slice(0, visibleFiles)) {
      const card = assistant.createDiv({ cls: "y-ai-generated" }); card.createSpan({ text: file.name });
      if (["png", "jpg", "jpeg", "webp"].includes(file.extension)) { const picture = card.createEl("img", { attr: { src: this.app.vault.adapter.getResourcePath(generatedCachePath(this.app.vault.configDir, file)), alt: file.name, loading: "lazy" } }); picture.addEventListener("error", () => { picture.hidden = true; }); }
      this.button(card, "Save attachment", () => { void w.saveGeneratedFile(turn.id, file.id, turnConversation(turn.conversationId)).then(saved => { if (saved && this.chatQuery) { const index = this.searchResults.findIndex(item => item.id === saved.id); if (index >= 0) this.searchResults[index] = saved; this.refreshConversationView(); } }); }, w.settingsLocked);
    }
    if ((turn.generated?.length ?? 0) > visibleFiles) this.button(assistant, "Show more generated files", () => { this.generatedVisible.set(turn.id, visibleFiles + 4); this.render(); });
    if (turn.requestTruncated || turn.answerTruncated || turn.generatedTruncated || turn.workDetailsTruncated) this.button(assistant, "Load full local conversation", () => { if (!this.chatQuery) void w.loadFullChat(turn.id); else void w.fullChat(turn.id, turnConversation(turn.conversationId)).then(full => { if (full && this.chatQuery) { const index = this.searchResults.findIndex(item => item.id === turn.id); if (index >= 0) this.searchResults[index] = full; this.refreshConversationView(); } }).catch(() => new Notice("The full local conversation could not be loaded.")); });
    this.chatCopy.decorate(assistant, turn, "assistant");
    this.highlight(exchange.querySelector<HTMLElement>(".y-ai-user") ?? exchange);
    return exchange;
  }
  private async loadEarlierChats(): Promise<void> {
    if (this.loadingOlder || this.olderOffset === null) return;
    const id = this.work.library.active;
    this.loadingOlder = true;
    this.render();
    try {
      const page = await this.work.searchChats("", this.olderOffset, id);
      if (id !== this.work.library.active || !this.work.current) return;
      this.olderChats = [...this.olderChats, ...page.turns];
      this.olderOffset = page.nextOffset;
      this.chatVisible += page.turns.length;
    } catch { new Notice("Earlier messages could not be loaded."); }
    finally {
      this.loadingOlder = false;
      this.refreshConversationView();
    }
  }
  private async chooseConversation(conversation: Conversation): Promise<void> {
    if (conversation.archived && !await this.work.changeConversation(conversation.id, { archived: false })) return;
    if (await this.work.openConversation(conversation.id)) {
      this.layout = "chat"; this.libraryOpen = false; this.chatQuery = ""; this.searchEpoch++;
      this.render();
    }
  }
  private async createConversation(folderId: string | null = null): Promise<void> {
    if (await this.work.createConversation(folderId)) { this.layout = "chat"; this.libraryOpen = false; this.chatQuery = ""; this.render(); }
  }
  private libraryButton(el: HTMLElement, label: string, icon: string, action: () => void, disabled = false, iconOnly = false): HTMLButtonElement {
    const button = this.button(el, "", action, disabled, iconOnly ? "clickable-icon y-ai-library-icon" : "y-ai-library-button");
    button.setAttribute("aria-label", label);
    if (iconOnly) setTooltip(button, label);
    setIcon(button.createSpan({ cls: "y-ai-library-symbol", attr: { "aria-hidden": "true" } }), icon);
    if (!iconOnly) button.createSpan({ text: label });
    return button;
  }
  private editLibraryName(kind: "conversation" | "folder", id: string | null, name = ""): void {
    this.libraryEdit = { kind, id, name }; this.libraryError = "";
    this.render();
    const field = this.contentEl.querySelector<HTMLInputElement>(".y-ai-library-name");
    field?.focus(); field?.select();
  }
  private libraryNameEditor(el: HTMLElement): void {
    const edit = this.libraryEdit;
    if (!edit) return;
    const w = this.work, form = el.createEl("form", { cls: "y-ai-library-editor" });
    const name = edit.kind === "folder" ? "Folder name" : "Conversation name";
    const field = form.createEl("input", { value: edit.name, cls: "y-ai-library-name", attr: { type: "text", "aria-label": name, placeholder: name, required: "" } });
    field.maxLength = CONVERSATION_NAME_LIMIT;
    field.addEventListener("input", () => { edit.name = field.value; });
    const row = form.createDiv({ cls: "y-ai-library-actions" });
    row.createEl("button", { text: "Save", cls: "mod-cta", attr: { type: "submit" } }).disabled = !w.canSwitchConversation;
    this.button(row, "Cancel", () => { this.libraryEdit = null; this.libraryError = ""; this.render(); });
    if (this.libraryError) form.createEl("p", { text: this.libraryError, cls: "y-ai-hint", attr: { role: "status" } });
    form.addEventListener("submit", event => {
      event.preventDefault();
      const save = edit.kind === "folder" ? w.changeFolder(edit.id, edit.name) : w.changeConversation(edit.id!, { name: edit.name });
      void save.then(ok => {
        if (ok) { this.libraryEdit = null; this.libraryError = ""; }
        else this.libraryError = "Choose a valid name. Folder names must be unique.";
        this.render();
      });
    });
  }
  private deleteConfirmation(conversation: Conversation): void {
    const work = this.work, modal = new Modal(this.app);
    const title = conversation.name || "New conversation";
    modal.setTitle("Delete conversation?");
    modal.contentEl.createEl("p", { text: `Delete “${title}” and its messages and drafts from this device?` });
    modal.contentEl.createEl("p", { text: conversation.shared
      ? "The vault copy stays available to other devices. Saved notes and API keys are kept."
      : "Saved notes and API keys are kept. Older copies in vault backups can still exist." });
    const actions = modal.contentEl.createDiv({ cls: "y-ai-library-actions" });
    this.button(actions, "Cancel", () => modal.close());
    this.button(actions, "Delete", () => {
      modal.close();
      if (this.work === work) void work.deleteConversation(conversation.id).then(deleted => {
        if (!deleted || this.work !== work) return;
        this.chatQuery = "";
        this.searchEpoch++;
        this.searchResults = [];
        this.searchNext = null;
        this.render();
      });
    }, !work.canSwitchConversation || !!conversation.shared?.stopping, "mod-warning");
    modal.open();
  }
  private syncConfirmation(conversation: Conversation, stop = false): void {
    const w = this.work, modal = new Modal(this.app);
    const title = stop ? "Stop syncing this conversation?" : "Sync this conversation with the vault?";
    modal.contentEl.createEl("h2", { text: title });
    modal.contentEl.createEl("p", { text: stop
      ? "Yoofloe keeps a device copy before removing the shared files. Other devices keep copies they already saved. Obsidian Sync can retain deleted files in its history."
      : "Anyone with access to this vault can read the shared conversation files. Confirm that your remote vault uses end-to-end encryption if you use Obsidian Sync." });
    if (!stop) modal.contentEl.createEl("a", { text: "Obsidian sync encryption", href: "https://obsidian.md/help/sync/security",
      attr: { target: "_blank", rel: "noopener noreferrer" } });
    const actions = modal.contentEl.createDiv({ cls: "y-ai-library-actions" });
    this.button(actions, "Cancel", () => modal.close());
    this.button(actions, stop ? "Stop syncing" : "Sync with this vault", () => {
      modal.close();
      if (this.work !== w) return;
      if (stop) void w.stopConversationSync(conversation.id);
      else void w.syncConversation(conversation.id);
    }, !w.canSwitchConversation, "mod-cta");
    modal.open();
  }
  private async chooseSyncedConversation(id: string, revision: string, preferredId?: string): Promise<void> {
    if (await this.work.openSyncedConversation(id, revision, preferredId)) {
      this.layout = "chat";
      this.libraryOpen = false;
      this.chatQuery = "";
      this.searchEpoch++;
      this.render();
    }
  }
  private syncedVersionButtons(el: HTMLElement, id: string, versions: readonly SharedVersionChoice[], entry?: Conversation): void {
    for (const version of versions) {
      const open = () => { void this.chooseSyncedConversation(id, version.revision, entry?.id); };
      const label = !version.ready ? "Waiting for sync" : entry?.shared?.revision === version.revision
        ? "Current device version" : entry && versions.length === 1 ? "Open vault update" : version.title;
      const button = this.libraryButton(el, label, "cloud", open, !this.work.canSwitchConversation ||
        !version.ready || entry?.shared?.revision === version.revision);
      if (versions.length > 1) {
        const detail = [new Date(version.at).toLocaleString(), version.lastRequest].filter(Boolean).join(" · ");
        setTooltip(button, detail);
        button.setAttribute("aria-label", label + " · " + detail);
        button.createEl("small", { text: detail });
      }
    }
  }
  private libraryConversation(el: HTMLElement, conversation: Conversation, showFolder = false): void {
    const w = this.work, title = conversation.name || "New conversation";
    const line = el.createDiv({ cls: "y-ai-library-row" });
    const open = this.libraryButton(line, title, conversation.pinned ? "pin" : "message-circle", () => void this.chooseConversation(conversation), conversation.id !== w.library.active && !w.canSwitchConversation);
    open.classList.add("y-ai-library-chat");
    if (conversation.archived) open.setAttribute("aria-label", `Restore and open ${title}`);
    if (conversation.id === w.library.active) open.setAttribute("aria-current", "true");
    if (showFolder && conversation.folderId) {
      const folder = w.library.folders.find(item => item.id === conversation.folderId);
      if (folder) open.createEl("small", { text: folder.name });
    }
    const menu = this.details(line, "manage-" + conversation.id, "");
    menu.classList.add("y-ai-library-menu");
    const summary = menu.querySelector("summary")!;
    summary.setAttribute("aria-label", `Manage ${title}`);
    setIcon(summary, "ellipsis");
    const actions = menu.createDiv({ cls: "y-ai-library-actions" });
    const addDelete = () => {
      if (w.supportsConversationDeletion)
        this.libraryButton(actions, "Delete", "trash-2", () => this.deleteConfirmation(conversation),
          !w.canSwitchConversation || !!conversation.shared?.stopping).setAttribute("aria-label", `Delete ${title}`);
    };
    if (conversation.archived) {
      this.libraryButton(actions, "Restore", "archive-restore", () => { void w.changeConversation(conversation.id, { archived: false }); }, !w.canSwitchConversation);
      addDelete();
      return;
    }
    this.libraryButton(actions, "Rename", "pencil", () => this.editLibraryName("conversation", conversation.id, title), !w.canSwitchConversation);
    this.libraryButton(actions, conversation.pinned ? "Unpin" : "Pin", conversation.pinned ? "pin-off" : "pin", () => { void w.changeConversation(conversation.id, { pinned: !conversation.pinned }); }, !w.canSwitchConversation);
    this.libraryButton(actions, "Archive", "archive", () => { void w.changeConversation(conversation.id, { archived: true }); }, !w.canSwitchConversation);
    addDelete();
    if (w.supportsConversationSync) {
      if (conversation.shared?.stopping) {
        this.libraryButton(actions, "Finish stopping sync", "cloud-off", () => { void w.stopConversationSync(conversation.id); }, !w.canSwitchConversation);
      } else if (w.isSharing(conversation)) {
        if (w.needsSyncRetry(conversation))
          this.libraryButton(actions, "Retry vault sync", "refresh-cw", () => { void w.syncConversation(conversation.id); }, !w.canSwitchConversation);
        else actions.createEl("small", { text: "Saved to vault" });
        const versions = w.syncedVersions(conversation);
        if (versions.length > 1) actions.createEl("small", { text: "Choose a version. Both versions are kept." });
        if (versions.some(version => version.revision !== conversation.shared?.revision))
          this.syncedVersionButtons(actions, conversation.shared!.id, versions, conversation);
        this.libraryButton(actions, "Stop syncing", "cloud-off", () => this.syncConfirmation(conversation, true), !w.canSwitchConversation);
      } else {
        actions.createEl("small", { text: "On this device" });
        this.libraryButton(actions, "Sync with this vault", "cloud-upload", () => this.syncConfirmation(conversation), !w.canSwitchConversation);
      }
    }
    if (w.library.folders.length) {
      const label = menu.createEl("label", { cls: "y-ai-field" }); label.createSpan({ text: "Move to folder" });
      const select = label.createEl("select", { attr: { "aria-label": `Move ${title} to folder` } });
      select.createEl("option", { value: "", text: "No folder" });
      for (const folder of w.library.folders) select.createEl("option", { value: folder.id, text: folder.name });
      select.value = conversation.folderId ?? "";
      select.disabled = !w.canSwitchConversation;
      select.addEventListener("change", () => { void w.changeConversation(conversation.id, { folderId: select.value || null }); });
    }
  }
  private renderLibrary(el: HTMLElement): void {
    const w = this.work;
    const panel = el.createEl("section", { cls: "y-ai-library-view", attr: { "aria-label": "Conversations" } });
    const top = panel.createDiv({ cls: "y-ai-library-toolbar" });
    this.libraryButton(top, "Back to chat", "chevron-left", () => { this.libraryOpen = false; this.render(); }, false, true);
    top.createEl("h3", { text: "Conversations" });
    this.libraryButton(top, "New conversation", "square-pen", () => void this.createConversation(), !w.canSwitchConversation || w.library.conversations.length >= MAX_CONVERSATIONS, true);
    this.libraryButton(top, "New folder", "folder-plus", () => this.editLibraryName("folder", null), !w.canSwitchConversation || w.library.folders.length >= MAX_FOLDERS, true);
    this.libraryNameEditor(panel);
    if (w.legacyConversationNotice) panel.createEl("p", { text: w.legacyConversationNotice, cls: "y-ai-hint" });
    if (w.libraryMessage) panel.createEl("p", { text: w.libraryMessage, cls: "y-ai-hint", attr: { role: "status" } });
    if (!w.canSwitchConversation && !w.librarySaving) panel.createEl("p", { text: "Conversation controls are available when the workspace is idle.", cls: "y-ai-hint" });
    const localShareIds = new Set(w.library.conversations.flatMap(item => item.shared ? [item.shared.id] : []));
    const hiddenShares = new Set(w.library.hiddenShared);
    const fromVault = w.sharedConversations.filter(item => !localShareIds.has(item.id) && !hiddenShares.has(item.id));
    if (w.sharedStatus) panel.createEl("p", { text: w.sharedStatus, cls: "y-ai-hint", attr: { role: "status" } });
    if (fromVault.length) {
      const group = panel.createDiv({ cls: "y-ai-library-group" });
      group.createEl("h4", { text: "From this vault" });
      for (const item of fromVault) {
        if (item.versions.length > 1) group.createEl("p", { text: "Choose a version. Both versions are kept.", cls: "y-ai-hint" });
        this.syncedVersionButtons(group, item.id, item.versions);
        if (item.problem && !item.versions.length) group.createEl("p", { cls: "y-ai-hint",
          text: item.problem === "waiting" ? "Waiting for the conversation files to sync." : "A vault conversation could not be verified." });
      }
    }
    const ordered = [...w.library.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
    const pinned = ordered.filter(item => !item.archived && item.pinned);
    if (pinned.length) {
      const group = panel.createDiv({ cls: "y-ai-library-group" });
      group.createEl("h4", { text: "Pinned" });
      for (const item of pinned) this.libraryConversation(group, item, true);
    }
    const folders = panel.createDiv({ cls: "y-ai-library-group" });
    if (w.library.folders.length) folders.createEl("h4", { text: "Folders" });
    for (const folder of w.library.folders) {
      const group = this.details(folders, "conversation-folder-" + folder.id, "");
      group.classList.add("y-ai-library-folder");
      const summary = group.querySelector("summary")!;
      setIcon(summary.createSpan({ cls: "y-ai-library-symbol" }), "folder");
      summary.createSpan({ text: folder.name });
      const actions = group.createDiv({ cls: "y-ai-library-actions y-ai-folder-actions" });
      this.libraryButton(actions, "New conversation", "plus", () => void this.createConversation(folder.id), !w.canSwitchConversation || w.library.conversations.length >= MAX_CONVERSATIONS);
      this.libraryButton(actions, "Rename folder", "pencil", () => this.editLibraryName("folder", folder.id, folder.name), !w.canSwitchConversation);
      this.libraryButton(actions, "Remove folder", "folder-minus", () => { void w.removeFolder(folder.id); }, !w.canSwitchConversation);
      for (const item of ordered.filter(item => !item.archived && !item.pinned && item.folderId === folder.id)) this.libraryConversation(group, item);
    }
    const loose = ordered.filter(item => !item.archived && !item.pinned && !item.folderId);
    for (const item of loose) this.libraryConversation(panel, item);
    const archived = ordered.filter(item => item.archived);
    if (archived.length) {
      const group = this.details(panel, "archived-conversations", "");
      group.classList.add("y-ai-library-folder");
      const summary = group.querySelector("summary")!;
      setIcon(summary.createSpan({ cls: "y-ai-library-symbol" }), "archive");
      summary.createSpan({ text: "Archived" });
      for (const item of archived) this.libraryConversation(group, item, true);
    }
  }
  private updateWorkHeading(metadata: HTMLElement, turn: ChatTurn): void {
    const label = turn.status === "running" && this.work.stopping ? "Stopping…" :
      turn.status === "paused" && turn.pausedForConnection ? "Paused for connection" :
      turn.status === "paused" && turn.pausedForInput ? "Paused at input verification" :
      turn.status === "failed" && confirmedChangeCount(turn) > 0 ? "Changes saved · Could not finish" : WORK_STATUS[turn.status];
    metadata.querySelector(".y-ai-work-label")?.setText(label);
    metadata.querySelector(".y-ai-work-mode")?.setText(turn.sourceMode === "expanded" ? "Expanded" : "Provided only");
    const duration = metadata.querySelector<HTMLElement>(".y-ai-work-duration");
    if (!duration) return;
    duration.toggleAttribute("data-work-live", turn.status === "running" && !this.chatQuery);
    duration.hidden = turn.durationMs === undefined;
    if (turn.durationMs !== undefined) duration.setText(formatWorkDuration(turn.durationMs));
  }
  private renderWorkDetails(el: HTMLElement, turn: ChatTurn): void {
    el.empty();
    el.createEl("p", { text: `${turn.model || "Saved conversation"} · ${turn.requests} API request(s)${turn.online ? ` · web ${turn.online.search} · analysis ${turn.online.analysis} · images ${turn.online.image}` : ""}${turn.transcriptions ? ` · audio ${turn.transcriptions}` : ""}`, cls: "y-ai-hint" });
    if (turn.inputTokens || turn.outputTokens)
      el.createEl("p", { text: `Task usage · ${turn.inputTokens.toLocaleString()} input · ${turn.outputTokens.toLocaleString()} output tokens`, cls: "y-ai-hint" });
    for (const coverage of turn.readCoverage ?? []) {
      if (!coverage.total) continue;
      const note = coverage.path.split("/").at(-1) ?? coverage.path;
      const scope = coverage.selection ? "Reference" : "Note";
      el.createEl("p", { text: `${scope} · ${note} · ${coverage.read.toLocaleString()} / ${coverage.total.toLocaleString()} characters read`, cls: "y-ai-hint" });
    }
    if (turn.activity?.length) {
      const timeline = el.createEl("ol", { cls: "y-ai-timeline", attr: { "aria-label": "Task activity" } });
      for (const event of turn.activity) {
        if (event.state === "blocked" && turn.fileWarnings?.includes(event.text)) continue;
        const row = timeline.createEl("li", { attr: { "data-state": event.state } });
        setIcon(row.createSpan({ cls: "y-ai-timeline-icon", attr: { "aria-label": ACTIVITY_LABEL[event.state] } }), ACTIVITY_ICON[event.state]);
        const copy = row.createDiv({ cls: "y-ai-timeline-copy" });
        if (event.kind === "summary") copy.createEl("small", { text: "OpenAI summary" });
        copy.createDiv({ text: event.text });
        row.createEl("time", { text: new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) });
      }
    }
    for (const note of turn.steers ?? []) {
      const steer = el.createDiv({ cls: "y-ai-steer-note" });
      steer.createEl("small", { text: "You · steer" });
      steer.createEl("p", { text: note.text, cls: "y-ai-request-text" });
    }
  }
  private updateElapsed(): void {
    const elapsed = this.work.task?.durationMs;
    if (elapsed === undefined) return;
    const duration = this.contentEl.querySelector<HTMLElement>("[data-work-live]");
    const label = formatWorkDuration(elapsed);
    if (duration && duration.textContent !== label) duration.setText(label);
  }
  private updateQueue(el: HTMLElement): void {
    const w = this.work;
    const signature = JSON.stringify([w.followUps, w.queueHeld, w.queueMessage, w.canResumeQueue, w.canSteer, w.followUpSaving, w.editingFollowUpId, w.busy]);
    if (signature === this.queueSignature) return;
    this.queueSignature = signature;
    const focus = el.contains(el.ownerDocument.activeElement) ? el.ownerDocument.activeElement?.getAttribute("aria-label") : null;
    el.empty();
    el.hidden = !w.followUps.length && !w.queueMessage;
    if (el.hidden) return;
    if (w.followUps.length) {
      const header = el.createDiv({ cls: "y-ai-queue-header" });
      header.createEl("strong", { text: `Follow-ups · ${w.followUps.length}` });
      if (w.queueHeld && w.followUps[0]?.status === "queued") this.button(header, "Resume queue", () => void w.resumeQueue(), !w.canResumeQueue);
      else if (!w.queueHeld && w.followUps.some(entry => entry.status === "queued")) this.button(header, "Pause queue", () => w.pauseQueue());
    }
    if (w.queueMessage) el.createEl("p", { text: w.queueMessage, cls: "y-ai-hint", attr: { role: "status" } });
    for (const [index, entry] of w.followUps.entries()) {
      const item = el.createEl("article", { cls: "y-ai-queue-entry" });
      item.createEl("small", { text: QUEUE_STATUS[entry.status] });
      item.createEl("p", { text: entry.text, cls: "y-ai-queue-text" });
      if (entry.context?.reference) item.createEl("small", { text: selectionLabel(entry.context.reference), cls: "y-ai-reference-label" });
      if (entry.context?.attachments.length) item.createEl("small", { text: `${entry.context.attachments.length} attachment(s)` });
      item.createEl("small", { text: `${entry.access.target ?? "No note attached"} · Read ${SCOPE_LABELS[entry.access.read]} · ${entry.access.write === "none" ? "Read only" : `Write ${WRITE_SCOPE_LABELS[entry.access.write]}`}`, cls: "y-ai-queue-access" });
      if (entry.status !== "queued" && entry.status !== "review") continue;
      const row = item.createDiv({ cls: "y-ai-queue-actions" });
      const edit = this.button(row, entry.status === "review" ? "Review" : "Edit", () => {
        if (w.editFollowUp(entry.id)) this.openFollowUp();
        else new Notice("Finish or close the additional draft first.");
      }, w.followUpSaving);
      edit.setAttribute("aria-label", `${edit.textContent} message ${index + 1}`);
      const remove = this.button(row, "Remove", () => void w.removeFollowUp(entry.id), w.followUpSaving);
      remove.setAttribute("aria-label", `Remove message ${index + 1}`);
      if (w.canSteerQueued(entry)) this.button(row, "Steer now", () => void w.steerQueued(entry)).setAttribute("aria-label", `Steer now · message ${index + 1}`);
    }
    if (focus) Array.from(el.querySelectorAll<HTMLButtonElement>("button")).find(button => button.getAttribute("aria-label") === focus)?.focus({ preventScroll: true });
  }
  private activeTurnChanged(turn: ChatTurn): boolean {
    const prior = this.renderedTurn;
    return !prior || prior.id !== turn.id || prior.answer !== turn.answer || prior.status !== turn.status ||
      prior.uploadCleanupWarning !== turn.uploadCleanupWarning || taskFailure(prior) !== taskFailure(turn) ||
      JSON.stringify([prior.actions, prior.sources, prior.generated, prior.fileWarnings]) !== JSON.stringify([turn.actions, turn.sources, turn.generated, turn.fileWarnings]);
  }
  private statusFeedback(): string {
    const w = this.work;
    const feedback = w.busy && w.task?.busy ? w.task.message : w.message;
    if (this.settingsExpanded || this.chatQuery) return feedback;
    const latest = w.chat.at(-1);
    return latest && (taskFailure(latest) === feedback || latest.fileWarnings?.includes(feedback)) ? "" : feedback;
  }
  private refreshProgress(): void {
    this.stopOpeningChatFollow?.();
    const el = this.contentEl, w = this.work, messages = el.querySelector<HTMLElement>(".y-ai-transcript-content");
    const turn = w.chat.at(-1);
    if (turn && messages && !this.chatQuery) {
      let conversation = messages.querySelector<HTMLElement>(".y-ai-chat");
      if (!conversation) {
        messages.querySelector(".y-ai-empty")?.remove();
        conversation = messages.createDiv({ cls: "y-ai-chat", attr: { "aria-label": "Conversation" } });
        messages.prepend(conversation);
      }
      const existing = conversation.querySelector<HTMLElement>(`[data-turn-id="${turn.id}"]`);
      if (existing && !this.activeTurnChanged(turn)) {
        const work = existing.querySelector<HTMLElement>(".y-ai-work");
        const progress = work?.querySelector<HTMLElement>(".y-ai-work-progress");
        if (work && progress) { this.updateWorkHeading(work, turn); this.renderWorkDetails(progress, turn); }
      } else {
        const focusedSummary = existing?.querySelector(".y-ai-work > summary") === el.ownerDocument.activeElement;
        const exchange = this.renderTurn(conversation, turn);
        if (existing) existing.replaceWith(exchange);
        if (focusedSummary) exchange.querySelector<HTMLElement>(".y-ai-work > summary")?.focus({ preventScroll: true });
        this.renderedTurn = { ...turn };
      }
    }
    const feedback = this.statusFeedback();
    const status = el.querySelector<HTMLElement>(".y-ai-status");
    if (status && status.textContent !== feedback) status.setText(feedback);
    const queue = el.querySelector<HTMLElement>(".y-ai-queue");
    if (queue) this.updateQueue(queue);
    this.refreshComposer();
  }
  private watchChatScroll(messages: HTMLElement, body: HTMLElement, jump: HTMLButtonElement, openAtLatest: boolean): void {
    const filtered = messages.hasAttribute("data-search-results");
    let scrollTop = messages.scrollTop;
    // Hold the initial position through late Markdown and image layout until someone starts reading or a task updates.
    const stopOpeningFollow = () => { openAtLatest = false; };
    this.stopOpeningChatFollow = stopOpeningFollow;
    messages.addEventListener("pointerdown", stopOpeningFollow, { passive: true });
    messages.addEventListener("keydown", stopOpeningFollow);
    const updateButton = () => {
      const focused = jump.ownerDocument.activeElement === jump;
      jump.hidden = filtered || !!this.chatQuery || messages.clientHeight < 52 || nearLatest(messages);
      if (jump.hidden && focused) messages.focus({ preventScroll: true });
    };
    const move = (top: number) => {
      messages.scrollTop = top;
      scrollTop = messages.scrollTop;
    };
    const goToLatest = () => {
      move(messages.scrollHeight);
      this.savedChatScroll = scrollTop;
    };
    jump.addEventListener("click", () => {
      if (filtered || this.chatQuery) return;
      this.followChat = true;
      goToLatest();
      updateButton();
    });
    const readPosition = () => {
      if (filtered || !messages.clientHeight || messages.scrollTop === scrollTop) return;
      scrollTop = messages.scrollTop;
      const atLatest = nearLatest(messages);
      // Re-rendering Markdown can briefly shorten the transcript and clamp scrollTop.
      if (atLatest && this.savedChatScroll > messages.scrollHeight - messages.clientHeight) return;
      this.savedChatScroll = scrollTop;
      this.followChat = atLatest;
      stopOpeningFollow();
    };
    this.readChatPosition = readPosition;
    messages.addEventListener("scroll", () => {
      readPosition();
      updateButton();
    }, { passive: true });

    const updateLayout = () => {
      if (messages.clientHeight && !filtered && !this.chatQuery && !this.selectingText && !this.chatCopy.selection()) {
        if (openAtLatest || this.work.autoScrollChat && this.followChat) goToLatest();
        else if (this.savedChatScroll > scrollTop) move(this.savedChatScroll);
      }
      updateButton();
    };
    // Measure the whole transcript, including late Markdown and image layout, without watching every text update.
    const win = messages.ownerDocument.defaultView;
    if (win) {
      const observer = new win.ResizeObserver(updateLayout);
      observer.observe(messages);
      observer.observe(body);
      this.rendering?.register(() => observer.disconnect());
    }
    updateLayout();
  }
  private followUpFocused(): boolean {
    const active = this.contentEl.ownerDocument.activeElement;
    return !!active && this.contentEl.contains(active) &&
      active.matches(".y-ai-follow-up-input, .y-ai-follow-up-actions button, .y-ai-close-follow-up");
  }
  private get showFollowUp(): boolean {
    const w = this.work;
    return !w.calendarDraftActive && (w.canStop || w.stopping || w.canContinue || !this.followUpClosed && !!(w.followUpDraft || w.editingFollowUpId));
  }
  private openFollowUp(): void {
    if (this.work.calendarDraftActive) return;
    this.followUpClosed = false;
    this.render();
    this.contentEl.querySelector<HTMLTextAreaElement>(".y-ai-follow-up-input")?.focus();
  }
  private apiLimit(): string { return this.work.maximum === "none" ? "No request limit" : requestLimitLabel(this.work.maximum); }
  private refreshComposer(): void {
    const el = this.contentEl, w = this.work;
    this.composerOptions.refresh();
    const reference = el.querySelector<HTMLButtonElement>(".y-ai-reference-trigger");
    const referenceAction = w.reference ? "preview" : w.canRestoreReference ? "restore" : "none";
    if (reference && reference.dataset.action !== referenceAction) {
      reference.dataset.action = referenceAction;
      reference.hidden = referenceAction === "none";
      if (!reference.hidden) {
        const label = referenceAction === "preview" ? "Preview selected reference" : "Restore reference";
        reference.setAttribute("aria-label", label);
        if (referenceAction === "preview") reference.setAttribute("aria-haspopup", "dialog");
        else reference.removeAttribute("aria-haspopup");
        setTooltip(reference, label);
        setIcon(reference, referenceAction === "preview" ? "text-select" : "undo-2");
      }
    }
    const followUp = el.querySelector<HTMLTextAreaElement>(".y-ai-follow-up-input");
    if (followUp) followUp.readOnly = w.followUpSaving;
    const run = el.querySelector<HTMLButtonElement>(".y-ai-send");
    if (run) {
      const action = w.busy ? w.canStop ? "stop" : w.stopping ? "stopping" : "finishing" : w.canContinue ? "continue" : "send";
      if (run.dataset.action !== action) {
        const { label, icon } = COMPOSER_ACTIONS[action];
        run.dataset.action = action;
        run.setAttribute("aria-label", label);
        setTooltip(run, label);
        setIcon(run, icon);
      }
      run.disabled = w.busy ? !w.canStop : !this.actionReady();
      run.hidden = !!followUp && !w.busy && !w.canContinue;
      run.classList.toggle("mod-warning", w.busy);
      run.classList.toggle("mod-cta", !w.busy);
    }
    const add = el.querySelector<HTMLButtonElement>(".y-ai-add-message");
    if (add) {
      add.hidden = w.calendarDraftActive || !!followUp || !w.followUpDraft;
      add.closest(".y-ai-dock")?.classList.toggle("y-ai-add-message-visible", !add.hidden);
    }
    const close = el.querySelector<HTMLButtonElement>(".y-ai-close-follow-up");
    if (close) {
      close.hidden = (w.busy || w.canContinue) && !w.editingFollowUpId;
      close.disabled = w.followUpSaving;
    }
    el.querySelectorAll<HTMLButtonElement>(".y-ai-submit-follow-up").forEach(submit => {
      const mode = submit.dataset.followUp;
      submit.classList.toggle("mod-cta", mode === w.followUpDefault);
      submit.disabled = w.calendarDraftActive || w.modelSaving || w.followUpSaving || w.addingAttachments || !w.followUpDraft.trim() || w.stopping ||
        w.followUps.length >= FOLLOW_UP_LIMIT && !w.editingFollowUpId || mode === "steer" && !w.canSteer;
    });
    this.composerOptions.fitLabels();
  }
  private followUpEditor(compose: HTMLElement, controls: HTMLElement): void {
    const w = this.work, wrap = compose.createDiv({ cls: "y-ai-follow-up" });
    const input = wrap.createEl("textarea", { text: w.followUpDraft, cls: "y-ai-follow-up-input", attr: { rows: "1", placeholder: "Add a message…", "aria-label": "Additional message" } });
    input.maxLength = FOLLOW_UP_TEXT_LIMIT;
    const updateDraft = () => {
      w.setFollowUpDraft(input.value);
      this.followUpClosed = false;
      if (!this.composing && !this.showFollowUp) {
        const focused = input.ownerDocument.activeElement === input;
        this.saveSoon();
        this.render();
        if (focused) this.contentEl.querySelector<HTMLTextAreaElement>(".y-ai-primary-prompt")?.focus({ preventScroll: true });
        return;
      }
      this.sizeComposerInput(input); this.refreshComposer(); this.saveSoon();
    };
    input.addEventListener("input", updateDraft);
    let afterComposition: FollowUpMode | undefined;
    const send = (mode: FollowUpMode) => {
      if (this.composing) {
        if (afterComposition === undefined) {
          afterComposition = mode;
          input.blur();
        }
        return;
      }
      void w.submitFollowUp(mode).then(saved => {
        if (!input.isConnected) return;
        if (saved && !this.showFollowUp) this.render();
        else if (input.value !== w.followUpDraft) {
          input.value = w.followUpDraft;
          this.sizeComposerInput(input);
        }
      });
    };
    input.addEventListener("compositionstart", () => { this.composing = true; });
    input.addEventListener("compositionend", () => {
      const mode = afterComposition;
      afterComposition = undefined;
      this.composing = false;
      updateDraft();
      if (mode !== undefined && input.isConnected) send(mode);
    });
    const actions = controls.createDiv({ cls: "y-ai-follow-up-actions", attr: { role: "group", "aria-label": "Follow-up actions" } });
    const queue = this.button(actions, "Queue", () => send("queue"), true, "y-ai-submit-follow-up");
    queue.dataset.followUp = "queue";
    setTooltip(queue, "Queue as a separate task");
    const steer = this.button(actions, "Steer", () => send("steer"), true, "y-ai-submit-follow-up");
    steer.dataset.followUp = "steer";
    setTooltip(steer, FOLLOW_UP_LABELS.steer);
    actions.addEventListener("pointerdown", event => {
      // A touch can blur the input before click. Keep the keyboard and button in place until submission.
      if (event.pointerType !== "mouse" && event.isPrimary && event.button === 0 && input.ownerDocument.activeElement === input) event.preventDefault();
    });
    const close = this.button(controls, "", () => {
      this.followUpClosed = true;
      if (w.editingFollowUpId) w.closeFollowUpEdit();
      this.render();
      const target = this.showFollowUp ? ".y-ai-follow-up-input" : w.followUpDraft ? ".y-ai-add-message" : ".y-ai-primary-prompt";
      this.contentEl.querySelector<HTMLElement>(target)?.focus({ preventScroll: true });
    }, false, "clickable-icon y-ai-close-follow-up");
    close.setAttribute("aria-label", "Close additional message");
    setTooltip(close, "Close additional message");
    setIcon(close, "x");
    input.addEventListener("keydown", event => {
      if (event.isComposing || this.composing) return;
      const action = w.followUpDefault === "steer" ? steer : queue;
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        if (!action.disabled) action.click();
      } else if (event.key === "Escape" && !close.hidden && !close.disabled) {
        event.preventDefault();
        close.click();
      }
    });
  }
  private sizeComposerInput(input: HTMLTextAreaElement): void {
    const win = input.ownerDocument.defaultView;
    if (!win || !input.offsetWidth) return;
    const style = win.getComputedStyle(input);
    const lineHeight = parseFloat(style.lineHeight);
    if (!Number.isFinite(lineHeight)) return;
    const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const border = input.offsetHeight - input.clientHeight;
    const max = Math.ceil(lineHeight * 3 + padding + border);
    const scroll = input.scrollTop;
    input.style.removeProperty("height");
    input.classList.remove("is-overflowing");
    const natural = input.scrollHeight + border;
    const overflow = natural > max;
    input.setCssProps({ height: `${Math.min(natural, max)}px` });
    input.classList.toggle("is-overflowing", overflow);
    if (overflow) {
      input.scrollTop = input.ownerDocument.activeElement === input && input.selectionEnd === input.value.length ? input.scrollHeight : scroll;
    }
  }
  private sizeComposerInputs(): void {
    this.contentEl.querySelectorAll<HTMLTextAreaElement>(".y-ai-compose textarea").forEach(input => this.sizeComposerInput(input));
  }
  private apiDisclosureLabel(): string { return `OpenAI API, paid, ${this.apiLimit()}. Usage details`; }
  private apiDisclosure(dock: HTMLElement): void {
    const w = this.work, disclosure = this.details(dock, "api-disclosure", "");
    disclosure.classList.add("y-ai-api");
    const summary = disclosure.querySelector("summary")!;
    summary.setAttribute("aria-label", this.apiDisclosureLabel());
    summary.createSpan({ text: "OpenAI API", cls: "y-ai-api-provider" });
    summary.createSpan({ text: "Paid", cls: "y-ai-api-part" });
    summary.createSpan({ text: this.apiLimit(), cls: "y-ai-api-part y-ai-api-limit" });
    setIcon(summary.createSpan({ cls: "y-ai-api-info", attr: { "aria-hidden": "true" } }), "info");
    const content = disclosure.createDiv({ cls: "y-ai-api-content" });
    content.createEl("p", { text: "Requests go directly to the OpenAI API using your key. OpenAI bills your account for model, tool and audio usage." });
    content.createEl("p", { text: `The request can include permitted notes and selected files. ${w.mode === "ask" ? "Access is read-only." : `Write access is set to ${WRITE_SCOPE_LABELS[w.writeScope]}.`}` });
    content.createEl("a", { text: "OpenAI API data policy ↗", href: OPENAI_DATA_URL, attr: { target: "_blank", rel: "noopener noreferrer" } });
  }
  revealAppContext(app: "calendar" | "chronohud"): void {
    if (!Platform.isAndroidApp || !this.work.current) return;
    this.openDetails.delete("calendar");
    this.openDetails.delete("chronohud");
    this.openDetails.add(app);
    if (this.settingsExpanded && !this.libraryOpen) this.render();
    else this.showLayout("settings");
    this.contentEl.querySelector(".y-ai-app-context-title")?.scrollIntoView({ block: "start" });
  }
  private appContext(parent: HTMLElement): void {
    const group = parent.createEl("section", { cls: "y-ai-app-context", attr: { "aria-label": "App context" } });
    group.createEl("h3", { cls: "y-ai-app-context-title", text: "App context" });
    if (!Platform.isAndroidApp) {
      group.createEl("p", { cls: "y-ai-hint y-ai-app-context-guide", text: "Connect Yoofloe Calendar and ChronoHUD in Obsidian on an Android phone or tablet." });
      return;
    }
    const apps: { key: "calendar" | "chronohud"; name: string; icon: string; store: string }[] = [
      { key: "calendar", name: "Yoofloe Calendar", icon: "calendar-days", store: CALENDAR_STORE },
    ];
    if (this.work.chronoHud) apps.push({ key: "chronohud", name: "ChronoHUD", icon: "timer", store: CHRONOHUD_STORE });
    const open = apps.find(app => this.openDetails.has(app.key));
    const controls = group.createDiv({ cls: "y-ai-app-context-buttons" });
    for (const app of apps) {
      const button = controls.createEl("button", {
        cls: "y-ai-app-context-button",
        attr: { type: "button", "aria-expanded": String(open === app), "data-context-app": app.key },
      });
      setIcon(button.createSpan({ cls: "y-ai-setting-icon", attr: { "aria-hidden": "true" } }), app.icon);
      button.createSpan({ cls: "y-ai-app-context-name", text: app.name });
      setIcon(button.createSpan({ cls: "y-ai-setting-chevron", attr: { "aria-hidden": "true" } }), "chevron-down");
      button.addEventListener("click", () => {
        if (open === app) { this.openDetails.delete(app.key); this.render(); }
        else this.revealAppContext(app.key);
        this.contentEl.querySelector<HTMLButtonElement>('[data-context-app="' + app.key + '"]')?.focus({ preventScroll: true });
      });
    }
    group.createEl("p", { cls: "y-ai-hint y-ai-app-context-guide", text: "Use Obsidian and the selected app on the same Android phone or tablet. Approve each lookup in the app." });
    if (!open) return;
    const body = group.createDiv({ cls: "y-ai-app-context-body", attr: { role: "region", "aria-label": open.name } });
    if (open.key === "calendar") this.calendarPanel(body);
    else this.chronoHudPanel(body);
    const footer = body.createDiv({ cls: "y-ai-app-context-footer" });
    const store = footer.createEl("a", {
      href: open.store, text: "View on Google Play",
      attr: { target: "_blank", rel: "noopener noreferrer", "aria-label": "View " + open.name + " on Google Play" },
    });
    setIcon(store.createSpan({ attr: { "aria-hidden": "true" } }), "external-link");
  }
  private chronoHudPanel(parent: HTMLElement): void {
    const access = this.work.chronoHud;
    if (!access) return;
    const requestContext = async () => {
      const url = await access.open();
      if (url) this.contentEl.ownerDocument.defaultView?.open(url, "_self");
    };
    const checkReply = async () => {
      const id = access.requestId;
      if (id) await access.receive(id);
    };
    renderChronoHudPanel(parent, {
      draft: access.draft, locked: this.work.settingsLocked, pending: access.pending, busy: access.busy,
      delivery: access.delivery, message: access.message, includedIndices: access.includedIndices,
      excerptsEnabled: access.excerptsEnabled, openSections: this.openDetails, requestContext, checkReply,
      updateDraft: patch => access.updateDraft(patch), clearContext: () => access.clear(),
      setIncluded: (index, included) => access.setIncluded(index, included), useExcerpts: enabled => access.useExcerpts(enabled),
    });
  }
  private workspaceCalendarPanel(parent: HTMLElement): void {
    const workspace = this.work, access = workspace.workspaceCalendar;
    if (!access) return;
    const open = async (mode: "capabilities" | "records") => {
      const url = await access.open(mode);
      if (url) this.contentEl.ownerDocument.defaultView?.open(url, "_self");
    };
    const check = async () => {
      const id = access.requestId;
      if (id) await access.receive(id);
    };
    renderCalendarWorkspacePanel(parent, {
      selection: access.selection, capabilities: access.capabilities, delivery: access.delivery,
      message: access.message, pending: access.pending, locked: workspace.settingsLocked, canFind: access.canFind,
      excerptsEnabled: access.excerptsEnabled, openSections: this.openDetails,
      includedIndices: access.includedIndices, setIncluded: (index, included) => access.setIncluded(index, included),
      checkCapabilities: () => open("capabilities"), findRecords: () => open("records"),
      checkReply: check,
      clearContext: () => access.clear(), updateSelection: patch => access.updateSelection(patch),
      useExcerpts: enabled => access.useExcerpts(enabled),
    });
    workspaceCalendarChangeToggle(parent, workspace);
  }
  private calendarPanel(parent: HTMLElement): void {
    const w = this.work;
    this.workspaceCalendarPanel(parent);
    if (Platform.isAndroidApp) {
      const calendar = this.details(parent, "quick-calendar", "Quick Calendar lookup");
      calendar.createEl("p", { text: "If prompted, choose this vault’s Yoofloe Calendar Inbox. Review returned excerpts here before sharing them with OpenAI.", cls: "y-ai-hint" });
      if (!w.requestId) {
        const query = calendar.createEl("textarea", { text: w.calendarQuestion, attr: { rows: "2", placeholder: "E.g. Study and project plans for next week", "aria-label": "Calendar question" } }); query.disabled = w.settingsLocked;
        query.addEventListener("input", () => { w.calendarQuestion = query.value; });
        this.select(calendar, "Calendar workspace", { auto: "Automatic · relevant workspaces", ...AREA_LABELS }, w.area, value => { w.area = value; });
        const periods = { auto: "Automatic · from question", ...PERIOD_LABELS }; delete (periods as Partial<typeof periods>).custom;
        this.select(calendar, "Calendar period", periods, w.period, value => { w.period = value; });
        this.button(calendar, "Find relevant Calendar records", () => { void w.findCalendar().then(url => { if (url) this.contentEl.ownerDocument.defaultView?.open(url, "_self"); }); }, w.settingsLocked);
      } else if (!w.delivery) this.button(calendar, "Check Calendar reply", () => { if (w.requestId) void w.receiveCalendar(w.requestId); }, w.settingsLocked);
      if (w.requestId) this.button(calendar, w.delivery ? "Remove Calendar context" : "Cancel Calendar request", () => void w.removeCalendar(), w.settingsLocked);
      calendarChangeToggle(calendar, w);
      if (w.delivery) {
        calendar.createEl("p", { text: `${w.delivery.context.scope.areas.map(a => AREA_LABELS[a]).join(", ")} · ${w.delivery.context.from ?? "any date"} → ${w.delivery.context.through ?? "any date"}${w.delivery.context.partial ? " · partial coverage" : ""}` });
        for (const record of w.delivery.records) { const item = calendar.createEl("details"); item.createEl("summary", { text: record.title }); item.createEl("pre", { text: record.text }); }
      }
    }
  }
  private render(): void {
    if (!this.work.current) return;
    if (this.composing) { this.pendingRender = true; return; }
    this.pendingRender = false; this.queueSignature = "";
    const w = this.work, el = this.contentEl;
    const previousChat = el.querySelector<HTMLElement>(".y-ai-messages");
    const previousSettings = el.querySelector<HTMLElement>(".y-ai-scroll");
    if (previousSettings?.getClientRects().length) this.savedSettingsScroll = previousSettings.scrollTop;
    const differentConversation = this.lastConversationId !== w.library.active;
    const openAtLatest = differentConversation || !this.renderedReady && w.ready;
    this.renderedReady = w.ready;
    if (differentConversation) {
      this.chatCopy.reset();
      this.lastConversationId = w.library.active; this.olderChats = []; this.olderOffset = 0; this.chatVisible = 10;
      this.followUpClosed = false;
      this.savedChatScroll = 0; this.savedSearchScroll = 0; this.followChat = true;
    } else {
      this.readChatPosition?.();
      if (previousChat?.clientHeight && previousChat.hasAttribute("data-search-results")) this.savedSearchScroll = previousChat.scrollTop;
    }
    el.classList.toggle("y-ai-library-open", this.libraryOpen);
    const activeField = el.ownerDocument.activeElement;
    const tabFocused = !!activeField && el.contains(activeField) && activeField.matches(".y-ai-view-tabs > button");
    const jumpFocused = !!activeField && el.contains(activeField) && activeField.matches(".y-ai-jump-latest");
    const promptSelection = differentConversation ? null : this.composerOptions.selectionForRedraw(".y-ai-primary-prompt");
    const followUpSelection = differentConversation ? null : this.composerOptions.selectionForRedraw(".y-ai-follow-up-input");
    const referenceFocused = activeField?.matches(".y-ai-reference-trigger") && el.contains(activeField);
    const settingsFocus = activeField && el.querySelector(".y-ai-scroll")?.contains(activeField) && activeField.matches("input,textarea,select") ? activeField.getAttribute("aria-label") : null;
    const selectionStart = settingsFocus && "selectionStart" in activeField! ? (activeField as HTMLInputElement).selectionStart : null;
    const selectionEnd = settingsFocus && "selectionEnd" in activeField! ? (activeField as HTMLInputElement).selectionEnd : null;
    const oldSearch = el.querySelector<HTMLInputElement>(".y-ai-chat-search"), searchFocused = el.ownerDocument.activeElement === oldSearch, searchCursor = oldSearch?.selectionStart ?? this.chatQuery.length;
    this.composerOptions.close();
    this.rendering?.unload(); this.rendering = new Component(); this.rendering.load(); el.empty();
    const header = el.createDiv({ cls: "y-ai-header" }), title = header.createDiv({ cls: "y-ai-heading" });
    title.createEl("h2", { text: "Yoofloe" }); const noteContext = title.createEl("p", { text: `${w.source?.selection && w.readScope === "current" ? "Selected text · " : ""}${w.title}`, attr: { "aria-live": "polite" } });
    if (w.source?.path) setTooltip(noteContext, w.source.path);
    const note = this.button(header, "", () => this.options.chooseNote(), w.settingsLocked || !w.ready, "clickable-icon"); note.setAttribute("aria-label", "Choose note"); setTooltip(note, "Choose a note to read or edit"); setIcon(note, "paperclip");
    const library = this.button(header, "", () => { this.layout = "chat"; this.libraryOpen = !this.libraryOpen; this.render(); }, false, "clickable-icon");
    library.setAttribute("aria-label", "Manage conversations"); setTooltip(library, "Manage conversations"); library.setAttribute("aria-expanded", String(this.libraryOpen)); setIcon(library, "messages-square");
    const fresh = this.button(header, "", () => void this.createConversation(), !w.canSwitchConversation || w.library.conversations.length >= MAX_CONVERSATIONS, "clickable-icon");
    fresh.setAttribute("aria-label", "New conversation"); setTooltip(fresh, "New conversation"); setIcon(fresh, "square-pen");
    const chatId = `${this.settingsId}-chat`;
    const hide = this.button(header, "", () => this.options.hide(), false, "clickable-icon"); hide.setAttribute("aria-label", "Hide Yoofloe"); setTooltip(hide, "Hide Yoofloe"); setIcon(hide, "panel-right-close");
    this.viewTabs(el, chatId);
    const chatPanel = el.createEl("section", { cls: "y-ai-chat-panel", attr: { id: chatId, role: "tabpanel", "aria-labelledby": this.tabId("chat") } });
    chatPanel.hidden = this.settingsExpanded;
    if (this.libraryOpen) this.renderLibrary(chatPanel);
    if (w.nextSource) {
      const candidate = w.nextSource, context = chatPanel.createDiv({ cls: "y-ai-note-context" });
      setTooltip(context.createSpan({ text: candidate.path.split("/").at(-1) ?? candidate.path }), candidate.path);
      const attach = this.button(context, candidate.selection ? "Use selection" : "Use opened note", () => w.attachNote(candidate), w.settingsLocked, "mod-cta");
      setTooltip(attach, w.settingsLocked ? "Finish or stop the current task before changing its note" : "Connect this note without clearing the conversation or draft");
    }
    const searchBar = chatPanel.createDiv({ cls: "y-ai-search-bar" }), searchIcon = searchBar.createSpan({ cls: "y-ai-search-icon" }); setIcon(searchIcon, "search");
    const search = searchBar.createEl("input", { value: this.chatQuery, cls: "y-ai-chat-search", attr: { type: "search", placeholder: "Search conversations", "aria-label": "Search conversations", autocomplete: "off" } }); search.maxLength = 200;
    search.addEventListener("input", () => { this.chatQuery = search.value; this.searchEpoch++; const win = el.ownerDocument.defaultView; win?.clearTimeout(this.searchTimer); this.searchTimer = win?.setTimeout(() => { void this.searchConversation(); }, 250); });
    search.addEventListener("keydown", event => { if (event.key === "Escape") { this.chatQuery = ""; void this.searchConversation(); } });
    if (this.chatQuery) { const clear = this.button(searchBar, "", () => { this.chatQuery = ""; void this.searchConversation(); }, false, "clickable-icon"); clear.setAttribute("aria-label", "Clear conversation search"); setIcon(clear, "x"); }
    const conversationActions = searchBar.createEl("button", { cls: "clickable-icon", attr: { type: "button", "aria-label": "Conversation actions" } });
    setIcon(conversationActions, "ellipsis"); setTooltip(conversationActions, "Conversation actions");
    conversationActions.addEventListener("click", event => this.chatCopy.menu(event));
    this.chatCopy.renderToolbar(chatPanel);
    const transcript = chatPanel.createDiv({ cls: "y-ai-transcript" });
    const messagesId = `${chatId}-messages`;
    const messages = transcript.createDiv({ cls: "y-ai-messages", attr: { id: messagesId, role: "region", "aria-label": "Scrollable conversation", tabindex: "0" } });
    messages.toggleAttribute("data-search-results", !!this.chatQuery);
    const transcriptBody = messages.createDiv({ cls: "y-ai-transcript-content" });
    const jump = transcript.createEl("button", { cls: "y-ai-jump-latest", attr: { type: "button", "aria-label": "Jump to latest message", "aria-controls": messagesId } });
    jump.hidden = true;
    setIcon(jump, "arrow-down");
    setTooltip(jump, "Jump to latest message");
    messages.addEventListener("pointerdown", event => {
      const target = event.target as HTMLElement;
      if (event.button === 0 && target.closest(".y-ai-chat") && !target.closest("button,input,summary,a")) {
        this.selectingText = true;
      }
    });
    const settingsPanel = el.createEl("section", { cls: "y-ai-settings-panel", attr: { id: this.settingsId, role: "tabpanel", "aria-labelledby": this.tabId("settings") } });
    settingsPanel.hidden = !this.settingsExpanded;
    const settingsBar = settingsPanel.createDiv({ cls: "y-ai-settings-bar" });
    this.button(settingsBar, "Plugin settings", () => this.options.settings(), w.settingsLocked || w.modelSaving, "y-ai-plugin-settings");
    if (w.canStop || w.stopping) this.button(settingsBar, w.stopping ? "Stopping…" : "Stop", () => w.stop(), !w.canStop, "y-ai-settings-stop mod-warning");
    const scroll = settingsPanel.createDiv({ cls: "y-ai-scroll", attr: { "aria-label": "Workspace settings" } });
    if (!w.configured && w.ready) {
      const intro = scroll.createDiv({ cls: "y-ai-setup" }), copy = intro.createDiv({ cls: "y-ai-setup-copy" });
      copy.createEl("strong", { text: "Connect OpenAI" }); copy.createEl("p", { text: "Your key · API charges apply" });
      this.button(intro, "Set up", () => this.options.settings(), false, "mod-cta");
    }
    const primarySettings = scroll.createDiv({ cls: "y-ai-settings-grid" }), secondarySettings = scroll.createDiv({ cls: "y-ai-settings-secondary" });
    if (w.canContinue) {
      const pause = scroll.createDiv({ cls: "y-ai-card" }); pause.createEl("strong", { text: `Paused · ${w.task?.requests ?? 0} request(s) used` });
      pause.createEl("p", { text: `Continue with the original model (${w.task?.modelId ?? w.model.model}) and original data/change scopes. Earlier tool results and completed changes are reused, not replayed. Continuation is available while this vault session stays open.`, cls: "y-ai-hint" });
      this.limitControl(pause); this.onlineLimitControl(pause); this.button(pause, "Finish here", () => void w.finishHere(), w.busy); this.button(pause, "New task", () => void w.newTask(), w.busy);
    }
    const scope = this.details(primarySettings, "scope", "Permissions");
    this.settingSummary(scope, "Access", w.mode === "ask" ? `Read: ${SCOPE_LABELS[w.readScope]}` : w.readScope === w.writeScope ? SCOPE_LABELS[w.readScope] : `Read: ${SCOPE_LABELS[w.readScope]} · Write: ${WRITE_SCOPE_LABELS[w.writeScope]}`, "sliders-horizontal");
    setTooltip(scope.querySelector("summary")!, `${MODE_LABELS[w.mode]} · Read: ${SCOPE_LABELS[w.readScope]} · Write: ${WRITE_SCOPE_LABELS[w.writeScope]}`);
    this.select(scope, "Allowed actions", MODE_LABELS, w.mode, value => { w.mode = value; this.render(); });
    if (w.mode === "all") scope.createEl("p", { text: "All actions still follow the read scope and write target below. They never expand access to other notes.", cls: "y-ai-hint" });
    this.select(scope, "Notes AI can read", SCOPE_LABELS, w.readScope, value => { w.readScope = value; this.render(); });
    scope.createEl("p", { text: "Access controls note reads and changes. Selected reference excerpts and attachments are additional context.", cls: "y-ai-hint" });
    if (w.mode !== "ask") {
      this.select(scope, "Write target", WRITE_SCOPE_LABELS, w.writeScope, value => { w.writeScope = value; w.preview = ""; this.render(); });
      scope.createEl("p", { text: w.writeScope === "current" ? w.source ? "Only the attached note can change. Choose New documents to create notes." : "No note attached. Attach a note to edit it, or choose New documents to create notes." : w.writeScope === "new" ? "Create notes in the output folder; read and revise this task's new notes. Existing notes stay unchanged." : "Edit notes inside this scope and create new notes in the output folder. Excluded folders remain protected.", cls: "y-ai-hint" });
    }
    const folderLabel = scope.createDiv({ cls: "y-ai-field" }); folderLabel.createSpan({ text: "Working / output folder" });
    const folder = this.button(folderLabel, "", () => {
      if (w.settingsLocked || !w.current) return;
      new VaultFolderPicker(this.app, () => w.current && !w.settingsLocked && folder.isConnected,
        () => w.excluded.split("\n").map(path => path.trim()).filter(Boolean),
        path => { w.setOutputFolder(path); this.saveSoon(); this.render(); }, w.outputFolder).open();
    }, w.settingsLocked, "y-ai-folder");
    folder.setAttribute("aria-label", `Choose working and output folder: ${w.outputFolder || "Vault root"}`);
    setTooltip(folder, "Choose a folder inside this vault");
    setIcon(folder.createSpan({ cls: "y-ai-folder-icon" }), "folder");
    folder.createSpan({ text: w.outputFolder || "Vault root · /", cls: "y-ai-folder-path" });
    setIcon(folder.createSpan({ cls: "y-ai-folder-icon" }), "chevron-down");
    scope.createEl("p", { text: w.readScope === "folder" || w.writeScope === "folder" ? "Note folder uses this folder and its subfolders for existing-note access. New files are also saved here. Manual Save attachment is separate." : "This is the destination for permitted new files. The write target controls creation. Manual Save attachment keeps AI permissions unchanged.", cls: "y-ai-hint" });
    if (!w.canContinue) { this.limitControl(scope); this.onlineLimitControl(scope); }
    const exclusions = scope.createEl("label", { cls: "y-ai-field" }); exclusions.createSpan({ text: "Excluded folders · one vault path per line" });
    const excluded = exclusions.createEl("textarea", { text: w.excluded, attr: { rows: "2", "aria-label": "Excluded folders" } }); excluded.disabled = w.settingsLocked;
    excluded.addEventListener("input", () => { w.excluded = excluded.value; this.saveSoon(); });
    scope.createEl("p", { text: "Thinking depth changes model reasoning cost, not file permissions or response length. Settings, hidden folders, recovery files and detected API keys are excluded. Key detection is not a complete secret scanner.", cls: "y-ai-hint" });
    this.button(scope, "Preview data", () => { el.querySelector<HTMLTextAreaElement>(".y-ai-compose textarea")?.blur(); void w.review(); }, w.settingsLocked);
    scope.createEl("p", { text: "Local initial preview · no API request. Later relevant excerpts may also be sent within your chosen data scope.", cls: "y-ai-hint" });
    const followUps = this.details(secondarySettings, "follow-up-settings", "Follow-ups");
    this.settingSummary(followUps, "Follow-ups", w.followUpDefault === "queue" ? "Queue" : "Steer", "list-end");
    const defaultLabel = followUps.createEl("label", { cls: "y-ai-field" });
    defaultLabel.createSpan({ text: "New messages while working" });
    const defaultMode = defaultLabel.createEl("select", { attr: { "aria-label": "New messages while working" } });
    for (const [value, label] of Object.entries(FOLLOW_UP_LABELS)) defaultMode.createEl("option", { value, text: label });
    defaultMode.value = w.followUpDefault;
    defaultMode.disabled = !w.ready;
    defaultMode.addEventListener("change", () => w.setFollowUpDefault(defaultMode.value as FollowUpMode));
    const contextSettings = this.details(secondarySettings, "context-settings", "Context");
    this.settingSummary(contextSettings, "Context", w.autoCompact ? "Auto compact" : "Recent messages", "layers");
    const compactLabel = contextSettings.createEl("label", { cls: "y-ai-context-toggle" });
    const compact = compactLabel.createEl("input", { attr: { type: "checkbox" } });
    compact.checked = w.autoCompact; compact.disabled = w.settingsLocked;
    compactLabel.createSpan({ text: "Automatically compact long conversations" });
    compact.addEventListener("change", () => w.setAutoCompact(compact.checked));
    contextSettings.createEl("p", { cls: "y-ai-hint", text: `Supported models can compact the active context at ${AUTO_COMPACT_TOKENS.toLocaleString()} tokens. Full messages remain in the local conversation.` });
    const data = this.details(secondarySettings, "privacy", "Privacy and data use");
    this.settingSummary(data, "Privacy", "", "shield-check");
    for (const text of [DATA_FLOW_NOTICE, LOCAL_DATA_NOTICE, OPENAI_DATA_NOTICE, CONTROL_NOTICE]) data.createEl("p", { text, cls: "y-ai-hint" });
    data.createEl("a", { text: "Privacy and local data controls ↗", href: PRIVACY_URL, attr: { target: "_blank", rel: "noopener noreferrer" } });
    data.createEl("p").createEl("a", { text: "OpenAI data policy ↗", href: OPENAI_DATA_URL, attr: { target: "_blank", rel: "noopener noreferrer" } });
    const autoScrollLabel = scroll.createEl("label", { cls: "y-ai-context-toggle y-ai-auto-scroll" });
    const autoScroll = autoScrollLabel.createEl("input", { attr: { type: "checkbox", "aria-label": "Auto-scroll while working" } });
    autoScroll.checked = w.autoScrollChatChecked;
    autoScroll.disabled = !w.canChangeAutoScrollChat;
    autoScrollLabel.createSpan({ text: "Auto-scroll while working" });
    autoScroll.addEventListener("change", () => {
      void w.setAutoScrollChat(autoScroll.checked).catch(() => new Notice("The auto-scroll setting could not be saved on this device."));
    });
    this.appContext(scroll);
    scroll.append(secondarySettings);
    if (w.chat.length || this.chatQuery) this.conversation(transcriptBody);
    else if (w.result) this.markdown(transcriptBody, w.result);
    else { const empty = transcriptBody.createDiv({ cls: "y-ai-empty" }); empty.createEl("strong", { text: "What would you like to work on?" }); empty.createEl("p", { text: "Ask, write, research, or attach a file." }); }
    this.renderedTurn = w.chat.length ? { ...w.chat.at(-1)! } : null;
    const queue = transcriptBody.createEl("section", { cls: "y-ai-queue", attr: { "aria-label": "Follow-up messages" } });
    this.updateQueue(queue);
    const feedback = this.statusFeedback();
    if (w.busy || feedback && (!w.task || w.task.state !== "completed" || w.message !== w.task.message)) {
      const status = (this.settingsExpanded ? scroll : transcriptBody).createEl("p", { text: feedback, cls: this.settingsExpanded ? "y-ai-status y-ai-settings-status" : "y-ai-status", attr: { role: "status", "aria-live": "polite" } });
      if (this.settingsExpanded) scroll.prepend(status);
    }
    if (w.agent?.pendingTrash.length) {
      const trash = scroll.createDiv({ cls: "y-ai-card" }); trash.createEl("strong", { text: "Review before moving to trash" });
      for (const item of w.agent.pendingTrash) trash.createEl("p", { text: item.title });
      this.button(trash, `Move ${w.agent.pendingTrash.length} note(s) to Trash`, () => void w.confirmTrash(), w.settingsLocked, "mod-warning");
    }
    if (w.task?.events.length) {
      const activity = this.details(secondarySettings, "activity", "Activity"); this.settingSummary(activity, "Activity", `${w.task.requests} used`, "activity");
      activity.createEl("p", { text: `${w.task.usage.input + w.task.usage.output} tokens · web ${w.task.online.search} · analysis ${w.task.online.analysis} · images ${w.task.online.image}`, cls: "y-ai-hint" });
      for (const event of w.task.events) activity.createEl("p", { text: event.text, cls: "y-ai-hint" });
      if (w.agent) for (const sent of w.agent.sent) activity.createEl("p", { text: `Read for OpenAI: ${sent.path} · ${sent.bytes} bytes`, cls: "y-ai-hint" });
    }
    if (w.history.length) {
      const history = this.details(secondarySettings, "history", "Changed files and recovery"); this.settingSummary(history, "Recovery", "Note changes", "history");
      for (const journal of w.history.slice(0, 10)) {
        const item = history.createDiv({ cls: "y-ai-card" }); item.createEl("strong", { text: `${new Date(journal.createdAt).toLocaleString()} · ${journal.status === "undone" ? "Reverted" : journal.status}` });
        for (const op of journal.operations) item.createEl("p", { text: `${op.kind}: ${op.path}${op.target ? ` → ${op.target}` : ""} · ${op.status === "undone" ? "reverted" : op.status}`, cls: "y-ai-hint" });
        this.button(item, "Revert changes from this task", () => void w.undo(journal), w.settingsLocked || journal.status === "undone");
      }
    }
    if (w.preview) { const preview = this.details(scroll, "preview", "Data to be sent · initial preview"); preview.open = true; preview.createEl("pre", { text: w.preview }); }
    scroll.createEl("a", { text: "www.yoofloe.com ↗", href: "https://www.yoofloe.com", cls: "y-ai-site", attr: { target: "_blank", rel: "noopener noreferrer" } });
    const followUp = this.showFollowUp;
    const dock = chatPanel.createDiv({ cls: `y-ai-dock${followUp ? " y-ai-follow-up-open" : ""}` });
    calendarChangeCard(dock, w);
    const selectedAttachments = followUp ? w.followUpAttachments : w.attachments;
    if (selectedAttachments.length) {
      const attachments = dock.createDiv({ cls: "y-ai-attachments", attr: { "aria-label": "Attached files" } });
      for (const file of selectedAttachments) { const chip = attachments.createDiv({ cls: "y-ai-attachment" }); const icon = chip.createSpan(); setIcon(icon, file.kind === "audio" ? "audio-lines" : file.kind === "image" ? "image" : "file-text"); setTooltip(chip.createSpan({ text: file.name, cls: "y-ai-attachment-name" }), `${file.name} · ${(file.bytes / 1024).toFixed(0)} KiB${file.kind === "audio" ? " · transcription charges apply" : ""}`); const remove = this.button(chip, "", () => w.removeAttachment(file.id, followUp), !w.canChangeReference || w.addingAttachments, "clickable-icon"); remove.setAttribute("aria-label", `Remove ${file.name} from this request`); setIcon(remove, "x"); }
    }
    const compose = dock.createDiv({ cls: "y-ai-compose" });
    const prompt = compose.createEl("textarea", { text: w.prompt, cls: "y-ai-primary-prompt", attr: { rows: "1", "aria-label": "Ask", placeholder: "Ask…" } });
    prompt.disabled = w.settingsLocked && !w.addingAttachments; prompt.maxLength = 32000;
    const controls = dock.createDiv({ cls: `y-ai-row y-ai-composer-controls${followUp ? " y-ai-follow-up-controls" : ""}${w.busy ? " y-ai-running-controls" : ""}` });
    const picker = controls.createEl("input", { attr: { type: "file", multiple: "", "aria-label": "Choose attachments" } }); picker.hidden = true;
    picker.addEventListener("change", () => { const files = Array.from(picker.files ?? []); picker.value = ""; void w.addAttachments(files, undefined, undefined, followUp); });
    const attach = this.button(controls, "", () => picker.click(), !w.canChangeReference || w.addingAttachments, "y-ai-attach clickable-icon"); attach.setAttribute("aria-label", "Attach images, files or audio"); setTooltip(attach, ATTACHMENT_LIMIT_LABEL); setIcon(attach, "plus");
    this.composerOptions.render(controls);
    if (followUp) {
      this.followUpEditor(compose, controls);
      dock.addEventListener("focusout", () => {
        dock.ownerDocument.defaultView?.setTimeout(() => {
          if (dock.isConnected && this.pendingRender && !this.followUpFocused() && !w.followUpSaving &&
            !controls.contains(dock.ownerDocument.activeElement)) this.render();
        }, 0);
      });
    }
    const referenceButton = this.button(compose, "", () => {
      const reference = w.reference;
      if (reference) new ReferenceModal(this.app, w, reference, { followUp, draft: true }).open();
      else w.restoreReference();
    }, false, "clickable-icon y-ai-reference-trigger");
    referenceButton.hidden = true;
    const addMessage = this.button(controls, "", () => this.openFollowUp(), false, "y-ai-add-message clickable-icon");
    addMessage.setAttribute("aria-label", "Reopen follow-up draft");
    setTooltip(addMessage, "Reopen follow-up draft");
    setIcon(addMessage, "message-square-plus");
    const run = this.button(controls, "", () => { if (w.busy) w.stop(); else { prompt.blur(); void w.run(); } }, false, "y-ai-send");
    this.apiDisclosure(dock);
    const budget = dock.createEl("button", { text: "Estimating input…", cls: "y-ai-input-budget", attr: { "aria-label": "Input size details" } });
    budget.type = "button";
    this.scheduleBudget();
    this.refreshComposer();
    prompt.addEventListener("input", () => { w.setPrompt(prompt.value); this.sizeComposerInput(prompt); run.disabled = !this.actionReady(); this.saveSoon(); });
    prompt.addEventListener("paste", event => {
      const text = event.clipboardData?.getData("text/plain");
      if (!text) return;
      const remaining = prompt.maxLength - prompt.value.length + prompt.selectionEnd - prompt.selectionStart;
      if (text.length < PASTED_TEXT_THRESHOLD && text.length <= remaining) return;
      event.preventDefault();
      if (w.addingAttachments) { new Notice("Wait for the current attachment to finish, then paste again."); return; }
      void w.addPastedText(text);
    });
    prompt.addEventListener("compositionstart", () => { this.composing = true; });
    prompt.addEventListener("compositionend", () => {
      this.composing = false; w.setPrompt(prompt.value); this.sizeComposerInput(prompt); this.saveSoon();
      if (this.pendingRender) this.render();
    });
    prompt.addEventListener("keydown", event => { if (!event.isComposing && event.key === "Enter" && (event.ctrlKey || event.metaKey) && !run.disabled && !w.busy) { event.preventDefault(); run.click(); } });
    this.sizeComposerInputs();
    if (this.settingsExpanded) scroll.scrollTop = this.savedSettingsScroll;
    else if (!this.libraryOpen && this.chatQuery) messages.scrollTop = this.savedSearchScroll;
    this.watchChatScroll(messages, transcriptBody, jump, openAtLatest);
    if (settingsFocus && this.settingsExpanded) {
      const replacement = Array.from(scroll.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input,textarea,select")).find(field => field.getAttribute("aria-label") === settingsFocus);
      if (replacement && !replacement.disabled) { replacement.focus({ preventScroll: true }); if (selectionStart !== null && selectionEnd !== null && "setSelectionRange" in replacement) replacement.setSelectionRange(selectionStart, selectionEnd); }
    }
    if (searchFocused && !this.settingsExpanded) { search.focus({ preventScroll: true }); search.setSelectionRange(searchCursor, searchCursor); }
    if (promptSelection && !prompt.disabled && !followUp && !this.settingsExpanded) {
      prompt.focus({ preventScroll: true }); prompt.setSelectionRange(...promptSelection); this.sizeComposerInput(prompt);
    }
    if (followUpSelection && followUp && !this.settingsExpanded) {
      const input = el.querySelector<HTMLTextAreaElement>(".y-ai-follow-up-input");
      input?.focus({ preventScroll: true }); input?.setSelectionRange(...followUpSelection); if (input) this.sizeComposerInput(input);
    }
    if (referenceFocused && !this.settingsExpanded) {
      const target = referenceButton.hidden ? compose.querySelector<HTMLElement>(followUp ? ".y-ai-follow-up-input" : ".y-ai-primary-prompt") : referenceButton;
      target?.focus({ preventScroll: true });
    }
    if (jumpFocused && !this.settingsExpanded && !this.libraryOpen) (jump.hidden ? messages : jump).focus({ preventScroll: true });
    if (tabFocused) el.querySelector<HTMLButtonElement>(`[data-view-layout="${this.layout}"]`)?.focus({ preventScroll: true });
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
      this.sizeComposerInputs();
      this.composerOptions.fitLabels();
      if (root.classList.contains("y-ai-tiny")) root.scrollTop = 0;
      win.clearTimeout(timer); timer = win.setTimeout(() => { const active = doc.activeElement; if (active !== null && active.instanceOf(HTMLElement) && root.contains(active) && active.matches("textarea,input,select")) active.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" }); }, 350);
    };
    const focus = () => { const active = doc.activeElement; root.classList.toggle("y-ai-searching", active !== null && active.instanceOf(HTMLElement) && active.matches(".y-ai-chat-search")); resize(); };
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
  getDisplayText(): string { return "Yoofloe"; }
  getIcon(): string { return "sparkles"; }
  getState(): Record<string, unknown> { return this.savedState; }
  setState(state: Record<string, unknown>): Promise<void> { this.savedState = state; return Promise.resolve(); }
  onOpen(): Promise<void> {
    const el = this.contentEl; el.empty(); el.classList.add("yoofloe-ai"); const card = el.createDiv({ cls: "y-ai-card" });
    card.createEl("h3", { text: "Yoofloe" }); card.createEl("p", { text: "Writer and capture are now one workspace. Existing Markdown, settings and this panel’s saved state are kept." });
    const b = card.createEl("button", { text: "Open Yoofloe", cls: "mod-cta" }); b.addEventListener("click", () => this.openAi()); return Promise.resolve();
  }
}
