import { DEFAULT_OPENAI_MODEL, findOpenAiModel, MODEL_CATALOG_CHECKED, MODEL_CATALOG_URL, MODEL_PRICING_URL, OPENAI_MODELS } from "./openai-models";
import { DEFAULT_GEMINI_MODEL, findGeminiModel, GEMINI_CATALOG_CHECKED, GEMINI_CATALOG_URL, GEMINI_MODELS, GEMINI_PRICING_URL } from "./gemini-models";
import { isOpenAiModelId } from "./openai";
import { isGeminiModelId } from "./gemini";
import type { AiProvider } from "./ai-session";

export const CUSTOM_MODEL_CHOICE = "__custom__";
export function isAiProvider(value: unknown): value is AiProvider { return value === "openai" || value === "gemini"; }
export function providerLabel(provider: AiProvider) { return provider === "gemini" ? "Gemini" : "OpenAI"; }
export function modelCatalog(provider: AiProvider) {
  return provider === "gemini"
    ? { models: GEMINI_MODELS, defaultModel: DEFAULT_GEMINI_MODEL, checked: GEMINI_CATALOG_CHECKED, url: GEMINI_CATALOG_URL, pricing: GEMINI_PRICING_URL }
    : { models: OPENAI_MODELS, defaultModel: DEFAULT_OPENAI_MODEL, checked: MODEL_CATALOG_CHECKED, url: MODEL_CATALOG_URL, pricing: MODEL_PRICING_URL };
}
export function findAiModel(provider: AiProvider, id: string) { return provider === "gemini" ? findGeminiModel(id) : findOpenAiModel(id); }
export function isAiModelId(provider: AiProvider, id: string) { return provider === "gemini" ? isGeminiModelId(id) : isOpenAiModelId(id); }
