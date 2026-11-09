import { App, MarkdownView, Modal, Notice, Platform, Plugin, PluginSettingTab, Setting, TFolder, requestUrl, requireApiVersion, type Editor, type Vault } from "obsidian";
import { ACTION, INBOX } from "./protocol";
import { CalendarSession, type TransferStore } from "./session";
import { saveDelivery, type NoteStore } from "./notes";
import { AiPreferences } from "./ai-preferences";
import { OPENAI_ADAPTER } from "./openai";
import { AiSession } from "./ai-session";
import { AiDraftModal, AiSettingsModal, type AiContext } from "./ai-modals";
import { recordLabel } from "./record-types";
import { QuestionModal } from "./question-modal";
import { NoteWork } from "./note-work";
import { NoteModal } from "./note-modal";
import type { NoteTarget } from "./note-context";

const REQUIREMENTS = "Android phones and tablets only. Requires Yoofloe Calendar 1.8.5 or later and Obsidian 1.11.5 or later on the same device and Android user profile. Direct connection is unavailable on desktop, iPhone, and iPad.";
const STORE_URL = "https://play.google.com/store/apps/details?id=com.yoofloe.calendar";
const NOTE_REQUIREMENTS = "Note AI works in Obsidian on Android phones and tablets. It uses your own OpenAI key; Yoofloe Calendar is needed only when you add Calendar context.";

/** All writes are create-only and bound to the vault captured by the calling modal. */
function noteStore(vault: Vault): NoteStore {
  return { exists: path => Promise.resolve(vault.getAbstractFileByPath(path) !== null), read: path => vault.adapter.read(path),
    mkdir: async path => { const item = vault.getAbstractFileByPath(path); if (item && !(item instanceof TFolder)) throw Error("Folder conflict"); if (!item) await vault.createFolder(path); },
    create: async (path, text) => { await vault.create(path, text); } };
}

