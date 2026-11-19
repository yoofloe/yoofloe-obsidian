import { assertId, createRequest, decode, encode, shape, WINDOW_MS } from "./protocol";

export const CALENDAR_CHANGE_VERSION = 4;
export const MAX_CALENDAR_CHANGE_OPERATIONS = 12;
const MAX_PROPOSAL_BYTES = 64 * 1024;
export const MAX_CALENDAR_CHANGE_TRANSFER_BYTES = 128 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const digest = /^[a-f0-9]{64}$/;
const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
const utcTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const eventFields = ["title", "description", "start", "end", "allDay", "timezone"];
const taskFields = ["title", "description", "dueDate", "status"];

export type CalendarChangeAction = "review" | "status" | "undo";
export type CalendarChangeKind = "event" | "task";
export type CalendarChangeOperationAction = "create" | "update" | "delete";
export type CalendarChangeStatus = "applied" | "cancelled" | "conflict" | "not_found" | "undone" | "rejected";

export interface CalendarChangeValues {
  readonly title?: string;
  readonly description?: string;
  readonly start?: string;
  readonly end?: string;
  readonly allDay?: boolean;
  readonly timezone?: string;
  readonly dueDate?: string | null;
  readonly status?: "pending" | "completed";
}

export interface CalendarChangeOperation {
  readonly opId: string;
  readonly kind: CalendarChangeKind;
  readonly action: CalendarChangeOperationAction;
  readonly target: Readonly<{ id: string; revision: number }> | null;
  readonly values: CalendarChangeValues | null;
}

export interface CalendarChangeDraft {
  readonly proposalId: string;
  readonly proposalDigest: string;
  readonly datasetId: string | null;
  readonly operations: readonly CalendarChangeOperation[];
}

export interface CalendarChangeRequest {
  format: "yoofloe.calendar.change.request";
  version: 4;
  requestId: string;
  vault: string;
  vaultId: string;
  nonce: string;
  key: string;
  createdAt: number;
  expiresAt: number;
  action: CalendarChangeAction;
  proposalId: string;
  proposalDigest: string;
  datasetId: string | null;
  iv: string | null;
  ciphertext: string | null;
}

export interface CalendarChangeResult {
  opId: string;
  kind: CalendarChangeKind;
  id: string;
  revision: number | null;
}

export interface CalendarChangeReply {
  version: 4;
  requestId: string;
  proposalId: string;
  proposalDigest: string;
  datasetId: string;
  status: CalendarChangeStatus;
  results: CalendarChangeResult[];
}

function object(value: unknown): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") throw Error("Invalid Calendar change.");
  return value as Record<string, unknown>;
}

function text(value: unknown, maximum: number, multiline = false): value is string {
  if (typeof value !== "string" || encoder.encode(value).length > maximum) return false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if ((c < 32 || c === 127) && !(multiline && (c === 9 || c === 10 || c === 13))) return false;
  }
  return true;
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !dateOnly.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function validInstant(value: unknown): value is string {
  if (typeof value !== "string" || !utcTime.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === (value.length === 20 ? value.replace(/Z$/, ".000Z") : value);
}

function validZone(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_+./-]{1,100}$/.test(value)) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
}

