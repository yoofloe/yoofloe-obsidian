import { requestUrl } from "obsidian";
import { describeAccessError, normalizeFunctionsBaseUrl, parseAccessStatus, parseSecurityContract, YoofloeConnectionChangedError } from "../external-access";
import type {
  YoofloeDataApiResponse,
  YoofloeDomain,
  YoofloeEntitlement,
  YoofloeGardenerApiResponse,
  YoofloePluginSettings,
  YoofloeRange,
  YoofloeScope,
  YoofloeWriteExecuteRequest,
  YoofloeWriteExecuteResponse,
  YoofloeWritePreviewRequest,
  YoofloeWritePreviewResponse
} from "../types";

type BundleRequest = {
  domains: YoofloeDomain[];
  range: YoofloeRange;
  scope: YoofloeScope;
  includeRaw: boolean;
  includeFrontmatterHints: boolean;
};

type GardenerBriefRequest = {
  domains: YoofloeDomain[];
  range: YoofloeRange;
  scope: YoofloeScope;
  format: "json" | "markdown";
};

function joinUrl(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

type YoofloeClientSettings = Pick<YoofloePluginSettings, "functionsBaseUrl">;

export type YoofloeReachedFunction = true | false | "unknown";

export interface YoofloeApiDiagnostics {
  status: number;
  code?: string;
  requestId?: string;
  providerStatus?: number;
  providerRequestId?: string;
  providerModel?: string;
  providerLocation?: string;
  functionSlug: string;
  host: string;
  reachedFunction: YoofloeReachedFunction;
  entitlement?: YoofloeEntitlement | null;
}

export class YoofloeApiError extends Error {
  status: number;
  code?: string;
  requestId?: string;
  providerStatus?: number;
  providerRequestId?: string;
  providerModel?: string;
  providerLocation?: string;
  functionSlug: string;
  host: string;
  reachedFunction: YoofloeReachedFunction;
  entitlement: YoofloeEntitlement | null;

  constructor(message: string, diagnostics: YoofloeApiDiagnostics) {
    super(message);
    this.name = "YoofloeApiError";
    this.status = diagnostics.status;
    this.code = diagnostics.code;
    this.requestId = diagnostics.requestId;
    this.providerStatus = diagnostics.providerStatus;
    this.providerRequestId = diagnostics.providerRequestId;
    this.providerModel = diagnostics.providerModel;
    this.providerLocation = diagnostics.providerLocation;
    this.functionSlug = diagnostics.functionSlug;
    this.host = diagnostics.host;
    this.reachedFunction = diagnostics.reachedFunction;
    this.entitlement = diagnostics.entitlement || null;
  }

  toDiagnostics() {
    return {
      status: this.status,
      code: this.code,
      requestId: this.requestId,
      providerStatus: this.providerStatus,
      providerRequestId: this.providerRequestId,
      providerModel: this.providerModel,
      providerLocation: this.providerLocation,
      functionSlug: this.functionSlug,
      host: this.host,
      reachedFunction: this.reachedFunction
    };
  }
}

function getEndpointParts(settings: YoofloeClientSettings, path: string) {
  const url = joinUrl(settings.functionsBaseUrl, path);
  try {
    return {
      url,
      host: new URL(url).host,
      functionSlug: path.replace(/^\/+/, "").split(/[/?#]/)[0] || path
    };
  } catch {
    return {
      url,
      host: "unknown",
      functionSlug: path.replace(/^\/+/, "").split(/[/?#]/)[0] || path
    };
  }
}

function parseResponsePayload(response: { json?: unknown; text?: string }) {
  if (response.json && typeof response.json === "object" && !Array.isArray(response.json)) {
    return response.json as Record<string, unknown>;
  }

  const text = typeof response.text === "string" ? response.text.trim() : "";
  if (!text) return {};
  if (!text.startsWith("{") || text.length > 10000) return {};

  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function inferReachedFunction(status: number, payload: Record<string, unknown>) {
  if (typeof payload.requestId === "string" || typeof payload.code === "string") return true;
  if (status === 404) return false;
  return "unknown";
}

function parseEntitlement(payload: Record<string, unknown>) {
  const entitlement = payload.entitlement;
  if (!entitlement || typeof entitlement !== "object" || Array.isArray(entitlement)) return null;

  const candidate = entitlement as Partial<YoofloeEntitlement>;
  return typeof candidate.allowed === "boolean"
    ? {
      allowed: candidate.allowed,
      tier: typeof candidate.tier === "string" ? candidate.tier : "",
      source: typeof candidate.source === "string" ? candidate.source : "",
      status: typeof candidate.status === "string" ? candidate.status : null
    }
    : null;
}

function safeErrorMessage(status: number, code?: string) {
  if (code && /^(TOKEN_|EXTERNAL_|CLIENT_UPDATE_REQUIRED|CONNECTION_CHANGED|RATE_LIMITED)/.test(code)) {
    return describeAccessError(status, code);
  }
  switch (code) {
    case "INVALID_TOKEN":
      return "Yoofloe authentication failed. Reconnect Yoofloe in Settings.";
    case "AI_TERMS_REQUIRED":
      return "Yoofloe AI terms need attention before generation can continue.";
    case "AI_TOKEN_LIMIT_EXCEEDED":
    case "AI_BUDGET_LIMIT_EXCEEDED":
      return "Yoofloe AI usage limits are blocking this generation.";
    case "AI_PROVIDER_REQUEST_REJECTED":
      return "Yoofloe AI could not use this prompt or context safely.";
    case "AI_PROVIDER_PERMISSION_DENIED":
      return "Yoofloe AI provider access is not configured correctly.";
    case "AI_PROVIDER_MODEL_UNAVAILABLE":
      return "Yoofloe AI model is currently unavailable.";
    case "AI_PROVIDER_RATE_LIMITED":
      return "Yoofloe AI is rate limited. Try again shortly.";
    case "AI_PROVIDER_UNAVAILABLE":
      return "Yoofloe AI provider is temporarily unavailable.";
    case "SENSITIVE_SOURCE_DISABLED":
      return "A sensitive Yoofloe source is off for this request.";
    default:
      break;
  }

  if (status === 401) return "Yoofloe authentication failed. Reconnect Yoofloe in Settings.";
  if (status === 402) return "Yoofloe AI usage limits are blocking this generation.";
  if (status === 403) return "Yoofloe access is blocked for this request.";
  if (status === 429) return "Yoofloe AI is rate limited. Try again shortly.";
  if (status >= 500) return "Yoofloe AI is temporarily unavailable.";
  if (status > 0) return `Yoofloe request failed with status ${status}.`;
  return "Yoofloe request failed before a response was received.";
}

function buildResponseError(
  settings: YoofloeClientSettings,
  path: string,
  status: number,
  payload: Record<string, unknown>
) {
  const { host, functionSlug } = getEndpointParts(settings, path);
  const code = typeof payload.code === "string" ? payload.code : undefined;
  const requestId = typeof payload.requestId === "string" ? payload.requestId : undefined;
  const providerStatus = typeof payload.providerStatus === "number" ? payload.providerStatus : undefined;
  const providerRequestId = typeof payload.providerRequestId === "string" ? payload.providerRequestId : undefined;
  const providerModel = typeof payload.providerModel === "string" ? payload.providerModel : undefined;
  const providerLocation = typeof payload.providerLocation === "string" ? payload.providerLocation : undefined;
  const responseMessage = typeof payload.error === "string" ? payload.error.trim() : "";
  const message = code === "SENSITIVE_SOURCE_DISABLED" && responseMessage
    ? responseMessage
    : safeErrorMessage(status, code);

  return new YoofloeApiError(message, {
    status,
    code,
    requestId,
    providerStatus,
    providerRequestId,
    providerModel,
    providerLocation,
    functionSlug,
    host,
    reachedFunction: inferReachedFunction(status, payload),
    entitlement: parseEntitlement(payload)
  });
}

function buildThrownRequestError(settings: YoofloeClientSettings, path: string, error: unknown) {
  const { host, functionSlug } = getEndpointParts(settings, path);
  const rawMessage = error instanceof Error ? error.message : "";
  const statusMatch = rawMessage.match(/status\s+(\d{3})/i);
  const status = statusMatch ? Number(statusMatch[1]) : 0;
  const message = safeErrorMessage(status);

  return new YoofloeApiError(message, {
    status,
    functionSlug,
    host,
    reachedFunction: "unknown"
  });
}

async function postJson<T>(settings: YoofloeClientSettings, token: string, path: string, body?: object): Promise<T> {
  settings = { functionsBaseUrl: normalizeFunctionsBaseUrl(settings.functionsBaseUrl) };
  const trimmedToken = token.trim();
  if (!trimmedToken) {
    throw new Error("Yoofloe API token is missing.");
  }

  let response;
  try {
    response = await requestUrl({
      url: getEndpointParts(settings, path).url,
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${trimmedToken}`,
        "Content-Type": "application/json"
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      throw: false
    });
  } catch (error) {
    throw buildThrownRequestError(settings, path, error);
  }

  if (response.status >= 400) {
    if (body === undefined && (response.status === 404 || response.status === 405)) {
      throw buildResponseError(settings, path, response.status, { code: "CLIENT_UPDATE_REQUIRED" });
    }
    throw buildResponseError(settings, path, response.status, parseResponsePayload(response));
  }

  return response.json as T;
}

export class YoofloeClient {
  private readonly settings: YoofloeClientSettings;
  constructor(
    settings: YoofloeClientSettings,
    private readonly token: string,
    private readonly isConnectionCurrent: () => boolean = () => true
  ) { this.settings = { functionsBaseUrl: settings.functionsBaseUrl }; }

  private async request<T>(path: string, body?: object): Promise<T> {
    if (!this.isConnectionCurrent()) throw new YoofloeConnectionChangedError();
    try {
      const result = await postJson<T>(this.settings, this.token, path, body);
      if (!this.isConnectionCurrent()) throw new YoofloeConnectionChangedError();
      return result;
    } catch (error) {
      if (!this.isConnectionCurrent()) throw new YoofloeConnectionChangedError();
      throw error;
    }
  }

  async testToken() {
    return parseAccessStatus(await this.request("obsidian-data-api"));
  }

  async fetchBundle(request: BundleRequest): Promise<YoofloeDataApiResponse> {
    const response = await this.request<YoofloeDataApiResponse>("obsidian-data-api", request);
    parseSecurityContract(response?.bundle?.meta?.security);
    return response;
  }

  async fetchGardenerBrief(request: GardenerBriefRequest): Promise<YoofloeGardenerApiResponse> {
    return this.request<YoofloeGardenerApiResponse>("obsidian-gardener-api", {
      surface: "brief",
      domains: request.domains,
      range: request.range,
      scope: request.scope,
      format: request.format
    });
  }

  async previewWriteActions(request: YoofloeWritePreviewRequest): Promise<YoofloeWritePreviewResponse> {
    return this.request<YoofloeWritePreviewResponse>("obsidian-write-preview", request);
  }

  async executeWriteActions(request: YoofloeWriteExecuteRequest): Promise<YoofloeWriteExecuteResponse> {
    return this.request<YoofloeWriteExecuteResponse>("obsidian-write-execute", request);
  }
}