/** Standalone Calendar companion. Loading the plugin never reads a transfer or contacts a server. */
export default class CalendarCompanionPlugin extends Plugin {
  private modal: CompanionModal | null = null;
  private question: QuestionModal | null = null;
  private aiSettings: AiSettingsModal | null = null;
  private ai: AiContext | null = null;
  private noteAi: AiSession | null = null;
  private noteWork: NoteWork | null = null;
  private noteView: NoteModal | null = null;
  private nextNote: { target: NoteTarget; selection: { from: number; to: number } } | null = null;
  private aiGate = { busy: false };
  private actions = new Map<MarkdownView, HTMLElement>();
  private live = true;
  onload(): void {
    this.addSettingTab(new CompanionSettings(this.app, this));
    this.addCommand({ id: "open-calendar-companion", name: "Ask Calendar", callback: () => this.openQuestion() });
    this.addCommand({ id: "import-calendar-snapshots", name: "Import complete Calendar records manually", callback: () => this.openCompanion() });
    this.addRibbonIcon("calendar", "Ask Yoofloe Calendar", () => this.openQuestion());
    this.addCommand({ id: "note-ai", name: "Note AI", icon: "sparkles", mobileOnly: true,
      editorCallback: (editor, info) => { if (info instanceof MarkdownView) this.openNote(editor, info); else new Notice("Open this Markdown note in the editor first."); } });
    if (Platform.isAndroidApp && this.app.workspace) {
      this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor, info) => {
        if (info instanceof MarkdownView) menu.addItem(item => item.setTitle("Note AI").setIcon("sparkles").onClick(() => this.openNote(editor, info)));
      }));
      this.registerEvent(this.app.workspace.on("file-menu", (menu, file, _source, leaf) => {
        const view = leaf?.view ?? this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view instanceof MarkdownView && view.file === file) menu.addItem(item => item.setTitle("Note AI").setIcon("sparkles").onClick(() => this.openNote(view.editor, view)));
      }));
      const update = () => this.updateNoteActions();
      this.registerEvent(this.app.workspace.on("layout-change", update));
      this.registerEvent(this.app.workspace.on("active-leaf-change", update));
      this.app.workspace.onLayoutReady(update);
      this.register(() => { for (const action of this.actions.values()) action.remove(); this.actions.clear(); });
    }
    this.registerObsidianProtocolHandler(ACTION, params => {
      if (!Platform.isAndroidApp || !this.live) { new Notice(REQUIREMENTS); return; }
      if (!params.requestId) { this.openQuestion(); return; }
      if (params.vault === this.app.vault.getName() && this.noteWork?.requestId === params.requestId) { void this.noteWork.receive(params.requestId); this.showNote(); return; }
      if (params.vault === this.app.vault.getName() && this.question?.requestId === params.requestId) { void this.question.receive(params.requestId); return; }
      if (!this.modal || params.vault !== this.app.vault.getName()) { new Notice("No matching connection in this vault. Start a new Calendar request."); return; }
      void this.modal.receive(params.requestId ?? "");
    });
  }
  private updateNoteActions(): void {
    if (!this.live) return;
    const views = this.app.workspace.getLeavesOfType("markdown").map(leaf => leaf.view).filter((view): view is MarkdownView => view instanceof MarkdownView);
    for (const [view, element] of this.actions) if (!views.includes(view)) { element.remove(); this.actions.delete(view); }
    for (const view of views) if (!this.actions.has(view)) this.actions.set(view, view.addAction("sparkles", "Note AI", () => this.openNote(view.editor, view)));
  }
  openActiveNote(): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view) this.openNote(view.editor, view); else new Notice("Open a Markdown note in the editor first.");
  }
  private openNote(editor: Editor, view: MarkdownView): void {
    if (!this.live || !Platform.isAndroidApp) { new Notice(NOTE_REQUIREMENTS); return; }
    const file = view.file, owner = this.app.vault, path = file?.path;
    if (!file || !path || view.getMode() !== "source") { new Notice("Switch this Markdown note to editing mode first."); return; }
    const selections = editor.listSelections();
    if (selections.length !== 1) { new Notice("Choose one text selection, or place the cursor in your note."); return; }
    const positions = [editor.posToOffset(selections[0].anchor), editor.posToOffset(selections[0].head)].sort((a, b) => a - b);
    const current = () => this.live && this.app.vault === owner && owner.getAbstractFileByPath(path) === file && file.path === path && view.file === file && view.editor === editor &&
      view.getMode() === "source" && this.app.workspace.getLeavesOfType("markdown").some(leaf => leaf.view === view);
    const target: NoteTarget = { identity: file, path, title: file.basename, read: () => current() ? editor.getValue() : null,
      change: (from, to, text) => { if (!current()) throw Error("The original note is no longer open."); editor.transaction({ changes: [{ from: editor.offsetToPos(from), to: editor.offsetToPos(to), text }] }, "yoofloe-note-ai"); } };
    this.nextNote = { target, selection: { from: positions[0], to: positions[1] } };
    if (this.noteWork?.target.identity === file && this.noteWork.target.path === path) {
      // Rebind a reopened leaf, keeping the original reviewed text and conflict digest.
      this.noteWork.target.read = target.read; this.noteWork.target.change = target.change;
    }
    if (!this.noteWork) this.startNote(); else this.showNote();
  }
  private startNote(): void {
    if (this.noteWork?.busy || !this.nextNote) return;
    const next = this.nextNote; this.nextNote = null;
    this.noteView?.close(); this.noteWork?.dispose();
    const context = this.aiContext(), owner = this.app.vault;
    if (!this.noteAi) this.noteAi = this.createAiSession(() => context.current(), context.preferences);
    const adapter = owner.adapter;
    this.noteWork = new NoteWork(next.target, next.selection, { current: () => context.current(), ai: this.noteAi, preferences: context.preferences,
      inboxHint: () => adapter.getResourcePath(`${INBOX}/`), calendar: () => new CalendarSession({ vaultName: () => this.app.vault.getName(), allowed: () => context.current(),
        store: { exists: path => adapter.exists(path), mkdir: path => adapter.mkdir(path), write: (path, text) => adapter.write(path, text), read: path => adapter.read(path),
          size: async path => { const stat = await adapter.stat(path); return stat?.type === "file" ? stat.size : null; }, remove: path => adapter.remove(path) } }),
      save: async (path, text) => { if (!context.current()) throw Error("Vault changed"); await owner.create(path, text); } });
    this.showNote(); void this.noteWork.initialize();
  }
  private showNote(): void {
    if (!this.noteWork?.current) return;
    if (this.noteView) { this.noteView.open(); return; }
    this.question?.close(); this.modal?.close();
    this.noteView = new NoteModal(this.app, this.noteWork, { closed: () => { this.noteView = null; }, settings: () => this.openAiSettings(),
      startNew: () => {
        if (!this.nextNote && this.noteWork) { const view = this.app.workspace.getActiveViewOfType(MarkdownView); if (view) this.openNote(view.editor, view); }
        this.startNote();
      }, nextTitle: () => this.nextNote?.target.title ?? null });
    this.noteView.open();
  }
  openQuestion(): void {
    if (!this.live) return;
    this.noteView?.close();
    if (this.question) { this.question.open(); return; }
    this.modal?.close();
    this.question = new QuestionModal(this.app, { live: () => this.live, closed: () => { this.question = null; },
      ai: () => this.aiContext(), openAiSettings: () => this.openAiSettings(), manualImport: () => this.openCompanion(), notes: noteStore(this.app.vault), requirements: REQUIREMENTS });
    this.question.open();
  }
  openCompanion(): void {
    if (!this.live) return;
    this.noteView?.close();
    if (this.modal) { this.modal.open(); return; }
    this.question?.close();
    this.modal = new CompanionModal(this.app, () => this.live, () => { this.modal = null; }, () => this.aiContext(), () => this.openAiSettings());
    this.modal.open();
  }
  private aiContext(): AiContext {
    if (!this.ai) {
      const owner = this.app.vault, name = owner.getName();
      const current = () => this.live && Platform.isAndroidApp && this.app.vault === owner && owner.getName() === name;
      const preferences = new AiPreferences({ current, binding: () => owner.adapter.getResourcePath(""), load: () => this.loadData(), save: value => this.saveData(value),
        secrets: () => requireApiVersion("1.11.5") && typeof this.app.secretStorage?.getSecret === "function" && typeof this.app.secretStorage?.setSecret === "function" ? this.app.secretStorage : null });
      const session = this.createAiSession(current, preferences);
      this.ai = { current, preferences, session };
    }
    return this.ai;
  }
  private createAiSession(current: () => boolean, preferences: AiPreferences): AiSession {
    return new AiSession({ adapters: [OPENAI_ADAPTER], current, gate: this.aiGate, key: provider => preferences.key(provider), transport: async request => {
      if (!current()) throw Error("Vault changed");
      // Optional BYOK feature: this is the only network call. See README, Optional AI.
      const response = await requestUrl(request); return { status: response.status, text: response.text };
    } });
  }
  openAiSettings(): void {
    if (!this.live || !Platform.isAndroidApp) return;
    if (this.aiSettings) { this.aiSettings.open(); return; }
    this.aiSettings = new AiSettingsModal(this.app, this.aiContext(), () => { this.aiSettings = null; void this.noteWork?.refreshSettings(); }); this.aiSettings.open();
  }
  onunload(): void { this.live = false; this.noteView?.close(); this.noteWork?.dispose(); this.noteWork = null; this.nextNote = null; this.noteAi = null; this.ai?.session.enableForSession(false); this.aiSettings?.close(); this.aiSettings = null; this.question?.close(); this.question = null; this.modal?.close(); this.modal = null; this.ai = null; }
}

