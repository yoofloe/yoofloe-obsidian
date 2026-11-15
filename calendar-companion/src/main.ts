import { turnConversation } from "./conversation-library";
import { openDesktopResponse } from "./desktop-responses";
import { App, FileSystemAdapter, MarkdownView, Notice, Platform, Plugin, PluginSettingTab, Setting, requestUrl, requireApiVersion, type SettingDefinitionRender } from "obsidian";
import { ACTION, INBOX } from "./protocol";
import { CalendarSession, type TransferStore } from "./session";
import { CalendarChangeSession } from "./calendar-change-session";
import { CalendarWorkspaceLookupSession } from "./calendar-workspace-lookup-session";
import { CalendarWorkspaceChangeSession } from "./calendar-workspace-change-session";
import { validateCalendarWorkspaceOperation } from "./calendar-workspace-catalog";
import { temporaryCalendarTransferStore } from "./calendar-workspace-file";
import { AiPreferences, localSecretBinding } from "./ai-preferences";
import { OPENAI_ADAPTER } from "./openai";
import { AiSession } from "./ai-session";
import { AiSettingsModal, type AiContext } from "./ai-modals";
import { AiWorkspace, type WorkspaceSource } from "./workspace";
import { AI_VIEW, LegacyYoofloeView, YoofloeAiView } from "./workspace-view";
import { loadWorkRecords, obsidianAgentHost } from "./obsidian-agent-host";
import { CompanionModal } from "./manual-import";
import { captureSelectionReference, type SelectionReference } from "./selection-reference";
import { observeNoteSelection } from "./note-selection-observer";
import { DATA_FLOW_NOTICE, LOCAL_DATA_NOTICE, PRIVACY_URL } from "./privacy-copy";
import { readChat, validChatId, chatMatches, searchChatPreview, type ChatTurn } from "./chat-history";
import { generatedStore } from "./generated-files";
import { attachmentStore } from "./attachments";
import { boundedOpenAiDownload, providerFiles } from "./provider-files";
import { WorkspaceNotePicker } from "./note-picker";