function validateValues(value: unknown, kind: CalendarChangeKind, action: CalendarChangeOperationAction): CalendarChangeValues | null {
  if (action === "delete") {
    if (value !== null) throw Error("A Calendar deletion cannot supply replacement values.");
    return null;
  }
  const fields = object(value);
  const allowed = kind === "event" ? eventFields : taskFields;
  if (!Object.keys(fields).length || Object.keys(fields).some(field => !allowed.includes(field)))
    throw Error("This Calendar change contains unsupported fields.");
  const has = (field: string) => Object.hasOwn(fields, field);
  const { title, description, start, end, allDay, timezone, dueDate, status } = fields;
  if ((action === "create" || has("title")) && (!text(title, 512) || !title.trim())) throw Error("Enter a Calendar title of up to 512 UTF-8 bytes.");
  if (has("description") && !text(description, 4096, true)) throw Error("The Calendar description is too long or contains unsupported characters.");
  if (kind === "event") {
    if (action === "create" && (!has("start") || !has("end") || !has("allDay") || !has("timezone")))
      throw Error("New Calendar events require start, end, all-day and time zone values.");
    if (has("allDay") && (typeof allDay !== "boolean" || !has("start") || !has("end")))
      throw Error("Set start and end together when supplying an all-day value.");
    if (has("timezone") && !validZone(timezone)) throw Error("Choose an IANA time zone for the Calendar event.");
    const validBound = (bound: unknown) => allDay === true ? validDate(bound) : allDay === false ? validInstant(bound) : validDate(bound) || validInstant(bound);
    if (has("start") && !validBound(start) || has("end") && !validBound(end))
      throw Error("Use ISO dates for all-day events and UTC instants for timed events.");
    if (typeof start === "string" && typeof end === "string" &&
        (validDate(start) !== validDate(end) || Date.parse(end) <= Date.parse(start)))
      throw Error("The Calendar event end must follow its start.");
  } else {
    if (has("dueDate") && dueDate !== null && !validDate(dueDate)) throw Error("Use an ISO due date or clear the date.");
    if (has("status") && status !== "pending" && status !== "completed") throw Error("Only pending and completed tasks are supported.");
  }
  // Keep stable JSON field order so a saved proposal retains the exact digest.
  return Object.freeze(Object.fromEntries<unknown>(allowed.filter(has).map(field => [field, fields[field]])));
}

export function validateCalendarChangeOperations(operations: unknown, datasetId: string | null): readonly CalendarChangeOperation[] {
  if (datasetId !== null) assertId(datasetId);
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > MAX_CALENDAR_CHANGE_OPERATIONS)
    throw Error("A Calendar proposal must contain 1 to 12 changes.");
  const ids = new Set<string>();
  const targets = new Set<string>();
  const result = operations.map((value: unknown): CalendarChangeOperation => {
    shape(value, ["opId", "kind", "action", "target", "values"]);
    const { opId, kind, action } = value;
    assertId(opId);
    if (ids.has(opId)) throw Error("A Calendar proposal contains a duplicate change identity.");
    ids.add(opId);
    if (kind !== "event" && kind !== "task") throw Error("This Calendar record type cannot be changed.");
    if (action !== "create" && action !== "update" && action !== "delete") throw Error("This Calendar action is not supported.");
    let target: CalendarChangeOperation["target"] = null;
    if (action === "create") {
      if (value.target !== null) throw Error("A new Calendar record cannot name an existing target.");
    } else {
      if (!datasetId) throw Error("Read the current Calendar records before proposing an edit or deletion.");
      shape(value.target, ["id", "revision"]);
      if (!text(value.target.id, 1000) || !value.target.id || typeof value.target.revision !== "number" ||
          !Number.isSafeInteger(value.target.revision) || value.target.revision < 1)
        throw Error("This Calendar change needs a valid record identity and revision.");
      const identity = `${kind}:${value.target.id}`;
      if (targets.has(identity)) throw Error("A Calendar proposal can change each existing record only once.");
      targets.add(identity);
      target = Object.freeze({ id: value.target.id, revision: value.target.revision });
    }
    return Object.freeze({ opId, kind, action, target, values: validateValues(value.values, kind, action) });
  });
  return Object.freeze(result);
}

