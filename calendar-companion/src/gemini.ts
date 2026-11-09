import { AiSession, DRAFT_INSTRUCTION, type AiAdapter, type AiDraft, type AiTransport } from "./ai-session";

export const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/";
const encoder = new TextEncoder();
export function isGeminiModelId(model: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model) && !/^(?:sk-|AIza)/i.test(model);
}
export function validateGeminiKey(value: string): string {
  const key = value.trim();
  if (!/^AIza[A-Za-z0-9_-]{20,252}$/.test(key)) throw Error("Enter your Google AI Studio API key, without a URL or Bearer prefix.");
  return key;
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function tokenCount(value: unknown): number | null { return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null; }
/** Only model text is used. Thought parts, tools, code results and provider error bodies are never executed or shown. */
export function parseGeminiDraft(status: number, raw: string): AiDraft {
  if (status === 401 || status === 403) throw Error("Gemini rejected this key or its permissions. No retry was made.");
  if (status === 429) throw Error("Gemini reported a rate or quota limit. No retry was made.");
  if (status < 200 || status >= 300) throw Error("Gemini could not complete the request. No retry was made.");
  if (encoder.encode(raw).length > 8 * 1024 * 1024) throw Error("Gemini returned a response too large to open safely on this device.");
  let data: unknown;
  try { data = JSON.parse(raw); } catch { throw Error("Gemini returned an unreadable response. No retry was made."); }
  if (!object(data) || !Array.isArray(data.candidates)) throw Error("Gemini did not return a text draft. No retry was made.");
  const candidate: unknown = data.candidates[0];
  if (!object(candidate) || !["STOP", "MAX_TOKENS"].includes(candidate.finishReason as string)
    || !object(candidate.content) || candidate.content.role !== "model" || !Array.isArray(candidate.content.parts)) throw Error("Gemini did not return a completed text draft. No retry was made.");
  const text = candidate.content.parts.filter(part => object(part) && part.thought !== true && typeof part.text === "string").map(part => (part as { text: string }).text).join("\n").trim();
  if (!text) throw Error("Gemini returned no text. No automatic retry was made.");
  if (encoder.encode(text).length > 4 * 1024 * 1024) throw Error("The returned draft is too large to open safely on this device.");
  const usage = object(data.usageMetadata) ? data.usageMetadata : {};
  return { text, incomplete: candidate.finishReason === "MAX_TOKENS", inputTokens: tokenCount(usage.promptTokenCount), outputTokens: tokenCount(usage.candidatesTokenCount), thinkingTokens: tokenCount(usage.thoughtsTokenCount) };
}
export const GEMINI_ADAPTER: AiAdapter = {
  provider: "gemini", label: "Google Gemini",
  validateModel(model) { if (!isGeminiModelId(model)) throw Error("Choose a Gemini API model ID or enter an exact ID under Custom, for example gemini-3.5-flash-lite."); },
  validateKey: validateGeminiKey,
  request: (review, key) => ({
    url: `${GEMINI_ENDPOINT}${encodeURIComponent(review.model)}:generateContent`, method: "POST", contentType: "application/json", headers: { "x-goog-api-key": key }, throw: false,
    body: JSON.stringify({ systemInstruction: { parts: [{ text: DRAFT_INSTRUCTION }] }, contents: [{ role: "user", parts: [{ text: review.input }] }] }),
  }),
  parse: parseGeminiDraft,
};
export class GeminiSession extends AiSession {
  constructor(options: { current: () => boolean; key: () => Promise<string | null>; transport: AiTransport }) { super({ ...options, adapters: [GEMINI_ADAPTER] }); }
}
