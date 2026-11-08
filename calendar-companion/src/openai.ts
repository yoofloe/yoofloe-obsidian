import { AiSession, DRAFT_INSTRUCTION, type AiAdapter, type AiDraft, type AiHttpRequest, type AiReview, type AiTransport } from "./ai-session";
export { MAX_AI_INPUT_BYTES } from "./ai-session";
import { findOpenAiModel } from "./openai-models";

export const OPENAI_ENDPOINT = "https://api.openai.com/v1/responses";
const encoder = new TextEncoder();
export interface OpenAiOptions { model: string }
export type OpenAiReview = AiReview;
export type OpenAiDraft = AiDraft;
export type OpenAiHttpRequest = AiHttpRequest;
export type OpenAiTransport = AiTransport;

/** Reject likely credentials pasted into the model selector's custom field. */
export function isOpenAiModelId(model: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model) && !/^(?:sk-|AIza)/i.test(model); }

/** Validate the model locally; output length is left to the provider's model default. */
export function validateOpenAiOptions(options: OpenAiOptions): OpenAiOptions {
  if (!isOpenAiModelId(options.model)) throw Error("Choose an API model ID from the list or enter an exact ID under Custom.");
  return { model: options.model };
}

/** Local syntax checks never verify a key with an external service. */
export function validateOpenAiKey(value: string): string {
  const key = value.trim();
  if (/^AIza/.test(key) || key.length < 20 || key.length > 512 || !/^[\x21-\x7e]+$/.test(key)) throw Error("Enter only the API key, without spaces or a Bearer prefix.");
  return key;
}

function object(value: unknown): value is { [key: string]: unknown } { return value !== null && typeof value === "object" && !Array.isArray(value); }
function tokenCount(value: unknown): number | null { return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null; }

/** Read only assistant text output; model tool calls are never executed. */
export function parseOpenAiDraft(status: number, raw: string): OpenAiDraft {
  if (status === 401 || status === 403) throw Error("OpenAI rejected this key or its permissions. No retry was made.");
  if (status === 429) throw Error("OpenAI reported a rate or quota limit. No retry was made.");
  if (status < 200 || status >= 300) throw Error("OpenAI could not complete the request. No retry was made.");
  if (encoder.encode(raw).length > 8 * 1024 * 1024) throw Error("OpenAI returned a response too large to open safely on this device.");
  let data: unknown;
  try { data = JSON.parse(raw); } catch { throw Error("OpenAI returned an unreadable response. No retry was made."); }
  if (!object(data) || !["completed", "incomplete"].includes(data.status as string) || !Array.isArray(data.output)) throw Error("OpenAI did not return a completed text draft.");
  const parts: string[] = [];
  for (const item of data.output) {
    if (!object(item) || item.type !== "message" || item.role !== "assistant" || !Array.isArray(item.content)) continue;
    for (const content of item.content) if (object(content) && content.type === "output_text" && typeof content.text === "string") parts.push(content.text);
  }
  const text = parts.join("\n").trim();
  if (!text) throw Error("OpenAI returned no text. No automatic retry was made.");
  if (encoder.encode(text).length > 4 * 1024 * 1024) throw Error("The returned draft is too large to open safely on this device.");
  const usage = object(data.usage) ? data.usage : {};
  return { text, incomplete: data.status === "incomplete", inputTokens: tokenCount(usage.input_tokens), outputTokens: tokenCount(usage.output_tokens) };
}

export const OPENAI_ADAPTER: AiAdapter = {
  provider: "openai", label: "OpenAI",
  validateModel(model) { validateOpenAiOptions({ model }); }, validateKey: validateOpenAiKey,
  profile: model => ({ reasoningEffort: findOpenAiModel(model)?.effort }),
  request: (review, key) => ({ url: OPENAI_ENDPOINT, method: "POST", contentType: "application/json", headers: { Authorization: `Bearer ${key}` }, throw: false,
    body: JSON.stringify({ model: review.model, instructions: DRAFT_INSTRUCTION, input: review.input, store: false, stream: false,
      ...(review.reasoningEffort ? { reasoning: { effort: review.reasoningEffort } } : {}) }) }),
  parse: parseOpenAiDraft,
};
/** Kept as a small provider adapter; shared session logic also protects Gemini. */
export class OpenAiSession extends AiSession {
  constructor(options: { current: () => boolean; key: () => Promise<string | null>; transport: OpenAiTransport }) { super({ ...options, adapters: [OPENAI_ADAPTER] }); }
}
