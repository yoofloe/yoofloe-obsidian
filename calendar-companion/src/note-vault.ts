import { App, MarkdownView, TFolder, type TFile, type Vault } from "obsidian";
import { NOTE_CONTEXT_BYTES } from "./note-context";
import { noteTerms, rankNote, type NoteWorkspace, type WorkspaceDocument } from "./note-workspace";
const encoder = new TextEncoder();

/** Uses live editor buffers first and vault.process for closed files. No startup reads. */
export function createNoteWorkspace(app: App, vault: Vault, current: () => boolean, sourcePath: string): NoteWorkspace {
  const guard = () => { if (!current() || app.vault !== vault) throw Error("The vault changed."); };
  const editorFor = (file: TFile) => app.workspace.getLeavesOfType("markdown").map(leaf => leaf.view)
    .find((view): view is MarkdownView => view instanceof MarkdownView && view.file === file && view.getMode() === "source")?.editor;
  const valid = (file: TFile, path: string) => { guard(); return file.path === path && vault.getAbstractFileByPath(path) === file; };
  const read = async (file: TFile, path: string) => {
    if (!valid(file, path)) return null;
    const editor = editorFor(file), text = editor ? editor.getValue() : await vault.cachedRead(file);
    if (!valid(file, path)) return null;
    // An editor opened during the disk read takes precedence over cached disk content.
    return editorFor(file)?.getValue() ?? text;
  };
  return {
    async search(question) {
      guard(); const terms = noteTerms(question);
      const all = vault.getMarkdownFiles().filter(file => file.path !== sourcePath && !/^Yoofloe Calendar\/(?:AI backups|AI drafts)\//.test(file.path) && !/(?:^|\/)\./.test(file.path));
      const links = app.metadataCache.resolvedLinks[sourcePath] ?? {};
      const candidates = all.slice(0, 2000).map(file => ({ file, score: rankNote(file.basename, terms) * 8 + (links[file.path] ? 5 : 0) }))
        .sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path)).slice(0, 32);
      const matches: { file: TFile; path: string; text: string; score: number }[] = []; let scanned = 0;
      for (const { file, score } of candidates) {
        guard(); if (file.stat.size > NOTE_CONTEXT_BYTES * 4 || (!terms.length && !score)) continue;
        const path = file.path, text = await read(file, path); scanned++;
        if (text === null || encoder.encode(text).length > NOTE_CONTEXT_BYTES) continue;
        const relevance = score + rankNote(text, terms);
        if (relevance > 0) matches.push({ file, path, text, score: relevance });
      }
      guard();
      const documents: WorkspaceDocument[] = matches.sort((a, b) => b.score - a.score).slice(0, 4).map(({ file, path, text }, index) => ({
        reference: `N${index + 2}`, title: file.basename, path, text, read: () => read(file, path),
        async replace(expected, markdown) {
          if (!valid(file, path)) throw Error("This note was renamed or deleted. Your proposal is kept.");
          const editor = editorFor(file);
          if (editor) {
            if (editor.getValue() !== expected) throw Error("This note has new edits. Refresh its context before replacing it.");
            editor.transaction({ changes: [{ from: { line: 0, ch: 0 }, to: editor.offsetToPos(expected.length), text: markdown }] }, "yoofloe-note-ai");
          } else await vault.process(file, original => {
            if (!valid(file, path) || editorFor(file) || original !== expected) throw Error("This note changed. The proposal was kept.");
            return markdown;
          });
        },
      }));
      return { documents, scanned, total: all.length };
    },
    async backup(_path, original) {
      guard();
      for (const folder of ["Yoofloe Calendar", "Yoofloe Calendar/AI backups"]) {
        const existing = vault.getAbstractFileByPath(folder);
        if (existing && !(existing instanceof TFolder)) throw Error("The backup folder conflicts with an existing file.");
        if (!existing) { await vault.createFolder(folder); guard(); }
      }
      const path = `Yoofloe Calendar/AI backups/${crypto.randomUUID()}.md`;
      await vault.create(path, original); guard(); return path;
    },
  };
}
