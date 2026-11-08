/** Curated text models, checked against official OpenAI docs. Never fetched with an API key. */
export const MODEL_CATALOG_CHECKED = "2026-11-08";
export const MODEL_CATALOG_URL = "https://developers.openai.com/api/docs/models";
export const MODEL_PRICING_URL = "https://developers.openai.com/api/docs/pricing";
export const CUSTOM_MODEL_CHOICE = "__custom__";
export const OPENAI_MODELS = [
  { id: "gpt-6-luna", label: "GPT-6 Luna · Economy (recommended)",
    description: "Start here for summaries, checklists and simple rewrites. Lowest-cost option in this list.", effort: "none" },
  { id: "gpt-6.1-terra", label: "GPT-6.1 Terra · Writing",
    description: "For drafting and revising everyday text. Costs more than Luna.", effort: "none" },
  { id: "gpt-6.1-sol", label: "GPT-6.1 Sol · Complex work",
    description: "For more demanding drafts. Higher cost; thinking can use the token budget before text appears.", effort: "low" },
  { id: "gpt-6-astra", label: "GPT-6 Astra · Higher cost",
    description: "For the most demanding tasks. Highest-cost option here; choose Luna for short, economical drafts.", effort: "low" },
] as const;
export const DEFAULT_OPENAI_MODEL = OPENAI_MODELS[0].id;

/** Unknown or previously saved model IDs remain usable through Custom. */
export function findOpenAiModel(id: string) { return OPENAI_MODELS.find(model => model.id === id); }
