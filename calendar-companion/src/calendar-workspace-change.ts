import { assertId, createRequest, decode, encode, WINDOW_MS } from "./protocol";
import type { CalendarChangeAction, CalendarChangeStatus } from "./calendar-change";
import { isRecordKind, type RecordKind } from "./record-types";

export const CALENDAR_WORKSPACE_CHANGE_VERSION = 5;
export const MAX_CALENDAR_WORKSPACE_CHANGE_OPERATIONS = 12;
export const MAX_CALENDAR_WORKSPACE_CHANGE_REFERENCES = 12;
const MAX_PROPOSAL_BYTES = 1024 * 1024;
export const MAX_CALENDAR_WORKSPACE_CHANGE_TRANSFER_BYTES = 2 * 1024 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const digestPattern = /^[a-f0-9]{64}$/;
const codePattern = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const statuses = new Set<string>(["applied", "cancelled", "conflict", "not_found", "undone", "rejected"]);

export type CalendarWorkspaceChangeAction = CalendarChangeAction;
export type CalendarWorkspaceChangeStatus = CalendarChangeStatus;

export interface CalendarWorkspaceChangeReference {
  readonly kind: RecordKind;
  readonly id: string;
  readonly revision: number;
}

export interface CalendarWorkspaceOperation {
  readonly opId: string;
  readonly kind: string;
  readonly action: string;
  readonly target: Readonly<{ id: string; revision: number }> | null;
  readonly values: Readonly<Record<string, unknown>> | null;
  readonly references?: readonly CalendarWorkspaceChangeReference[];
}

/** The catalog owns allowed kinds, actions and values. The wire owns identity and encoding. */
export type CalendarWorkspaceChangeValidator = (operation: CalendarWorkspaceOperation, datasetId: string | null) => CalendarWorkspaceOperation;

export interface CalendarWorkspaceChangeDraft {
  readonly version: 5;
  readonly proposalId: string;
  readonly proposalDigest: string;
  readonly datasetId: string | null;
  readonly operations: readonly CalendarWorkspaceOperation[];
}

export interface CalendarWorkspaceChangeRequest {
  format: "yoofloe.calendar.change.request";
  version: 5;
  requestId: string;
  vault: string;
  vaultId: string;
  nonce: string;
  key: string;
  createdAt: number;
  expiresAt: number;
  action: CalendarWorkspaceChangeAction;
  proposalId: string;
  proposalDigest: string;
  datasetId: string | null;
  iv: string | null;
  ciphertext: string | null;
}

export interface CalendarWorkspaceChangeResult {
  opId: string;
  kind: string;
  id: string;
  revision: number | null;
}

export interface CalendarWorkspaceChangeReply {
  version: 5;
  requestId: string;
  proposalId: string;
  proposalDigest: string;
  datasetId: string;
  status: CalendarWorkspaceChangeStatus;
  results: CalendarWorkspaceChangeResult[];
}

function plainObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw Error("Invalid Calendar workspace change JSON.");
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw Error("Use plain JSON for Calendar workspace changes.");
  return value as Record<string, unknown>;
}

function objectWithKeys(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const record = plainObject(value);
  const keys = Reflect.ownKeys(record);
  if (keys.length !== fields.length || !fields.every(key => Object.hasOwn(record, key)))
    throw Error("This Calendar workspace change format is not supported.");
  for (const key of fields) dataProperty(record, key);
  return record;
}

function dataProperty(value: object, key: string): unknown {
  const field = Object.getOwnPropertyDescriptor(value, key);
  if (!field || !field.enumerable || !Object.hasOwn(field, "value")) throw Error("Use plain JSON fields for Calendar workspace changes.");
  return field.value as unknown;
}

function boundedText(value: unknown, maximum: number): value is string {
  if (typeof value !== "string" || !value.length || value.length > maximum || encoder.encode(value).length > maximum) return false;
  for (const char of value) {
    const point = char.codePointAt(0)!;
    if (point < 32 || point === 127 || point >= 0xd800 && point <= 0xdfff) return false;
  }
  return true;
}

