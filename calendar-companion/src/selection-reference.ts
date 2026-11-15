import { safeOutbound, vaultPath } from "./agent-policy";
import { inputDigest } from "./question-input";

export interface SelectionReference {
  id: string;
  path: string;
  version: string;
  from: number;
  to: number;
  firstLine: number;
  lastLine: number;
  quote?: string;
  wholeNote?: boolean;
  needsReview?: boolean;
}

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const hash = /^[a-f0-9]{64}$/;
const MAX_READING_QUOTE = 32 * 1024;

export function readSelectionReference(value: unknown): SelectionReference | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (typeof item.path !== "string") return null;
  try { vaultPath(item.path); } catch { return null; }
  const validRange = typeof item.from === "number" && Number.isSafeInteger(item.from) && item.from >= 0 &&
    typeof item.to === "number" && Number.isSafeInteger(item.to) && item.to >= item.from;
  const validVersion = typeof item.version === "string" && hash.test(item.version);
  const quote = typeof item.quote === "string" && item.quote.length <= MAX_READING_QUOTE ? item.quote : undefined;
  const validLines = typeof item.firstLine === "number" && Number.isSafeInteger(item.firstLine) && item.firstLine > 0 &&
    typeof item.lastLine === "number" && Number.isSafeInteger(item.lastLine) && item.lastLine >= item.firstLine;
  return {
    id: typeof item.id === "string" && uuid.test(item.id) ? item.id : crypto.randomUUID(),
    path: item.path, version: validVersion ? item.version as string : "",
    from: validRange ? item.from as number : 0, to: validRange ? item.to as number : 0,
    firstLine: validLines ? item.firstLine as number : 0, lastLine: validLines ? item.lastLine as number : 0,
    ...(quote !== undefined ? { quote } : {}),
    ...(item.wholeNote === true && item.from === 0 && quote === undefined ? { wholeNote: true } : {}),
    ...(!validRange || !validVersion || item.needsReview === true || item.quote !== undefined && quote === undefined ? { needsReview: true } : {}),
  };
}

export async function captureSelectionReference(path: string, document: string, from: number, to: number, quote?: string): Promise<SelectionReference> {
  vaultPath(path);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from || to > document.length)
    throw Error("Select a passage in the note first.");
  if (quote !== undefined && (!quote.trim() || quote.length > MAX_READING_QUOTE))
    throw Error("Choose a smaller passage in reading view, or use the editor for a long selection.");
  if (quote) safeOutbound(quote);
  return {
    id: crypto.randomUUID(), path, version: await inputDigest(document), from, to,
    firstLine: document.slice(0, from).split("\n").length,
    lastLine: document.slice(0, Math.max(from, to - 1)).split("\n").length,
    ...(quote === undefined ? {} : { quote }),
  };
}

export async function selectionText(reference: SelectionReference, document: string, version?: string): Promise<string> {
  if (reference.needsReview) throw Error("Review this reference before sending, or remove it from the request.");
  if (reference.version !== (version ?? await inputDigest(document)) || reference.from < 0 || reference.to > document.length)
    throw Error("The reference changed. Refresh the selection before sending.");
  return reference.quote ?? document.slice(reference.from, reference.to);
}

export function selectionLabel(reference: SelectionReference): string {
  const title = reference.path.split("/").at(-1)?.replace(/\.md$/i, "") ?? reference.path;
  const range = reference.wholeNote ? "Whole note" : reference.quote ? "Quoted text" : !reference.firstLine ? "Selected text" : reference.firstLine === reference.lastLine ?
    `Line ${reference.firstLine}` : `Lines ${reference.firstLine}–${reference.lastLine}`;
  return `${title} · ${reference.needsReview ? "Review reference" : range}`;
}
