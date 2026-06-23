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
export const YOOFLOE_AI_DOCUMENT_TYPES = [
  "daily-review",
  "weekly-plan",
  "insight-brief",
  "decision-memo",
  "action-plan",
  "wellness-check",
  "finance-snapshot",
  "free-prompt",
  "deep-dive"
] as const;
export const YOOFLOE_OUTPUT_TARGETS = ["new-note", "append-current", "insert-cursor", "replace-selection"] as const;
export const YOOFLOE_CONTEXT_MODES = ["smart", "manual"] as const;
export const YOOFLOE_SOURCE_DISPLAYS = ["hidden", "summary", "details"] as const;
export const YOOFLOE_CAPTURE_TARGETS = ["memo", "task", "journal"] as const;

export type YoofloeDomain = (typeof YOOFLOE_DOMAINS)[number];
export type YoofloeRange = (typeof YOOFLOE_RANGES)[number];
export type YoofloeScope = "personal";
export type YoofloeDateFormat = "YYYY-MM-DD" | "YYYYMMDD" | "YYYY.MM.DD";
export type YoofloeGardenerSurface = "brief" | "plan" | "prompt" | "export";
export type YoofloeAiProviderType = "yoofloe-hosted" | "none" | "gemini-google" | "gemini-vertex";
export type YoofloeAiDocumentType = (typeof YOOFLOE_AI_DOCUMENT_TYPES)[number];
export type YoofloeOutputTarget = (typeof YOOFLOE_OUTPUT_TARGETS)[number];
export type YoofloeContextMode = (typeof YOOFLOE_CONTEXT_MODES)[number];
export type YoofloeSourceDisplay = (typeof YOOFLOE_SOURCE_DISPLAYS)[number];
export type YoofloeCaptureTarget = (typeof YOOFLOE_CAPTURE_TARGETS)[number];
export type YoofloeAccessMode = "read" | "read-write";
export type YoofloeCaptureAction = string;
export type YoofloeCaptureResultStatus = "applied" | "blocked" | "needs_confirmation" | "conflict" | "failed" | "skipped";

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

export interface YoofloeExternalAccessSecurityContract {
  schemaVersion: 2;
  scope: YoofloeScope;
  coupleScopeEnabled: false;
  encryptionMode: "mixed_legacy_v1_and_zke_v2";
  zkeAtRestMode: "zke_client_decrypt";
  legacyServerDerivedKeyStatus: "migration_only";
  requiresLocalKeyForV2: true;
  canReadCiphertext: true;
  canReadZkePlaintext: false;
  plaintextExportConsentRequired: true;
  patCanDecrypt: false;
  mcpConfigCanDecrypt: false;
  rawKeyStorageAllowed: false;
  serverCanDecryptV2: false;
}

export interface YoofloePluginSettings {
  apiToken: string;
  functionsBaseUrl: string;
  savePath: string;
  dateFormat: YoofloeDateFormat;
  language: string;
  defaultRange: YoofloeRange;
  defaultScope: YoofloeScope;
  defaultDomains: YoofloeDomain[];
  defaultOutputTarget: YoofloeOutputTarget;
  defaultTone: string;
  includeRawData: boolean;
  autoFrontmatter: boolean;
  showAdvancedProvider: boolean;
  showMcpSetup: boolean;
  yoofloeAccessMode: YoofloeAccessMode;
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
    security?: YoofloeExternalAccessSecurityContract;
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

export interface YoofloeWriterSource {
  domain: YoofloeDomain;
  title: string;
  citation: string;
  summary: string;
}

export interface YoofloeWriterUnavailable {
  code: string;
  message: string;
}

export interface YoofloeCurrentNoteContext {
  enabled: boolean;
  path?: string;
  title?: string;
  content?: string;
  selectionOnly?: boolean;
}

export interface YoofloeHostedWriterRequest {
  documentType: YoofloeAiDocumentType;
  domains: YoofloeDomain[];
  range: YoofloeRange;
  scope: YoofloeScope;
  prompt?: string;
  tone?: string;
  outputMode?: YoofloeOutputTarget;
  includeRaw?: boolean;
  contextMode?: YoofloeContextMode;
  sourceDisplay?: YoofloeSourceDisplay;
  currentNoteContext?: YoofloeCurrentNoteContext;
}

export interface YoofloeWriterContextPlan {
  mode: YoofloeContextMode;
  intent: string;
  domains: YoofloeDomain[];
  domainsRead?: YoofloeDomain[];
  domainsBlocked?: YoofloeDomain[];
  omittedDomains: YoofloeDomain[];
  primaryDomains?: YoofloeDomain[];
  supportingDomains?: YoofloeDomain[];
  readPlan?: Array<{
    domain: YoofloeDomain;
    reads: string[];
    reason?: string;
    sensitive?: boolean;
  }>;
  recordsRead?: Partial<Record<YoofloeDomain, number>>;
  sourceCount?: number;
  estimatedInputTokens?: number;
}

export interface YoofloeHostedWriterResponse {
  success: boolean;
  requestId?: string;
  title: string;
  markdownBody: string;
  sources: YoofloeWriterSource[];
  unavailable: YoofloeWriterUnavailable[];
  contextPlan?: YoofloeWriterContextPlan;
  entitlement?: YoofloeEntitlement;
  rateLimit?: YoofloeRateLimit;
  security?: YoofloeExternalAccessSecurityContract;
  provider?: {
    type?: string;
    label?: string;
    model?: string;
    hosted?: boolean;
  };
}

export interface YoofloeCaptureCandidate {
  candidateId: string;
  action: YoofloeCaptureAction;
  domain?: string;
  menu?: string;
  riskTier?: string;
  itemType: "memo" | "journal" | "task";
  title: string;
  normalizedFields: Record<string, unknown>;
  sourceSnippet?: string | null;
  confidence?: number;
  warnings?: string[];
  requiresConfirmation?: boolean;
}

export interface YoofloeWritePreviewRequest {
  source: "manual" | "selection";
  text: string;
  notePath?: string;
  selectionOnly?: boolean;
  target: YoofloeCaptureTarget;
  domain?: YoofloeCaptureDomain;
  scope: YoofloeScope;
}

export interface YoofloeWritePreviewResponse {
  success: boolean;
  previewId: string;
  expiresAt: string;
  candidates: YoofloeCaptureCandidate[];
  unavailable?: YoofloeWriterUnavailable[];
  security?: Record<string, unknown>;
}

export interface YoofloeWriteExecuteRequest {
  previewId: string;
  approvedCandidateIds: string[];
  editedFields: Record<string, Record<string, unknown>>;
  confirmations: {
    confirmSoftDelete?: boolean;
  };
  clientRequestId: string;
  scope: YoofloeScope;
}

export interface YoofloeWriteExecuteResult {
  candidateId: string;
  status: YoofloeCaptureResultStatus;
  itemId?: string;
  message?: string;
}

export interface YoofloeWriteExecuteResponse {
  success: boolean;
  previewId: string;
  results: YoofloeWriteExecuteResult[];
}
import type { YoofloeCaptureDomain } from "./capture-registry";
