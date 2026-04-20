import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
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

function parseResponseBody(text: string) {
  if (!text) return null;

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function postJsonRequest(url: string, pat: string, body: Record<string, unknown>) {
  const targetUrl = new URL(url);
  const requestBody = JSON.stringify(body);
  const requestFn = targetUrl.protocol === "https:" ? httpsRequest : httpRequest;

  return await new Promise<{ status: number; body: unknown; }>((resolve, reject) => {
    const request = requestFn(targetUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pat}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(requestBody)
      }
    }, (response) => {
      const chunks: Buffer[] = [];

      response.on("data", (chunk: Buffer | string) => {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      });

      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: response.statusCode ?? 500,
          body: parseResponseBody(text)
        });
      });
    });

    request.on("error", reject);
    request.write(requestBody);
    request.end();
  });
}

async function postJson<TResponse>(
  config: YoofloeMcpConfig,
  path: string,
  body: Record<string, unknown>
): Promise<TResponse> {
  const response = await postJsonRequest(`${normalizeBaseUrl(config.functionsBaseUrl)}/${path}`, config.pat, body);

  if (response.status >= 400) {
    const code = response.body && typeof response.body === "object"
      ? (response.body as Record<string, unknown>).code
      : undefined;

    throw new YoofloeMcpHttpError(
      errorMessageFromBody(response.body, response.status),
      response.status,
      typeof code === "string" ? code : undefined,
      response.body
    );
  }

  return response.body as TResponse;
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
