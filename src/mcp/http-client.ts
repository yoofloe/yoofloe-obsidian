import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { describeAccessError, parseAccessStatus, parseSecurityContract } from "../external-access";
import type {
  YoofloeDataApiResponse,
  YoofloeAccessStatusResponse,
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
  configurationIssues?: Array<{ code: string; message: string }>;
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

function parseResponseBody(text: string) {
  if (!text) return null;

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function postJsonRequest(url: string, pat: string, body?: Record<string, unknown>) {
  if (!pat) throw new YoofloeMcpHttpError("Configure YOOFLOE_PAT before requesting Yoofloe access.", 0, "PAT_MISSING");
  const targetUrl = new URL(url);
  if ((targetUrl.protocol !== "https:" && !(targetUrl.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(targetUrl.hostname)))
    || targetUrl.username || targetUrl.password) throw new Error("Use an HTTPS Yoofloe endpoint or a local test server.");
  const requestBody = body === undefined ? undefined : JSON.stringify(body);
  const requestFn = targetUrl.protocol === "https:" ? httpsRequest : httpRequest;

  return await new Promise<{ status: number; body: unknown; }>((resolve, reject) => {
    const request = requestFn(targetUrl, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${pat}`,
        "Content-Type": "application/json",
        ...(requestBody === undefined ? {} : { "Content-Length": Buffer.byteLength(requestBody) })
      }
    }, (response) => {
      const chunks: Buffer[] = [];
      let responseBytes = 0;

      response.on("data", (chunk: Buffer | string) => {
        responseBytes += Buffer.byteLength(chunk);
        if (responseBytes > 8 * 1024 * 1024) {
          request.destroy(new Error("Yoofloe response exceeded the safe size limit."));
          return;
        }
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      });
      response.on("error", reject);

      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: response.statusCode ?? 500,
          body: parseResponseBody(text)
        });
      });
    });

    request.on("error", reject);
    request.setTimeout(15000, () => request.destroy(new Error("Yoofloe request timed out.")));
    if (requestBody !== undefined) request.write(requestBody);
    request.end();
  });
}

async function postJson<TResponse>(
  config: YoofloeMcpConfig,
  path: string,
  body?: Record<string, unknown>
): Promise<TResponse> {
  const response = await postJsonRequest(`${normalizeBaseUrl(config.functionsBaseUrl)}/${path}`, config.pat, body);

  if (response.status >= 400) {
    const code = body === undefined && (response.status === 404 || response.status === 405)
      ? "CLIENT_UPDATE_REQUIRED" : response.body && typeof response.body === "object"
      ? (response.body as Record<string, unknown>).code
      : undefined;

    throw new YoofloeMcpHttpError(
      describeAccessError(response.status, typeof code === "string" ? code : undefined),
      response.status,
      typeof code === "string" ? code : undefined,
      response.body
    );
  }

  return response.body as TResponse;
}

export class YoofloeMcpHttpClient {
  accessStatus: YoofloeAccessStatusResponse | null = null;
  constructor(private readonly config: YoofloeMcpConfig) {}

  async fetchBundle(request: YoofloeBundleRequest): Promise<YoofloeDataApiResponse> {
    const response = await postJson<YoofloeDataApiResponse>(this.config, "obsidian-data-api", {
      domains: request.domains,
      range: request.range,
      scope: "personal",
      includeRaw: request.includeRaw,
      includeFrontmatterHints: request.includeFrontmatterHints
    });
    parseSecurityContract(response?.bundle?.meta?.security);
    return response;
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
    this.accessStatus = null;
    const response = parseAccessStatus(await postJson(this.config, "obsidian-data-api"));
    this.accessStatus = response;
    return { ok: response.entitlement.allowed, ...response };
  }
}

export function defaultFunctionsBaseUrl() {
  return DEFAULT_FUNCTIONS_BASE_URL;
}
