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
export const YOOFLOE_AI_DOCUMENT_TYPES = ["insight-brief", "decision-memo", "action-plan", "deep-dive"] as const;

export type YoofloeDomain = (typeof YOOFLOE_DOMAINS)[number];
export type YoofloeRange = (typeof YOOFLOE_RANGES)[number];
export type YoofloeScope = "personal";
export type YoofloeDateFormat = "YYYY-MM-DD" | "YYYYMMDD" | "YYYY.MM.DD";
export type YoofloeGardenerSurface = "brief" | "plan" | "prompt" | "export";
export type YoofloeAiProviderType = "none" | "gemini-google" | "gemini-vertex";
export type YoofloeAiDocumentType = (typeof YOOFLOE_AI_DOCUMENT_TYPES)[number];

export interface MarkdownRenderOptions {
  autoFrontmatter: boolean;
  includeRawData: boolean;
}

export interface YoofloeByokSettings {
  type: YoofloeAiProviderType;
  clientId: string;
  googleConnected: boolean;
  googleLastConnectState: "idle" | "pending" | "success" | "error";
  googleLastConnectMessage: string;
  project: string;
  location: string;
  googleModel: string;
  vertexModel: string;
}

export interface YoofloeEntitlement {
  allowed: boolean;
  tier: string;
  source: string;
  status: string | null;
}

export interface YoofloeRateLimit {
  limit: number;
  remaining: number;
  windowSeconds: number;
}

export interface YoofloePluginSettings {
  apiToken: string;
  functionsBaseUrl: string;
  savePath: string;
  dateFormat: YoofloeDateFormat;
  language: string;
  defaultRange: YoofloeRange;
  defaultScope: YoofloeScope;
  includeRawData: boolean;
  autoFrontmatter: boolean;
  provider: YoofloeByokSettings;
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
  entitlement: YoofloeEntitlement;
  rateLimit?: YoofloeRateLimit;
  bundle: YoofloeBundle;
}

export interface YoofloeGardenerApiResponse<TData = Record<string, unknown>> {
  success: boolean;
  generatedAt: string;
  surface: YoofloeGardenerSurface;
  format: "json" | "markdown";
  entitlement: YoofloeEntitlement;
  rateLimit?: YoofloeRateLimit;
  data: TData;
  rendered?: string;
}
