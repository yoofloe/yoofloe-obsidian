import { FuzzySuggestModal, Notice, type App, type TFolder } from "obsidian";
import { allowedPath, type TaskPolicy } from "./agent-policy";

/** Vault metadata only, on user request. Never grants access outside the existing task policy. */
export class VaultFolderPicker extends FuzzySuggestModal<TFolder> {
  constructor(app: App, private readonly current: () => boolean, private readonly excluded: () => string[], private readonly choose: (path: string) => void) {
    super(app);
    this.setPlaceholder("Find a folder in this vault…");
    this.setInstructions([{ command: "↑↓", purpose: "Navigate" }, { command: "↵", purpose: "Choose folder" }, { command: "esc", purpose: "Cancel" }]);
  }
  private path(folder: TFolder): string { return folder.path === "/" ? "" : folder.path; }
  private available(folder: TFolder): boolean {
    if (!this.current()) return false;
    const path = this.path(folder);
    const actual = path ? this.app.vault.getAbstractFileByPath(path) : this.app.vault.getRoot();
    if (actual !== folder) return false;
    const policy: TaskPolicy = { sourcePath: null, folder: "", readScope: "vault", writeScope: "vault", mode: "edit", configDir: this.app.vault.configDir, excluded: this.excluded() };
    return allowedPath(policy, path ? `${path}/Folder.md` : "Folder.md", "create");
  }
  getItems(): TFolder[] {
    if (!this.current()) return [];
    return this.app.vault.getAllFolders(true).filter(folder => this.available(folder)).sort((a, b) => this.path(a).localeCompare(this.path(b)));
  }
  getItemText(folder: TFolder): string { return this.path(folder) || "Vault root · /"; }
  onChooseItem(folder: TFolder): void {
    if (!this.available(folder)) { new Notice("This folder is no longer available. Choose another folder inside this vault."); return; }
    this.choose(this.path(folder));
  }
}
