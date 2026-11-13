import { validChatId } from "./chat-history";

export const FIRST_CONVERSATION_ID = "inbox";
export const MAX_CONVERSATIONS = 200;
export const MAX_FOLDERS = 50;
export const CONVERSATION_NAME_LIMIT = 100;

export interface ConversationFolder { id: string; name: string }
export interface Conversation {
  id: string;
  name: string;
  folderId: string | null;
  pinned: boolean;
  archived: boolean;
  updatedAt: number;
}
export interface ConversationLibrary {
  active: string;
  conversations: Conversation[];
  folders: ConversationFolder[];
}
export function conversationName(value: unknown): string {
  return typeof value === "string" ? [...value.trim().slice(0, CONVERSATION_NAME_LIMIT)].map(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char).join("").trim() : "";
}
export function newConversationRecord(id: string, folderId: string | null = null): Conversation {
  return { id, name: "", folderId, pinned: false, archived: false, updatedAt: Date.now() };
}
export function turnConversation(value: string | undefined): string { return value ?? FIRST_CONVERSATION_ID; }

export function readLibrary(raw: unknown): ConversationLibrary {
  const source = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const folders: ConversationFolder[] = [], conversations: Conversation[] = [];
  const folderIds = new Set<string>(), conversationIds = new Set<string>();
  if (Array.isArray(source.folders)) for (const row of source.folders.slice(0, MAX_FOLDERS) as unknown[]) {
    if (!row || typeof row !== "object") continue;
    const { id, name } = row as Record<string, unknown>, label = conversationName(name);
    if (typeof id !== "string" || !validChatId(id) || !label || folderIds.has(id)) continue;
    folderIds.add(id); folders.push({ id, name: label });
  }
  if (Array.isArray(source.conversations)) for (const row of source.conversations.slice(0, MAX_CONVERSATIONS) as unknown[]) {
    if (!row || typeof row !== "object") continue;
    const { id, name, folderId, pinned, archived, updatedAt } = row as Record<string, unknown>;
    if (typeof id !== "string" || !validChatId(id) || conversationIds.has(id)) continue;
    conversationIds.add(id);
    conversations.push({ id, name: conversationName(name), folderId: typeof folderId === "string" && folderIds.has(folderId) ? folderId : null,
      pinned: pinned === true, archived: archived === true, updatedAt: typeof updatedAt === "number" && Number.isFinite(updatedAt) ? updatedAt : 0 });
  }
  if (!conversations.length) conversations.push(newConversationRecord(FIRST_CONVERSATION_ID));
  const active = conversations.find(conversation => conversation.id === source.active && !conversation.archived) ??
    conversations.find(conversation => !conversation.archived) ?? conversations[0];
  active.archived = false;
  return { active: active.id, conversations, folders };
}
