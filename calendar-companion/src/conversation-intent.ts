import { containsCredential } from "./agent-policy";
import type { ChatTurn } from "./chat-history";
import { turnConversation } from "./conversation-library";

const MAX_REQUESTS = 8;
const MAX_INTENT_BYTES = 16000;
const MAX_REQUEST_CHARACTERS = 2000;
export interface UserDirection { request: string; corrections: string[]; status: ChatTurn["status"]; partial: boolean }

export function readUserDirections(value: unknown): UserDirection[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-MAX_REQUESTS).flatMap((raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const entry = raw as Record<string, unknown>;
    if (typeof entry.request !== "string" || entry.request.length > MAX_REQUEST_CHARACTERS ||
      !Array.isArray(entry.corrections) || entry.corrections.length > 2 ||
      entry.corrections.some((text: unknown) => typeof text !== "string" || text.length > 800 || containsCredential(text)) ||
      typeof entry.status !== "string" || !["completed", "failed", "stopped"].includes(entry.status) || containsCredential(entry.request)) return [];
    return [{ request: entry.request, corrections: entry.corrections as string[], status: entry.status as ChatTurn["status"], partial: entry.partial === true }];
  });
}

/** User-authored directions remain useful when the note, model or source scope changes. */
export function conversationIntent(turns: readonly ChatTurn[], conversationId: string,
  coveredRequests: ReadonlySet<string>, remembered: readonly UserDirection[] = []): UserDirection[] {
  const recent: UserDirection[] = [];
  const seen = new Set<string>();
  const candidates: UserDirection[] = [...remembered];
  for (const turn of turns) {
    if (turnConversation(turn.conversationId) !== conversationId || turn.status === "running" || turn.status === "paused") continue;
    const corrections = (turn.steers ?? []).map(note => note.text);
    candidates.push({ request: turn.request, corrections, status: turn.status,
      partial: !!turn.requestTruncated || !!turn.workDetailsTruncated && corrections.length > 0 });
  }
  let remaining = MAX_INTENT_BYTES;
  for (let index = candidates.length - 1; index >= 0 && recent.length < MAX_REQUESTS; index--) {
    const turn = candidates[index], corrections = turn.corrections;
    if ((!turn.request.trim() && !corrections.length) || containsCredential(turn.request) || corrections.some(containsCredential)) continue;
    const entry = {
      request: turn.request.slice(0, MAX_REQUEST_CHARACTERS),
      corrections: corrections.slice(-2).map(text => text.slice(0, 800)),
      status: turn.status,
      partial: turn.partial || turn.request.length > MAX_REQUEST_CHARACTERS ||
        corrections.length > 2 || corrections.some(text => text.length > 800),
    };
    const identity = JSON.stringify([entry.request.trim(), entry.corrections]).normalize("NFC").toLowerCase();
    if (seen.has(identity)) continue;
    seen.add(identity);
    if (coveredRequests.has(turn.request) && !corrections.length) continue;
    const cost = new TextEncoder().encode(JSON.stringify(entry)).length;
    if (cost > remaining) break;
    remaining -= cost;
    recent.unshift(entry);
  }
  return recent;
}
