import { requestUrl } from "obsidian";
import type {
  YoofloeDataApiResponse,
  YoofloeDomain,
  YoofloeGardenerApiResponse,
  YoofloePluginSettings,
  YoofloeRange,
  YoofloeScope
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

export class YoofloeApiError extends Error {
  status: number;
  body?: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = "YoofloeApiError";
    this.status = status;
    this.body = body;
  }
}

async function postJson<T>(settings: YoofloeClientSettings, token: string, path: string, body: Record<string, unknown>): Promise<T> {
  const trimmedToken = token.trim();
  if (!trimmedToken) {
    throw new Error("Yoofloe API token is missing.");
  }

  const response = await requestUrl({
    url: joinUrl(settings.functionsBaseUrl, path),
    method: "POST",
    headers: {
      Authorization: `Bearer ${trimmedToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (response.status >= 400) {
    const payload = response.json as Record<string, unknown> | null;
    const apiError = payload?.error;
    const message = typeof apiError === "string" ? apiError : `Yoofloe request failed with status ${response.status}`;
    throw new YoofloeApiError(message, response.status, payload);
  }

  return response.json as T;
}

export class YoofloeClient {
  constructor(
    private readonly settings: YoofloeClientSettings,
    private readonly token: string
  ) {}

  async testToken() {
    return this.fetchBundle({
      domains: ["garden"],
      range: "1M",
      scope: "personal",
      includeRaw: false,
      includeFrontmatterHints: false
    });
  }

  async fetchBundle(request: BundleRequest): Promise<YoofloeDataApiResponse> {
    return postJson<YoofloeDataApiResponse>(this.settings, this.token, "obsidian-data-api", request);
  }

  async fetchGardenerBrief(request: GardenerBriefRequest): Promise<YoofloeGardenerApiResponse> {
    return postJson<YoofloeGardenerApiResponse>(this.settings, this.token, "obsidian-gardener-api", {
      surface: "brief",
      domains: request.domains,
      range: request.range,
      scope: request.scope,
      format: request.format
    });
  }
}