function code(value: unknown): value is string {
  return typeof value === "string" && codePattern.test(value);
}

function revision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

interface JsonBudget { nodes: number; units: number }
const jsonBudget = (): JsonBudget => ({ nodes: 20000, units: MAX_PROPOSAL_BYTES });

function countText(value: string, budget: JsonBudget): void {
  budget.units -= value.length;
  if (budget.units < 0) throw Error("This Calendar workspace proposal is too large.");
}

/** Snapshot JSON without invoking getters or serializers, then sort all object keys. */
function canonicalJson(value: unknown, budget: JsonBudget, depth = 0): unknown {
  if (--budget.nodes < 0 || depth > 16) throw Error("This Calendar workspace proposal has too many nested values.");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") { countText(value, budget); return value; }
  if (typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return value === 0 ? 0 : value;
  if (Array.isArray(value)) {
    if (value.length > budget.nodes || Reflect.ownKeys(value).length !== value.length + 1)
      throw Error("Invalid Calendar workspace change list.");
    const items: unknown[] = [];
    for (let i = 0; i < value.length; i++) items.push(canonicalJson(dataProperty(value, String(i)), budget, depth + 1));
    return Object.freeze(items);
  }
  const record = plainObject(value);
  const keys = Reflect.ownKeys(record);
  if (keys.length > budget.nodes || keys.some(key => typeof key !== "string"))
    throw Error("Invalid Calendar workspace change fields.");
  return Object.freeze(Object.fromEntries((keys as string[]).sort().map(key => {
    countText(key, budget);
    return [key, canonicalJson(dataProperty(record, key), budget, depth + 1)];
  })));
}

function ordered(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}

function readReferences(
  value: unknown, datasetId: string | null, operationKind: string, target: CalendarWorkspaceOperation["target"], budget: JsonBudget,
): readonly CalendarWorkspaceChangeReference[] {
  if (!Array.isArray(value) || value.length > MAX_CALENDAR_WORKSPACE_CHANGE_REFERENCES || Reflect.ownKeys(value).length !== value.length + 1)
    throw Error("A Calendar change can reference up to 12 other records.");
  if (value.length && datasetId === null) throw Error("Look up the related Calendar records first.");
  const seen = new Set<string>(), references: CalendarWorkspaceChangeReference[] = [];
  for (let i = 0; i < value.length; i++) {
    const { kind, id, revision: reviewedRevision } = objectWithKeys(dataProperty(value, String(i)), ["kind", "id", "revision"]);
    if (!isRecordKind(kind) || !boundedText(id, 1000) || !revision(reviewedRevision) || kind === operationKind && id === target?.id)
      throw Error("This Calendar change needs a valid related record identity and revision.");
    const key = kind + ":" + id;
    if (seen.has(key)) throw Error("A Calendar change contains a duplicate related record.");
    seen.add(key);
    countText(id, budget);
    references.push(Object.freeze({ kind, id, revision: reviewedRevision }));
  }
  references.sort((first, second) => ordered(first.kind, second.kind) || ordered(first.id, second.id));
  return Object.freeze(references);
}

function readOperation(value: unknown, datasetId: string | null, budget: JsonBudget): CalendarWorkspaceOperation {
  const fields = ["opId", "kind", "action", "target", "values"];
  if (Object.hasOwn(plainObject(value), "references")) fields.push("references");
  const { opId, kind, action, target: rawTarget, values: rawValues, references: rawReferences } = objectWithKeys(value, fields);
  assertId(opId);
  if (!code(kind) || !code(action)) throw Error("Invalid Calendar workspace change code.");
  let target: CalendarWorkspaceOperation["target"] = null;
  if (rawTarget !== null) {
    if (datasetId === null) throw Error("Read the current Calendar records before proposing changes to an existing record.");
    const { id, revision: valueRevision } = objectWithKeys(rawTarget, ["id", "revision"]);
    if (!boundedText(id, 1000) || !revision(valueRevision)) throw Error("This Calendar workspace change needs a valid record identity and revision.");
    target = Object.freeze({ id, revision: valueRevision });
  }
  const values = rawValues === null ? null : plainObject(canonicalJson(plainObject(rawValues), budget));
  const references = fields.length === 6 ? readReferences(rawReferences, datasetId, kind, target, budget) : undefined;
  return Object.freeze({ opId, kind, action, target, values, ...(references?.length ? { references } : {}) });
}

export function validateCalendarWorkspaceChangeOperations(
  operations: unknown, datasetId: string | null, validate: CalendarWorkspaceChangeValidator,
): readonly CalendarWorkspaceOperation[] {
  if (datasetId !== null) assertId(datasetId);
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > MAX_CALENDAR_WORKSPACE_CHANGE_OPERATIONS)
    throw Error("A Calendar workspace proposal must contain 1 to 12 changes.");
  const incoming = jsonBudget(), outgoing = jsonBudget();
  const ids = new Set<string>(), targets = new Set<string>();
  const result: CalendarWorkspaceOperation[] = [];
  for (let i = 0; i < operations.length; i++) {
    const input = readOperation(dataProperty(operations, String(i)), datasetId, incoming);
    const checked = validate(input, datasetId);
    const operation = checked === input ? input : readOperation(checked, datasetId, outgoing);
    if (input.opId !== operation.opId || input.kind !== operation.kind || input.action !== operation.action ||
        input.target?.id !== operation.target?.id || input.target?.revision !== operation.target?.revision ||
        JSON.stringify(input.references) !== JSON.stringify(operation.references))
      throw Error("The Calendar catalog changed the identity of a proposed operation.");
    if (ids.has(operation.opId)) throw Error("A Calendar proposal contains a duplicate change identity.");
    ids.add(operation.opId);
    if (operation.target) {
      const identity = JSON.stringify([operation.kind, operation.target.id]);
      if (targets.has(identity)) throw Error("A Calendar proposal can change each existing record only once.");
      targets.add(identity);
    }
    result.push(operation);
  }
  return Object.freeze(result);
}