function proposalBytes(operations: readonly CalendarChangeOperation[]): Uint8Array<ArrayBuffer> {
  const bytes = encoder.encode(JSON.stringify({ operations }));
  if (bytes.length > MAX_PROPOSAL_BYTES) throw Error("This Calendar proposal is too large.");
  return bytes;
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function createCalendarChangeDraft(operations: unknown, datasetId: string | null): Promise<CalendarChangeDraft> {
  const canonical = validateCalendarChangeOperations(operations, datasetId);
  const proposalId = crypto.randomUUID();
  assertId(proposalId);
  const plain = proposalBytes(canonical);
  try {
    return Object.freeze({ proposalId, proposalDigest: await sha256(plain), datasetId, operations: canonical });
  } finally { plain.fill(0); }
}

/** Validate stored drafts independently; the workspace never stores transfer keys. */
export async function readCalendarChangeDraft(saved: unknown): Promise<CalendarChangeDraft> {
  shape(saved, ["proposalId", "proposalDigest", "datasetId", "operations"]);
  assertId(saved.proposalId);
  const { proposalId, proposalDigest, datasetId } = saved;
  if (datasetId !== null) assertId(datasetId);
  if (typeof proposalDigest !== "string" || !digest.test(proposalDigest)) throw Error("Invalid Calendar proposal digest.");
  const operations = validateCalendarChangeOperations(saved.operations, datasetId);
  const plain = proposalBytes(operations);
  try {
    if (await sha256(plain) !== proposalDigest) throw Error("The saved Calendar proposal changed.");
    return Object.freeze({ proposalId, proposalDigest, datasetId, operations });
  } finally { plain.fill(0); }
}

export function assertLiveCalendarChange(request: CalendarChangeRequest, now = Date.now()): void {
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(request.createdAt) || !Number.isSafeInteger(request.expiresAt) ||
      request.createdAt < 0 || request.expiresAt <= request.createdAt || request.expiresAt - request.createdAt > WINDOW_MS ||
      now < request.createdAt - 60000 || now > request.expiresAt)
    throw Error("This Calendar change request expired. Check its status before retrying.");
}

export function calendarChangeAad(request: CalendarChangeRequest, direction: "request" | "reply"): Uint8Array<ArrayBuffer> {
  return encoder.encode(`yoofloe-calendar-change/v4|${direction}|${request.action}|${request.requestId}|${request.vault}|${request.vaultId}|${request.nonce}|${request.proposalId}|${request.proposalDigest}|${request.datasetId ?? ""}`);
}

export async function createCalendarChangeRequest(
  draft: CalendarChangeDraft,
  options: { vaultName: string; vaultId: string; action?: CalendarChangeAction; datasetId?: string | null; now?: number },
): Promise<CalendarChangeRequest> {
  const prepared = await readCalendarChangeDraft(draft);
  const { vaultName, vaultId, action = "review", now = Date.now() } = options;
  assertId(vaultId);
  if (action !== "review" && action !== "status" && action !== "undo") throw Error("Invalid Calendar change request action.");
  const datasetId = options.datasetId === undefined ? prepared.datasetId : options.datasetId;
  if (datasetId !== null) assertId(datasetId);
  if ((action === "review" || prepared.datasetId !== null) && datasetId !== prepared.datasetId)
    throw Error("The Calendar dataset does not match this proposal.");
  if (action === "undo" && datasetId === null) throw Error("Check which Calendar dataset applied this proposal before undoing it.");
  const base = createRequest(vaultName, now);
  const request: CalendarChangeRequest = {
    format: "yoofloe.calendar.change.request", version: 4, requestId: base.requestId, vault: base.vault,
    vaultId, nonce: base.nonce, key: base.key, createdAt: base.createdAt, expiresAt: base.expiresAt, action,
    proposalId: prepared.proposalId, proposalDigest: prepared.proposalDigest, datasetId, iv: null, ciphertext: null,
  };
  assertLiveCalendarChange(request, now);
  if (action === "review") {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = proposalBytes(prepared.operations);
    const keyBytes = decode(request.key, 32);
    try {
      const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
      const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: calendarChangeAad(request, "request") }, key, plain);
      request.iv = encode(iv);
      request.ciphertext = encode(new Uint8Array(ciphertext));
    } finally { plain.fill(0); keyBytes.fill(0); }
  }
  return request;
}

/** The deep link opens a review surface. The vault marker carries the proposal and key. */
export function calendarChangeLaunchUrl(request: CalendarChangeRequest, inboxHint?: string): string {
  assertId(request.requestId);
  assertId(request.vaultId);
  decode(request.vault, 256);
  const hint = typeof inboxHint === "string" && text(inboxHint, 1024) && inboxHint ? `&inbox=${encode(encoder.encode(inboxHint))}` : "";
  return `yoofloe-calendar://obsidian/change?version=4&requestId=${request.requestId}&vault=${request.vault}&vaultId=${request.vaultId}${hint}`;
}

