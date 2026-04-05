export const YOOFLOE_DOMAINS = [
  "schedule",
  "life",
  "wellness",
  "finance",
  "business",
  "journal",
  "garden"
] as const;

export const YOOFLOE_RANGES = ["1W", "1M", "6M", "1Y", "All"] as const;

export type YoofloeDomain = (typeof YOOFLOE_DOMAINS)[number];
export type YoofloeRange = (typeof YOOFLOE_RANGES)[number];
export type YoofloeScope = "personal";

export interface YoofloePluginSettings {
  apiToken: string;
  functionsBaseUrl: string;
  savePath: string;
  dateFormat: "YYYY-MM-DD" | "YYYYMMDD" | "YYYY.MM.DD";
  language: string;
  defaultRange: YoofloeRange;
  defaultScope: YoofloeScope;
  includeRawData: boolean;
  autoFrontmatter: boolean;
}

export interface YoofloeBundle {
  meta: {
    schema_version: string;
    generated_at: string;
    scope: YoofloeScope;
    range: YoofloeRange;
    domains: YoofloeDomain[];
    fidelity: string;
  };
  overview: Record<string, unknown>;
  domains: Record<string, { summary: Record<string, unknown>; evidence: Record<string, unknown>; raw?: Record<string, unknown> }>;
  prompt_hints?: {
    suggested_questions?: string[];
    usage_notes?: string[];
  };
  frontmatter_hints?: {
    source?: string;
    tags?: string[];
    suggested_title?: string;
    fields?: Record<string, unknown>;
  };
}

export interface YoofloeDataApiResponse {
  success: boolean;
  generatedAt: string;
  entitlement: {
    allowed: boolean;
    tier: string;
    source: string;
    status: string | null;
  };
  rateLimit?: {
    limit: number;
    remaining: number;
    windowSeconds: number;
  };
  bundle: YoofloeBundle;
}