const STORE_URL = "https://play.google.com/store/apps/details?id=com.yoofloe.calendar";
/** Plugin ID, local secret binding and the Calendar v2/v3 callback stay stable. No startup network requests. */
export default class YoofloeAiPlugin extends Plugin {
  private live = true;
  private ai: AiContext | null = null;
  private work: AiWorkspace | null = null;
  private aiSettings: AiSettingsModal | null = null;
  private manual: CompanionModal | null = null;
  private gate = { busy: false };
  private lastSource: WorkspaceSource | null = null;
  private sourceEpoch = 0;
  private selectionEpoch = 0;
  private capturingSource: number | null = null;
  private capturingPath: string | null = null;
  private notesReady = false;
  private actions = new Map<MarkdownView, { button: HTMLElement; document: Document; stopSelection: () => void }>();
  onload(): void {
    this.addSettingTab(new YoofloeSettings(this.app, this));
    this.registerView(AI_VIEW, leaf => new YoofloeAiView(leaf, this.workspace(), { settings: () => this.openAiSettings(), chooseNote: () => { void this.chooseNote(); }, hide: () => { leaf.detach(); } }));
    for (const type of ["yoofloe-ai-writer", "yoofloe-capture"]) this.registerView(type, leaf => new LegacyYoofloeView(leaf, type, () => this.openWorkspace()));
    this.addCommand({ id: "note-ai", name: "Open", icon: "sparkles", callback: () => this.openWorkspace() });
    this.addRibbonIcon("sparkles", "Yoofloe", () => this.openWorkspace());
    if (this.app.workspace) {
      this.registerEvent(this.app.workspace.on("editor-menu", (menu, _editor, info) => {
        if (info instanceof MarkdownView) menu.addItem(item => item.setTitle("Yoofloe").setIcon("sparkles").onClick(() => this.openWorkspace(info)));
      }));
      this.registerEvent(this.app.workspace.on("file-menu", (menu, file, _source, leaf) => {
        const view = leaf?.view; if (view instanceof MarkdownView && view.file === file) menu.addItem(item => item.setTitle("Yoofloe").setIcon("sparkles").onClick(() => this.openWorkspace(view)));
      }));
      const update = () => this.updateActions();
      const trackNote = () => this.updateActions(this.notesReady);
      this.registerEvent(this.app.workspace.on("layout-change", update));
      this.registerEvent(this.app.workspace.on("active-leaf-change", trackNote));
      this.registerEvent(this.app.workspace.on("file-open", trackNote));
      this.app.workspace.onLayoutReady(() => { update(); this.notesReady = true; void this.mergeLegacyPanels(); });
      this.register(() => {
        for (const action of this.actions.values()) { action.button.remove(); action.stopSelection(); }
        this.actions.clear();
      });
    }
    this.registerObsidianProtocolHandler(ACTION, params => {
      if (!this.live || !Platform.isAndroidApp) { new Notice("Direct Calendar lookup requires both apps on the same Android phone or tablet. Yoofloe itself works without Calendar."); return; }
      if (params.version === "5" && params.requestId) {
        const work = this.work, prior = this.app.workspace.getLeavesOfType(AI_VIEW)[0];
        if (work?.workspaceCalendarChanges.requestId === params.requestId) {
          if (prior) void this.app.workspace.revealLeaf(prior);
          void work.workspaceCalendarChanges.receive(params.requestId);
          return;
        }
        if (work?.workspaceCalendar?.requestId === params.requestId) {
          if (prior) void this.app.workspace.revealLeaf(prior);
          void work.workspaceCalendar.receive(params.requestId);
          return;
        }
        new Notice("No matching Calendar workspace request. Open the active request in Yoofloe.");
        return;
      }
      if (params.version === "4") {
        const changes = this.work?.calendarChanges;
        if (!changes || !params.requestId || params.requestId !== changes.requestId) {
          new Notice("No matching Calendar change connection. Check the proposal in Yoofloe.");
          return;
        }
        const leaf = this.app.workspace.getLeavesOfType(AI_VIEW)[0];
        if (leaf) void this.app.workspace.revealLeaf(leaf);
        void changes.receive(params.requestId);
        return;
      }
      if (!params.requestId) { this.openWorkspace(); return; }
      if (params.vault !== this.app.vault.getName()) { new Notice("This Calendar request belongs to another vault."); return; }
      if (this.work?.requestId === params.requestId) { void this.work.receiveCalendar(params.requestId); this.openWorkspace(); return; }
      if (this.manual) { void this.manual.receive(params.requestId); return; }
      new Notice("No matching local request. Start a new Calendar lookup in Yoofloe.");
    });
  }
  private capture(view: MarkdownView): WorkspaceSource | null {
    if (!view.file) return null;
    const source: WorkspaceSource = { path: view.file.path };
    if (view.getMode() === "source") {
      const ranges = view.editor.listSelections().map(({ anchor, head }) => {
        const start = view.editor.posToOffset(anchor), end = view.editor.posToOffset(head);
        return { from: Math.min(start, end), to: Math.max(start, end) };
      }).filter(range => range.from < range.to);
      if (ranges.length > 1)
        throw Error("Choose one continuous passage for the reference.");
      if (ranges.length === 1) source.selection = ranges[0];
    } else {
      const selection = view.contentEl.ownerDocument.getSelection();
      if (selection && !selection.isCollapsed && selection.anchorNode && selection.focusNode &&
          view.contentEl.contains(selection.anchorNode) && view.contentEl.contains(selection.focusNode))
        source.quote = selection.toString();
    }
    return source;
  }
  private canCaptureOpenReference(view: MarkdownView, work: AiWorkspace): boolean {
    const doc = view.contentEl.ownerDocument;
    return this.live && this.work === work && work.canChangeReference && !work.settingsLocked && !work.editingFollowUpId &&
      this.app.workspace.getLeavesOfType(AI_VIEW).some(leaf => {
        if (!(leaf.view instanceof YoofloeAiView)) return false;
        const pane = leaf.view.contentEl;
        return pane.ownerDocument === doc && (Platform.isMobile || pane.isConnected && pane.getClientRects().length > 0);
      });
  }
  private watchOpenReference(view: MarkdownView): () => void {
    return observeNoteSelection(view.contentEl, () => {
      const work = this.work;
      if (!work || !this.canCaptureOpenReference(view, work)) return null;
      try {
        const source = this.capture(view);
        if (!source || (!source.selection && !source.quote)) return null;
        return { key: JSON.stringify(source), value: { work, source, revision: work.referenceRevision } };
      } catch { return null; }
    }, ({ work, source, revision }, epoch) => {
      const file = view.file;
      const mode = view.getMode();
      const ownerDocument = view.contentEl.ownerDocument;
      if (epoch !== this.selectionEpoch || !file || file.path !== source.path || work.referenceRevision !== revision) return;
      void (async () => {
        const document = mode === "source" ? view.editor.getValue() : await this.app.vault.cachedRead(file);
        const reference = await captureSelectionReference(source.path, document, source.selection?.from ?? 0,
          source.selection?.to ?? document.length, source.quote);
        if (epoch !== this.selectionEpoch || view.file !== file || file.path !== source.path || view.getMode() !== mode ||
            view.contentEl.ownerDocument !== ownerDocument ||
            !this.canCaptureOpenReference(view, work) || !this.actions.has(view)) return;
        work.setReference(reference, revision);
      })().catch(() => { /* A stale or unsupported selection leaves the draft as it was. */ });
    }, () => {
      const work = this.work;
      if (work && this.canCaptureOpenReference(view, work)) this.selectionEpoch++;
      return this.selectionEpoch;
    });
  }
  private updateActions(bindActive = false): void {
    if (!this.live) return;
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active?.file) {
      if (this.lastSource?.path !== active.file.path && this.capturingPath !== active.file.path) { this.sourceEpoch++; this.selectionEpoch++; this.capturingSource = null; this.capturingPath = null; this.lastSource = { path: active.file.path }; }
      if (bindActive && this.capturingSource === null && this.work && this.lastSource) this.work.bind({ path: this.lastSource.path });
    }
    const views = this.app.workspace.getLeavesOfType("markdown").map(leaf => leaf.view).filter((view): view is MarkdownView => view instanceof MarkdownView);
    for (const [view, action] of this.actions) if (!views.includes(view)) {
      action.button.remove(); action.stopSelection(); this.actions.delete(view);
    }
    for (const view of views) {
      const doc = view.contentEl.ownerDocument;
      const previous = this.actions.get(view);
      if (previous?.document === doc) continue;
      previous?.stopSelection();
      const button = previous?.button ?? view.addAction("sparkles", "Yoofloe", () => this.openWorkspace(view));
      this.actions.set(view, { button, document: doc, stopSelection: this.watchOpenReference(view) });
    }
  }
  openWorkspace(sourceView?: MarkdownView): void {
    void this.showWorkspace(sourceView).catch(() => new Notice("Yoofloe could not open. Existing notes and saved work are kept."));
  }
  private async showWorkspace(sourceView?: MarkdownView): Promise<void> {
    if (!this.live) return;
    const epoch = ++this.sourceEpoch;
    const selectionEpoch = ++this.selectionEpoch;
    const referenceRevision = this.work?.referenceRevision;
    const file = this.app.workspace.getActiveFile();
    const focused = this.app.workspace.getActiveViewOfType(MarkdownView);
    const active = sourceView ?? focused ?? this.app.workspace.getLeavesOfType("markdown").map(leaf => leaf.view).find((view): view is MarkdownView => view instanceof MarkdownView && view.file === file);
    let selected: WorkspaceSource | null = null;
    let reference: SelectionReference | null = null;
    if (active) {
      const source = this.capture(active);
      const sourceFile = active.file; this.capturingSource = epoch; this.capturingPath = source?.path ?? null;
      try {
        if (source && sourceFile && (source.selection || source.quote)) {
          const document = active.getMode() === "source" ? active.editor.getValue() : await this.app.vault.cachedRead(sourceFile);
          reference = await captureSelectionReference(source.path, document, source.selection?.from ?? 0,
            source.selection?.to ?? document.length, source.quote);
        }
      }
      finally { if (this.capturingSource === epoch) { this.capturingSource = null; this.capturingPath = null; } }
      if (!this.live) return;
      if (this.sourceEpoch === epoch && active.file === sourceFile && sourceFile?.path === source?.path) { selected = source ? { path: source.path } : null; this.lastSource = selected; }
    }
    const work = this.workspace(); await work.initialize(); if (!this.live) return;
    if (this.sourceEpoch === epoch && this.capturingSource === null) {
      work.bind(selected ?? this.lastSource, false, true);
      if (reference && selectionEpoch === this.selectionEpoch) work.setReference(reference, referenceRevision ?? work.referenceRevision);
    }
    let leaf = this.app.workspace.getLeavesOfType(AI_VIEW)[0];
    if (Platform.isPhone && leaf && leaf.getRoot() !== this.app.workspace.rootSplit) {
      const previous = leaf; leaf = this.app.workspace.getLeaf(true); await leaf.setViewState({ type: AI_VIEW, active: true });
      if (previous.view.getViewType() === AI_VIEW) previous.detach();
    }
    if (!leaf) { leaf = Platform.isPhone ? this.app.workspace.getLeaf(true) : this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(true); await leaf.setViewState({ type: AI_VIEW, active: true }); }
    await this.app.workspace.revealLeaf(leaf);
  }
  private async chooseNote(): Promise<void> {
    const work = this.workspace(); await work.initialize();
    if (!this.live || !work.current || work.settingsLocked) return;
    try { new WorkspaceNotePicker(this.app, work).open(); }
    catch { new Notice("Notes could not be listed. Check the selected read scope and try again."); }
  }
  private async mergeLegacyPanels(): Promise<void> {
    const types = ["yoofloe-ai-writer", "yoofloe-capture"], leaves = types.flatMap(type => this.app.workspace.getLeavesOfType(type));
    if (!leaves.length || !this.live) return;
    try {
      const owner = this.app.vault, root = `${owner.configDir}/plugins/yoofloe`, path = `${root}/legacy-layout-${crypto.randomUUID()}.json`;
      const text = JSON.stringify({ savedAt: Date.now(), panels: leaves.map(leaf => leaf.getViewState()) });
      await owner.adapter.write(path, text); if (!this.live || this.app.vault !== owner || await owner.adapter.read(path) !== text) return;
      let current = this.app.workspace.getLeavesOfType(AI_VIEW)[0];
      for (const leaf of leaves) {
        if (!this.live || !types.includes(leaf.view.getViewType())) continue;
        if (!current) { await leaf.setViewState({ type: AI_VIEW, active: false }); current = leaf; }
        else leaf.detach();
      }
    } catch { new Notice("The old panel state could not be backed up. It was kept; open Yoofloe from the sparkle icon."); }
  }
  private context(): AiContext {
    if (!this.ai) {
      const owner = this.app.vault, name = owner.getName(), current = () => this.live && this.app.vault === owner && owner.getName() === name;
      const preferences = new AiPreferences({ current, binding: () => localSecretBinding(owner.adapter.getResourcePath(""), !Platform.isAndroidApp && typeof FileSystemAdapter === "function" && owner.adapter instanceof FileSystemAdapter ? owner.adapter.getBasePath() : undefined), load: () => this.loadData(), save: value => this.saveData(value),
        secrets: () => requireApiVersion("1.11.5") && typeof this.app.secretStorage?.getSecret === "function" && typeof this.app.secretStorage?.setSecret === "function" ? this.app.secretStorage : null });
      const session = new AiSession({ adapters: [OPENAI_ADAPTER], current, gate: this.gate, key: provider => preferences.key(provider), transport: async request => {
        if (!current()) throw Error("Vault changed"); const response = await requestUrl(request); return { status: response.status, text: response.text };
      } });
      this.ai = { current, preferences, session };
    }
    return this.ai;
  }
  private workspace(): AiWorkspace {
    if (this.work) return this.work;
    const ai = this.context(), owner = this.app.vault, adapter = owner.adapter, root = `${owner.configDir}/plugins/yoofloe`;
    const provider = providerFiles(async request => { const response = await requestUrl(request); return { status: response.status, text: response.text, arrayBuffer: response.arrayBuffer }; }, boundedOpenAiDownload);
    const localFiles = { configDir: owner.configDir, exists: (path: string) => adapter.exists(path), mkdir: async (path: string) => { if (!ai.current()) throw Error("Vault changed"); await adapter.mkdir(path); }, read: (path: string) => adapter.readBinary(path), write: async (path: string, bytes: ArrayBuffer) => { if (!ai.current()) throw Error("Vault changed"); await adapter.writeBinary(path, bytes); } };
    const workspaceLimit = 8 * 1024 * 1024;
    const readLocalState = async (path: string): Promise<unknown> => {
      if (!ai.current()) throw Error("Vault changed");
      if (!await adapter.exists(path)) return null;
      const stat = await adapter.stat(path);
      if (!stat || stat.size > workspaceLimit) throw Error("Saved work exceeds its local size limit.");
      const value = JSON.parse(await adapter.read(path)) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("The existing work record is not a workspace object.");
      return value;
    };
    const saveLocalState = async (path: string, value: unknown): Promise<void> => {
      if (!ai.current()) throw Error("Vault changed");
      const text = JSON.stringify(value);
      if (new TextEncoder().encode(text).length > workspaceLimit) throw Error("Saved work exceeds its local size limit.");
      await adapter.write(path, text);
      if (!ai.current() || await adapter.read(path) !== text) throw Error("The local work record could not be confirmed.");
    };
    const conversationPath = (id: string) => {
      if (!validChatId(id)) throw Error("Invalid local conversation identifier.");
      return `${root}/conversations/${id}.json`;
    };
    let chatQueue: Promise<void> = Promise.resolve();
    const companionStore: TransferStore = {
      exists: path => adapter.exists(path), mkdir: path => adapter.mkdir(path),
      write: (path, text) => adapter.write(path, text), read: path => adapter.read(path),
      size: async path => { const stat = await adapter.stat(path); return stat?.type === "file" ? stat.size : null; },
      remove: path => adapter.remove(path),
    };
    const companionOptions = { store: companionStore, vaultName: () => owner.getName(), allowed: () => ai.current() && Platform.isAndroidApp };
    const workspaceTransfer = () => ({
      store: Platform.isDesktopApp ? temporaryCalendarTransferStore() : companionStore,
      vaultName: () => owner.getName(), allowed: () => ai.current() && (Platform.isDesktopApp || Platform.isAndroidApp),
      vaultIdentity: () => this.app.vault, canClean: () => this.app.vault === owner,
    });
    this.work = new AiWorkspace({ current: () => ai.current(), preferences: ai.preferences, gate: this.gate, configDir: owner.configDir,
      ...(Platform.isDesktopApp ? { liveResponse: openDesktopResponse } : {}),
      generated: generatedStore({ ...localFiles, download: provider.download }),
      attachments: attachmentStore({ ...localFiles, upload: provider.upload, transcribe: provider.transcribe, removeUpload: provider.removeUpload,
        transcript: async path => { if (!await adapter.exists(path)) return null; const stat = await adapter.stat(path); if (!stat || stat.size > 512 * 1024) throw Error("The saved transcript exceeds its limit."); return adapter.read(path); },
        saveTranscript: async (path, text) => { if (!ai.current()) throw Error("Vault changed"); await adapter.write(path, text); if (await adapter.read(path) !== text) throw Error("The transcript could not be saved locally."); },
      }),
      host: current => obsidianAgentHost(this.app, owner, current), inboxHint: () => adapter.getResourcePath(`${INBOX}/`),
      transport: async request => {
        if (!ai.current()) throw Error("Vault changed");
        const { status, text, headers } = await requestUrl(request);
        return { status, text, headers };
      },
      countTokens: async request => {
        if (!ai.current()) throw Error("Vault changed");
        const { status, text, headers } = await requestUrl(request);
        return { status, text, headers };
      },
      storage: {
        load: () => readLocalState(`${root}/workspace.json`),
        save: value => saveLocalState(`${root}/workspace.json`, value),
        loadConversation: id => readLocalState(conversationPath(id)),
        saveConversation: async (id, value) => {
          if (!ai.current()) throw Error("Vault changed");
          const path = conversationPath(id), folder = `${root}/conversations`;
          if (!await adapter.exists(folder)) await adapter.mkdir(folder);
          await saveLocalState(path, value);
        },
        history: () => loadWorkRecords(owner),
        saveChat: (turn: ChatTurn) => {
          if (!validChatId(turn.id)) return Promise.reject(Error("Invalid local chat record."));
          if (turn.requestTruncated || turn.answerTruncated || turn.generatedTruncated || turn.workDetailsTruncated) return Promise.reject(Error("Load the full conversation before updating its archive."));
          const text = JSON.stringify({ ...turn, requestTruncated: false, answerTruncated: false, generatedTruncated: false });
          if (new TextEncoder().encode(text).length > 6 * 1024 * 1024) return Promise.reject(Error("The full chat record exceeds its local size limit. The current answer is kept."));
          const next = chatQueue.then(async () => {
            if (!ai.current()) throw Error("Vault changed"); const folder = `${root}/chats`; if (!await adapter.exists(folder)) await adapter.mkdir(folder);
            const path = `${folder}/${turn.id}.json`; await adapter.write(path, text); if (!ai.current() || await adapter.read(path) !== text) throw Error("Local chat saving could not be confirmed.");
          }); chatQueue = next.catch(() => {}); return next;
        },
        loadChat: async id => {
          if (!ai.current() || !validChatId(id)) throw Error("This chat record is unavailable.");
          const path = `${root}/chats/${id}.json`, stat = await adapter.stat(path);
          if (!stat || stat.size > 6 * 1024 * 1024) throw Error("This full chat record cannot be read safely.");
          const turn = readChat(JSON.parse(await adapter.read(path)) as unknown); if (!ai.current() || turn?.id !== id) throw Error("The local chat record could not be confirmed."); return turn;
        },
        searchChats: async (query, offset, conversationId) => {
          if (!ai.current() || !query.trim() && !conversationId || conversationId && !validChatId(conversationId) || query.length > 200 || !Number.isSafeInteger(offset) || offset < 0) return { turns: [], nextOffset: null };
          const folder = `${root}/chats`; if (!await adapter.exists(folder)) return { turns: [], nextOffset: null };
          const listing = await adapter.list(folder), paths = listing.files.filter(path => { const name = path.slice(folder.length + 1); return path.startsWith(folder + "/") && name.endsWith(".json") && validChatId(name.slice(0, -5)); }).sort().reverse();
          const turns: ChatTurn[] = []; let index = offset, bytes = 0;
          for (; index < Math.min(paths.length, offset + 20); index++) {
            if (!ai.current()) break; const stat = await adapter.stat(paths[index]); if (!stat || stat.size > 6 * 1024 * 1024) continue;
            if (bytes && bytes + stat.size > 8 * 1024 * 1024) break; bytes += stat.size;
            try { const turn = readChat(JSON.parse(await adapter.read(paths[index])) as unknown); if (turn && (!conversationId || turnConversation(turn.conversationId) === conversationId) && (!query || chatMatches(turn, query))) turns.push(query ? searchChatPreview(turn, query) : turn); } catch { /* An unreadable archive stays untouched. */ }
          }
          return { turns, nextOffset: index < paths.length ? index : null };
        },
      },
      ...(Platform.isAndroidApp ? {
        calendar: () => new CalendarSession(companionOptions),
        calendarChange: () => new CalendarChangeSession({ ...companionOptions, canClean: () => this.app.vault === owner }),
      } : {}),
      ...(Platform.isAndroidApp || Platform.isDesktopApp ? {
        workspaceLookup: () => new CalendarWorkspaceLookupSession(workspaceTransfer()),
        workspaceChange: () => new CalendarWorkspaceChangeSession({ ...workspaceTransfer(), validate: validateCalendarWorkspaceOperation }),
      } : {}),
    });
    return this.work;
  }
  openAiSettings(manualDrafts = false): void {
    if (this.work?.settingsLocked) { new Notice("Finish or stop the current task before changing its model and key settings."); return; }
    if (!this.live) return; if (this.aiSettings) { this.aiSettings.open(); return; }
    this.aiSettings = new AiSettingsModal(this.app, this.context(), () => { this.aiSettings = null; void this.work?.refreshSettings(); }, manualDrafts); this.aiSettings.open();
  }
  openManual(): void {
    if (!this.live || !Platform.isAndroidApp) return; if (this.manual) { this.manual.open(); return; }
    this.manual = new CompanionModal(this.app, () => this.live, () => { this.manual = null; }, () => this.context(), () => this.openAiSettings(true)); this.manual.open();
  }
  onunload(): void { this.live = false; this.work?.dispose(); this.work = null; this.ai?.session.enableForSession(false); this.aiSettings?.close(); this.manual?.close(); this.aiSettings = null; this.manual = null; this.ai = null; }
}
interface SettingsRow {
  name: string; desc: string; aliases?: string[]; heading?: boolean; render?(setting: Setting): void;
}
class YoofloeSettings extends PluginSettingTab {
  constructor(app: App, private readonly yoofloe: YoofloeAiPlugin) { super(app, yoofloe); }
  /** Indexed at registration on 1.13+. Definitions are static: no vault reads, keys or provider calls. */
  getSettingDefinitions(): SettingDefinitionRender[] {
    return this.rows().map(row => ({ name: row.name, desc: row.desc, aliases: row.aliases, render: setting => this.renderRow(setting, row) }));
  }
  /** The same rows remain available on 1.11.5–1.12; newer hosts render the definitions instead. */
  display(): void {
    this.containerEl.empty();
    for (const row of this.rows()) this.renderRow(new Setting(this.containerEl), row);
  }
  private renderRow(setting: Setting, row: SettingsRow): void {
    setting.setName(row.name).setDesc(row.desc); if (row.heading) setting.setHeading(); row.render?.(setting);
  }
  private rows(): SettingsRow[] {
    const rows: SettingsRow[] = [
      { name: "Workspace", heading: true, desc: "Write, edit, organize and explore Markdown with your own OpenAI key. Works independently on desktop, mobile and tablets. Yoofloe Calendar is optional." },
      { name: "Yoofloe", desc: "Discover Yoofloe apps and support at www.yoofloe.com.", aliases: ["website", "homepage", "Yoofloe"], render: setting => { setting.descEl.appendText(" "); setting.descEl.createEl("a", { text: "www.yoofloe.com", href: "https://www.yoofloe.com", attr: { target: "_blank", rel: "noopener noreferrer" } }); } },
      { name: "One workspace", desc: "Use the sparkle ribbon, note header, note menu, or Yoofloe: Open command. Closing the panel keeps your draft and result.", aliases: ["Yoofloe", "notes", "data scope", "permissions", "request limit"],
        render: setting => { setting.addButton(b => b.setButtonText("Open Yoofloe").onClick(() => this.yoofloe.openWorkspace())); } },
      { name: "OpenAI key, model and thinking depth", desc: "Settings make no API requests. Starting a task sends permitted note text and context directly to OpenAI; API charges apply. A task may make multiple requests.", aliases: ["API key", "effort", "custom model", "AI settings", "cost"],
        render: setting => { setting.addButton(b => b.setButtonText("AI settings").onClick(() => this.yoofloe.openAiSettings())); } },
      { name: "Privacy and local data", desc: `${DATA_FLOW_NOTICE} ${LOCAL_DATA_NOTICE}`, aliases: ["privacy", "backups", "Undo", "data sharing", "servers", "OpenAI retention"],
        render: setting => { setting.descEl.appendText(" "); setting.descEl.createEl("a", { text: "Privacy and data controls", href: PRIVACY_URL, attr: { target: "_blank", rel: "noopener noreferrer" } }); } },
      { name: "Yoofloe Calendar · optional Android app", desc: "Plans, tasks, notes, study, projects and focus. Direct local lookup requires both apps on the same Android phone or tablet and profile, Calendar 1.8.5+, Obsidian 1.11.5+, and a vault in shared device storage. Yoofloe works independently on other platforms.", aliases: ["Calendar", "Android", "local records"],
        render: setting => { setting.addButton(b => b.setButtonText("Discover Calendar").onClick(() => this.containerEl.ownerDocument.defaultView?.open(STORE_URL, "_blank"))); } },
    ];
    if (Platform.isAndroidApp) rows.push({ name: "Manual Calendar import (advanced)", desc: "Save complete Markdown snapshots without AI. Calendar records remain unchanged.", aliases: ["Calendar import", "snapshots"],
      render: setting => { setting.addButton(b => b.setButtonText("Import records").onClick(() => this.yoofloe.openManual())); } });
    return rows;
  }
}