function proposalBytes(operations: readonly CalendarWorkspaceOperation[]): Uint8Array<ArrayBuffer> {
  const bytes = encoder.encode(JSON.stringify({ operations }));
  if (bytes.length > MAX_PROPOSAL_BYTES) throw Error("This Calendar workspace proposal is too large.");
  return bytes;
}

async function proposalHash(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const sha = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(sha, byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function createCalendarWorkspaceChangeDraft(
  operations: unknown, datasetId: string | null, validate: CalendarWorkspaceChangeValidator,
): Promise<CalendarWorkspaceChangeDraft> {
  const canonical = validateCalendarWorkspaceChangeOperations(operations, datasetId, validate);
  const proposalId = crypto.randomUUID();
  assertId(proposalId);
  const plain = proposalBytes(canonical);
  try {
    return Object.freeze({ version: 5, proposalId, proposalDigest: await proposalHash(plain), datasetId, operations: canonical });
  } finally { plain.fill(0); }
}

/** Revalidate a persisted v5 draft without storing or reopening any transport key. */
export async function readCalendarWorkspaceChangeDraft(saved: unknown, validate: CalendarWorkspaceChangeValidator): Promise<CalendarWorkspaceChangeDraft> {
  const { version, proposalId, proposalDigest, datasetId, operations } = objectWithKeys(saved, ["version", "proposalId", "proposalDigest", "datasetId", "operations"]);
  if (version !== 5) throw Error("This saved draft belongs to an earlier Calendar change protocol.");
  assertId(proposalId);
  if (datasetId !== null) assertId(datasetId);
  if (typeof proposalDigest !== "string" || !digestPattern.test(proposalDigest)) throw Error("Invalid Calendar proposal digest.");
  const canonical = validateCalendarWorkspaceChangeOperations(operations, datasetId, validate);
  const plain = proposalBytes(canonical);
  try {
    if (await proposalHash(plain) !== proposalDigest) throw Error("The saved Calendar workspace proposal changed.");
    return Object.freeze({ version: 5, proposalId, proposalDigest, datasetId, operations: canonical });
  } finally { plain.fill(0); }
}

export function assertLiveCalendarWorkspaceChange(request: CalendarWorkspaceChangeRequest, now = Date.now()): void {
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(request.createdAt) || !Number.isSafeInteger(request.expiresAt) ||
      request.createdAt < 0 || request.expiresAt <= request.createdAt || request.expiresAt - request.createdAt > WINDOW_MS ||
      now < request.createdAt - 60000 || now > request.expiresAt)
    throw Error("This Calendar change request expired. Check its status before retrying.");
}

export function calendarWorkspaceChangeAad(request: CalendarWorkspaceChangeRequest, direction: "request" | "reply"): Uint8Array<ArrayBuffer> {
  return encoder.encode(`yoofloe-calendar-change/v5|${direction}|${request.action}|${request.requestId}|${request.vault}|${request.vaultId}|${request.nonce}|${request.proposalId}|${request.proposalDigest}|${request.datasetId ?? ""}`);
}

type WorkspaceChangeRequestOptions = { vaultName: string; vaultId: string; action?: CalendarWorkspaceChangeAction; datasetId?: string | null; now?: number };

export async function prepareCalendarWorkspaceChangeRequest(
  draft: CalendarWorkspaceChangeDraft,
  options: WorkspaceChangeRequestOptions,
  validate: CalendarWorkspaceChangeValidator,
): Promise<{ draft: CalendarWorkspaceChangeDraft; request: CalendarWorkspaceChangeRequest }> {
  const prepared = await readCalendarWorkspaceChangeDraft(draft, validate);
  const { vaultName, vaultId, action = "review", now = Date.now() } = options;
  assertId(vaultId);
  if (action !== "review" && action !== "status" && action !== "undo") throw Error("Invalid Calendar workspace change request action.");
  const datasetId = options.datasetId === undefined ? prepared.datasetId : options.datasetId;
  if (datasetId !== null) assertId(datasetId);
  if (action === "review" && datasetId === null) throw Error("Connect to the Calendar dataset before reviewing changes.");
  if ((action === "review" || prepared.datasetId !== null) && datasetId !== prepared.datasetId)
    throw Error("The Calendar dataset does not match this proposal.");
  if (action === "undo" && datasetId === null) throw Error("Check which Calendar dataset applied this proposal before undoing it.");
  const base = createRequest(vaultName, now);
  const request: CalendarWorkspaceChangeRequest = {
    format: "yoofloe.calendar.change.request", version: 5, requestId: base.requestId, vault: base.vault,
    vaultId, nonce: base.nonce, key: base.key, createdAt: base.createdAt, expiresAt: base.expiresAt, action,
    proposalId: prepared.proposalId, proposalDigest: prepared.proposalDigest, datasetId, iv: null, ciphertext: null,
  };
  assertLiveCalendarWorkspaceChange(request, now);
  if (action === "review") {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = proposalBytes(prepared.operations);
    const keyBytes = decode(request.key, 32);
    try {
      const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
      const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: calendarWorkspaceChangeAad(request, "request") }, key, plain);
      request.iv = encode(iv);
      request.ciphertext = encode(new Uint8Array(cipher));
    } finally { plain.fill(0); keyBytes.fill(0); }
  }
  return { draft: prepared, request };
}

