import { assertId, createRequest, decode, encode, shape, WINDOW_MS } from "./protocol";
import { civilDate, validZone } from "./question-query";

export const CHRONOHUD_VERSION = 1;
export const CHRONOHUD_INBOX = "ChronoHUD Inbox";
export const CHRONOHUD_ACTION = "yoofloe-chronohud-context";
export const CHRONOHUD_AREAS = Object.freeze(["dashboard", "timeline", "mandalart", "matrix"] as const);
export const CHRONOHUD_MAX_TERMS = 8;
export const CHRONOHUD_TERM_BYTES = 80;
export const CHRONOHUD_MAX_RECORDS = 20;
export const CHRONOHUD_MAX_TEXT_BYTES = 32768;
export const CHRONOHUD_REPLY_BYTES = 256 * 1024;

const REQUEST_FORMAT = "yoofloe.chronohud.request";
const REPLY_FORMAT = "yoofloe.chronohud.reply";
const TITLE_BYTES = 2048;
const CLOCK_SKEW_MS = 60_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export type ChronoHudArea = typeof CHRONOHUD_AREAS[number];
export interface ChronoHudQuery {
  readonly areas: readonly ChronoHudArea[];
  readonly terms: readonly string[];
  readonly maxRecords: number;
  readonly maxTextBytes: number;
}
export interface ChronoHudContext {
  readonly zone: string;
  readonly scanned: number;
  readonly matched: number;
  readonly partial: boolean;
}
export interface ChronoHudRecord {
  readonly area: ChronoHudArea;
  readonly title: string;
  readonly text: string;
  readonly date: string | null;
}
export interface ChronoHudDelivery {
  readonly version: typeof CHRONOHUD_VERSION;
  readonly requestId: string;
  readonly exportedAt: number;
  readonly query: ChronoHudQuery;
  readonly context: ChronoHudContext;
  readonly records: readonly ChronoHudRecord[];
}
export interface ChronoHudRequest {
  readonly format: typeof REQUEST_FORMAT;
  readonly version: typeof CHRONOHUD_VERSION;
  readonly requestId: string;
  readonly vault: string;
  readonly vaultId: string;
  readonly nonce: string;
  key: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly query: ChronoHudQuery;
}

const bytes = (value: string): number => encoder.encode(value).byteLength;
function isArea(value: unknown): value is ChronoHudArea {
  return typeof value === "string" && CHRONOHUD_AREAS.includes(value as ChronoHudArea);
}
function intInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
function exactShape(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
  shape(value, fields);
  // Each expected key must exist individually.
  if (!fields.every(key => Object.hasOwn(value, key))) throw Error("This ChronoHUD transfer format is not supported.");
}
function plainText(value: unknown, maximum: number, multiline = false): value is string {
  if (typeof value !== "string" || value.length > maximum || bytes(value) > maximum) return false;
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code < 32 && !(multiline && (code === 9 || code === 10 || code === 13)) ||
        code >= 127 && code <= 159 || code >= 0xd800 && code <= 0xdfff) return false;
  }
  return true;
}
function normalizedTerm(term: string): string {
  return term.trim().toLowerCase().normalize("NFC");
}

/** Convert a user-entered comma or newline separated search into canonical terms. */
export function chronohudSearchTerms(topic: string): string[] {
  return [...new Set(topic.split(/[,\n]/).map(normalizedTerm).filter(Boolean))];
}

/** Source labels follow the native reply order, even when a subset is selected. */
export function chronohudExcerptReference(index: number): string { return "H" + (index + 1); }

