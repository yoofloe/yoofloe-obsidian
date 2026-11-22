import { sourceList, type SourceMode, type WebSource, type OnlineUsage } from "./research";
import { readGeneratedFiles, type GeneratedFile } from "./generated-files";
import { readAttachments, type Attachment } from "./attachments";
import { readActivity, readSteerNotes, workText, type SteerNote, type WorkEvent } from "./work-activity";
import { validContextScope } from "./conversation-context";
import { readSelectionReference, type ReferenceSnapshot, type SelectionReference } from "./selection-reference";
import { containsCredential } from "./agent-policy";
import type { ReadCoverage } from "./vault-agent";
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
  reference?: SelectionReference;
  referenceSnapshot?: ReferenceSnapshot;
  pausedForInput?: boolean;
  pausedForConnection?: boolean;
  pausedForServer?: boolean;
  readCoverage?: ReadCoverage[];
  uploadCleanupWarning?: string;
  generatedTruncated?: boolean;
  conversationId?: string; contextScope?: string | null;
  sharedMessageId?: string;
  sharedContext?: { conversationId: string; scope: string };
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
function referencePreview(reference: SelectionReference): SelectionReference {
  if (!reference.quote) return reference;
  const { quote, ...preview } = reference;
  return { ...preview, needsReview: true };
}
export function chatPreview(turn: ChatTurn): ChatTurn {
  const excerpt = turn.referenceSnapshot;
  const limited = !!excerpt && excerpt.text.length > 4096;
  return { ...turn, request: turn.request.slice(0, 4000), answer: turn.answer.slice(0, 16000), actions: turn.actions.slice(-100), generated: turn.generated?.slice(0, 16), generatedTruncated: !!turn.generatedTruncated || (turn.generated?.length ?? 0) > 16,
    ...(turn.reference ? { reference: referencePreview(turn.reference) } : {}),
    ...(limited ? { referenceSnapshot: { text: excerpt.text.slice(0, 4096).replace(/[\uD800-\uDBFF]$/, ""), partial: true } } : {}),
    activity: turn.activity?.slice(-24).map(event => ({ ...event, text: event.text.slice(0, 360) })),
    steers: turn.steers?.slice(-5).map(note => ({ ...note, text: note.text.slice(0, 1000), ...(note.context?.reference?.quote ?
      { context: { ...note.context, reference: referencePreview(note.context.reference) } } : {}) })),
    workDetailsTruncated: !!turn.workDetailsTruncated || (turn.activity?.length ?? 0) > 24 || (turn.steers?.length ?? 0) > 5 ||
      !!turn.activity?.some(event => event.text.length > 360) || !!turn.steers?.some(note => note.text.length > 1000 || note.context?.reference?.quote) ||
      !!turn.reference?.quote || limited,
    requestTruncated: !!turn.requestTruncated || turn.request.length > 4000, answerTruncated: !!turn.answerTruncated || turn.answer.length > 16000 };
}
export function readChat(value: unknown): ChatTurn | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || !validChatId(v.id) || typeof v.request !== "string" || v.request.length > 32000 || typeof v.answer !== "string" || v.answer.length > 4 * 1024 * 1024) return null;
  const status = ["running", "paused", "completed", "stopped", "failed"].includes(String(v.status)) ? v.status as ChatTurn["status"] : "stopped";
  const count = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : 0;
  const reference = readSelectionReference(v.reference);
  const snapshot = v.referenceSnapshot && typeof v.referenceSnapshot === "object" ? v.referenceSnapshot as Record<string, unknown> : null;
  const referenceSnapshot = reference && typeof snapshot?.text === "string" && snapshot.text.length <= 32768 && !containsCredential(snapshot.text) ?
    { text: snapshot.text, partial: snapshot.partial === true } : null;
  const readCoverage = Array.isArray(v.readCoverage) ? v.readCoverage.slice(-24).flatMap(value => {
    if (!value || typeof value !== "object") return [];
    const { path, selection, read, total } = value as Record<string, unknown>;
    return typeof path === "string" && path.length <= 500 && !containsCredential(path) && typeof selection === "boolean" &&
      typeof read === "number" && typeof total === "number" && count(read) === read && count(total) === total && read <= total ?
      [{ path, selection, read, total }] : [];
  }) : undefined;
  const actions: ChatAction[] = [];
  if (Array.isArray(v.actions)) for (const action of v.actions.slice(-100)) {
    if (!action || typeof action !== "object") continue;
    const a = action as Record<string, unknown>;
    if (typeof a.kind === "string" && typeof a.path === "string") actions.push({ kind: a.kind.slice(0, 32), path: a.path.slice(0, 500), ...(typeof a.target === "string" ? { target: a.target.slice(0, 500) } : {}) });
  }
  const sharedContext = v.sharedContext && typeof v.sharedContext === "object" ? v.sharedContext as Record<string, unknown> : null;
  return { id: v.id, request: v.request, answer: v.answer, startedAt: typeof v.startedAt === "number" && Number.isFinite(v.startedAt) ? v.startedAt : null,
    model: typeof v.model === "string" ? v.model.slice(0, 128) : "", status, requests: count(v.requests), inputTokens: count(v.inputTokens), outputTokens: count(v.outputTokens), actions,
    ...(typeof v.durationMs === "number" && Number.isSafeInteger(v.durationMs) && v.durationMs >= 0 ? { durationMs: v.durationMs } : {}),
    ...(typeof v.conversationId === "string" && validChatId(v.conversationId) ? { conversationId: v.conversationId } : {}),
    ...(v.contextScope === null || validContextScope(v.contextScope) ? { contextScope: v.contextScope } : {}),
    ...(typeof v.sharedMessageId === "string" && validChatId(v.sharedMessageId) ? { sharedMessageId: v.sharedMessageId } : {}),
    ...(sharedContext && typeof sharedContext.conversationId === "string" && validChatId(sharedContext.conversationId) &&
      validContextScope(sharedContext.scope) ? { sharedContext: { conversationId: sharedContext.conversationId, scope: sharedContext.scope } } : {}),
    activity: readActivity(v.activity), steers: readSteerNotes(v.steers), workDetailsTruncated: v.workDetailsTruncated === true,
    requestTruncated: v.requestTruncated === true, answerTruncated: v.answerTruncated === true,
    ...(typeof v.sourcePath === "string" ? { sourcePath: v.sourcePath.slice(0, 500) } : {}), actionsKnown: v.actionsKnown === true, actionTotal: Math.max(count(v.actionTotal), actions.length),
    sourceMode: v.sourceMode === "expanded" ? "expanded" : "provided", sources: sourceList(v.sources), generated: readGeneratedFiles(v.generated), generatedTruncated: v.generatedTruncated === true,
    attachments: readAttachments(v.attachments), ...(reference ? { reference } : {}), ...(referenceSnapshot ? { referenceSnapshot } : {}),
    ...(v.pausedForInput === true ? { pausedForInput: true } : {}), ...(v.pausedForConnection === true ? { pausedForConnection: true } : {}),
    ...(v.pausedForServer === true ? { pausedForServer: true } : {}),
    ...(readCoverage ? { readCoverage } : {}),
    transcriptions: count(v.transcriptions), fileWarnings: Array.isArray(v.fileWarnings) ? v.fileWarnings.filter((value): value is string => typeof value === "string").slice(0, 32).map(value => value.slice(0, 500)) : [],
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
