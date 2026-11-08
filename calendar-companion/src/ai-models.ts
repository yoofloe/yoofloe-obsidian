import { DEFAULT_OPENAI_MODEL, findOpenAiModel, MODEL_CATALOG_CHECKED, MODEL_CATALOG_URL, MODEL_PRICING_URL, OPENAI_MODELS } from "./openai-models";
import { isOpenAiModelId } from "./openai";
import type { AiProvider } from "./ai-session";

// Keep dormant Gemini implementation/catalog in their own modules, outside the public bundle.
export const PUBLIC_AI_PROVIDERS: readonly AiProvider[] = ["openai"];
export const CUSTOM_MODEL_CHOICE = "__custom__";
export function isAiProvider(value: unknown): value is AiProvider { return value === "openai" || value === "gemini"; }
export function isAiProviderEnabled(value: unknown): value is AiProvider { return isAiProvider(value) && PUBLIC_AI_PROVIDERS.includes(value); }
export function providerLabel(provider: AiProvider) { return provider === "gemini" ? "Gemini" : "OpenAI"; }
export function modelCatalog(provider: AiProvider) {
  if (!isAiProviderEnabled(provider)) throw Error("This AI provider is unavailable in this version.");
  return { models: OPENAI_MODELS, defaultModel: DEFAULT_OPENAI_MODEL, checked: MODEL_CATALOG_CHECKED, url: MODEL_CATALOG_URL, pricing: MODEL_PRICING_URL };
}
export function findAiModel(provider: AiProvider, id: string) { return isAiProviderEnabled(provider) ? findOpenAiModel(id) : undefined; }
export function isAiModelId(provider: AiProvider, id: string) { return isAiProviderEnabled(provider) && isOpenAiModelId(id); }
