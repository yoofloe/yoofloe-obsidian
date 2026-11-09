import { validateOpenAiKey } from "./openai";
import { DEFAULT_OPENAI_MODEL } from "./openai-models";
import { isAiModelId, isAiProviderEnabled, modelCatalog, providerLabel } from "./ai-models";
import type { AiModelOptions, AiProvider } from "./ai-session";
import { isEffortSetting, resolveEffort } from "./effort";

export const DEFAULT_OPENAI_OPTIONS: AiModelOptions = { model: DEFAULT_OPENAI_MODEL };
/** Desktop resource URLs contain a changing cache timestamp. Android keeps the existing secret binding byte-for-byte. */
export function localSecretBinding(resource: string, basePath?: string): string { return basePath ? `file-system:${basePath.replaceAll("\\", "/")}` : resource; }
export interface AiPreferenceHost {
  current(): boolean; binding(): string; load(): Promise<unknown>; save(value: unknown): Promise<void>;
  secrets(): { getSecret(id: string): string | null; setSecret(id: string, secret: string): void } | null;
}
function settings(raw: unknown): Record<string, unknown> { return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {}; }

/** Provider/model choices are local settings. Each provider has a separate vault-bound secret ID. */
export class AiPreferences {
  private mutation: Promise<void> = Promise.resolve();
  constructor(private readonly host: AiPreferenceHost) {}
  private guard() { if (!this.host.current()) throw Error("The vault changed. Reopen AI settings in the current vault."); }
  private update(change: (previous: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
    const next = this.mutation.then(async () => { this.guard(); const previous = settings(await this.host.load()); this.guard(); const changed = change(previous); if (changed !== previous) await this.host.save(changed); this.guard(); });
    this.mutation = next.catch(() => {}); return next;
  }
  /** A non-secret stable identity; adding it preserves all existing settings and secret IDs. */
  async vaultId(): Promise<string> {
    let id = "";
    await this.update(previous => {
      const saved = previous.calendarVaultId;
      id = typeof saved === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(saved) ? saved : crypto.randomUUID();
      return saved === id ? previous : { ...previous, calendarVaultId: id };
    }); return id;
  }
  async readProvider(): Promise<AiProvider> {
    this.guard(); const raw = settings(await this.host.load()); this.guard();
    return isAiProviderEnabled(raw.aiProvider) ? raw.aiProvider : "openai";
  }
  async selectProvider(provider: AiProvider): Promise<void> {
    this.guard(); if (!isAiProviderEnabled(provider)) throw Error("This AI provider is unavailable in this version.");
    await this.update(previous => ({ ...previous, aiProvider: provider }));
  }
  async read(provider: AiProvider = "openai"): Promise<AiModelOptions> {
    this.guard(); if (!isAiProviderEnabled(provider)) throw Error("Unsupported provider.");
    const raw = settings(await this.host.load()); this.guard();
    const saved = settings(raw[provider]);
    const model = typeof saved.model === "string" && saved.model.length <= 128 && saved.model.trim() ? saved.model : modelCatalog(provider).defaultModel;
    try { if (isEffortSetting(saved.effort)) { resolveEffort(model, saved.effort); return { model, effort: saved.effort }; } } catch { /* A changed model cannot inherit an unsupported value. */ }
    return { model };
  }
  async save(options: AiModelOptions, provider: AiProvider = "openai"): Promise<void> {
    this.guard();
    if (!isAiProviderEnabled(provider) || !isAiModelId(provider, options.model)) throw Error("Choose a valid API model ID.");
    resolveEffort(options.model, options.effort);
    await this.update(previous => { const providerSettings: Record<string, unknown> = { ...settings(previous[provider]), model: options.model }; delete providerSettings.maxOutputTokens; delete providerSettings.effort; if (options.effort !== undefined) providerSettings.effort = options.effort; return { ...previous, [provider]: providerSettings }; });
  }
  private async secretId(provider: AiProvider): Promise<string> {
    this.guard(); if (!isAiProviderEnabled(provider)) throw Error("Unsupported provider.");
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
    if (!isAiProviderEnabled(provider)) throw Error("Unsupported provider.");
    const key = validateOpenAiKey(value), id = await this.secretId(provider); this.guard();
    const storage = this.host.secrets(); if (!storage) throw Error("Obsidian secret storage is unavailable.");
    storage.setSecret(id, key);
    this.guard();
    if (storage.getSecret(id) !== key) throw Error("The key could not be confirmed in local secret storage.");
  }
  async clearKey(provider: AiProvider = "openai"): Promise<void> {
    const id = await this.secretId(provider); this.guard();
    const storage = this.host.secrets(); if (!storage) throw Error("Obsidian secret storage is unavailable.");
    storage.setSecret(id, "");
  }
}
