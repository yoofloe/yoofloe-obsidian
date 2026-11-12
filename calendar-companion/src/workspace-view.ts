import { Component, ItemView, MarkdownRenderer, Notice, Platform, setIcon, type WorkspaceLeaf } from "obsidian";
import { AiWorkspace } from "./workspace";
import { MODE_LABELS, SCOPE_LABELS, WRITE_SCOPE_LABELS } from "./agent-policy";
import { EFFORT_LABELS, resolveEffort, supportedEfforts } from "./effort";
import { modelCatalog } from "./ai-models";
import { AREA_LABELS, PERIOD_LABELS } from "./question-query";
import { safeNoteMarkdown } from "./note-context";
import { VaultFolderPicker } from "./folder-picker";
import { availableViewHeight } from "./view-bounds";
import { DATA_FLOW_NOTICE, LOCAL_DATA_NOTICE, OPENAI_DATA_NOTICE, CONTROL_NOTICE, PRIVACY_URL, OPENAI_DATA_URL } from "./privacy-copy";
import { customRequestLimit, requestLimitLabel } from "./request-limit";
import { SOURCE_MODES, supportsHostedTools } from "./research";
import { generatedCachePath } from "./generated-files";
import { ATTACHMENT_ACCEPT } from "./attachments";
import { chatMatches, searchChatPreview, type ChatTurn } from "./chat-history";

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
  private chatQuery = "";
  private searchResults: ChatTurn[] = [];
  private searchNext: number | null = null;
  private searching = false;
  private searchEpoch = 0;
  private searchTimer: number | undefined;
  private generatedVisible = new Map<string, number>();
  constructor(leaf: WorkspaceLeaf, readonly work: AiWorkspace, private readonly options: ViewOptions) { super(leaf); }
  getViewType(): string { return AI_VIEW; }
  getDisplayText(): string { return "Yoofloe AI"; }
  getIcon(): string { return "sparkles"; }
  async onOpen(): Promise<void> {
    this.contentEl.classList.add("yoofloe-ai"); this.unsubscribe = this.work.subscribe(() => this.render());
    this.stopViewport = this.watchViewport(); this.render(); await this.work.initialize();
  }
  async onClose(): Promise<void> {
    this.searchEpoch++; if (this.searchTimer !== undefined) this.contentEl.ownerDocument.defaultView?.clearTimeout(this.searchTimer);
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
    const d = el.createEl("details", { cls: "y-ai-details", attr: { "data-section": key } }); d.open = this.openDetails.has(key); d.createEl("summary", { text: title });
    d.addEventListener("toggle", () => { if (d.open) this.openDetails.add(key); else this.openDetails.delete(key); }); return d;
  }
  private settingSummary(details: HTMLDetailsElement, title: string, value: string, icon: string): void {
    const summary = details.querySelector("summary"); if (!summary) return; summary.empty();
    const symbol = summary.createSpan({ cls: "y-ai-setting-icon" }); setIcon(symbol, icon);
    const copy = summary.createSpan({ cls: "y-ai-setting-copy" }); copy.createEl("strong", { text: title }); if (value) copy.createEl("small", { text: value, attr: { title: value } });
    const chevron = summary.createSpan({ cls: "y-ai-setting-chevron" }); setIcon(chevron, "chevron-down");
  }
  private select<T extends string>(el: HTMLElement, label: string, values: Record<T, string>, selected: T, change: (value: T) => void, allowPaused = false): HTMLSelectElement {
    const wrap = el.createEl("label", { cls: "y-ai-field" }); wrap.createSpan({ text: label });
    const select = wrap.createEl("select", { attr: { "aria-label": label } });
    for (const [value, text] of Object.entries(values)) select.createEl("option", { text: String(text), value }); select.value = selected; select.disabled = this.work.busy || !allowPaused && this.work.canContinue;
    select.addEventListener("change", () => { change(select.value as T); this.work.preview = ""; this.saveSoon(); }); return select;
  }
  private actionReady(): boolean {
    const w = this.work; return !w.busy && !w.addingAttachments && w.ready && w.configured && !w.limitProblem && (w.canContinue ? w.canResumeWithLimit : !!w.prompt.trim());
  }
  private refreshLimitDisclosure(): void {
    const w = this.work, label = requestLimitLabel(w.maximum);
    this.contentEl.querySelectorAll<HTMLElement>(".y-ai-limit-caption").forEach(el => el.setText(label));
    this.contentEl.querySelector<HTMLElement>(".y-ai-privacy-short")?.setText(`OpenAI · paid · ${label}`);
    const run = this.contentEl.querySelector<HTMLButtonElement>(".y-ai-send");
    if (run && !w.busy) run.title = `Send permitted data directly to OpenAI · API charges · ${label}`;
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
    } catch { if (epoch === this.searchEpoch) this.work.message = "Some local conversations could not be searched. Existing files are kept."; }
    finally { if (epoch === this.searchEpoch && this.work.current) { this.searching = false; this.render(); if (focused) { const input = this.contentEl.querySelector<HTMLInputElement>(".y-ai-chat-search"); input?.focus({ preventScroll: true }); input?.setSelectionRange(input.value.length, input.value.length); } } }
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
      this.highlight(result); const scroll = this.contentEl.querySelector(".y-ai-messages"); if (this.followChat && !this.chatQuery && scroll) scroll.scrollTop = scroll.scrollHeight;
    }).catch(() => { if (result.isConnected) { result.empty(); result.createEl("pre", { text }); result.inert = false; } });
  }
  private conversation(el: HTMLElement): void {
    const w = this.work;
    if (!this.chatQuery && w.chat.length > this.chatVisible) this.button(el, `Show ${Math.min(10, w.chat.length - this.chatVisible)} earlier task(s)`, () => { this.chatVisible += 10; this.render(); });
    if (this.chatQuery) { el.createEl("p", { text: `${this.searchResults.length} matching conversation(s)${this.searching ? " · searching…" : ""} · local search`, cls: "y-ai-hint", attr: { role: "status" } }); if (this.searchNext !== null) this.button(el, "Search more saved history", () => void this.searchConversation(true), this.searching); }
    const conversation = el.createDiv({ cls: "y-ai-chat", attr: { "aria-label": "Conversation" } });
    const labels: Record<string, string> = { edit: "Updated", create: "Created", rename: "Renamed", folder: "Created folder", trash: "Moved to trash", properties: "Updated properties", asset: "Saved attachment" };
    for (const turn of (this.chatQuery ? this.searchResults : w.chat.slice(-this.chatVisible))) {
      const exchange = conversation.createEl("article", { cls: "y-ai-exchange" });
      if (turn.request || turn.attachments?.length) {
        const user = exchange.createDiv({ cls: "y-ai-message y-ai-user" }); user.createEl("strong", { text: "You", cls: "y-ai-message-label" }); user.createEl("p", { text: turn.request, cls: "y-ai-request-text" });
        if (turn.attachments?.length) { const files = user.createDiv({ cls: "y-ai-sent-files" }); for (const file of turn.attachments) files.createSpan({ text: file.name, cls: "y-ai-sent-file" }); this.button(files, "Attach again", () => w.useAttachments(turn.attachments!), w.settingsLocked); }
      }
      const assistant = exchange.createDiv({ cls: "y-ai-message y-ai-assistant" }); assistant.createEl("strong", { text: "Yoofloe AI", cls: "y-ai-message-label" });
      const status = turn.status === "running" ? w.stopping ? "Stopping…" : "Working…" : turn.status === "paused" ? "Paused at request limit" : turn.status === "completed" ? "Completed" : turn.status === "stopped" ? "Stopped" : "Could not finish";
      const metadata = this.details(assistant, "turn-" + turn.id, `${status} · ${turn.sourceMode === "expanded" ? "Expanded" : "Provided materials"}`);
      metadata.createEl("p", { text: `${turn.model || "Saved conversation"} · ${turn.requests} API request(s)${turn.online ? ` · web ${turn.online.search} · analysis ${turn.online.analysis} · images ${turn.online.image}` : ""}${turn.transcriptions ? ` · audio ${turn.transcriptions}` : ""}`, cls: "y-ai-hint" });
      for (const file of turn.attachments ?? []) metadata.createEl("p", { text: `Attached: ${file.name}`, cls: "y-ai-hint" });
      if (turn.actions.length) { const actions = metadata.createDiv({ cls: "y-ai-chat-actions" }); for (const action of turn.actions) actions.createEl("p", { text: `${labels[action.kind] ?? "Changed"}: ${action.path}${action.target ? ` → ${action.target}` : ""}`, cls: "y-ai-hint" }); }
      if ((turn.actionTotal ?? 0) > turn.actions.length) assistant.createEl("p", { text: `${turn.actionTotal} confirmed operations in total. Recent actions are shown here; all recovery segments are kept under changed files and recovery.`, cls: "y-ai-hint" });
      else if (!turn.actions.length && turn.status === "completed" && turn.actionsKnown) metadata.createEl("p", { text: "No file changes were recorded for this task.", cls: "y-ai-hint" });
      if (turn.answer) this.markdown(assistant, turn.answer, turn.sourcePath ?? "");
      if (turn.sources?.length) { const sources = this.details(assistant, "sources-" + turn.id, `Sources · ${turn.sources.length}`); for (const source of turn.sources) sources.createEl("p").createEl("a", { text: source.title || source.url, href: source.url, attr: { target: "_blank", rel: "noopener noreferrer" } }); }
      for (const warning of turn.fileWarnings ?? []) assistant.createEl("p", { text: warning, cls: "y-ai-file-warning" });
      const visibleFiles = this.generatedVisible.get(turn.id) ?? 4;
      for (const file of (turn.generated ?? []).slice(0, visibleFiles)) {
        const card = assistant.createDiv({ cls: "y-ai-generated" }); card.createSpan({ text: file.name });
        if (["png", "jpg", "jpeg", "webp"].includes(file.extension)) { const picture = card.createEl("img", { attr: { src: this.app.vault.adapter.getResourcePath(generatedCachePath(this.app.vault.configDir, file)), alt: file.name, loading: "lazy" } }); picture.addEventListener("error", () => { picture.hidden = true; }); picture.addEventListener("load", () => { const scroll = this.contentEl.querySelector(".y-ai-messages"); if (this.followChat && !this.chatQuery && scroll) scroll.scrollTop = scroll.scrollHeight; }); }
        this.button(card, "Save attachment", () => { void w.saveGeneratedFile(turn.id, file.id).then(saved => { if (saved && this.chatQuery) { const index = this.searchResults.findIndex(item => item.id === saved.id); if (index >= 0) this.searchResults[index] = saved; this.render(); } }); }, w.settingsLocked);
      }
      if ((turn.generated?.length ?? 0) > visibleFiles) this.button(assistant, "Show more generated files", () => { this.generatedVisible.set(turn.id, visibleFiles + 4); this.render(); });
      if (turn.requestTruncated || turn.answerTruncated || turn.generatedTruncated) this.button(assistant, "Load full local conversation", () => { if (!this.chatQuery) void w.loadFullChat(turn.id); else void w.fullChat(turn.id).then(full => { if (full && this.chatQuery) { const index = this.searchResults.findIndex(item => item.id === turn.id); if (index >= 0) this.searchResults[index] = full; this.render(); } }).catch(() => new Notice("The full local conversation could not be loaded.")); });
      this.highlight(exchange.querySelector<HTMLElement>(".y-ai-user") ?? exchange);
    }
  }
  private render(): void {
    if (!this.work.current) return;
    const w = this.work, el = this.contentEl, previousScroll = el.querySelector<HTMLElement>(".y-ai-messages"), oldScroll = previousScroll?.scrollTop ?? 0, oldMenuScroll = el.querySelector<HTMLElement>(".y-ai-scroll")?.scrollTop ?? 0;
    const oldSearch = el.querySelector<HTMLInputElement>(".y-ai-chat-search"), searchFocused = el.ownerDocument.activeElement === oldSearch, searchCursor = oldSearch?.selectionStart ?? this.chatQuery.length;
    const follow = !previousScroll && w.chat.length > 0 || w.busy && w.chat.length > this.lastChatCount || !!previousScroll && previousScroll.scrollTop + previousScroll.clientHeight >= previousScroll.scrollHeight - 32; this.lastChatCount = w.chat.length; this.followChat = follow;
    this.rendering?.unload(); this.rendering = new Component(); this.rendering.load(); el.empty();
    const header = el.createDiv({ cls: "y-ai-header" }), title = header.createDiv({ cls: "y-ai-heading" });
    title.createEl("h2", { text: "Yoofloe AI" }); title.createEl("p", { text: w.title, attr: { title: w.source?.path ?? "Create a document without opening a note" } });
    const fresh = this.button(header, "", () => void w.newTask(), w.settingsLocked, "clickable-icon"); fresh.setAttribute("aria-label", "New conversation task"); fresh.title = "New task"; setIcon(fresh, "square-pen");
    const settings = this.button(header, "", () => this.options.settings(), w.settingsLocked, "clickable-icon"); settings.setAttribute("aria-label", "Yoofloe AI settings"); setIcon(settings, "settings-2");
    const hide = this.button(header, "", () => this.options.hide(), false, "clickable-icon"); hide.setAttribute("aria-label", "Hide Yoofloe AI"); setIcon(hide, "panel-right-close");
    const chatPanel = el.createEl("section", { cls: "y-ai-chat-panel", attr: { "aria-label": "Yoofloe AI conversation" } });
    const searchBar = chatPanel.createDiv({ cls: "y-ai-search-bar" }), searchIcon = searchBar.createSpan({ cls: "y-ai-search-icon" }); setIcon(searchIcon, "search");
    const search = searchBar.createEl("input", { value: this.chatQuery, cls: "y-ai-chat-search", attr: { type: "search", placeholder: "Search conversations", "aria-label": "Search conversations", autocomplete: "off" } }); search.maxLength = 200;
    search.addEventListener("input", () => { this.chatQuery = search.value; this.searchEpoch++; const win = el.ownerDocument.defaultView; win?.clearTimeout(this.searchTimer); this.searchTimer = win?.setTimeout(() => { void this.searchConversation(); }, 250); });
    search.addEventListener("keydown", event => { if (event.key === "Escape") { this.chatQuery = ""; void this.searchConversation(); } });
    if (this.chatQuery) { const clear = this.button(searchBar, "", () => { this.chatQuery = ""; void this.searchConversation(); }, false, "clickable-icon"); clear.setAttribute("aria-label", "Clear conversation search"); setIcon(clear, "x"); }
    const messages = chatPanel.createDiv({ cls: "y-ai-messages", attr: { "aria-label": "Scrollable conversation", tabindex: "0" } });
    messages.addEventListener("wheel", () => { this.followChat = false; }, { passive: true }); messages.addEventListener("touchstart", () => { this.followChat = false; }, { passive: true });
    const scroll = el.createDiv({ cls: "y-ai-scroll" });
    if (!w.configured && w.ready) {
      const intro = scroll.createDiv({ cls: "y-ai-setup" }), copy = intro.createDiv({ cls: "y-ai-setup-copy" });
      copy.createEl("strong", { text: "Connect OpenAI" }); copy.createEl("p", { text: "Your key · API charges apply" });
      this.button(intro, "Set up", () => this.options.settings(), false, "mod-cta");
    }
    if (w.nextSource) this.button(scroll, `New task for ${w.nextSource.path.split("/").at(-1)}`, () => void w.newTask(w.nextSource), w.busy, "y-ai-next");
    const primarySettings = scroll.createDiv({ cls: "y-ai-settings-grid" }), secondarySettings = scroll.createDiv({ cls: "y-ai-settings-secondary" });
    const modelSettings = this.details(primarySettings, "model-settings", "Model");
    const selectedModel = modelCatalog("openai").models.find(item => item.id === w.model.model);
    this.settingSummary(modelSettings, "Model", selectedModel?.label.split(" · ")[0] ?? w.model.model ?? "Choose a model", "sparkles");
    const models = modelSettings.createDiv({ cls: "y-ai-models" }), choices: Record<string, string> = {};
    for (const model of modelCatalog("openai").models) choices[model.id] = model.label;
    if (w.model.model && !choices[w.model.model]) choices[w.model.model] = `Custom · ${w.model.model}`;
    choices.__custom__ = "Custom model…";
    const model = this.select(models, "Model", choices, w.model.model, value => { if (value === "__custom__") this.options.settings(); else void w.setModel({ model: value }); });
    model.title = choices[w.model.model] ?? w.model.model;
    if (w.model.model && !supportsHostedTools(w.model.model)) modelSettings.createEl("p", { text: "Hosted web, analysis and image tools are not enabled for this custom model because support is unconfirmed. Choose a listed model for those tools. Text and permitted note actions remain available.", cls: "y-ai-hint" });
    const efforts: Record<string, string> = { default: EFFORT_LABELS.default };
    for (const effort of supportedEfforts(w.model.model)) efforts[effort] = EFFORT_LABELS[effort];
    this.select(models, "Thinking depth", efforts, w.model.effort ?? resolveEffort(w.model.model) ?? "default", value => { void w.setModel({ ...w.model, effort: value }); });
    models.createEl("p", { text: w.model.model, cls: "y-ai-model-id", attr: { "aria-label": "Selected model ID" } });
    if (w.canContinue) {
      const pause = scroll.createDiv({ cls: "y-ai-card" }); pause.createEl("strong", { text: `Paused · ${w.task?.requests ?? 0} request(s) used` });
      pause.createEl("p", { text: `Continue with the original model (${w.task?.modelId ?? w.model.model}) and original data/change scopes. Earlier tool results and completed changes are reused, not replayed. Continuation is available while this vault session stays open.`, cls: "y-ai-hint" });
      this.limitControl(pause); this.onlineLimitControl(pause); this.button(pause, "Finish here", () => void w.finishHere(), w.busy); this.button(pause, "New task", () => void w.newTask(), w.busy);
    }
    const scope = this.details(primarySettings, "scope", "Permissions");
    this.settingSummary(scope, "Access", w.mode === "ask" ? `Read: ${SCOPE_LABELS[w.readScope]}` : w.readScope === w.writeScope ? SCOPE_LABELS[w.readScope] : `Read: ${SCOPE_LABELS[w.readScope]} · Write: ${WRITE_SCOPE_LABELS[w.writeScope]}`, "sliders-horizontal");
    scope.querySelector("summary")?.setAttribute("title", `${MODE_LABELS[w.mode]} · Read: ${SCOPE_LABELS[w.readScope]} · Write: ${WRITE_SCOPE_LABELS[w.writeScope]}`);
    this.select(scope, "Allowed actions", MODE_LABELS, w.mode, value => { w.mode = value; this.render(); });
    if (w.mode === "all") scope.createEl("p", { text: "All actions still follow the read scope and write target below. They never expand access to other notes.", cls: "y-ai-hint" });
    this.select(scope, "Notes AI can read", SCOPE_LABELS, w.readScope, value => { w.readScope = value; this.render(); });
    scope.createEl("p", { text: "This scope controls notes. Selected attachments and the source mode are separate context choices.", cls: "y-ai-hint" });
    if (w.source?.selection) this.button(scope, "Use whole attached note", () => { if (!w.source) return; delete w.source.selection; delete w.source.selectionVersion; w.preview = ""; this.saveSoon(); this.render(); }, w.settingsLocked);
    if (w.mode !== "ask") {
      this.select(scope, "Write target", WRITE_SCOPE_LABELS, w.writeScope, value => { w.writeScope = value; w.preview = ""; this.render(); });
      scope.createEl("p", { text: w.writeScope === "current" ? w.source ? "Only the attached note can change. Choose New documents to create notes." : "No note attached. Attach a note to edit it, or choose New documents to create notes." : w.writeScope === "new" ? "Create notes in the output folder; read and revise this task's new notes. Existing notes stay unchanged." : "Edit notes inside this scope and create new notes in the output folder. Excluded folders remain protected.", cls: "y-ai-hint" });
    }
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
    scope.createEl("p", { text: w.readScope === "folder" || w.writeScope === "folder" ? "Note folder uses this folder and its subfolders for existing-note access. New files are also saved here. Manual Save attachment is separate." : "This is the destination for permitted new files. The write target controls creation. Manual Save attachment keeps AI permissions unchanged.", cls: "y-ai-hint" });
    if (!w.canContinue) { this.limitControl(scope); this.onlineLimitControl(scope); }
    const exclusions = scope.createEl("label", { cls: "y-ai-field" }); exclusions.createSpan({ text: "Excluded folders · one vault path per line" });
    const excluded = exclusions.createEl("textarea", { text: w.excluded, attr: { rows: "2", "aria-label": "Excluded folders" } }); excluded.disabled = w.settingsLocked;
    excluded.addEventListener("input", () => { w.excluded = excluded.value; this.saveSoon(); });
    scope.createEl("p", { text: "Thinking depth changes model reasoning cost, not file permissions or response length. Settings, hidden folders, recovery files and detected API keys are excluded. Key detection is not a complete secret scanner.", cls: "y-ai-hint" });
    this.button(scope, "Preview data", () => { el.querySelector<HTMLTextAreaElement>(".y-ai-compose textarea")?.blur(); void w.review(); }, w.settingsLocked);
    scope.createEl("p", { text: "Local initial preview · no API request. Later relevant excerpts may also be sent within your chosen data scope.", cls: "y-ai-hint" });
    const data = this.details(secondarySettings, "privacy", "Privacy and data use");
    this.settingSummary(data, "Privacy", "", "shield-check");
    for (const text of [DATA_FLOW_NOTICE, LOCAL_DATA_NOTICE, OPENAI_DATA_NOTICE, CONTROL_NOTICE]) data.createEl("p", { text, cls: "y-ai-hint" });
    data.createEl("a", { text: "Privacy and local data controls ↗", href: PRIVACY_URL, attr: { target: "_blank", rel: "noopener noreferrer" } });
    data.createEl("p").createEl("a", { text: "OpenAI data policy ↗", href: OPENAI_DATA_URL, attr: { target: "_blank", rel: "noopener noreferrer" } });
    const calendar = this.details(scroll, "calendar", w.delivery ? `Calendar · ${w.delivery.records.length} excerpt(s)` : "Add Yoofloe Calendar context (optional)");
    calendar.classList.add("y-ai-calendar-setting"); this.settingSummary(calendar, "Yoofloe Calendar", w.delivery ? `${w.delivery.records.length} record(s) added` : "Optional app context", "calendar-days");
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
    scroll.append(secondarySettings);
    if (w.chat.length || this.chatQuery) this.conversation(messages);
    else if (w.result) this.markdown(messages, w.result);
    else { const empty = messages.createDiv({ cls: "y-ai-empty" }); empty.createEl("strong", { text: "What would you like to work on?" }); empty.createEl("p", { text: "Ask, write, research, or attach a file." }); }
    if ((w.message || w.task?.message) && (w.busy || !w.task || w.task.state !== "completed" || w.message !== w.task.message)) messages.createEl("p", { text: w.busy && w.task?.busy ? w.task.message : w.message, cls: "y-ai-status", attr: { role: "status", "aria-live": "polite" } });
    if (w.result) {
      const resultActions = messages.createDiv({ cls: "y-ai-result-actions" });
      this.button(resultActions, "Copy Markdown", () => { void navigator.clipboard.writeText(w.result).then(() => new Notice("Markdown copied"), () => new Notice("Copy was unavailable; the result is kept.")); });
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
      const history = this.details(secondarySettings, "history", "Changed files and recovery"); this.settingSummary(history, "Recovery", "Undo", "history");
      for (const journal of w.history.slice(0, 10)) {
        const item = history.createDiv({ cls: "y-ai-card" }); item.createEl("strong", { text: `${new Date(journal.createdAt).toLocaleString()} · ${journal.status}` });
        for (const op of journal.operations) item.createEl("p", { text: `${op.kind}: ${op.path}${op.target ? ` → ${op.target}` : ""} · ${op.status}`, cls: "y-ai-hint" });
        this.button(item, "Undo this task", () => void w.undo(journal), w.settingsLocked || journal.status === "undone");
      }
    }
    if (w.preview) { const preview = this.details(scroll, "preview", "Data to be sent · initial preview"); preview.open = true; preview.createEl("pre", { text: w.preview }); }
    scroll.createEl("a", { text: "www.yoofloe.com ↗", href: "https://www.yoofloe.com", cls: "y-ai-site", attr: { target: "_blank", rel: "noopener noreferrer" } });
    const dock = chatPanel.createDiv({ cls: "y-ai-dock" });
    if (w.attachments.length) {
      const attachments = dock.createDiv({ cls: "y-ai-attachments", attr: { "aria-label": "Attached files" } });
      for (const file of w.attachments) { const chip = attachments.createDiv({ cls: "y-ai-attachment" }); const icon = chip.createSpan(); setIcon(icon, file.kind === "audio" ? "audio-lines" : file.kind === "image" ? "image" : "file-text"); chip.createSpan({ text: file.name, cls: "y-ai-attachment-name", attr: { title: `${file.name} · ${(file.bytes / 1024).toFixed(0)} KiB${file.kind === "audio" ? " · transcription charges apply" : ""}` } }); const remove = this.button(chip, "", () => w.removeAttachment(file.id), w.settingsLocked, "clickable-icon"); remove.setAttribute("aria-label", `Remove ${file.name} from this request`); setIcon(remove, "x"); }
    }
    const compose = dock.createDiv({ cls: "y-ai-compose" });
    const prompt = compose.createEl("textarea", { text: w.prompt, attr: { rows: "2", "aria-label": "Ask Yoofloe AI", placeholder: "Ask Yoofloe AI…" } }); prompt.disabled = w.settingsLocked; prompt.maxLength = 32000;
    const privacy = dock.createEl("p", { cls: "y-ai-hint" });
    const full = privacy.createSpan({ cls: "y-ai-privacy-full" }); full.appendText("OpenAI · API charges · "); full.createSpan({ text: requestLimitLabel(w.maximum), cls: "y-ai-limit-caption" }); full.appendText(`. ${w.mode === "ask" ? "Read only" : `Write: ${WRITE_SCOPE_LABELS[w.writeScope]}`}.`);
    privacy.createSpan({ text: `OpenAI · paid · ${requestLimitLabel(w.maximum)}`, cls: "y-ai-privacy-short" });
    const tiny = privacy.createSpan({ text: "OpenAI · paid", cls: "y-ai-privacy-tiny" });
    if (w.task?.requests) { full.appendText(` ${w.busy || w.canContinue ? "Used" : "Last task"} ${w.task.requests} · ${w.task.usage.input + w.task.usage.output} tokens.`); if (w.busy || w.canContinue) tiny.createSpan({ text: ` · ${w.task.requests} used`, cls: "y-ai-usage-tiny" }); }
    privacy.setAttribute("title", "Data goes directly to OpenAI, including relevant note excerpts within the permitted scope. Local key storage does not make AI local. New notes may be created in the output folder.");
    const controls = dock.createDiv({ cls: "y-ai-row" });
    const picker = controls.createEl("input", { attr: { type: "file", accept: ATTACHMENT_ACCEPT, multiple: "", "aria-label": "Choose attachments" } }); picker.hidden = true;
    picker.addEventListener("change", () => { const files = Array.from(picker.files ?? []); picker.value = ""; void w.addAttachments(files); });
    const attach = this.button(controls, "", () => picker.click(), w.settingsLocked, "y-ai-attach clickable-icon"); attach.setAttribute("aria-label", "Attach images, files or audio"); attach.title = "Attach images, files or audio · 10 files / 20 MiB total · sent only when you choose send"; setIcon(attach, "plus");
    const mode = this.select(controls, "AI mode", { expanded: "Expanded", provided: "Provided only" }, w.sourceMode, value => w.setSourceMode(value)); mode.title = SOURCE_MODES[w.sourceMode];
    const run = this.button(controls, w.busy ? w.canStop ? "Stop" : w.stopping ? "Stopping…" : "Finishing…" : w.canContinue ? "Continue" : "Send", () => { if (w.busy) w.stop(); else { prompt.blur(); void w.run(); } }, w.busy ? !w.canStop : !this.actionReady(), `y-ai-send ${w.busy ? "mod-warning" : "mod-cta"}`);
    run.title = w.busy ? "Stop future requests and file actions; keep completed work and any already-sent answer" : `Send permitted data directly to OpenAI · API charges · ${requestLimitLabel(w.maximum)}`;
    prompt.addEventListener("input", () => { w.setPrompt(prompt.value); run.disabled = !this.actionReady(); this.saveSoon(); });
    prompt.addEventListener("keydown", event => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !run.disabled && !w.busy) { event.preventDefault(); run.click(); } });
    scroll.scrollTop = oldMenuScroll; messages.scrollTop = follow && !this.chatQuery ? messages.scrollHeight : oldScroll;
    if (searchFocused) { search.focus({ preventScroll: true }); search.setSelectionRange(searchCursor, searchCursor); }
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
    const focus = () => { const active = doc.activeElement; root.classList.toggle("y-ai-searching", active !== null && active.instanceOf(HTMLElement) && active.matches(".y-ai-chat-search")); root.classList.toggle("y-ai-editing-scope", active !== null && active.instanceOf(HTMLElement) && !!active.closest(".y-ai-scroll") && active.matches("input,textarea")); resize(); };
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
