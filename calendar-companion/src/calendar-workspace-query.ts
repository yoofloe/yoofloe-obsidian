
import { createRequest, decode, encode, assertId, shape, type RecordSnapshot } from "./protocol";
import { QUERY_REPLY_BYTES, civilDate, validZone, validateQuestionContext, validateQuestionQuery, type QuestionContext, type QuestionQuery } from "./question-query";
import { isRecordKind, type RecordKind } from "./record-types";

export const WORKSPACE_VERSION = 5;
export type WorkspaceFolderKind = "note_folder" | "study_folder" | "project_folder" | "task";
export interface WorkspaceFilters {
  folders: { kind: WorkspaceFolderKind; id: string }[];
  projects: string[];
  includeTrash: boolean;
  includeArchive: boolean;
  includeFinancials: boolean;
  includeAttachmentMetadata: boolean;
}
export interface WorkspaceQuery {
  mode: "capabilities" | "records";
  lookup: QuestionQuery | null;
  kinds: RecordKind[];
  filters: WorkspaceFilters;
}
export interface WorkspaceCapabilities {
  readKinds: RecordKind[];
  writeKinds: { kind: RecordKind; actions: string[] }[];
}
export interface WorkspaceOccurrence {
  originalStart: string;
  timeBasis: "DATE" | "UTC" | "ZONED";
  timezone?: string;
  originalOffset?: string;
}
export interface WorkspaceRecordDetails {
  intervals?: { startAt: string; endAt: string }[];
  occurrences?: WorkspaceOccurrence[];
  origin?: WorkspaceOccurrence & { seriesId: string; seriesRevision: number };
  status?: string;
  completed?: boolean;
  taskFolder?: boolean;
  pinned?: boolean;
  dueDate?: string;
  startDate?: string;
  targetDate?: string;
  recordedSeconds?: number;
  scheduledSeconds?: number;
  currency?: string;
  gross?: string;
  net?: string;
  netKind?: string;
  amount?: string;
  fromCurrency?: string;
  toCurrency?: string;
  rate?: string;
  tags?: string[];
  attachmentCount?: number;
  mediaType?: string;
  byteLength?: number;
}
export interface WorkspaceRecord extends RecordSnapshot {
  state: "active" | "archived" | "trashed";
  details: WorkspaceRecordDetails;
}
export interface WorkspaceLookupDelivery {
  version: 5;
  requestId: string;
  datasetId: string;
  exportedAt: number;
  query: WorkspaceQuery;
  context: QuestionContext | null;
  records: WorkspaceRecord[];
  capabilities: WorkspaceCapabilities;
}
export type WorkspaceQueryRequest = Omit<ReturnType<typeof createRequest>, "version"> & {
  version: 5; vaultId: string; query: WorkspaceQuery;
};
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const folders = new Set(["note_folder", "study_folder", "project_folder", "task"]);
const financialKinds = new Set(["project_income", "project_expense", "project_rate"]);
const financialDetails: Record<string,string[]> = {
  project_income: ["currency", "gross", "net", "netKind"],
  project_expense: ["currency", "amount"],
  project_rate: ["fromCurrency", "toCurrency", "rate"],
};
const actionNames = new Set(["create", "update", "delete", "restore", "move", "archive", "unarchive", "link", "unlink"]);
const offsetTime = /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,9})?)?(?:Z|[+-]\d\d:\d\d)$/;
const decimal = /^-?(?:0|[1-9]\d{0,36})(?:\.\d{0,23}[1-9])?$/;
const isDecimal = (value: string) => decimal.test(value) && value !== "-0";
const dateKeys = new Set(["dueDate", "startDate", "targetDate"]);
const numberKeys = new Set(["recordedSeconds", "scheduledSeconds", "attachmentCount", "byteLength"]);

