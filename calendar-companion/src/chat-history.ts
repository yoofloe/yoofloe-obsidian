import { sourceList, type SourceMode, type WebSource, type OnlineUsage } from "./research";
import { readGeneratedFiles, type GeneratedFile } from "./generated-files";
import { readAttachments, type Attachment } from "./attachments";
import { readActivity, readSteerNotes, workText, type SteerNote, type WorkEvent } from "./work-activity";
import { validContextScope } from "./conversation-context";
export interface ChatAction { kind: string; path: string; target?: string }
export interface ChatTurn {
  id: string; request: string; answer: string; startedAt: number | null; model: string;
  status: "running" | "paused" | "completed" | "stopped" | "failed";
  requests: number; inputTokens: number; outputTokens: number; actions: ChatAction[];
  requestTruncated?: boolean; answerTruncated?: boolean;
  sourcePath?: string; actionsKnown?: boolean;
  actionTotal?: number;
  sourceMode?: SourceMode; sources?: WebSource[]; online?: OnlineUsage; generated?: GeneratedFile[];
  attachments?: Attachment[]; transcriptions?: number; fileWarnings?: string[];
  uploadCleanupWarning?: string;
  generatedTruncated?: boolean;
  conversationId?: string; contextScope?: string | null;
  durationMs?: number; activity?: WorkEvent[]; steers?: SteerNote[]; workDetailsTruncated?: boolean;
}
export const CHAT_HISTORY_LIMIT = 50;
export function confirmedChangeCount(turn: ChatTurn): number { return Math.max(turn.actionTotal ?? 0, turn.actions.length); }
export function taskFailure(turn: ChatTurn): string {
  if (turn.status !== "failed" || !turn.activity) return "";
  for (let index = turn.activity.length - 1; index >= 0; index--) {
    const event = turn.activity[index];
    if (event.state === "blocked" && !turn.fileWarnings?.includes(event.text)) return event.text;
  }
  return "";
}
export function validChatId(id: string): boolean { return /^[a-zA-Z0-9_-]{1,80}$/.test(id); }
export function chatPreview(turn: ChatTurn): ChatTurn {
  return { ...turn, request: turn.request.slice(0, 4000), answer: turn.answer.slice(0, 16000), actions: turn.actions.slice(-100), generated: turn.generated?.slice(0, 16), generatedTruncated: !!turn.generatedTruncated || (turn.generated?.length ?? 0) > 16,
    activity: turn.activity?.slice(-24).map(event => ({ ...event, text: event.text.slice(0, 360) })),
    steers: turn.steers?.slice(-5).map(note => ({ ...note, text: note.text.slice(0, 1000) })),
    workDetailsTruncated: !!turn.workDetailsTruncated || (turn.activity?.length ?? 0) > 24 || (turn.steers?.length ?? 0) > 5 ||
      !!turn.activity?.some(event => event.text.length > 360) || !!turn.steers?.some(note => note.text.length > 1000),
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
    ...(typeof v.durationMs === "number" && Number.isSafeInteger(v.durationMs) && v.durationMs >= 0 ? { durationMs: v.durationMs } : {}),
    ...(typeof v.conversationId === "string" && validChatId(v.conversationId) ? { conversationId: v.conversationId } : {}),
    ...(v.contextScope === null || validContextScope(v.contextScope) ? { contextScope: v.contextScope } : {}),
    activity: readActivity(v.activity), steers: readSteerNotes(v.steers), workDetailsTruncated: v.workDetailsTruncated === true,
    requestTruncated: v.requestTruncated === true, answerTruncated: v.answerTruncated === true,
    ...(typeof v.sourcePath === "string" ? { sourcePath: v.sourcePath.slice(0, 500) } : {}), actionsKnown: v.actionsKnown === true, actionTotal: Math.max(count(v.actionTotal), actions.length),
    sourceMode: v.sourceMode === "expanded" ? "expanded" : "provided", sources: sourceList(v.sources), generated: readGeneratedFiles(v.generated), generatedTruncated: v.generatedTruncated === true,
    attachments: readAttachments(v.attachments), transcriptions: count(v.transcriptions), fileWarnings: Array.isArray(v.fileWarnings) ? v.fileWarnings.filter((value): value is string => typeof value === "string").slice(0, 32).map(value => value.slice(0, 500)) : [],
    ...(typeof v.uploadCleanupWarning === "string" ? { uploadCleanupWarning: workText(v.uploadCleanupWarning, 500) } : {}),
    online: v.online && typeof v.online === "object" ? { search: count((v.online as OnlineUsage).search), analysis: count((v.online as OnlineUsage).analysis), image: count((v.online as OnlineUsage).image) } : undefined };
}
export function chatMatches(turn: ChatTurn, query: string): boolean {
  return [turn.request,turn.answer,...(turn.steers ?? []).map(note => note.text),...turn.actions.map(action=>action.path),...(turn.attachments??[]).map(file=>file.name)].join("\n").toLocaleLowerCase().includes(query.toLocaleLowerCase());
}
export function searchChatPreview(turn: ChatTurn, query: string): ChatTurn {
  const excerpt = (text: string) => { const index=text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()), start=Math.max(0,index-160); return (start?"…":"")+text.slice(start,start+1600)+(text.length>start+1600?"…":""); };
  return {...chatPreview(turn),request:excerpt(turn.request),answer:excerpt(turn.answer),requestTruncated:turn.request.length>1600,answerTruncated:turn.answer.length>1600};
}
