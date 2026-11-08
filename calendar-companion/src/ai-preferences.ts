import { validateOpenAiKey, type OpenAiOptions } from "./openai";

export const DEFAULT_OPENAI_OPTIONS: OpenAiOptions = { model: "", maxOutputTokens: 512 };
export interface AiPreferenceHost {
  current(): boolean; binding(): string; load(): Promise<unknown>; save(value: unknown): Promise<void>;
  secrets(): { getSecret(id: string): string | null; setSecret(id: string, secret: string): void } | null;
}

/** Model settings may live in data.json. API keys use a vault-bound Obsidian secret ID only. */
export class AiPreferences {
  constructor(private readonly host: AiPreferenceHost) {}
  private guard() { if (!this.host.current()) throw Error("The vault changed. Reopen OpenAI settings in the current vault."); }
  async read(): Promise<OpenAiOptions> {
    this.guard(); const raw = await this.host.load(); this.guard();
    const value = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { openai?: unknown }).openai : null;
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_OPENAI_OPTIONS };
    const saved = value as { model?: unknown; maxOutputTokens?: unknown };
    return { model: typeof saved.model === "string" && saved.model.length <= 128 ? saved.model : "",
      maxOutputTokens: Number.isSafeInteger(saved.maxOutputTokens) && (saved.maxOutputTokens as number) >= 128 && (saved.maxOutputTokens as number) <= 4096 ? saved.maxOutputTokens as number : 512 };
  }
  async save(options: OpenAiOptions): Promise<void> {
    this.guard();
    if (options.model.length > 128 || (options.model !== "" && !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(options.model)) || !Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens < 128 || options.maxOutputTokens > 4096) throw Error("Enter a model ID and a token limit between 128 and 4096.");
    const raw = await this.host.load(); this.guard();
    const previous = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    await this.host.save({ ...previous, openai: { model: options.model, maxOutputTokens: options.maxOutputTokens } }); this.guard();
  }
  private async secretId(): Promise<string> {
    this.guard(); const binding = this.host.binding();
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(binding)); this.guard();
    if (binding !== this.host.binding()) throw Error("The vault changed.");
    return "ycc-openai-" + Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
  }
  async key(): Promise<string | null> {
    const id = await this.secretId(); this.guard();
    const storage = this.host.secrets();
    if (!storage) throw Error("OpenAI keys require Obsidian secret storage. Update Obsidian before configuring a key.");
    return storage.getSecret(id)?.trim() || null;
  }
  async hasKey(): Promise<boolean> { return Boolean(await this.key()); }
  async saveKey(value: string): Promise<void> {
    const key = validateOpenAiKey(value), id = await this.secretId(); this.guard();
    const storage = this.host.secrets(); if (!storage) throw Error("Obsidian secret storage is unavailable.");
    storage.setSecret(id, key);
  }
  async clearKey(): Promise<void> {
    const id = await this.secretId(); this.guard();
    const storage = this.host.secrets(); if (!storage) throw Error("Obsidian secret storage is unavailable.");
    storage.setSecret(id, "");
  }
}
