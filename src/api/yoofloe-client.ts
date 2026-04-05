import { requestUrl } from "obsidian";
import type { YoofloeDataApiResponse, YoofloeDomain, YoofloePluginSettings, YoofloeRange, YoofloeScope } from "../types";

type BundleRequest = {
  domains: YoofloeDomain[];
  range: YoofloeRange;
  scope: YoofloeScope;
  includeRaw: boolean;
  includeFrontmatterHints: boolean;
};

function joinUrl(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

async function postJson<T>(settings: YoofloePluginSettings, path: string, body: Record<string, unknown>): Promise<T> {
  const token = settings.apiToken.trim();
  if (!token) {
    throw new Error("Yoofloe API token is missing.");
  }

  const response = await requestUrl({
    url: joinUrl(settings.functionsBaseUrl, path),
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (response.status >= 400) {
    const payload = response.json || {};
    const message = typeof payload?.error === "string" ? payload.error : `Yoofloe request failed with status ${response.status}`;
    throw new Error(message);
  }

  return response.json as T;
}

export class YoofloeClient {
  constructor(private readonly settings: YoofloePluginSettings) {}

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
    return postJson<YoofloeDataApiResponse>(this.settings, "obsidian-data-api", request);
  }
}
