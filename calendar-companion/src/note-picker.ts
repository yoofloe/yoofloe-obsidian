import { App, FuzzySuggestModal } from "obsidian";
import type { AiWorkspace } from "./workspace";

type NoteChoice = { path: string | null; title: string };
/** Search filenames locally; choosing a note never sends its contents to a provider. */
export class WorkspaceNotePicker extends FuzzySuggestModal<NoteChoice> {
  private readonly choices: NoteChoice[];
  constructor(app: App, private readonly work: AiWorkspace) {
    super(app);
    this.choices = [{ path: null, title: "Chat without a note" }, ...work.availableNotes()];
    this.limit = 100; this.setPlaceholder("Find a note to read or edit…");
    this.setInstructions([{ command: "↑↓", purpose: "Navigate" }, { command: "↵", purpose: "Connect note" }, { command: "esc", purpose: "Cancel" }]);
  }
  getItems(): NoteChoice[] { return this.work.current ? this.choices : []; }
  getItemText(item: NoteChoice): string { return item.path ? `${item.title} · ${item.path}` : item.title; }
  onChooseItem(item: NoteChoice): void { this.work.attachNote(item.path ? { path: item.path } : null); }
}
