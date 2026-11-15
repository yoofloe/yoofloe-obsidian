import { containsCredential, type WorkScope, type WriteScope } from "./agent-policy";
import { readSelectionReference, type SelectionReference } from "./selection-reference";
import { readAttachments, type Attachment } from "./attachments";

export type FollowUpMode = "queue" | "steer";
export type FollowUpStatus = "queued" | "steer-pending" | "sending" | "review";
export interface FollowUpAccess {
  target: string | null;
  read: WorkScope;
  write: WriteScope | "none";
  signature: string;
}
export interface FollowUp {
  id: string;
  text: string;
  status: FollowUpStatus;
  access: FollowUpAccess;
  context?: FollowUpContext;
}
export interface FollowUpContext { reference: SelectionReference | null; attachments: Attachment[]; needsReview?: boolean; deferNoteRead?: boolean }

export function readFollowUpContext(value: unknown): FollowUpContext | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") return { reference: null, attachments: [], needsReview: true };
  const raw = value as Record<string, unknown>, reference = readSelectionReference(raw.reference), attachments = readAttachments(raw.attachments);
  const invalid = raw.needsReview === true || raw.reference !== null && !reference || reference?.needsReview ||
    !Array.isArray(raw.attachments) || raw.attachments.length !== attachments.length;
  return { reference, attachments, ...(invalid ? { needsReview: true } : {}), ...(raw.deferNoteRead === true ? { deferNoteRead: true } : {}) };
}

export const FOLLOW_UP_LIMIT = 20;
export const FOLLOW_UP_TEXT_LIMIT = 32000;
export function followUpMode(value: unknown): FollowUpMode { return value === "steer" ? "steer" : "queue"; }

/** A recovered queue has no automatic dispatch authority. In-flight entries require review. */
export function readFollowUps(value: unknown): FollowUp[] {
  if (!Array.isArray(value)) return [];
  const entries: FollowUp[] = [];
  const ids = new Set<string>();
  for (const item of value.slice(0, FOLLOW_UP_LIMIT) as unknown[]) {
    if (!item || typeof item !== "object") continue;
    const { id, text, status, access, context: rawContext } = item as Record<string, unknown>;
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(id) || ids.has(id) ||
      typeof text !== "string" || !text.trim() || text.length > FOLLOW_UP_TEXT_LIMIT || containsCredential(text) ||
      !access || typeof access !== "object") continue;
    const { target, read, write, signature } = access as Record<string, unknown>;
    if (target !== null && (typeof target !== "string" || target.length > 500 || containsCredential(target))) continue;
    if (!["current", "folder", "vault"].includes(String(read)) ||
      !["none", "current", "new", "folder", "vault"].includes(String(write)) ||
      typeof signature !== "string" || signature.length > 12000 || containsCredential(signature)) continue;
    ids.add(id);
    const context = readFollowUpContext(rawContext);
    entries.push({ id, text, status: status === "queued" && !context?.needsReview ? "queued" : "review", ...(context ? { context } : {}),
      access: { target, read: read as WorkScope, write: write as WriteScope | "none", signature } });
  }
  return entries;
}