function validateChangeReply(value: unknown, request: CalendarChangeRequest, draft: CalendarChangeDraft): CalendarChangeReply {
  shape(value, ["version", "requestId", "proposalId", "proposalDigest", "datasetId", "status", "results"]);
  const { datasetId, status, results } = value;
  if (value.version !== 4 || value.requestId !== request.requestId ||
      value.proposalId !== request.proposalId || value.proposalDigest !== request.proposalDigest ||
      draft.proposalId !== request.proposalId || draft.proposalDigest !== request.proposalDigest)
    throw Error("This Calendar reply belongs to a different proposal.");
  assertId(datasetId);
  if (status !== "applied" && status !== "cancelled" && status !== "conflict" &&
      status !== "not_found" && status !== "undone" && status !== "rejected") throw Error("Invalid Calendar change status.");
  const successful = status === "applied" || status === "undone";
  if (successful && request.datasetId !== null && datasetId !== request.datasetId)
    throw Error("This reply belongs to a different Calendar dataset.");
  if (!Array.isArray(results) || results.length !== (successful ? draft.operations.length : 0)) throw Error("Invalid Calendar change results.");
  const expected = new Map(draft.operations.map(op => [op.opId, op]));
  const nativeIds = new Set<string>();
  for (const result of results as unknown[]) {
    shape(result, ["opId", "kind", "id", "revision"]);
    assertId(result.opId);
    const operation = expected.get(result.opId);
    if (!operation || result.kind !== operation.kind || !text(result.id, 1000) || !result.id ||
        operation.target && result.id !== operation.target.id ||
        result.revision !== null && (typeof result.revision !== "number" || !Number.isSafeInteger(result.revision) || result.revision < 1))
      throw Error("The Calendar result does not match its proposed change.");
    const identity = `${operation.kind}:${result.id}`;
    if (nativeIds.has(identity)) throw Error("The Calendar reply contains duplicate result identities.");
    nativeIds.add(identity);
    expected.delete(result.opId);
  }
  return value as unknown as CalendarChangeReply;
}

export async function openCalendarChangeReply(
  raw: string, request: CalendarChangeRequest, draft: CalendarChangeDraft, now = Date.now(),
): Promise<CalendarChangeReply> {
  assertLiveCalendarChange(request, now);
  if (raw.length > MAX_CALENDAR_CHANGE_TRANSFER_BYTES || encoder.encode(raw).length > MAX_CALENDAR_CHANGE_TRANSFER_BYTES)
    throw Error("This Calendar change reply is too large.");
  let envelope: unknown;
  try { envelope = JSON.parse(raw); } catch { throw Error("This Calendar change reply is incomplete or invalid."); }
  shape(envelope, ["format", "version", "requestId", "iv", "ciphertext"]);
  if (envelope.format !== "yoofloe.calendar.change.reply" || envelope.version !== 4 || envelope.requestId !== request.requestId)
    throw Error("No matching Calendar change reply.");
  const keyBytes = decode(request.key, 32), iv = decode(envelope.iv, 12), cipher = decode(envelope.ciphertext, MAX_PROPOSAL_BYTES + 16);
  let plain: ArrayBuffer | null = null;
  try {
    if (keyBytes.length !== 32 || iv.length !== 12 || cipher.length < 17) throw Error("Invalid Calendar transfer encryption.");
    const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: calendarChangeAad(request, "reply") }, key, cipher);
    let value: unknown;
    try { value = JSON.parse(decoder.decode(plain)); } catch { throw Error("The Calendar change reply could not be read."); }
    return validateChangeReply(value, request, draft);
  } catch (error) {
    if (error instanceof Error && error.name === "OperationError") throw Error("The Calendar change reply could not be authenticated.");
    throw error;
  } finally { keyBytes.fill(0); if (plain) new Uint8Array(plain).fill(0); }
}
