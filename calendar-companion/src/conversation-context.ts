import { containsCredential } from "./agent-policy";
import { MAX_AI_INPUT_BYTES } from "./ai-session";
import type { ChatTurn } from "./chat-history";

export const AUTO_COMPACT_TOKENS = 32000;
const MAX_SAVED_COMPACTION_BYTES = 384 * 1024;
const MAX_HISTORY_BYTES = 640 * 1024;
const bytes = (value: string) => new TextEncoder().encode(value).length;

export interface CompactionItem extends Record<string, unknown> {
  type: "compaction";
  encrypted_content: string;
  id?: string;
}
export interface ConversationCheckpoint {
  scope: string;
  turnId: string;
  item: CompactionItem;
  at: number;
}
export const validContextScope = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

export const compactionProblems = ["missing_content", "content_too_large", "invalid_encoding", "credential_pattern", "invalid_id",
  "invalid_window", "missing_item", "unchanged_window", "input_not_reduced"] as const;
export type CompactionProblem = typeof compactionProblems[number];

export function inspectCompaction(value: unknown): CompactionItem | CompactionProblem {
  if (!value || typeof value !== "object") return "invalid_window";
  const { type, encrypted_content, id } = value as Record<string, unknown>;
  if (type !== "compaction" || typeof encrypted_content !== "string" || !encrypted_content) return "missing_content";
  if (encrypted_content.length > MAX_AI_INPUT_BYTES) return "content_too_large";
  if (!/^[A-Za-z0-9+/_=.~-]+$/.test(encrypted_content)) return "invalid_encoding";
  if (containsCredential(encrypted_content)) return "credential_pattern";
  if (id != null && (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(id))) return "invalid_id";
  return { type, encrypted_content, ...(typeof id === "string" ? { id } : {}) };
}
export function readCompaction(value: unknown): CompactionItem | null {
  const item = inspectCompaction(value);
  return typeof item === "string" ? null : item;
}
export function readCheckpoint(value: unknown): ConversationCheckpoint | null {
  if (!value || typeof value !== "object") return null;
  const { scope, turnId, item, at } = value as Record<string, unknown>, compact = readCompaction(item);
  if (!validContextScope(scope) || typeof turnId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(turnId) ||
    !compact || compact.encrypted_content.length > MAX_SAVED_COMPACTION_BYTES || typeof at !== "number" || !Number.isFinite(at)) return null;
  return { scope, turnId, item: compact, at };
}

export function conversationContext(turns: ChatTurn[], scope: string, checkpoint: ConversationCheckpoint | null, allowance: number): Record<string, unknown>[] {
  let remaining = Math.min(MAX_HISTORY_BYTES, allowance);
  if (remaining <= 0) return [];
  const saved = checkpoint?.scope === scope ? checkpoint : null;
  const checkpointBytes = saved ? bytes(JSON.stringify(saved.item)) : 0;
  const useCheckpoint = !!saved && checkpointBytes < remaining;
  const after = useCheckpoint ? turns.findIndex(turn => turn.id === saved.turnId) : -1;
  if (useCheckpoint) remaining -= checkpointBytes;
  const messages: Record<string, unknown>[] = [];
  for (let index = turns.length - 1; index >= Math.max(0, after); index--) {
    const turn = turns[index];
    if (turn.contextScope !== scope || turn.status !== "completed" || !turn.answer) continue;
    const request = index === after ? "" : turn.request.slice(0, 8000);
    const answer = turn.answer.slice(0, 24000);
    if (containsCredential(request) || containsCredential(answer)) continue;
    const pair = [...(request ? [{ role: "user", content: request }] : []), { role: "assistant", content: answer }];
    const size = bytes(JSON.stringify(pair)) + 1;
    if (size > remaining) break;
    remaining -= size;
    messages.unshift(...pair);
  }
  return useCheckpoint ? [saved.item, ...messages] : messages;
}
