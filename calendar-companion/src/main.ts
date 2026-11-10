import { App, FileSystemAdapter, MarkdownView, Notice, Platform, Plugin, PluginSettingTab, Setting, requestUrl, requireApiVersion, type SettingDefinitionRender } from "obsidian";
import { ACTION, INBOX } from "./protocol";
import { CalendarSession } from "./session";
import { AiPreferences, localSecretBinding } from "./ai-preferences";
import { OPENAI_ADAPTER } from "./openai";
import { AiSession } from "./ai-session";
import { AiSettingsModal, type AiContext } from "./ai-modals";
import { AiWorkspace, type WorkspaceSource } from "./workspace";
import { AI_VIEW, LegacyYoofloeView, YoofloeAiView } from "./workspace-view";
import { loadWorkRecords, obsidianAgentHost } from "./obsidian-agent-host";
import { CompanionModal } from "./manual-import";
import { inputDigest } from "./question-input";

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
  private actions = new Map<MarkdownView, HTMLElement>();
  onload(): void {
    this.addSettingTab(new YoofloeSettings(this.app, this));
    this.registerView(AI_VIEW, leaf => new YoofloeAiView(leaf, this.workspace(), { settings: () => this.openAiSettings(), hide: () => { leaf.detach(); } }));
    for (const type of ["yoofloe-ai-writer", "yoofloe-capture"]) this.registerView(type, leaf => new LegacyYoofloeView(leaf, type, () => this.openWorkspace()));
    this.addCommand({ id: "note-ai", name: "Open", icon: "sparkles", callback: () => this.openWorkspace() });
    this.addRibbonIcon("sparkles", "Yoofloe AI", () => this.openWorkspace());
    if (this.app.workspace) {
      this.registerEvent(this.app.workspace.on("editor-menu", (menu, _editor, info) => {
        if (info instanceof MarkdownView) menu.addItem(item => item.setTitle("Yoofloe AI").setIcon("sparkles").onClick(() => this.openWorkspace(info)));
      }));
      this.registerEvent(this.app.workspace.on("file-menu", (menu, file, _source, leaf) => {
        const view = leaf?.view; if (view instanceof MarkdownView && view.file === file) menu.addItem(item => item.setTitle("Yoofloe AI").setIcon("sparkles").onClick(() => this.openWorkspace(view)));
      }));
      const update = () => this.updateActions();
      this.registerEvent(this.app.workspace.on("layout-change", update));
      this.registerEvent(this.app.workspace.on("active-leaf-change", update));
      this.app.workspace.onLayoutReady(() => { update(); void this.mergeLegacyPanels(); });
      this.register(() => { for (const action of this.actions.values()) action.remove(); this.actions.clear(); });
    }
    this.registerObsidianProtocolHandler(ACTION, params => {
      if (!this.live || !Platform.isAndroidApp) { new Notice("Direct Calendar lookup requires both apps on the same Android phone or tablet. Yoofloe AI itself works without Calendar."); return; }
      if (!params.requestId) { this.openWorkspace(); return; }
      if (params.vault !== this.app.vault.getName()) { new Notice("This Calendar request belongs to another vault."); return; }
      if (this.work?.requestId === params.requestId) { void this.work.receiveCalendar(params.requestId); this.openWorkspace(); return; }
      if (this.manual) { void this.manual.receive(params.requestId); return; }
      new Notice("No matching local request. Start a new Calendar lookup in Yoofloe AI.");
    });
  }
  private capture(view: MarkdownView): WorkspaceSource | null {
    if (!view.file) return null;
    const source: WorkspaceSource = { path: view.file.path };
    if (view.getMode() === "source") {
      const selections = view.editor.listSelections();
      if (selections.length === 1) {
        const positions = [view.editor.posToOffset(selections[0].anchor), view.editor.posToOffset(selections[0].head)].sort((a, b) => a - b);
        if (positions[1] > positions[0]) source.selection = { from: positions[0], to: positions[1] };
      }
    }
    return source;
  }
  private updateActions(): void {
    if (!this.live) return;
    const active = this.app.workspace.getActiveViewOfType(MarkdownView); if (active?.file) this.lastSource = { path: active.file.path };
    const views = this.app.workspace.getLeavesOfType("markdown").map(leaf => leaf.view).filter((view): view is MarkdownView => view instanceof MarkdownView);
    for (const [view, action] of this.actions) if (!views.includes(view)) { action.remove(); this.actions.delete(view); }
    for (const view of views) if (!this.actions.has(view)) this.actions.set(view, view.addAction("sparkles", "Yoofloe AI", () => this.openWorkspace(view)));
  }
  openWorkspace(sourceView?: MarkdownView): void {
    void this.showWorkspace(sourceView).catch(() => new Notice("Yoofloe AI could not open. Existing notes and saved work are kept."));
  }
  private async showWorkspace(sourceView?: MarkdownView): Promise<void> {
    if (!this.live) return;
    const file = this.app.workspace.getActiveFile();
    const active = sourceView ?? this.app.workspace.getActiveViewOfType(MarkdownView) ?? this.app.workspace.getLeavesOfType("markdown").map(leaf => leaf.view).find((view): view is MarkdownView => view instanceof MarkdownView && view.file === file);
    if (active) {
      const source = this.capture(active);
      if (source?.selection) source.selectionVersion = await inputDigest(active.editor.getValue());
      this.lastSource = source;
    }
    const work = this.workspace(); await work.initialize(); if (!this.live) return; work.bind(this.lastSource);
    let leaf = this.app.workspace.getLeavesOfType(AI_VIEW)[0];
    if (Platform.isPhone && leaf && leaf.getRoot() !== this.app.workspace.rootSplit) {
      const previous = leaf; leaf = this.app.workspace.getLeaf(true); await leaf.setViewState({ type: AI_VIEW, active: true });
      if (previous.view.getViewType() === AI_VIEW) previous.detach();
    }
    if (!leaf) { leaf = Platform.isPhone ? this.app.workspace.getLeaf(true) : this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(true); await leaf.setViewState({ type: AI_VIEW, active: true }); }
    await this.app.workspace.revealLeaf(leaf);
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
    } catch { new Notice("The old panel state could not be backed up. It was kept; open Yoofloe AI from the sparkle icon."); }
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
    this.work = new AiWorkspace({ current: () => ai.current(), preferences: ai.preferences, gate: this.gate, configDir: owner.configDir,
      host: current => obsidianAgentHost(this.app, owner, current), inboxHint: () => adapter.getResourcePath(`${INBOX}/`),
      transport: async request => { if (!ai.current()) throw Error("Vault changed"); const response = await requestUrl(request); return { status: response.status, text: response.text }; },
      storage: {
        load: async () => { const path = `${root}/workspace.json`; if (!await adapter.exists(path)) return null; const stat = await adapter.stat(path); if (!stat || stat.size > 8 * 1024 * 1024) throw Error("Saved work exceeds its local size limit."); return JSON.parse(await adapter.read(path)) as unknown; },
        save: async value => { if (!ai.current()) throw Error("Vault changed"); const text = JSON.stringify(value); if (text.length > 8 * 1024 * 1024) throw Error("Saved work exceeds its local size limit."); const path = `${root}/workspace.json`; await adapter.write(path, text); if (await adapter.read(path) !== text) throw Error("The local work record could not be confirmed."); },
        history: () => loadWorkRecords(owner),
      },
      ...(Platform.isAndroidApp ? { calendar: () => new CalendarSession({ vaultName: () => owner.getName(), allowed: () => ai.current() && Platform.isAndroidApp,
        store: { exists: path => adapter.exists(path), mkdir: path => adapter.mkdir(path), write: (path, text) => adapter.write(path, text), read: path => adapter.read(path),
          size: async path => { const stat = await adapter.stat(path); return stat?.type === "file" ? stat.size : null; }, remove: path => adapter.remove(path) } }) } : {}),
    });
    return this.work;
  }
  openAiSettings(manualDrafts = false): void {
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
      { name: "One workspace", desc: "Use the sparkle ribbon, note header, note menu, or Yoofloe AI: Open command. Closing the panel keeps your draft and result.", aliases: ["Yoofloe AI", "notes", "data scope", "permissions", "request limit"],
        render: setting => { setting.addButton(b => b.setButtonText("Open Yoofloe AI").onClick(() => this.yoofloe.openWorkspace())); } },
      { name: "OpenAI key, model and thinking depth", desc: "Settings make no API requests. Starting a task sends permitted note text and context directly to OpenAI; API charges apply. A task may make multiple requests.", aliases: ["API key", "effort", "custom model", "AI settings", "cost"],
        render: setting => { setting.addButton(b => b.setButtonText("AI settings").onClick(() => this.yoofloe.openAiSettings())); } },
      { name: "Data and recovery", desc: "Review the data scope and allowed changes before starting. Write and organize modes may change multiple notes within the scope. Original backups and recovery records are local; sync services may copy them. AI can make mistakes. Local storage of a key does not make AI local.", aliases: ["privacy", "backups", "Undo", "data sharing"],
        render: setting => { setting.descEl.appendText(" "); setting.descEl.createEl("a", { text: "Privacy and data flow", href: "https://github.com/yoofloe/yoofloe-obsidian/blob/main/PRIVACY.md", attr: { target: "_blank", rel: "noopener noreferrer" } }); } },
      { name: "Yoofloe Calendar · optional Android app", desc: "Plans, tasks, notes, study, projects and focus. Direct local lookup requires both apps on the same Android phone or tablet and profile, Calendar 1.8.5+, Obsidian 1.11.5+, and a vault in shared device storage. Yoofloe AI works independently on other platforms.", aliases: ["Calendar", "Android", "local records"],
        render: setting => { setting.addButton(b => b.setButtonText("Discover Calendar").onClick(() => this.containerEl.ownerDocument.defaultView?.open(STORE_URL, "_blank"))); } },
    ];
    if (Platform.isAndroidApp) rows.push({ name: "Manual Calendar import (advanced)", desc: "Save complete Markdown snapshots without AI. Calendar records remain unchanged.", aliases: ["Calendar import", "snapshots"],
      render: setting => { setting.addButton(b => b.setButtonText("Import records").onClick(() => this.yoofloe.openManual())); } });
    return rows;
  }
}