export async function createCalendarWorkspaceChangeRequest(
  draft: CalendarWorkspaceChangeDraft, options: WorkspaceChangeRequestOptions, validate: CalendarWorkspaceChangeValidator,
): Promise<CalendarWorkspaceChangeRequest> {
  return (await prepareCalendarWorkspaceChangeRequest(draft, options, validate)).request;
}

export function calendarWorkspaceChangeLaunchUrl(request: CalendarWorkspaceChangeRequest, inboxHint?: string): string {
  assertId(request.requestId);
  assertId(request.vaultId);
  decode(request.vault, 256);
  const hint = boundedText(inboxHint, 1024) ? `&inbox=${encode(encoder.encode(inboxHint))}` : "";
  return `yoofloe-calendar://obsidian/change?version=5&requestId=${request.requestId}&vault=${request.vault}&vaultId=${request.vaultId}${hint}`;
}

function validateReply(value: unknown, request: CalendarWorkspaceChangeRequest, draft: CalendarWorkspaceChangeDraft): CalendarWorkspaceChangeReply {
  const reply = objectWithKeys(value, ["version", "requestId", "proposalId", "proposalDigest", "datasetId", "status", "results"]);
  const { datasetId, status, results } = reply;
  if (reply.version !== 5 || reply.requestId !== request.requestId || reply.proposalId !== request.proposalId ||
      reply.proposalDigest !== request.proposalDigest || draft.version !== 5 ||
      draft.proposalId !== request.proposalId || draft.proposalDigest !== request.proposalDigest)
    throw Error("This Calendar reply belongs to a different workspace proposal.");
  assertId(datasetId);
  if (typeof status !== "string" || !statuses.has(status)) throw Error("Invalid Calendar change status.");
  const successful = status === "applied" || status === "undone";
  if (successful && request.datasetId !== null && datasetId !== request.datasetId)
    throw Error("This reply belongs to a different Calendar dataset.");
  if (!Array.isArray(results) || results.length !== (successful ? draft.operations.length : 0)) throw Error("Invalid Calendar workspace change results.");
  const expected = new Map(draft.operations.map(op => [op.opId, op]));
  const ids = new Set<string>();
  for (const raw of results as unknown[]) {
    const { opId, kind, id, revision: resultRevision } = objectWithKeys(raw, ["opId", "kind", "id", "revision"]);
    assertId(opId);
    const operation = expected.get(opId);
    if (!operation || kind !== operation.kind || !boundedText(id, 1000) || operation.target && id !== operation.target.id ||
        resultRevision !== null && !revision(resultRevision))
      throw Error("The Calendar result does not match its proposed workspace change.");
    const identity = JSON.stringify([operation.kind, id]);
    if (ids.has(identity)) throw Error("The Calendar reply contains duplicate result identities.");
    ids.add(identity);
    expected.delete(opId);
  }
  return reply as unknown as CalendarWorkspaceChangeReply;
}

