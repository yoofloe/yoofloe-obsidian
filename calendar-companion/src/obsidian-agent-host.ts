import { App, MarkdownView, TFile, TFolder, normalizePath, parseYaml, stringifyYaml, type Vault } from "obsidian";
import { validateJournal, type AgentFile, type AgentHost, type WorkJournal } from "./vault-agent";
import { vaultPath } from "./agent-policy";
export function obsidianAgentHost(app: App, vault: Vault, current: () => boolean): AgentHost {
  const guard = () => { if (!current() || app.vault !== vault) throw Error("The task stopped or the vault changed."); };
  const fileFor = (file: AgentFile): TFile => { guard(); const item = vault.getAbstractFileByPath(file.path); if (!(item instanceof TFile) || item !== file.identity) throw Error("The note was renamed or replaced."); return item; };
  const record = (file: TFile): AgentFile => ({ identity: file, path: file.path, title: file.basename, size: file.stat.size });
  const viewFor = (file: TFile) => app.workspace.getLeavesOfType("markdown").map(leaf => leaf.view).find((view): view is MarkdownView => view instanceof MarkdownView && view.file === file && view.getMode() === "source");
  const editorFor = (file: TFile) => viewFor(file)?.editor;
  const ensure = async (path: string) => {
    for (const name of path.split("/").reduce<string[]>((parts, segment) => [...parts, parts.length ? parts[parts.length - 1] + "/" + segment : segment], [])) {
      guard(); const item = vault.getAbstractFileByPath(name); if (item && !(item instanceof TFolder)) throw Error("A folder name conflicts with a file."); if (!item) await vault.createFolder(name);
    }
  };
  const read = async (file: AgentFile) => { const item = fileFor(file), editor = editorFor(item); const value = editor ? editor.getValue() : await vault.read(item); fileFor(file); return editorFor(item)?.getValue() ?? value; };
  return {
    files: () => { guard(); return vault.getMarkdownFiles().map(record); },
    read: async file => { try { return await read(file); } catch { return null; } },
    async replace(file, expected, text) {
      const item = fileFor(file), view = viewFor(item), editor = view?.editor;
      if (editor && view) { if (editor.getValue() !== expected) throw Error("The note has newer unsaved edits."); editor.transaction({ changes: [{ from: { line: 0, ch: 0 }, to: editor.offsetToPos(expected.length), text }] }, "yoofloe-ai-task"); guard(); await view.save(); }
      else await vault.process(item, original => { fileFor(file); if (editorFor(item) || original !== expected) throw Error("The note changed during this task."); return text; });
      guard(); if (await read(file) !== text) throw Error("The saved edit could not be confirmed. The backup is kept; no retry was made.");
    },
    async create(path, text) {
      guard(); vaultPath(path); const normalized = normalizePath(path); if (normalized !== path || vault.getAbstractFileByPath(path)) throw Error("That filename exists or is invalid. Choose another name.");
      const file = await vault.create(path, text); guard(); if (await vault.read(file) !== text || vault.getAbstractFileByPath(path) !== file) throw Error("The created note could not be confirmed. No existing file was overwritten."); return record(file);
    },
    async rename(file, path) {
      const item = fileFor(file); vaultPath(path); if (vault.getAbstractFileByPath(path)) throw Error("The destination name already exists.");
      // Link edits are separate, version-checked tool actions; a move never silently changes other notes.
      await vault.rename(item, normalizePath(path)); guard(); if (item.path !== path || vault.getAbstractFileByPath(path) !== item) throw Error("The move could not be confirmed."); file.path = item.path; file.title = item.basename;
    },
    async folder(path) { guard(); vaultPath(path, true); const existing = vault.getAbstractFileByPath(path); if (existing) { if (!(existing instanceof TFolder)) throw Error("A file occupies this folder name."); return false; } await ensure(path); guard(); return true; },
    async properties(file, expected, values) {
      fileFor(file);
      const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(expected);
      const raw: unknown = match ? parseYaml(match[1]) : {};
      if (raw !== null && (typeof raw !== "object" || Array.isArray(raw))) throw Error("This note's properties are not a YAML object.");
      const frontmatter = { ...(raw as Record<string, unknown> | null), ...values };
      const after = "---\n" + stringifyYaml(frontmatter).trimEnd() + "\n---\n" + expected.slice(match?.[0].length ?? 0);
      // A whole-document version check also protects unsaved editor text and body changes during property edits.
      await this.replace(file, expected, after);
    },
    affected: path => { guard(); return Object.entries(app.metadataCache.resolvedLinks).filter(([, links]) => !!links[path]).map(([source]) => source); },
    async trash(file) { const item = fileFor(file); await app.fileManager.trashFile(item); guard(); if (vault.getAbstractFileByPath(file.path) === item) throw Error("Moving this note to Trash could not be confirmed."); },
    async backup(_path, text) {
      await ensure("Yoofloe AI/Backups"); const path = `Yoofloe AI/Backups/${crypto.randomUUID()}.md`; guard(); const file = await vault.create(path, text); guard();
      if (await vault.read(file) !== text) throw Error("The original backup could not be confirmed. The source note was not changed."); return path;
    },
    async readBackup(path) { guard(); if (!/^Yoofloe AI\/Backups\/[0-9a-f-]+\.md$/.test(path)) throw Error("Invalid backup reference."); const file = vault.getAbstractFileByPath(path); if (!(file instanceof TFile)) throw Error("The backup is missing."); return await vault.read(file); },
    async persist(journal) {
      guard(); if (!/^[0-9a-f-]{36}$/.test(journal.id)) throw Error("Invalid work record.");
      const root = `${vault.configDir}/plugins/yoofloe/tasks`;
      if (!await vault.adapter.exists(root)) { guard(); await vault.adapter.mkdir(root); }
      guard(); const path = `${root}/${journal.id}.json`, text = JSON.stringify(journal); await vault.adapter.write(path, text); guard();
      if (await vault.adapter.read(path) !== text) throw Error("The recovery record could not be confirmed. The task was stopped.");
    },
  };
}
export async function loadWorkRecords(vault: Vault): Promise<WorkJournal[]> {
  const root = `${vault.configDir}/plugins/yoofloe/tasks`; if (!await vault.adapter.exists(root)) return [];
  const listing = await vault.adapter.list(root), journals: WorkJournal[] = [];
  for (const path of listing.files.filter(path => /\/[0-9a-f-]{36}\.json$/.test(path)).slice(-30)) {
    const stat = await vault.adapter.stat(path); if (!stat || stat.size > 262144) continue;
    try { const data: unknown = JSON.parse(await vault.adapter.read(path)); validateJournal(data); if (path.endsWith(`/${data.id}.json`)) journals.push(data); } catch { /* An uncertain record is kept on disk. */ }
  }
  return journals.sort((a, b) => b.createdAt - a.createdAt);
}