class CompanionSettings extends PluginSettingTab {
  constructor(app: App, private readonly companion: CalendarCompanionPlugin) { super(app, companion); }
  display(): void {
    this.containerEl.empty(); new Setting(this.containerEl).setName("Connect your records").setHeading();
    this.containerEl.createEl("p", { text: NOTE_REQUIREMENTS });
    if (Platform.isAndroidApp) new Setting(this.containerEl).setName("Note AI").setDesc("Ask, summarize, refine or extract tasks from the note you have open. You can also use the note’s sparkle action, menu or mobile toolbar command.")
      .addButton(button => button.setButtonText("Open note AI").onClick(() => this.companion.openActiveNote()));
    this.containerEl.createEl("p", { text: REQUIREMENTS });
    new Setting(this.containerEl).setName("Yoofloe Calendar")
      .setDesc("Keep your plans, notes, study and project progress together, with a quiet place to focus. Install the Android app on this device to connect your records.")
      .addButton(button => button.setButtonText("Get Yoofloe Calendar").onClick(() => this.containerEl.ownerDocument.defaultView?.open(STORE_URL, "_blank")));
    new Setting(this.containerEl).setName(Platform.isAndroidApp ? "Local Calendar connection" : "Direct connection is not supported on this platform")
      .setDesc("Ask a question to find only relevant records on your phone. Calendar remembers the approved inbox. Local search requires no AI provider or Yoofloe account.")
      .addButton(button => button.setButtonText(Platform.isAndroidApp ? "Ask Calendar" : "View requirements").onClick(() => this.companion.openQuestion()));
    if (Platform.isAndroidApp) new Setting(this.containerEl).setName("Manual import (advanced)").setDesc("Choose complete records and save Markdown snapshots without AI.")
      .addButton(button => button.setButtonText("Import complete records").onClick(() => this.companion.openCompanion()));
    if (Platform.isAndroidApp) new Setting(this.containerEl).setName("AI drafts (optional; off by default)").setDesc("Use your own OpenAI API key for approved drafts. API charges apply only if you choose to generate.")
      .addButton(button => button.setButtonText("AI settings").onClick(() => this.companion.openAiSettings()));
  }
}