/** Validate and snapshot the exact human-selected query. */
export function validateChronoHudQuery(value: unknown): ChronoHudQuery {
  exactShape(value, ["areas", "terms", "maxRecords", "maxTextBytes"]);
  const { areas, terms, maxRecords, maxTextBytes } = value;
  if (!Array.isArray(areas) || !areas.length || areas.length > CHRONOHUD_AREAS.length ||
      !Array.from(areas).every(isArea) || new Set(areas).size !== areas.length)
    throw Error("Choose at least one ChronoHUD area, without duplicates.");
  if (!Array.isArray(terms) || terms.length > CHRONOHUD_MAX_TERMS ||
      !Array.from(terms).every(term => plainText(term, CHRONOHUD_TERM_BYTES) && term.length > 0 && term === normalizedTerm(term)) ||
      new Set(terms).size !== terms.length)
    throw Error("Choose up to eight distinct ChronoHUD search terms of at most 80 UTF-8 bytes each.");
  if (!intInRange(maxRecords, 1, CHRONOHUD_MAX_RECORDS) || !intInRange(maxTextBytes, 1, CHRONOHUD_MAX_TEXT_BYTES))
    throw Error("The ChronoHUD query exceeds its excerpt budget.");
  return Object.freeze({ areas: Object.freeze([...(areas as ChronoHudArea[])]), terms: Object.freeze([...(terms as string[])]),
    maxRecords, maxTextBytes });
}

/** Create an exact v1 marker with the same random ID, key, and nonce primitives as Calendar. */
export function createChronoHudRequest(vaultName: string, vaultId: string, value: ChronoHudQuery, now = Date.now()): ChronoHudRequest {
  assertId(vaultId);
  if (!intInRange(now, 0, Number.MAX_SAFE_INTEGER - WINDOW_MS)) throw Error("The ChronoHUD request time is invalid.");
  const query = validateChronoHudQuery(value);
  const { requestId, vault, nonce, key, createdAt, expiresAt } = createRequest(vaultName, now);
  return { format: REQUEST_FORMAT, version: CHRONOHUD_VERSION, requestId, vault, vaultId, nonce, key, createdAt, expiresAt, query };
}

/** Check freshness using the clock of the original requesting vault. */
export function assertChronoHudRequestLive(request: ChronoHudRequest, now = Date.now()): void {
  if (!intInRange(now, Math.max(0, request.createdAt - CLOCK_SKEW_MS), request.expiresAt) ||
      !intInRange(request.createdAt, 0, Number.MAX_SAFE_INTEGER - WINDOW_MS) || request.expiresAt !== request.createdAt + WINDOW_MS)
    throw Error("This ChronoHUD lookup expired. Start a new connection.");
}

/** Launch metadata contains no key, nonce, terms, or excerpt data. */
export function chronohudLaunchUrl(request: ChronoHudRequest, inboxHint?: string): string {
  assertId(request.requestId);
  assertId(request.vaultId);
  decode(request.vault, 256);
  const hint = typeof inboxHint === "string" && inboxHint && plainText(inboxHint, 1024)
    ? "&inbox=" + encode(encoder.encode(inboxHint)) : "";
  return "chronohud://obsidian/connect?version=" + CHRONOHUD_VERSION + "&requestId=" + request.requestId +
    "&vault=" + request.vault + "&vaultId=" + request.vaultId + hint;
}

/** The native callback only identifies which pending lookup Obsidian should check. */
export function chronohudCallbackUrl(requestId: string): string {
  assertId(requestId);
  return "obsidian://" + CHRONOHUD_ACTION + "?version=" + CHRONOHUD_VERSION + "&requestId=" + requestId;
}

/** Bind ciphertext to the precise request and vault, separate from Calendar's AAD domain. */
export function chronohudAad(request: ChronoHudRequest): Uint8Array<ArrayBuffer> {
  return encoder.encode("yoofloe-chronohud/v1|" + request.requestId + "|" + request.vault + "|" + request.vaultId + "|" + request.nonce);
}

