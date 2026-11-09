export const REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];
export type EffortSetting = ReasoningEffort | "default";
export const EFFORT_LABELS: Record<EffortSetting, string> = { default: "Model default", none: "Fast · none", low: "Light · low", medium: "Balanced · medium", high: "Deep · high", xhigh: "Deeper · xhigh", max: "Maximum · max" };
const all = new Set(["gpt-6-luna", "gpt-6.1-terra"]), reasoning = new Set(["gpt-6.1-sol", "gpt-6-astra"]);
export function supportedEfforts(model: string): readonly ReasoningEffort[] { return all.has(model) ? REASONING_EFFORTS : reasoning.has(model) ? REASONING_EFFORTS.slice(1) : []; }
export function isEffortSetting(value: unknown): value is EffortSetting { return value === "default" || typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value); }
/** Preserve earlier economical defaults. Unknown custom models use their own default without probing the API. */
export function resolveEffort(model: string, requested?: EffortSetting): ReasoningEffort | undefined {
  if (requested === "default") return undefined;
  if (requested !== undefined) {
    if (!supportedEfforts(model).includes(requested)) throw Error("This model does not list support for that thinking depth. Choose a supported value or Model default.");
    return requested;
  }
  return all.has(model) ? "none" : reasoning.has(model) ? "low" : undefined;
}