class CompanionModal extends Modal {
  private session: CalendarSession | null = null;
  private busy = false;
  private alive = false;
  private message = "";
  private saved = false;
  private draft: AiDraftModal | null = null;
  private owner = this.app.vault;
  constructor(app: App, private readonly pluginLive: () => boolean, private readonly closed: () => void,
    private readonly getAi: () => AiContext, private readonly openAiSettings: () => void) { super(app); }
  private current = () => this.alive && this.pluginLive() && this.app.vault === this.owner;
  onOpen(): void {
    this.alive = true; this.contentEl.classList.add("calendar-companion");
    if (Platform.isAndroidApp && this.current() && !this.session) {
      const adapter = this.owner.adapter;
      const store: TransferStore = { exists: path => adapter.exists(path), mkdir: path => adapter.mkdir(path),
        write: (path, text) => adapter.write(path, text), read: path => adapter.read(path),
        size: async path => { const info = await adapter.stat(path); return info?.type === "file" ? info.size : null; },
        remove: path => adapter.remove(path) };
      this.session = new CalendarSession({ store, vaultName: () => this.app.vault.getName(), allowed: () => Platform.isAndroidApp && this.current() });
    }
    this.render();
  }
  onClose(): void { this.alive = false; this.draft?.close(); this.draft = null; void this.session?.dispose(); this.session = null; this.closed(); }
  private render(): void {
    if (!this.current()) return;
    const el = this.contentEl; el.empty(); el.createEl("h2", { text: "Yoofloe Calendar Companion" });
    el.createEl("p", { text: REQUIREMENTS });
    if (!Platform.isAndroidApp) { el.createEl("p", { text: "Notes created on Android remain ordinary Markdown and can be read or edited here after transfer." }); return; }
    el.createEl("p", { text: "Use a vault in shared device storage. Android cannot grant Calendar access to an app-private vault. Calendar 1.8.5 or later is required." });
    if (this.message) el.createEl("p", { text: this.message, cls: "calendar-companion-status", attr: { role: "status" } });
    const session = this.session;
    if (!session) return;
    if (!session.requestId) {
      el.createEl("p", { text: "Start a request, then in Calendar choose this vault's 'Yoofloe Calendar Inbox' folder. Select the records you want to share and approve the transfer." });
      el.createEl("p", { text: "The transfer uses temporary files in this vault. Your configured vault sync tools may copy those files. The companion itself does not upload them." });
      new Setting(el).addButton(button => button.setButtonText(this.saved ? "Start another request" : "Connect Calendar").setCta().setDisabled(this.busy).onClick(() => void this.start()));
      new Setting(el).addButton(button => button.setButtonText("Get Yoofloe Calendar").onClick(() => this.contentEl.ownerDocument.defaultView?.open(STORE_URL, "_blank")));
      return;
    }
    const preview = session.preview;
    if (preview) {
      el.createEl("p", { text: `${preview.records.length} text snapshot(s). Saving creates new notes. It does not complete tasks, change Calendar records, or award Flow points.` });
      const list = el.createDiv({ cls: "calendar-companion-records" });
      for (const record of preview.records) {
        const row = list.createEl("section");
        row.createEl("h3", { text: record.title || "Untitled" });
        row.createEl("p", { text: `${recordLabel(record.kind)}${record.date ? ` · ${record.date}` : ""} · revision ${record.revision}` });
        row.createEl("pre", { text: record.text });
      }
      new Setting(el).addButton(button => button.setButtonText("Save Markdown notes").setCta().setDisabled(this.busy).onClick(() => void this.save()));
      new Setting(el).setName("AI draft (optional)").setDesc("Local import above remains free. AI generation requires your own API key and approval of possible API charges.")
        .addButton(button => button.setButtonText("AI settings").setDisabled(this.busy).onClick(this.openAiSettings))
        .addButton(button => button.setButtonText("Draft from selected records").setDisabled(this.busy).onClick(() => {
          if (!this.current()) return;
          if (this.draft) { this.draft.open(); return; }
          const sourceCurrent = () => { try { if (!this.current() || this.busy || session.preview !== preview) return false; session.assertCanSave(preview); return true; } catch { return false; } };
          this.draft = new AiDraftModal(this.app, this.getAi(), preview.records, noteStore(this.owner), sourceCurrent, () => { this.draft = null; }); this.draft.open();
        }));
    } else {
      el.createEl("p", { text: `Waiting for Calendar. Choose the '${INBOX}' folder in vault '${this.owner.getName()}'. Requests expire after 10 minutes.` });
      el.createEl("p", { text: "No response does not prove Calendar is missing. It may need an update, or the transfer may have been canceled. Return from Calendar, then check for a reply." });
      new Setting(el).addButton(button => button.setButtonText("Check reply").setDisabled(this.busy).onClick(() => void this.receive(session.requestId ?? "")));
    }
    new Setting(el).addButton(button => button.setButtonText("Cancel request").setDisabled(this.busy).onClick(() => void this.cancel()));
  }
  private async start(): Promise<void> {
    if (!this.session || this.busy || !this.current() || !Platform.isAndroidApp) return;
    this.busy = true; this.message = "";
    try { const url = await this.session.start(); if (!this.current()) return; this.render(); this.contentEl.ownerDocument.defaultView?.open(url, "_blank"); }
    catch { this.message = "Calendar could not be opened. Install or update the matching companion build, then try again."; }
    finally { this.busy = false; this.render(); }
  }
  async receive(id: string): Promise<void> {
    if (!this.session || this.busy || !this.current() || !Platform.isAndroidApp || this.session.preview) return;
    this.busy = true;
    try { await this.session.receive(id); this.message = "Review these snapshots before saving."; }
    catch { this.message = "A matching current reply could not be verified. Check the selected inbox, update Calendar if needed, or cancel and start a new request."; }
    finally { this.busy = false; this.render(); }
  }
  private async save(): Promise<void> {
    const session = this.session, delivery = session?.preview;
    if (!session || !delivery || this.busy || !this.current()) return;
    this.busy = true;
    try {
      const store = noteStore(this.owner);
      const result = await saveDelivery(delivery, store, () => { if (!this.current()) throw Error("Vault changed"); session.assertCanSave(delivery); });
      await session.cancel(); this.saved = true;
      this.message = `Saved ${result.created} new note(s); skipped ${result.skipped} identical snapshot(s).`;
    } catch { this.message = "Some notes could not be saved. Existing notes were kept. Check for edited-name conflicts and retry; identical saved snapshots are skipped."; }
    finally { this.busy = false; this.render(); }
  }
  private async cancel(): Promise<void> { if (this.busy) return; await this.session?.cancel(); this.message = "Request canceled. Existing notes were kept."; this.render(); }
}
