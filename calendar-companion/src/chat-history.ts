export interface ChatAction { kind: string; path: string; target?: string }
export interface ChatTurn {
  id: string; request: string; answer: string; startedAt: number | null; model: string;
  status: "running" | "paused" | "completed" | "stopped" | "failed";
  requests: number; inputTokens: number; outputTokens: number; actions: ChatAction[];
  requestTruncated?: boolean; answerTruncated?: boolean;
  sourcePath?: string; actionsKnown?: boolean;
  actionTotal?: number;
}
export const CHAT_HISTORY_LIMIT = 50;
export function validChatId(id: string): boolean { return /^[a-zA-Z0-9_-]{1,80}$/.test(id); }
export function chatPreview(turn: ChatTurn): ChatTurn {
  return { ...turn, request: turn.request.slice(0, 4000), answer: turn.answer.slice(0, 16000), actions: turn.actions.slice(-100),
    requestTruncated: !!turn.requestTruncated || turn.request.length > 4000, answerTruncated: !!turn.answerTruncated || turn.answer.length > 16000 };
}
export function readChat(value: unknown): ChatTurn | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || !validChatId(v.id) || typeof v.request !== "string" || v.request.length > 32000 || typeof v.answer !== "string" || v.answer.length > 4 * 1024 * 1024) return null;
  const status = ["running", "paused", "completed", "stopped", "failed"].includes(String(v.status)) ? v.status as ChatTurn["status"] : "stopped";
  const count = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : 0;
  const actions: ChatAction[] = [];
  if (Array.isArray(v.actions)) for (const action of v.actions.slice(-100)) {
    if (!action || typeof action !== "object") continue;
    const a = action as Record<string, unknown>;
    if (typeof a.kind === "string" && typeof a.path === "string") actions.push({ kind: a.kind.slice(0, 32), path: a.path.slice(0, 500), ...(typeof a.target === "string" ? { target: a.target.slice(0, 500) } : {}) });
  }
  return { id: v.id, request: v.request, answer: v.answer, startedAt: typeof v.startedAt === "number" && Number.isFinite(v.startedAt) ? v.startedAt : null,
    model: typeof v.model === "string" ? v.model.slice(0, 128) : "", status, requests: count(v.requests), inputTokens: count(v.inputTokens), outputTokens: count(v.outputTokens), actions,
    requestTruncated: v.requestTruncated === true, answerTruncated: v.answerTruncated === true,
    ...(typeof v.sourcePath === "string" ? { sourcePath: v.sourcePath.slice(0, 500) } : {}), actionsKnown: v.actionsKnown === true, actionTotal: Math.max(count(v.actionTotal), actions.length) };
}
