/** Curated text models, checked against official OpenAI docs. Never fetched with an API key. */
export const MODEL_CATALOG_CHECKED = "2026-11-17";
export const MODEL_CATALOG_URL = "https://developers.openai.com/api/docs/models";
export const MODEL_PRICING_URL = "https://developers.openai.com/api/docs/pricing";
export const HIGHER_API_COST = "Higher API cost";
export const CUSTOM_MODEL_CHOICE = "__custom__";
export const OPENAI_MODELS = [
  { id: "gpt-6-luna", label: "GPT-6 Luna", effort: "none", higherCost: false },
  { id: "gpt-6.1-terra", label: "GPT-6.1 Terra", effort: "none", higherCost: false },
  { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", effort: "low", higherCost: false },
  { id: "gpt-6.2-sol", label: "GPT-6.2 Sol", effort: "low", higherCost: false },
  { id: "gpt-6-astra", label: "GPT-6 Astra", effort: "low", higherCost: true },
  { id: "gpt-6.2-astra", label: "GPT-6.2 Astra", effort: "low", higherCost: true },
] as const;
export const DEFAULT_OPENAI_MODEL = OPENAI_MODELS[0].id;

/** Unknown or previously saved model IDs remain usable through Custom. */
export function findOpenAiModel(id: string) { return OPENAI_MODELS.find(model => model.id === id); }
