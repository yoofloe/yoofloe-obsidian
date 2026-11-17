import type { ChatTurn } from "./chat-history";
import { turnConversation } from "./conversation-library";

export interface ChatMessageSelection {
  turnId: string;
  role: "user" | "assistant";
}

interface ChatCopyPage {
  turns: ChatTurn[];
  nextOffset: number | null;
}

type CopyRole = ChatMessageSelection["role"];
const ALL_ROLES: ReadonlySet<CopyRole> = new Set(["user", "assistant"]);
const NO_ROLES: ReadonlySet<CopyRole> = new Set();
const USER_ROLE: ReadonlySet<CopyRole> = new Set(["user"]);
const ASSISTANT_ROLE: ReadonlySet<CopyRole> = new Set(["assistant"]);

function selectedRoles(selection: readonly ChatMessageSelection[]): Map<string, Set<CopyRole>> {
  const roles = new Map<string, Set<CopyRole>>();
  for (const item of selection) {
    const selected = roles.get(item.turnId) ?? new Set<CopyRole>();
    selected.add(item.role);
    roles.set(item.turnId, selected);
  }
  return roles;
}

function needsFullText(turn: ChatTurn, roles: ReadonlySet<CopyRole> = ALL_ROLES): boolean {
  return !!(roles.has("user") && (turn.requestTruncated || turn.workDetailsTruncated && turn.steers?.length) ||
    roles.has("assistant") && turn.answerTruncated);
}

function withFullText(turn: ChatTurn, full: ChatTurn, roles: ReadonlySet<CopyRole>): ChatTurn {
  if (full.id !== turn.id || turnConversation(full.conversationId) !== turnConversation(turn.conversationId) || needsFullText(full, roles))
    throw Error("The full message could not be loaded. Try copying again after restoring its local archive.");
  return {
    ...turn,
    ...(roles.has("user") && turn.requestTruncated ? { request: full.request, requestTruncated: false } : {}),
    ...(roles.has("assistant") && turn.answerTruncated ? { answer: full.answer, answerTruncated: false } : {}),
    ...(roles.has("user") && turn.workDetailsTruncated && turn.steers?.length ? { steers: full.steers, workDetailsTruncated: false } : {}),
  };
}

/** Pass only the chosen turns and omit readPage when copying selected messages. */
export async function collectConversationForCopy(
  current: readonly ChatTurn[],
  conversationId: string,
  readPage?: (offset: number) => Promise<ChatCopyPage>,
  loadFull?: (id: string) => Promise<ChatTurn | null>,
  currentGuard: () => boolean = () => true,
  requiredRoles?: readonly ChatMessageSelection[],
): Promise<ChatTurn[]> {
  const guard = () => {
    if (!currentGuard()) throw Error("The conversation changed. Choose the messages to copy again.");
  };
  guard();
  const selection = requiredRoles === undefined ? null : selectedRoles(requiredRoles);
  const rolesFor = (id: string): ReadonlySet<CopyRole> => selection ? selection.get(id) ?? NO_ROLES : ALL_ROLES;
  const turns = new Map<string, ChatTurn>();
  if (readPage) {
    let offset: number | null = 0;
    while (offset !== null) {
      guard();
      const page = await readPage(offset);
      guard();
      if (page.nextOffset !== null && (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset))
        throw Error("The saved conversation could not be read completely. Try copying again.");
      for (const turn of page.turns) {
        if (turnConversation(turn.conversationId) !== conversationId) continue;
        const earlier = turns.get(turn.id);
        if (!earlier || needsFullText(earlier, rolesFor(turn.id))) turns.set(turn.id, turn);
      }
      offset = page.nextOffset;
    }
  }

  // Current messages may contain a newer live response than the saved archive.
  for (const turn of current) {
    if (turnConversation(turn.conversationId) !== conversationId) continue;
    const archived = turns.get(turn.id);
    const roles = rolesFor(turn.id);
    turns.set(turn.id, needsFullText(turn, roles) && archived && !needsFullText(archived, roles) ? withFullText(turn, archived, roles) : turn);
  }
  for (const [id, turn] of turns) {
    guard();
    const roles = rolesFor(id);
    if (!needsFullText(turn, roles)) continue;
    const full = await loadFull?.(id);
    guard();
    if (!full) throw Error("The full message is unavailable. Restore its local archive before copying it.");
    turns.set(id, withFullText(turn, full, roles));
  }
  guard();
  return [...turns.values()].sort((a, b) => {
    if (a.startedAt === null) return b.startedAt === null ? 0 : -1;
    if (b.startedAt === null) return 1;
    return a.startedAt - b.startedAt;
  });
}

function userMessages(turn: ChatTurn): string[] {
  const entries = [{ text: turn.request, attachments: turn.attachments },
    ...(turn.steers ?? []).map(note => ({ text: note.text, attachments: note.context?.attachments }))];
  return entries.map(entry => {
    const attachments = entry.attachments?.map(file => "- " + file.name) ?? [];
    return [entry.text, ...(attachments.length ? ["Attachments\n" + attachments.join("\n")] : [])].filter(Boolean).join("\n\n");
  }).filter(Boolean);
}

/** A single-side copy retains the message's original Markdown and accepted follow-ups. */
export function copiedMessageText(turn: ChatTurn, role: ChatMessageSelection["role"]): string {
  if (needsFullText(turn, role === "user" ? USER_ROLE : ASSISTANT_ROLE)) throw Error("Load the full message before copying it.");
  return role === "assistant" ? turn.answer : userMessages(turn).join("\n\n");
}

export function formatCopiedConversation(turns: readonly ChatTurn[], selected?: readonly ChatMessageSelection[]): string {
  const selection = selected === undefined ? null : selectedRoles(selected);
  const available = new Set(turns.map(turn => turn.id));
  if (selected?.some(item => !available.has(item.turnId)))
    throw Error("A selected message is unavailable. Choose the messages to copy again.");
  const blocks: string[] = [];
  for (const turn of turns) {
    const roles = selection ? selection.get(turn.id) ?? NO_ROLES : ALL_ROLES;
    if (needsFullText(turn, roles)) throw Error("Load the full message before copying the conversation.");
    if (roles.has("user"))
      for (const text of userMessages(turn)) blocks.push("## You\n\n" + text);
    if (roles.has("assistant") && turn.answer) blocks.push("## Assistant\n\n" + turn.answer);
  }
  return blocks.join("\n\n");
}
