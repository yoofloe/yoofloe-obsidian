import { Menu, Notice, Platform, setIcon, setTooltip } from "obsidian";
import type { AiWorkspace } from "./workspace";
import type { ChatTurn } from "./chat-history";
import { turnConversation } from "./conversation-library";
import { collectConversationForCopy, copiedMessageText, formatCopiedConversation, type ChatMessageSelection } from "./chat-copy";

export class ChatCopyControls {
  selecting = false;
  private selected = new Map<string, { turn: ChatTurn; role: ChatMessageSelection["role"] }>();
  private busy = false;
  private epoch = 0;
  private toolbar: HTMLElement | null = null;

  constructor(private readonly getWork: () => AiWorkspace, private readonly root: HTMLElement,
    private readonly known: () => ChatTurn[], private readonly refresh: () => void) {}

  private get work(): AiWorkspace { return this.getWork(); }

  reset(): void {
    this.epoch++;
    this.selecting = false;
    this.selected.clear();
    this.toolbar = null;
  }

  menu(event: MouseEvent): void {
    const menu = new Menu();
    menu.addItem(item => item.setTitle("Copy conversation").setIcon("copy")
      .setDisabled(this.busy).onClick(() => { void this.copy(); }));
    menu.addItem(item => item.setTitle(this.selecting ? "Finish selecting" : "Select messages").setIcon("list-checks")
      .onClick(() => { this.selecting = !this.selecting; this.selected.clear(); this.refresh(); }));
    menu.showAtMouseEvent(event);
  }

  renderToolbar(parent: HTMLElement): void {
    this.toolbar = parent.createDiv({ cls: "y-ai-copy-toolbar" });
    this.toolbar.hidden = !this.selecting;
    if (!this.selecting) return;
    this.toolbar.createSpan({ cls: "y-ai-copy-count", attr: { role: "status" } });
    const copy = this.toolbar.createEl("button", { text: "Copy selected", attr: { type: "button" } });
    copy.addEventListener("click", () => { void this.copy([...this.selected.values()]); });
    const done = this.toolbar.createEl("button", { text: "Done", attr: { type: "button" } });
    done.addEventListener("click", () => { this.selecting = false; this.selected.clear(); this.refresh(); });
    this.updateToolbar();
  }

  private updateToolbar(): void {
    this.toolbar?.querySelector(".y-ai-copy-count")?.setText(`${this.selected.size} selected`);
    const button = this.toolbar?.querySelector<HTMLButtonElement>("button");
    if (button) { button.disabled = this.busy || !this.selected.size; button.setText(this.busy ? "Copying…" : "Copy selected"); }
  }

  decorate(element: HTMLElement, turn: ChatTurn, role: ChatMessageSelection["role"]): void {
    element.dataset.messageRole = role;
    if (this.selecting) {
      const key = turn.id + "/" + role;
      const selected = this.selected.has(key);
      if (selected) this.selected.set(key, { turn, role });
      const label = element.createEl("label", { cls: "y-ai-copy-choice" });
      const checkbox = label.createEl("input", { type: "checkbox", attr: { "aria-label": role === "user" ? "Select your message" : "Select assistant response" } });
      checkbox.checked = selected;
      label.createSpan({ text: role === "user" ? "Your message" : "Assistant response" });
      element.classList.toggle("y-ai-message-selected", selected);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) this.selected.set(key, { turn, role });
        else this.selected.delete(key);
        element.classList.toggle("y-ai-message-selected", checkbox.checked);
        this.updateToolbar();
      });
      element.prepend(label);
    }
    element.addEventListener("contextmenu", event => {
      if (Platform.isMobile && !("pointerType" in event && event.pointerType === "mouse")) return;
      const target = event.target as Node;
      const hit = target.nodeType === 1 ? target as Element : target.parentElement;
      if (hit?.closest("button,input,textarea,select")) return;
      event.preventDefault();
      event.stopPropagation();
      const text = this.selection();
      const menu = new Menu();
      menu.addItem(item => item.setTitle("Copy").setIcon("copy").setDisabled(this.busy)
        .onClick(() => { if (text) void this.write(text); else void this.copy([{ turn, role }], true); }));
      menu.addItem(item => item.setTitle("Select messages").setIcon("list-checks").onClick(() => {
        this.selecting = true; this.selected.set(turn.id + "/" + role, { turn, role }); this.refresh();
      }));
      menu.showAtMouseEvent(event);
    });
    if (!this.selecting && role === "assistant" && turn.answer) {
      const actions = element.createDiv({ cls: "y-ai-message-copy" });
      const button = actions.createEl("button", { cls: "clickable-icon", attr: { type: "button", "aria-label": "Copy response" } });
      setIcon(button, "copy"); setTooltip(button, "Copy response");
      button.addEventListener("click", () => { void this.copy([{ turn, role }], true); });
    }
  }

  selection(): string {
    const selection = this.root.ownerDocument.getSelection();
    if (!selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode) return "";
    const inChat = (node: Node) => {
      const element = node.nodeType === 1 ? node as Element : node.parentElement;
      return !!element?.closest(".y-ai-chat") && this.root.contains(node);
    };
    return inChat(selection.anchorNode) && inChat(selection.focusNode) ? selection.toString() : "";
  }

  private async write(text: string): Promise<void> {
    if (!text) { new Notice("There is no message text to copy."); return; }
    try {
      await this.root.ownerDocument.defaultView!.navigator.clipboard.writeText(text);
      new Notice("Copied");
    } catch { new Notice("Copy was unavailable. Select the text and use your device’s copy action."); }
  }

  private async copy(chosen?: { turn: ChatTurn; role: ChatMessageSelection["role"] }[], raw = false): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.updateToolbar();
    const epoch = this.epoch, work = this.work, conversationId = work.library.active;
    const current = () => this.work === work && work.current && this.root.isConnected && this.epoch === epoch && work.library.active === conversationId;
    try {
      const known = new Map(this.known().map(turn => [turn.id, turn]));
      const full = (id: string) => this.work.fullChat(id, turnConversation(known.get(id)?.conversationId ?? conversationId));
      let turns: ChatTurn[];
      if (chosen) {
        const requested = chosen.map(item => known.get(item.turn.id) ?? item.turn);
        const roles = chosen.map(({ turn, role }) => ({ turnId: turn.id, role }));
        turns = [];
        for (const owner of new Set(requested.map(turn => turnConversation(turn.conversationId)))) {
          const group = await collectConversationForCopy(requested, owner, undefined, full, current, roles);
          turns.push(...group);
        }
        turns.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
      } else {
        turns = await collectConversationForCopy([...known.values()], conversationId,
          offset => this.work.searchChats("", offset, conversationId, true), full, current);
      }
      if (!current()) return;
      const selection = chosen?.map(({ turn, role }) => ({ turnId: turn.id, role }));
      const text = raw && chosen?.length === 1 ? copiedMessageText(turns[0], chosen[0].role) : formatCopiedConversation(turns, selection);
      await this.write(text);
    } catch (error) { new Notice(error instanceof Error ? error.message : "The saved messages could not be copied."); }
    finally { this.busy = false; this.updateToolbar(); }
  }
}
