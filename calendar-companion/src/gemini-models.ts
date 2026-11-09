/** Curated text-generation models; public documentation only, never a credentialed model-list call. */
export const GEMINI_CATALOG_CHECKED = "2026-11-08";
export const GEMINI_CATALOG_URL = "https://ai.google.dev/gemini-api/docs/models";
export const GEMINI_PRICING_URL = "https://ai.google.dev/gemini-api/docs/pricing";
export const GEMINI_TERMS_URL = "https://ai.google.dev/gemini-api/terms";
export const GEMINI_MODELS = [
  { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite · Economy (recommended)",
    description: "For summaries, translation and simple drafts. Lowest paid-tier price in this list; free-tier availability depends on your account." },
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash · Complex work",
    description: "The latest Flash text model. For more demanding drafts, at a higher paid-tier price." },
  { id: "gemini-4-argon", label: "Gemini 4 Argon · Paid tier only",
    description: "The latest flagship reasoning model. No free tier; reasoning tokens also incur charges." },
] as const;
export const DEFAULT_GEMINI_MODEL = GEMINI_MODELS[0].id;
export function findGeminiModel(id: string) { return GEMINI_MODELS.find(model => model.id === id); }
