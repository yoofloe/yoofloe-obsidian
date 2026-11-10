import { Modal, Notice, Platform, SearchComponent, setIcon, type App, type TFolder } from "obsidian";
import { allowedPath, type TaskPolicy } from "./agent-policy";
import { folderRows, type FolderRow } from "./folder-tree";

/** Vault metadata only, on user request. Never grants access outside the existing task policy. */
export class VaultFolderPicker extends Modal {
  private selected: string;
  private query = "";
  private limit = 50;
  private expanded = new Set<string>();
  private list!: HTMLElement;
  private selection!: HTMLElement;
  private confirm!: HTMLButtonElement;
  private stopViewport: (() => void) | null = null;
  constructor(app: App, private readonly current: () => boolean, private readonly excluded: () => string[], private readonly choose: (path: string) => void, initial = "") {
    super(app); this.selected = initial;
    const parts = initial.split("/"); for (let i = 1; i <= parts.length; i++) this.expanded.add(parts.slice(0, i).join("/"));
  }
  private path(folder: TFolder): string { return folder.path === "/" ? "" : folder.path; }
  private available(folder: TFolder): boolean {
    if (!this.current()) return false;
    const path = this.path(folder);
    const actual = path ? this.app.vault.getAbstractFileByPath(path) : this.app.vault.getRoot();
    if (actual !== folder) return false;
    if (!path) return true;
    const policy: TaskPolicy = { sourcePath: null, folder: "", readScope: "vault", writeScope: "vault", mode: "organize", configDir: this.app.vault.configDir, excluded: this.excluded() };
    return allowedPath(policy, path, "organize");
  }
  getItems(): TFolder[] {
    if (!this.current()) return [];
    return this.app.vault.getAllFolders(true).filter(folder => this.available(folder));
  }
  getItemText(folder: TFolder): string { return this.path(folder) || "Vault root · /"; }
  onChooseItem(folder: TFolder): void {
    if (!this.available(folder)) { new Notice("This folder is no longer available. Choose another folder inside this vault."); return; }
    this.choose(this.path(folder)); this.close();
  }
  onOpen(): void {
    this.setTitle("Choose a folder"); this.modalEl.classList.add("y-ai-folder-modal"); this.containerEl.classList.add("y-ai-folder-container");
    this.modalEl.setAttribute("aria-label", "Choose a working and output folder inside this vault");
    const el = this.contentEl; el.empty(); el.classList.add("y-ai-folder-content");
    const search = new SearchComponent(el).setPlaceholder("Search all folders and subfolders…").onChange(value => { this.query = value; this.limit = 50; this.renderList(); });
    search.inputEl.setAttribute("aria-label", "Search all vault folders"); search.inputEl.maxLength = 500;
    search.inputEl.addEventListener("keydown", event => { if (event.key === "ArrowDown") { event.preventDefault(); this.list.querySelector<HTMLButtonElement>(".y-ai-folder-name")?.focus(); } });
    this.list = el.createDiv({ cls: "y-ai-folder-tree", attr: { role: "tree", "aria-label": "Vault folders" } });
    const footer = el.createDiv({ cls: "y-ai-folder-footer" }); this.selection = footer.createEl("p", { cls: "y-ai-folder-selection", attr: { "aria-live": "polite" } });
    const actions = footer.createDiv({ cls: "y-ai-folder-actions" });
    const cancel = actions.createEl("button", { text: "Cancel", attr: { type: "button" } }); cancel.addEventListener("click", () => this.close());
    this.confirm = actions.createEl("button", { text: "Use this folder", cls: "mod-cta", attr: { type: "button" } });
    this.confirm.addEventListener("click", () => { const folder = this.getItems().find(item => this.path(item) === this.selected); if (folder) this.onChooseItem(folder); else new Notice("Choose an available folder first."); });
    this.renderList(); this.stopViewport = this.watchViewport(); if (!Platform.isMobileApp) search.inputEl.focus();
  }
  onClose(): void { this.stopViewport?.(); this.stopViewport = null; this.contentEl.empty(); }
  private updateSelection(): void {
    this.selection.textContent = this.selected || "Vault root · /"; this.confirm.title = this.selection.textContent;
    this.confirm.disabled = !this.getItems().some(folder => this.path(folder) === this.selected);
    const buttons = Array.from(this.list.querySelectorAll<HTMLButtonElement>(".y-ai-folder-name"));
    const tabStop = buttons.find(button => button.dataset.path === this.selected) ?? buttons[0];
    for (const button of buttons) {
      const selected = button.dataset.path === this.selected; button.setAttribute("aria-selected", String(selected)); button.classList.toggle("is-selected", selected);
      button.tabIndex = button === tabStop ? 0 : -1;
    }
  }
  private toggle(path: string): void { if (this.expanded.has(path)) this.expanded.delete(path); else this.expanded.add(path); this.renderList(path); }
  private renderList(focus?: string): void {
    const scroll = this.list.scrollTop, rows = folderRows(this.getItems().map(folder => this.path(folder)), this.expanded, this.query);
    this.list.empty(); const shown = this.query.trim() ? rows.slice(0, this.limit) : rows;
    if (!rows.length) this.list.createEl("p", { text: "No matching folders", cls: "y-ai-hint" });
    for (const row of shown) {
      const wrap = this.list.createDiv({ cls: "y-ai-folder-row" }); wrap.style.setProperty("--y-ai-folder-depth", String(row.depth));
      if (row.hasChildren) {
        const toggle = wrap.createEl("button", { cls: `y-ai-folder-toggle${row.expanded ? " is-expanded" : ""}`, attr: { type: "button", tabindex: "-1", "aria-label": `${row.expanded ? "Collapse" : "Expand"} ${row.path}`, "aria-expanded": String(row.expanded) } });
        setIcon(toggle, "chevron-right"); toggle.addEventListener("click", () => this.toggle(row.path));
      } else wrap.createSpan({ cls: "y-ai-folder-spacer" });
      const button = wrap.createEl("button", { cls: "y-ai-folder-name", attr: { type: "button", role: "treeitem", "aria-level": String(row.depth + 1), "aria-label": row.path || "Vault root", title: row.path || "Vault root", tabindex: shown[0] === row || row.path === this.selected ? "0" : "-1" } });
      button.dataset.path = row.path; if (row.hasChildren) button.setAttribute("aria-expanded", String(row.expanded));
      setIcon(button.createSpan({ cls: "y-ai-folder-icon" }), row.expanded ? "folder-open" : "folder");
      button.createSpan({ text: row.path ? this.query.trim() ? row.path : row.path.split("/").at(-1) : "Vault root · /", cls: "y-ai-folder-path" });
      setIcon(button.createSpan({ cls: "y-ai-folder-check" }), "check");
      button.addEventListener("click", () => { this.selected = row.path; this.updateSelection(); });
      button.addEventListener("keydown", event => this.navigate(event, row));
    }
    if (shown.length < rows.length) {
      const more = this.list.createEl("button", { text: `Show 50 more · ${rows.length - shown.length} remaining`, cls: "y-ai-folder-more", attr: { type: "button" } });
      more.addEventListener("click", () => { this.limit += 50; this.renderList(shown.at(-1)?.path); });
    }
    this.updateSelection(); this.list.scrollTop = focus ? scroll : 0;
    if (focus) Array.from(this.list.querySelectorAll<HTMLButtonElement>(".y-ai-folder-name")).find(button => button.dataset.path === focus)?.focus();
  }
  private navigate(event: KeyboardEvent, row: FolderRow): void {
    const buttons = Array.from(this.list.querySelectorAll<HTMLButtonElement>(".y-ai-folder-name")), index = buttons.findIndex(button => button.dataset.path === row.path);
    let target: HTMLButtonElement | undefined;
    if (event.key === "ArrowDown") target = buttons[index + 1];
    else if (event.key === "ArrowUp") target = buttons[index - 1];
    else if (event.key === "Home") target = buttons[0];
    else if (event.key === "End") target = buttons.at(-1);
    else if (event.key === "ArrowRight" && row.hasChildren) {
      if (!row.expanded) { event.preventDefault(); this.toggle(row.path); return; }
      target = buttons[index + 1];
    }
    else if (event.key === "ArrowLeft") {
      if (row.expanded) { event.preventDefault(); this.toggle(row.path); return; }
      const parent = row.path.includes("/") ? row.path.slice(0, row.path.lastIndexOf("/")) : ""; target = buttons.find(button => button.dataset.path === parent);
    }
    if (target) { event.preventDefault(); for (const button of buttons) button.tabIndex = button === target ? 0 : -1; target.focus(); target.scrollIntoView({ block: "nearest" }); }
  }
  private watchViewport(): () => void {
    const doc = this.contentEl.ownerDocument, win = doc.defaultView; if (!win) return () => {};
    const viewport = win.visualViewport;
    const resize = () => {
      const keyboard = parseFloat(win.getComputedStyle(doc.body).getPropertyValue("--keyboard-height")) || 0;
      const visual = !!viewport && win.innerHeight - viewport.height > 80;
      const height = Math.max(0, (viewport?.height ?? win.innerHeight) - (visual ? 0 : keyboard));
      this.containerEl.style.height = `${height}px`; this.containerEl.style.top = `${viewport?.offsetTop ?? 0}px`;
      this.modalEl.style.setProperty("--y-ai-folder-height", `${height}px`); this.modalEl.classList.toggle("is-compact", height < 300);
    };
    const observer = new win.MutationObserver(resize); observer.observe(doc.body, { attributes: true, attributeFilter: ["style"] });
    observer.observe(doc.documentElement, { attributes: true, attributeFilter: ["style"] });
    viewport?.addEventListener("resize", resize); viewport?.addEventListener("scroll", resize); win.addEventListener("resize", resize); resize();
    return () => { observer.disconnect(); viewport?.removeEventListener("resize", resize); viewport?.removeEventListener("scroll", resize); win.removeEventListener("resize", resize); };
  }
}
