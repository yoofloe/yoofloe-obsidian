import type {
  YoofloeDataApiResponse,
  YoofloeDateFormat,
  YoofloeDomain,
  YoofloeGardenerApiResponse,
  YoofloeRange
} from "../types";

const DEFAULT_FUNCTIONS_BASE_URL = "https://hhiyerojemcujzcmlzao.supabase.co/functions/v1";

export interface YoofloeMcpConfig {
  pat: string;
  functionsBaseUrl: string;
  vaultPath: string;
  saveFolder: string;
  dateFormat: YoofloeDateFormat;
  pluginVersion: string;
}

export interface YoofloeBundleRequest {
  domains: YoofloeDomain[];
  range: YoofloeRange;
  includeRaw: boolean;
  includeFrontmatterHints: boolean;
}

export interface YoofloeGardenerBriefRequest {
  domains: YoofloeDomain[];
  range: YoofloeRange;
  format: "json" | "markdown";
}

export class YoofloeMcpHttpError extends Error {
  status: number;
  code?: string;
  body?: unknown;

  constructor(message: string, status: number, code?: string, body?: unknown) {
    super(message);
    this.name = "YoofloeMcpHttpError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

function normalizeBaseUrl(value: string) {
  return (value || DEFAULT_FUNCTIONS_BASE_URL).replace(/\/+$/, "");
}

function errorMessageFromBody(body: unknown, status: number) {
  if (body && typeof body === "object") {
    const payload = body as Record<string, unknown>;
    const message = payload.error || payload.message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }

  return `Yoofloe API request failed with status ${status}.`;
}

async function parseResponseBody(response: Response) {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function postJson<TResponse>(
  config: YoofloeMcpConfig,
  path: string,
  body: Record<string, unknown>
): Promise<TResponse> {
  const response = await fetch(`${normalizeBaseUrl(config.functionsBaseUrl)}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.pat}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const parsedBody = await parseResponseBody(response);

  if (!response.ok) {
    const code = parsedBody && typeof parsedBody === "object"
      ? (parsedBody as Record<string, unknown>).code
      : undefined;

    throw new YoofloeMcpHttpError(
      errorMessageFromBody(parsedBody, response.status),
      response.status,
      typeof code === "string" ? code : undefined,
      parsedBody
    );
  }

  return parsedBody as TResponse;
}

export class YoofloeMcpHttpClient {
  constructor(private readonly config: YoofloeMcpConfig) {}

  async fetchBundle(request: YoofloeBundleRequest): Promise<YoofloeDataApiResponse> {
    return await postJson<YoofloeDataApiResponse>(this.config, "obsidian-data-api", {
      domains: request.domains,
      range: request.range,
      scope: "personal",
      includeRaw: request.includeRaw,
      includeFrontmatterHints: request.includeFrontmatterHints
    });
  }

  async fetchGardenerBrief(request: YoofloeGardenerBriefRequest): Promise<YoofloeGardenerApiResponse> {
    return await postJson<YoofloeGardenerApiResponse>(this.config, "obsidian-gardener-api", {
      surface: "brief",
      domains: request.domains,
      range: request.range,
      scope: "personal",
      format: request.format
    });
  }

  async testToken() {
    const response = await this.fetchBundle({
      domains: ["schedule"],
      range: "1W",
      includeRaw: false,
      includeFrontmatterHints: false
    });

    return {
      ok: true,
      generatedAt: response.generatedAt,
      entitlement: response.entitlement,
      rateLimit: response.rateLimit,
      bundleMeta: response.bundle.meta
    };
  }
}

export function defaultFunctionsBaseUrl() {
  return DEFAULT_FUNCTIONS_BASE_URL;
}
