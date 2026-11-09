import { App, Modal, Platform, Setting, TFolder, type Vault } from "obsidian";
import { INBOX } from "./protocol";
import { CalendarSession, type TransferStore } from "./session";
import { saveDelivery, type NoteStore } from "./notes";
import { AiDraftModal, type AiContext } from "./ai-modals";
import { recordLabel } from "./record-types";
const REQUIREMENTS = "Direct Calendar connection requires Android phones or tablets, Yoofloe Calendar 1.8.5 or later and Obsidian 1.11.5 or later on the same device and Android user profile.";
const STORE_URL = "https://play.google.com/store/apps/details?id=com.yoofloe.calendar";
function noteStore(vault: Vault): NoteStore {
  return { exists: path => Promise.resolve(vault.getAbstractFileByPath(path) !== null), read: path => vault.adapter.read(path),
    mkdir: async path => { const item = vault.getAbstractFileByPath(path); if (item && !(item instanceof TFolder)) throw Error("Folder conflict"); if (!item) await vault.createFolder(path); },
    create: async (path, text) => { await vault.create(path, text); } };
}
export class CompanionModal extends Modal {
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
