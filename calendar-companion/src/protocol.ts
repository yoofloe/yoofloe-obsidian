import { isRecordKind, type RecordKind } from "./record-types";

export const INBOX = "Yoofloe Calendar Inbox";
export const ACTION = "yoofloe-calendar-companion";
export const MAX_REPLY_BYTES = 2 * 1024 * 1024;
export const TRANSPORT_VERSION = 2;
export const MAX_RECORDS = 50;
export const WINDOW_MS = 10 * 60 * 1000;
const encoder = new TextEncoder();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface Request {
  format: "yoofloe.calendar.request"; version: 2; requestId: string; vault: string;
  nonce: string; key: string; createdAt: number; expiresAt: number;
}
export interface RecordSnapshot {
  id: string; kind: RecordKind; sourceId: string; revision: number;
  title: string; text: string; date: string | null;
}
export interface Delivery {
  version: 2; requestId: string; datasetId: string; exportedAt: number; records: RecordSnapshot[];
}

/** Encode bytes without a Node or Electron dependency. */
export function encode(bytes: Uint8Array): string {
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Accept one canonical, bounded base64url representation. */
export function decode(value: unknown, maximum: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || value.length > Math.ceil(maximum * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) throw Error("Invalid transfer encoding.");
  let bytes: Uint8Array<ArrayBuffer>;
  try { bytes = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4)), c => c.charCodeAt(0)); }
  catch { throw Error("Invalid transfer encoding."); }
  if (bytes.length > maximum || encode(bytes) !== value) throw Error("Invalid transfer encoding.");
  return bytes;
}

/** Check a closed object before accepting a file or decrypted record. */
export function shape(value: unknown, fields: string[]): asserts value is { [key: string]: unknown } {
  if (!value || Array.isArray(value) || typeof value !== "object" || Object.keys(value).sort().join("|") !== [...fields].sort().join("|")) throw Error("This transfer format is not supported.");
}

/** Keep identifiers out of user-controlled filenames. */
export function assertId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !uuid.test(value)) throw Error("Invalid transfer identity.");
}

/** Create a one-use request. The random key stays in the selected vault, never in a URL. */
export function createRequest(vaultName: string, now = Date.now()): Request {
  if (!vaultName || encoder.encode(vaultName).length > 256 || /[\x00-\x1f\x7f]/.test(vaultName)) throw Error("This vault name is not supported.");
  const requestId = crypto.randomUUID(); assertId(requestId);
  return { format: "yoofloe.calendar.request", version: TRANSPORT_VERSION, requestId,
    vault: encode(encoder.encode(vaultName)), nonce: encode(crypto.getRandomValues(new Uint8Array(32))),
    key: encode(crypto.getRandomValues(new Uint8Array(32))), createdAt: now, expiresAt: now + WINDOW_MS };
}

/** Expired and future-dated requests never authorize a delivery. */
export function assertLive(request: Request, now = Date.now()): void {
  if (!Number.isSafeInteger(now) || now < request.createdAt - 60000 || now > request.expiresAt) throw Error("This request expired. Start a new connection.");
}

/** Launch metadata contains no record content or decryption key. */
export function launchUrl(request: Request): string {
  return `yoofloe-calendar://obsidian/connect?version=${TRANSPORT_VERSION}&requestId=${request.requestId}&vault=${request.vault}`;
}

/** Bind the encrypted reply to this exact request and vault. */
export function aad(request: Request): Uint8Array<ArrayBuffer> {
  return encoder.encode(`yoofloe-calendar-companion/v2|${request.requestId}|${request.vault}|${request.nonce}`);
}

/** Fully validate the plaintext before a single note can be created. */
export function validateDelivery(value: unknown, request: Request): Delivery {
  shape(value, ["version", "requestId", "datasetId", "exportedAt", "records"]);
  if (value.version !== TRANSPORT_VERSION || value.requestId !== request.requestId) throw Error("This reply belongs to a different request or companion version.");
  assertId(value.datasetId);
  if (!Number.isSafeInteger(value.exportedAt) || (value.exportedAt as number) < request.createdAt - 60000 || (value.exportedAt as number) > request.expiresAt) throw Error("Invalid transfer time.");
  if (!Array.isArray(value.records) || value.records.length < 1 || value.records.length > MAX_RECORDS) throw Error("Choose between 1 and 50 records.");
  const seen = new Set<string>();
  for (const record of value.records) {
    shape(record, ["id", "kind", "sourceId", "revision", "title", "text", "date"]); assertId(record.id);
    if (!isRecordKind(record.kind) || !Number.isSafeInteger(record.revision) || (record.revision as number) < 1) throw Error("Invalid Calendar record.");
    if (typeof record.sourceId !== "string" || !record.sourceId || encoder.encode(record.sourceId).length > 1000 || /[\x00-\x1f\x7f]/.test(record.sourceId)) throw Error("Invalid source identity.");
    if (typeof record.title !== "string" || encoder.encode(record.title).length > 4096 || typeof record.text !== "string" || encoder.encode(record.text).length > 256 * 1024) throw Error("A record is too large for this transfer.");
    if (record.date !== null && (typeof record.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(record.date) || Number.isNaN(Date.parse(record.date)) || new Date(record.date).toISOString().slice(0, 10) !== record.date)) throw Error("Invalid Calendar date.");
    const identity = `${record.kind}:${record.id}`;
    if (seen.has(identity)) throw Error("The transfer contains duplicate records.");
    seen.add(identity);
  }
  return value as unknown as Delivery;
}

/** Decrypt only a bounded reply for the currently pending request. */
export async function openReply(raw: string, request: Request, now = Date.now()): Promise<Delivery> {
  assertLive(request, now);
  if (encoder.encode(raw).length > MAX_REPLY_BYTES) throw Error("This transfer is too large.");
  let envelope: unknown;
  try { envelope = JSON.parse(raw); } catch { throw Error("This transfer is incomplete or invalid."); }
  shape(envelope, ["format", "version", "requestId", "iv", "ciphertext"]);
  if (envelope.format !== "yoofloe.calendar.reply" || envelope.version !== TRANSPORT_VERSION || envelope.requestId !== request.requestId) throw Error("This reply belongs to a different request or companion version.");
  const keyBytes = decode(request.key, 32), iv = decode(envelope.iv, 12);
  if (keyBytes.length !== 32 || iv.length !== 12) throw Error("Invalid transfer key or nonce.");
  const encrypted = decode(envelope.ciphertext, MAX_REPLY_BYTES);
  let plain: ArrayBuffer | null = null;
  try {
    const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad(request) }, key, encrypted);
    return validateDelivery(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain)), request);
  } catch (error) {
    if (error instanceof Error && error.name !== "OperationError") throw error;
    throw Error("The reply could not be authenticated. Start a new connection.");
  } finally { keyBytes.fill(0); if (plain) new Uint8Array(plain).fill(0); }
}
