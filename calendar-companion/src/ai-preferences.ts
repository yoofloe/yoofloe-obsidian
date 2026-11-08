import { validateOpenAiKey } from "./openai";
import { validateGeminiKey } from "./gemini";
import { DEFAULT_OPENAI_MODEL } from "./openai-models";
import { isAiModelId, isAiProvider, modelCatalog, providerLabel } from "./ai-models";
import type { AiModelOptions, AiProvider } from "./ai-session";

export const DEFAULT_OPENAI_OPTIONS: AiModelOptions = { model: DEFAULT_OPENAI_MODEL };
export interface AiPreferenceHost {
  current(): boolean; binding(): string; load(): Promise<unknown>; save(value: unknown): Promise<void>;
  secrets(): { getSecret(id: string): string | null; setSecret(id: string, secret: string): void } | null;
}
function settings(raw: unknown): Record<string, unknown> { return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {}; }

/** Provider/model choices are local settings. Each provider has a separate vault-bound secret ID. */
export class AiPreferences {
  constructor(private readonly host: AiPreferenceHost) {}
  private guard() { if (!this.host.current()) throw Error("The vault changed. Reopen AI settings in the current vault."); }
  async readProvider(): Promise<AiProvider> {
    this.guard(); const raw = settings(await this.host.load()); this.guard();
    return raw.aiProvider === "gemini" ? "gemini" : "openai";
  }
  async selectProvider(provider: AiProvider): Promise<void> {
    this.guard(); if (!isAiProvider(provider)) throw Error("Choose OpenAI or Gemini.");
    const previous = settings(await this.host.load()); this.guard();
    await this.host.save({ ...previous, aiProvider: provider }); this.guard();
  }
  async read(provider: AiProvider = "openai"): Promise<AiModelOptions> {
    this.guard(); if (!isAiProvider(provider)) throw Error("Unsupported provider.");
    const raw = settings(await this.host.load()); this.guard();
    const saved = settings(raw[provider]);
    return { model: typeof saved.model === "string" && saved.model.length <= 128 && saved.model.trim() ? saved.model : modelCatalog(provider).defaultModel };
  }
  async save(options: AiModelOptions, provider: AiProvider = "openai"): Promise<void> {
    this.guard();
    if (!isAiProvider(provider) || !isAiModelId(provider, options.model)) throw Error("Choose a valid API model ID.");
    const previous = settings(await this.host.load()); this.guard();
    await this.host.save({ ...previous, [provider]: { model: options.model } }); this.guard();
  }
  private async secretId(provider: AiProvider): Promise<string> {
    this.guard(); if (!isAiProvider(provider)) throw Error("Unsupported provider.");
    const binding = this.host.binding();
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(binding)); this.guard();
    if (binding !== this.host.binding()) throw Error("The vault changed.");
    return `ycc-${provider}-` + Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
  }
  async key(provider: AiProvider = "openai"): Promise<string | null> {
    const id = await this.secretId(provider); this.guard();
    const storage = this.host.secrets();
    if (!storage) throw Error(`${providerLabel(provider)} keys require Obsidian secret storage. Update Obsidian before configuring a key.`);
    return storage.getSecret(id)?.trim() || null;
  }
  async hasKey(provider: AiProvider = "openai"): Promise<boolean> { return Boolean(await this.key(provider)); }
  async saveKey(value: string, provider: AiProvider = "openai"): Promise<void> {
    if (!isAiProvider(provider)) throw Error("Unsupported provider.");
    const key = provider === "gemini" ? validateGeminiKey(value) : validateOpenAiKey(value), id = await this.secretId(provider); this.guard();
    const storage = this.host.secrets(); if (!storage) throw Error("Obsidian secret storage is unavailable.");
    storage.setSecret(id, key);
  }
  async clearKey(provider: AiProvider = "openai"): Promise<void> {
    const id = await this.secretId(provider); this.guard();
    const storage = this.host.secrets(); if (!storage) throw Error("Obsidian secret storage is unavailable.");
    storage.setSecret(id, "");
  }
}