const bytes = (s: string) => encoder.encode(s).length;
function text(value: unknown, maximum: number, empty = false): value is string {
  return typeof value === "string" && (empty || value.length > 0) && bytes(value) <= maximum && !value.includes("\0");
}
function idList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 12 || new Set(value).size !== value.length) throw Error("Choose up to 12 different projects.");
  const ids: string[] = [];
  for (const id of value as unknown[]) { assertId(id); ids.push(id); }
  return ids;
}
function kindList(value: unknown): RecordKind[] {
  if (!Array.isArray(value) || value.length > 40 || new Set(value).size !== value.length || !value.every(isRecordKind))
    throw Error("This Calendar record selection is invalid.");
  return [...value] as RecordKind[];
}
function areaOf(kind: RecordKind): QuestionQuery["areas"][number] {
  if (kind.startsWith("study_")) return "study";
  if (kind === "project" || kind.startsWith("project_")) return "project";
  if (kind.startsWith("note") || kind === "asset") return "notes";
  if (kind.startsWith("flow_")) return "flow";
  if (kind === "focus_session" || kind.startsWith("garden_") || kind === "focus_context") return "garden";
  return "calendar";
}
export function workspaceKindAllowed(query: WorkspaceQuery, kind: RecordKind): boolean {
  if (!query.lookup || !query.kinds.includes(kind)) return false;
  if (kind === "asset" && !query.filters.includeAttachmentMetadata) return false;
  if (financialKinds.has(kind) && !query.filters.includeFinancials) return false;
  return query.lookup.areas.includes(areaOf(kind)) || kind === "note" && query.lookup.includeLinkedNotes;
}
export function emptyWorkspaceFilters(): WorkspaceFilters {
  return { folders: [], projects: [], includeTrash: false, includeArchive: false, includeFinancials: false, includeAttachmentMetadata: false };
}
export function validateWorkspaceQuery(value: unknown): WorkspaceQuery {
  shape(value, ["mode", "lookup", "kinds", "filters"]);
  const { mode, filters } = value;
  if (mode !== "records" && mode !== "capabilities") throw Error("This Calendar request mode is unsupported.");
  shape(filters, ["folders", "projects", "includeTrash", "includeArchive", "includeFinancials", "includeAttachmentMetadata"]);
  if (typeof filters.includeTrash !== "boolean" || typeof filters.includeArchive !== "boolean" ||
      typeof filters.includeFinancials !== "boolean" || typeof filters.includeAttachmentMetadata !== "boolean" ||
      !Array.isArray(filters.folders) || filters.folders.length > 12) throw Error("The Calendar search filters are invalid.");
  const refs: WorkspaceFilters["folders"] = [];
  const seen = new Set<string>();
  for (const ref of filters.folders as unknown[]) {
    shape(ref, ["kind", "id"]);
    if (typeof ref.kind !== "string" || !folders.has(ref.kind)) throw Error("This Calendar folder type is not supported.");
    assertId(ref.id);
    const key = ref.kind + ":" + ref.id;
    if (seen.has(key)) throw Error("Choose each Calendar folder once.");
    refs.push({ kind: ref.kind as WorkspaceFolderKind, id: ref.id });
    seen.add(key);
  }
  const query: WorkspaceQuery = {
    mode, lookup: value.lookup === null ? null : validateQuestionQuery(value.lookup),
    kinds: kindList(value.kinds),
    filters: { folders: refs, projects: idList(filters.projects), includeTrash: filters.includeTrash,
      includeArchive: filters.includeArchive, includeFinancials: filters.includeFinancials,
      includeAttachmentMetadata: filters.includeAttachmentMetadata },
  };
  if (mode === "capabilities") {
    if (query.lookup || query.kinds.length || refs.length || query.filters.projects.length ||
        query.filters.includeTrash || query.filters.includeArchive || query.filters.includeFinancials || query.filters.includeAttachmentMetadata)
      throw Error("A capabilities check cannot request workspace records.");
  } else {
    if (!query.lookup || !query.kinds.length || !query.kinds.every(kind => workspaceKindAllowed(query, kind)))
      throw Error("Choose Calendar record types in the selected workspace and scope.");
    const { lookup } = query;
    if (query.filters.projects.length && !lookup.areas.includes("project") ||
        refs.some(ref => !lookup.areas.includes(areaOf(ref.kind)) && !(ref.kind === "note_folder" && lookup.includeLinkedNotes && query.kinds.includes("note"))))
      throw Error("Remove folder or project filters outside the selected workspaces.");
  }
  return query;
}
export function createWorkspaceQueryRequest(vaultName: string, vaultId: string, value: WorkspaceQuery, now = Date.now()): WorkspaceQueryRequest {
  assertId(vaultId);
  return { ...createRequest(vaultName, now), version: WORKSPACE_VERSION, vaultId, query: validateWorkspaceQuery(value) };
}
export function workspaceQueryAad(request: WorkspaceQueryRequest): Uint8Array<ArrayBuffer> {
  return encoder.encode("yoofloe-calendar-companion/v5|" + request.requestId + "|" + request.vault + "|" + request.vaultId + "|" + request.nonce);
}
export function workspaceQueryLaunchUrl(request: WorkspaceQueryRequest, inboxHint?: string): string {
  assertId(request.requestId);
  assertId(request.vaultId);
  decode(request.vault, 256);
  const hint = typeof inboxHint === "string" && inboxHint && bytes(inboxHint) <= 1024 ? "&inbox=" + encode(encoder.encode(inboxHint)) : "";
  return "yoofloe-calendar://obsidian/connect?version=5&requestId=" + request.requestId + "&vault=" + request.vault +
    "&vaultId=" + request.vaultId + hint;
}
function validTime(value: unknown): value is string {
  return typeof value === "string" && offsetTime.test(value) && civilDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
}
function calendarOccurrence(value: unknown): boolean {
  if (!jsonRecord(value) || Object.keys(value).some(key => !["originalStart", "timeBasis", "timezone", "originalOffset"].includes(key))) return false;
  const { originalStart, timeBasis, timezone, originalOffset } = value;
  if (timeBasis === "DATE") return civilDate(originalStart) && timezone === undefined && originalOffset === undefined;
  if (timeBasis === "UTC") return validTime(originalStart) && originalStart.endsWith("Z") && timezone === undefined && originalOffset === undefined;
  return timeBasis === "ZONED" && typeof originalStart === "string" && originalStart.length <= 48 &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,9})?)?$/.test(originalStart) &&
    typeof originalOffset === "string" && /^(?:Z|[+-](?:0\d|1[0-8]):[0-5]\d)$/.test(originalOffset) &&
    validZone(timezone) && validTime(originalStart + originalOffset);
}
function jsonRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function recordDetails(value: unknown, kind: RecordKind, attachment: boolean): WorkspaceRecordDetails {
  if (!jsonRecord(value)) throw Error("Calendar record details are invalid.");
  for (const [key, raw] of Object.entries(value)) {
    let valid = false;
    if (key === "intervals" && (kind === "event" || kind === "study_lecture")) {
      valid = Array.isArray(raw) && raw.length <= 32 && raw.every((entry: unknown) => {
        shape(entry, ["startAt", "endAt"]);
        return validTime(entry.startAt) && validTime(entry.endAt) && Date.parse(entry.startAt) < Date.parse(entry.endAt);
      });
    } else if (key === "occurrences" && kind === "event") {
      valid = Array.isArray(raw) && Array.isArray(value.intervals) && raw.length === value.intervals.length &&
        raw.length <= 32 && raw.every(calendarOccurrence);
    } else if (key === "origin" && kind === "event" && jsonRecord(raw)) {
      const { seriesId, seriesRevision, ...original } = raw;
      assertId(seriesId);
      valid = typeof seriesRevision === "number" && Number.isSafeInteger(seriesRevision) && seriesRevision > 0 && calendarOccurrence(original);
    } else if (key === "status") valid = typeof raw === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(raw);
    else if (key === "taskFolder") valid = kind === "task" && typeof raw === "boolean";
    else if (key === "completed" || key === "pinned") valid = typeof raw === "boolean";
    else if (dateKeys.has(key)) valid = civilDate(raw);
    else if (numberKeys.has(key)) {
      valid = typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 &&
        (key === "recordedSeconds" ? kind === "study_session" || kind === "focus_session" :
          key === "scheduledSeconds" ? kind === "study_lecture" || kind === "study_plan" :
          key === "byteLength" ? attachment && kind === "asset" : attachment);
    } else if (financialDetails[kind]?.includes(key)) {
      valid = typeof raw === "string" && (key.endsWith("urrency") ? /^[A-Z]{3}$/.test(raw) :
        key === "netKind" ? ["actual", "estimated", "ACTUAL", "ESTIMATED"].includes(raw) : isDecimal(raw));
    } else if (key === "tags") valid = Array.isArray(raw) && raw.length <= 32 && raw.every(tag => text(tag, 240, true));
    else if (key === "mediaType") valid = attachment && kind === "asset" && text(raw, 128) && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(raw);
    if (!valid) throw Error("Calendar returned an unsupported record detail.");
  }
  const details = value as WorkspaceRecordDetails;
  return details.netKind ? { ...details, netKind: details.netKind.toUpperCase() } : details;
}
function readCapabilities(value: unknown): WorkspaceCapabilities {
  shape(value, ["readKinds", "writeKinds"]);
  const readKinds = kindList(value.readKinds);
  const writeKinds: WorkspaceCapabilities["writeKinds"] = [];
  if (!Array.isArray(value.writeKinds) || value.writeKinds.length > 40) throw Error("Calendar capabilities are invalid.");
  const used = new Set<string>();
  for (const entry of value.writeKinds as unknown[]) {
    shape(entry, ["kind", "actions"]);
    if (!isRecordKind(entry.kind) || used.has(entry.kind) || !Array.isArray(entry.actions) || !entry.actions.length ||
        entry.actions.length > actionNames.size || new Set(entry.actions).size !== entry.actions.length ||
        entry.actions.some(action => typeof action !== "string" || !actionNames.has(action)))
      throw Error("Calendar returned an unsupported change capability.");
    used.add(entry.kind);
    writeKinds.push({ kind: entry.kind, actions: (entry.actions as string[]).slice() });
  }
  return { readKinds, writeKinds };
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!jsonRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
function sameQuery(a: WorkspaceQuery, b: WorkspaceQuery): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
export function validateWorkspaceLookup(value: unknown, request: WorkspaceQueryRequest, now = Date.now(), manualTransfer = false): WorkspaceLookupDelivery {
  shape(value, ["version", "requestId", "datasetId", "exportedAt", "query", "context", "records", "capabilities"]);
  const { datasetId, exportedAt, records } = value;
  // A manual reply can come from another device clock. It still has to fit this request window.
  assertId(datasetId);
  if (value.version !== 5 || value.requestId !== request.requestId || typeof exportedAt !== "number" || !Number.isSafeInteger(exportedAt) ||
      exportedAt < request.createdAt - 60000 || exportedAt > request.expiresAt || !manualTransfer && exportedAt > now + 60000)
    throw Error("This Calendar reply belongs to a different request.");
  const query = validateWorkspaceQuery(value.query);
  if (!sameQuery(query, request.query)) throw Error("The Calendar reply changed the selected scope.");
  const lookup = query.lookup;
  if (!Array.isArray(records) || records.length > (lookup?.maxRecords ?? 0)) throw Error("Calendar returned too many records.");
  const context = lookup ? validateQuestionContext(value.context, lookup, records.length, request.createdAt) : null;
  if (!lookup && value.context !== null) throw Error("The capabilities reply contains workspace context.");
  const capabilities = readCapabilities(value.capabilities);
  const result: WorkspaceRecord[] = [];
  const seen = new Set<string>();
  let usedBytes = 0;
  for (const record of records as unknown[]) {
    shape(record, ["id", "kind", "sourceId", "revision", "title", "text", "date", "state", "details"]);
    const { id, kind, sourceId, revision, title, text: excerpt, date, state } = record;
    if (!isRecordKind(kind) || !workspaceKindAllowed(query, kind) || !capabilities.readKinds.includes(kind) ||
        !text(id, 1000) || !text(sourceId, 1000) || seen.has(kind + ":" + sourceId) || !text(title, 2048, true) ||
        !text(excerpt, 32768, true) || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1 ||
        date !== null && !civilDate(date) || state !== "active" && state !== "archived" && state !== "trashed" ||
        state === "archived" && !query.filters.includeArchive || state === "trashed" && !query.filters.includeTrash)
      throw Error("Calendar returned a record outside the selected scope.");
    seen.add(kind + ":" + sourceId);
    usedBytes += bytes(excerpt);
    const details = recordDetails(record.details, kind, query.filters.includeAttachmentMetadata);
    if (details.origin && (details.origin.seriesId === sourceId || details.occurrences)) throw Error("Calendar returned an invalid detached occurrence.");
    result.push({ id, kind, sourceId, revision, title, text: excerpt, date, state, details });
  }
  if (usedBytes > (lookup?.maxTextBytes ?? 0)) throw Error("The Calendar reply exceeds the excerpt budget.");
  return { version: WORKSPACE_VERSION, requestId: request.requestId, datasetId, exportedAt, query, context, records: result, capabilities };
}
export async function openWorkspaceLookupReply(raw: string, request: WorkspaceQueryRequest, now = Date.now(), manualTransfer = false): Promise<WorkspaceLookupDelivery> {
  if (!Number.isSafeInteger(now) || now > request.expiresAt || now < request.createdAt - 60000 || bytes(raw) > QUERY_REPLY_BYTES)
    throw Error("This Calendar request expired or its reply exceeds the size limit.");
  const reply: unknown = JSON.parse(raw);
  shape(reply, ["format", "version", "requestId", "iv", "ciphertext"]);
  if (reply.format !== "yoofloe.calendar.reply" || reply.version !== WORKSPACE_VERSION || reply.requestId !== request.requestId)
    throw Error("The Calendar reply does not match this request.");
  const key = decode(request.key, 32), iv = decode(reply.iv, 12), ciphertext = decode(reply.ciphertext, QUERY_REPLY_BYTES);
  try {
    if (key.length !== 32 || iv.length !== 12 || ciphertext.length < 16) throw Error("The Calendar reply is incomplete.");
    const imported = await crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, ["decrypt"]);
    const clear = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: workspaceQueryAad(request) }, imported, ciphertext));
    try { return validateWorkspaceLookup(JSON.parse(decoder.decode(clear)), request, now, manualTransfer); }
    finally { clear.fill(0); }
  } finally { key.fill(0); }
}
