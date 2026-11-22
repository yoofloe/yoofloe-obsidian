import { openDesktopResponse } from "./desktop-responses";
import { App, FileSystemAdapter, MarkdownView, Notice, Platform, Plugin, PluginSettingTab, Setting, TFile, TFolder, apiVersion, requestUrl, requireApiVersion, type SettingDefinitionRender } from "obsidian";
import { ACTION, INBOX } from "./protocol";
import { CalendarSession, type TransferStore } from "./session";
import { CalendarChangeSession } from "./calendar-change-session";
import { CalendarWorkspaceLookupSession } from "./calendar-workspace-lookup-session";
import { CalendarWorkspaceChangeSession } from "./calendar-workspace-change-session";
import { validateCalendarWorkspaceOperation } from "./calendar-workspace-catalog";
import { ChronoHudLookupSession } from "./chronohud-lookup-session";
import { CHRONOHUD_ACTION, CHRONOHUD_INBOX } from "./chronohud-protocol";
import { AiPreferences, localSecretBinding } from "./ai-preferences";
import { OPENAI_ADAPTER } from "./openai";
import { holdRequestScreen } from "./openai-request";
import { createAndroidModelStream } from "./android-model-stream";
import { backgroundAccess } from "./background-response";
import { AiSession } from "./ai-session";
import { AiSettingsModal, type AiContext } from "./ai-modals";
import { AiWorkspace, type WorkspaceSource } from "./workspace";
import { AI_VIEW, LegacyYoofloeView, YoofloeAiView } from "./workspace-view";
import { obsidianAgentHost } from "./obsidian-agent-host";
import { CompanionModal } from "./manual-import";
import { captureSelectionReference, type SelectionReference } from "./selection-reference";
import { observeNoteSelection } from "./note-selection-observer";
import { DATA_FLOW_NOTICE, LOCAL_DATA_NOTICE, PRIVACY_URL } from "./privacy-copy";
import { DeviceRecords, indexedRecordDatabase } from "./device-records";
import { Diagnostics } from "./diagnostics";
import { ConversationStorage } from "./conversation-storage";
import { SharedConversations } from "./shared-conversations";
import { sharedConversationPath, SHARED_CONVERSATIONS_PATH } from "./agent-policy";
import { generatedStore } from "./generated-files";
import { attachmentStore, MAX_ATTACHMENT_BYTES } from "./attachments";
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
    this.registerObsidianProtocolHandler(CHRONOHUD_ACTION, params => {
      const access = this.work?.chronoHud;
      if (!this.live || !Platform.isAndroidApp || params.version !== "1" || !params.requestId || params.requestId !== access?.requestId) return;
      const leaf = this.app.workspace.getLeavesOfType(AI_VIEW)[0];
      if (leaf?.view instanceof YoofloeAiView) leaf.view.revealAppContext("chronohud");
      if (leaf) void this.app.workspace.revealLeaf(leaf);
      void access.receive(params.requestId);
    });
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
          if (prior?.view instanceof YoofloeAiView) prior.view.revealAppContext("calendar");
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
    if (!view.file || sharedConversationPath(view.file.path)) return null;
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
    const provider = providerFiles(async request => {
      const { status, text, arrayBuffer, headers } = await requestUrl(request);
      return { status, text, arrayBuffer, headers };
    }, (url, key, maximum, current, diagnostics) => boundedOpenAiDownload(url, key, maximum, current, undefined, diagnostics));
    const localFiles = { configDir: owner.configDir, exists: (path: string) => adapter.exists(path), mkdir: async (path: string) => { if (!ai.current()) throw Error("Vault changed"); await adapter.mkdir(path); }, read: (path: string) => adapter.readBinary(path), write: async (path: string, bytes: ArrayBuffer) => { if (!ai.current()) throw Error("Vault changed"); await adapter.writeBinary(path, bytes); } };
    const viewWindow = this.app.workspace.containerEl.ownerDocument.defaultView ?? window;
    const ownerName = owner.getName(), sameVault = () => this.app.vault === owner && owner.getName() === ownerName;
    const deviceOptions = {
      database: indexedRecordDatabase(viewWindow.indexedDB),
      secrets: () => requireApiVersion("1.11.5") ? this.app.secretStorage : null,
      vaultId: () => {
        const slot = "yoofloe-device-vault";
        const value: unknown = this.app.loadLocalStorage(slot);
        if (typeof value === "string" && /^[a-f0-9-]{36}$/.test(value)) return value;
        if (value != null) throw Error("The device vault identifier is invalid.");
        const id = crypto.randomUUID();
        this.app.saveLocalStorage(slot, id);
        if (this.app.loadLocalStorage(slot) !== id) throw Error("The device vault identifier could not be saved.");
        return id;
      },
    };
    const device = new DeviceRecords({ ...deviceOptions, current: () => ai.current() });
    // Only the diagnostic archive can finish its encrypted checkpoint during plugin unload.
    const diagnosticDevice = new DeviceRecords({ ...deviceOptions, current: sameVault });
    const document = viewWindow.document;
    const networkSignals = () => ({ online: viewWindow.navigator.onLine, visible: document.visibilityState === "visible" });
    const platform = Platform.isAndroidApp ? "android" : Platform.isIosApp ? "ios" :
      Platform.isWin ? "windows" : Platform.isMacOS ? "macos" : Platform.isLinux ? "linux" : "other";
    const diagnostics = new Diagnostics(diagnosticDevice, { plugin: this.manifest.version, obsidian: apiVersion, platform },
      sameVault, Date.now, networkSignals, viewWindow);
    const networkChanged = () => diagnostics.signal("network", networkSignals());
    this.registerDomEvent(viewWindow, "online", networkChanged);
    this.registerDomEvent(viewWindow, "offline", networkChanged);
    this.registerDomEvent(document, "visibilitychange", () => {
      diagnostics.signal("visibility", networkSignals());
      if (document.visibilityState !== "visible") void diagnostics.flush();
    });
    this.registerDomEvent(viewWindow, "pagehide", () => {
      diagnostics.signal("session", { visible: false });
      void diagnostics.flush();
    });
    const storage = new ConversationStorage(device, {
      read: async (name, limit) => {
        if (!ai.current()) throw Error("The vault changed.");
        const path = root + "/" + name;
        const stat = await adapter.stat(path);
        if (!stat) return null;
        if (stat.type !== "file" || stat.size > limit) throw Error("A legacy conversation file exceeds its device size limit.");
        const bytes = await adapter.readBinary(path);
        if (!ai.current() || bytes.byteLength > limit) throw Error("A legacy conversation file could not be verified.");
        return bytes;
      },
      list: async folder => {
        if (!ai.current()) throw Error("The vault changed.");
        const path = root + "/" + folder;
        return await adapter.exists(path) ? (await adapter.list(path)).files
          .filter(file => file.startsWith(path + "/")).map(file => file.slice(root.length + 1)) : [];
      },
    }, () => ai.current());
    const sharing = new SharedConversations({
      current: () => ai.current(),
      read: async (path, limit) => {
        if (!ai.current() || !sharedConversationPath(path)) throw Error("The shared conversation path is unavailable.");
        const stat = await adapter.stat(path);
        if (!stat) return null;
        if (stat.type !== "file" || stat.size > limit) throw Error("A synced conversation file exceeds its limit.");
        const text = await adapter.read(path);
        if (!ai.current() || new TextEncoder().encode(text).byteLength > limit) throw Error("A synced file could not be verified.");
        return text;
      },
      list: async path => {
        if (!ai.current() || !sharedConversationPath(path)) throw Error("The shared conversation folder is unavailable.");
        return await adapter.exists(path) ? await adapter.list(path) : { files: [], folders: [] };
      },
      mkdir: async path => {
        if (!sharedConversationPath(path)) throw Error("The shared conversation folder is unavailable.");
        for (const name of ["Yoofloe AI", SHARED_CONVERSATIONS_PATH, path]) {
          if (!ai.current()) throw Error("The vault changed.");
          const item = owner.getAbstractFileByPath(name);
          if (item instanceof TFolder) continue;
          try { await owner.createFolder(name); }
          catch { if (!(owner.getAbstractFileByPath(name) instanceof TFolder)) throw Error("The shared conversation folder could not be created."); }
        }
      },
      create: async (path, text) => {
        if (!ai.current() || !sharedConversationPath(path)) throw Error("The shared conversation path is unavailable.");
        await owner.create(path, text);
      },
      remove: async (path, expected) => {
        if (!ai.current() || !sharedConversationPath(path)) throw Error("The shared conversation path is unavailable.");
        const file = owner.getAbstractFileByPath(path);
        if (!(file instanceof TFile) || await owner.read(file) !== expected ||
          !ai.current() || owner.getAbstractFileByPath(path) !== file) throw Error("A shared file changed before removal.");
        await this.app.fileManager.trashFile(file);
        if (await adapter.exists(path)) throw Error("A shared conversation file could not be removed.");
      },
    });
    let sharedRefreshTimer = 0;
    const refresh = (path: string, oldPath = "") => {
      if (!sharedConversationPath(path) && !sharedConversationPath(oldPath)) return;
      viewWindow.clearTimeout(sharedRefreshTimer);
      sharedRefreshTimer = viewWindow.setTimeout(() => { void this.work?.refreshSharedConversations(); }, 200);
    };
    this.registerEvent(owner.on("create", file => refresh(file.path)));
    this.registerEvent(owner.on("modify", file => refresh(file.path)));
    this.registerEvent(owner.on("delete", file => refresh(file.path)));
    this.registerEvent(owner.on("rename", (file, oldPath) => refresh(file.path, oldPath)));
    this.register(() => viewWindow.clearTimeout(sharedRefreshTimer));
    const privateAttachment = (path: string) => {
      const name = path.slice(root.length + 1);
      if (!path.startsWith(root + "/") || !/^attachments\/[a-f0-9-]{36}\.[a-z0-9]+(?:\.transcript\.txt)?$/.test(name))
        throw Error("Invalid private attachment path.");
      return name;
    };
    const transcriptLimit = 512 * 1024;
    const companionStore: TransferStore = {
      exists: path => adapter.exists(path), mkdir: path => adapter.mkdir(path),
      write: (path, text) => adapter.write(path, text), read: path => adapter.read(path),
      size: async path => { const stat = await adapter.stat(path); return stat?.type === "file" ? stat.size : null; },
      remove: path => adapter.remove(path),
    };
    const companionOptions = { store: companionStore, vaultName: () => owner.getName(), allowed: () => ai.current() && Platform.isAndroidApp };
    const workspaceTransfer = () => ({
      ...companionOptions,
      vaultIdentity: () => this.app.vault, canClean: () => this.app.vault === owner,
    });
    this.work = new AiWorkspace({ current: () => ai.current(), preferences: ai.preferences, gate: this.gate, configDir: owner.configDir,
      ...(Platform.isDesktopApp ? { liveResponse: openDesktopResponse } : {}),
      ...(Platform.isAndroidApp ? {
        streamResponses: true, directStream: createAndroidModelStream(viewWindow),
        androidRecovery: {
          enabled: () => this.app.loadLocalStorage("yoofloe-android-response-recovery") === true,
          setEnabled: (enabled: boolean) => this.app.saveLocalStorage("yoofloe-android-response-recovery", enabled),
          access: backgroundAccess(async request => {
            if (this.app.vault !== owner) throw Error("Vault changed");
            const { status, text, headers } = await requestUrl(request);
            return { status, text, headers };
          }, document),
        },
        appVisible: () => document.visibilityState === "visible",
        holdScreen: () => holdRequestScreen(viewWindow.navigator.wakeLock, document),
      } : {}),
      generated: generatedStore({ ...localFiles, download: provider.download }),
      attachments: attachmentStore({
        configDir: owner.configDir, exists: path => Promise.resolve(path === root + "/attachments"),
        mkdir: () => Promise.resolve(),
        read: async path => {
          const bytes = await storage.readBlob(privateAttachment(path), MAX_ATTACHMENT_BYTES);
          if (!bytes) throw Error("The private attachment is unavailable. Attach it again.");
          return bytes;
        },
        write: (path, bytes) => storage.saveBlob(privateAttachment(path), bytes, MAX_ATTACHMENT_BYTES),
        upload: provider.upload, transcribe: provider.transcribe, removeUpload: provider.removeUpload,
        transcript: async path => {
          const bytes = await storage.readBlob(privateAttachment(path), transcriptLimit);
          return bytes === null ? null : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        },
        saveTranscript: (path, value) => storage.saveBlob(privateAttachment(path), new TextEncoder().encode(value).buffer, transcriptLimit),
      }),
      host: current => obsidianAgentHost(this.app, owner, current, journal => storage.saveJournal(journal)),
      inboxHint: () => adapter.getResourcePath(INBOX + "/"),
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
      storage, sharing, diagnostics,
      ...(Platform.isAndroidApp ? {
        calendar: () => new CalendarSession({ ...companionOptions, diagnostics: action => diagnostics.start("calendar", this.work?.library.active, { action }) }),
        calendarChange: () => new CalendarChangeSession({ ...companionOptions, canClean: () => this.app.vault === owner }),
      } : {}),
      ...(Platform.isAndroidApp ? {
        workspaceLookup: () => new CalendarWorkspaceLookupSession(workspaceTransfer()),
        chronoHudLookup: () => new ChronoHudLookupSession(workspaceTransfer()),
        chronoHudInboxHint: () => adapter.getResourcePath(CHRONOHUD_INBOX + "/"),
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
    this.manual = new CompanionModal(this.app, () => this.live, () => { this.manual = null; }, () => this.context(), () => this.openAiSettings(true),
      action => {
        const work = this.workspace();
        return work.diagnostics?.start("calendar", work.library.active, { action });
      });
    this.manual.open();
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