export async function openCalendarWorkspaceChangeReply(
  raw: string, request: CalendarWorkspaceChangeRequest, draft: CalendarWorkspaceChangeDraft, now = Date.now(),
): Promise<CalendarWorkspaceChangeReply> {
  assertLiveCalendarWorkspaceChange(request, now);
  if (raw.length > MAX_CALENDAR_WORKSPACE_CHANGE_TRANSFER_BYTES || encoder.encode(raw).length > MAX_CALENDAR_WORKSPACE_CHANGE_TRANSFER_BYTES)
    throw Error("This Calendar workspace reply is too large.");
  let envelope: unknown;
  try { envelope = JSON.parse(raw); } catch { throw Error("This Calendar workspace reply is incomplete or invalid."); }
  const { format, version, requestId, iv: rawIv, ciphertext } = objectWithKeys(envelope, ["format", "version", "requestId", "iv", "ciphertext"]);
  if (format !== "yoofloe.calendar.change.reply" || version !== 5 || requestId !== request.requestId)
    throw Error("No matching Calendar workspace reply.");
  const keyBytes = decode(request.key, 32);
  let plain: ArrayBuffer | null = null;
  try {
    const iv = decode(rawIv, 12), cipher = decode(ciphertext, MAX_PROPOSAL_BYTES + 16);
    if (keyBytes.length !== 32 || iv.length !== 12 || cipher.length < 17) throw Error("Invalid Calendar transfer encryption.");
    const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: calendarWorkspaceChangeAad(request, "reply") }, key, cipher);
    let value: unknown;
    try { value = JSON.parse(decoder.decode(plain)); } catch { throw Error("The Calendar workspace reply could not be read."); }
    return validateReply(value, request, draft);
  } catch (error) {
    if (error instanceof Error && error.name === "OperationError") throw Error("The Calendar workspace reply could not be authenticated.");
    throw error;
  } finally { keyBytes.fill(0); if (plain) new Uint8Array(plain).fill(0); }
}