function readDelivery(value: unknown, request: ChronoHudRequest, now: number, manualTransfer: boolean): ChronoHudDelivery {
  exactShape(value, ["version", "requestId", "exportedAt", "query", "context", "records"]);
  const { exportedAt, records, context } = value;
  if (value.version !== CHRONOHUD_VERSION || value.requestId !== request.requestId)
    throw Error("This ChronoHUD reply belongs to a different request.");
  // On Desktop the export clock may differ. It must still fall inside the original request window.
  if (!intInRange(exportedAt, request.createdAt, request.expiresAt) || !manualTransfer && exportedAt > now + CLOCK_SKEW_MS)
    throw Error("The ChronoHUD export time is outside this request window.");
  const query = validateChronoHudQuery(value.query);
  const selected = request.query;
  if (query.maxRecords !== selected.maxRecords || query.maxTextBytes !== selected.maxTextBytes ||
      query.areas.length !== selected.areas.length || query.areas.some((area, index) => area !== selected.areas[index]) ||
      query.terms.length !== selected.terms.length || query.terms.some((term, index) => term !== selected.terms[index]))
    throw Error("The ChronoHUD reply changed the selected scope.");
  if (!Array.isArray(records) || records.length > query.maxRecords) throw Error("The ChronoHUD reply exceeds the record budget.");

  exactShape(context, ["zone", "scanned", "matched", "partial"]);
  const { zone, scanned, matched, partial } = context;
  if (!validZone(zone) || !intInRange(scanned, 0, Number.MAX_SAFE_INTEGER) || !intInRange(matched, records.length, scanned) ||
      typeof partial !== "boolean" || matched > records.length && !partial)
    throw Error("The ChronoHUD search coverage is invalid.");

  let usedBytes = 0;
  const result: ChronoHudRecord[] = [];
  for (const entry of records as unknown[]) {
    exactShape(entry, ["area", "title", "text", "date"]);
    const { area, title, text, date } = entry;
    if (!isArea(area) || !query.areas.includes(area)) throw Error("The ChronoHUD reply includes an area outside the selected scope.");
    if (!plainText(title, TITLE_BYTES) || !plainText(text, query.maxTextBytes, true) || date !== null && !civilDate(date))
      throw Error("A ChronoHUD excerpt is invalid.");
    usedBytes += bytes(text);
    if (usedBytes > query.maxTextBytes) throw Error("The ChronoHUD reply exceeds the excerpt budget.");
    result.push(Object.freeze({ area, title, text, date }));
  }
  return Object.freeze({ version: CHRONOHUD_VERSION, requestId: request.requestId, exportedAt,
    query, context: Object.freeze({ zone, scanned, matched, partial }), records: Object.freeze(result) });
}

/** Decrypt and validate a bounded reply using the active in-memory request. */
export async function openChronoHudReply(raw: string, request: ChronoHudRequest, now = Date.now(), manualTransfer = false): Promise<ChronoHudDelivery> {
  assertChronoHudRequestLive(request, now);
  if (!raw || raw.length > CHRONOHUD_REPLY_BYTES || bytes(raw) > CHRONOHUD_REPLY_BYTES)
    throw Error("The ChronoHUD reply is empty or too large.");
  const envelope: unknown = JSON.parse(raw);
  exactShape(envelope, ["format", "version", "requestId", "iv", "ciphertext"]);
  if (request.format !== REQUEST_FORMAT || request.version !== CHRONOHUD_VERSION || envelope.format !== REPLY_FORMAT ||
      envelope.version !== CHRONOHUD_VERSION || envelope.requestId !== request.requestId)
    throw Error("This ChronoHUD reply does not match the pending request.");

  const iv = decode(envelope.iv, 12);
  const ciphertext = decode(envelope.ciphertext, CHRONOHUD_REPLY_BYTES);
  const keyBytes = decode(request.key, 32);
  try {
    if (iv.length !== 12 || ciphertext.length < 16 || keyBytes.length !== 32) throw Error("The ChronoHUD reply is incomplete.");
    const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
    const clear = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: chronohudAad(request) }, key, ciphertext));
    try { return readDelivery(JSON.parse(decoder.decode(clear)), request, now, manualTransfer); }
    finally { clear.fill(0); }
  } finally { keyBytes.fill(0); }
}
