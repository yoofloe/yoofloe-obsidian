import { Notice, Plugin, normalizePath } from "obsidian";
import { AGENT_DIRECT_GUIDE_URL, buildAgentSetupNoteMarkdown } from "./agent-guidance";
import { runAiDocumentAnalysis } from "./ai/byok-client";
import { getAiDocumentDefinition } from "./ai/prompts";
import { YoofloeApiError, YoofloeClient } from "./api/yoofloe-client";
import { requestDeepDiveFocusInstruction } from "./focus-modal";
import { renderAiNoteMarkdown } from "./generators/ai-note";
import { YoofloeGoogleAuthManager } from "./google-auth";
import { migrateLegacySecretsFromSettings, SECRET_STORAGE_REQUIRED_MESSAGE, YoofloeSecretStore } from "./secrets";
import { YoofloeSettingTab } from "./settings";
import { YOOFLOE_DOMAINS } from "./types";
import type { YoofloeAiDocumentType, YoofloeBundle, YoofloeEntitlement, YoofloePluginSettings } from "./types";

const DEFAULT_SETTINGS: YoofloePluginSettings = {
  apiToken: "",
  functionsBaseUrl: "https://hhiyerojemcujzcmlzao.supabase.co/functions/v1",
  savePath: "Yoofloe",
  dateFormat: "YYYY-MM-DD",
  language: "en",
  defaultRange: "1M",
  defaultScope: "personal",
  includeRawData: false,
  autoFrontmatter: true,
  provider: {
    type: "none",
    clientId: "",
    googleConnected: false,
    googleLastConnectState: "idle",
    googleLastConnectMessage: "",
    project: "",
    location: "us-central1",
    googleModel: "gemini-2.5-flash-lite",
    vertexModel: "gemini-2.5-flash-lite"
  }
};

const SUPPORTED_PLUGIN_PROVIDERS = new Set<YoofloePluginSettings["provider"]["type"]>([
  "none",
  "gemini-google",
  "gemini-vertex"
]);

const PRO_REQUIRED_NOTICE = "Yoofloe External AI Access requires an active Pro plan. This Obsidian plugin uses a Yoofloe PAT, while Yoofloe CLI and CLI MCP use app login.";
const PRO_REQUIRED_SETTINGS_MESSAGE = "This Yoofloe account does not currently include External AI Access. Upgrade to Pro to keep using the Obsidian plugin, CLI, and MCP surfaces.";

function isBlockedEntitlement(entitlement: YoofloeEntitlement | null | undefined) {
  return entitlement?.allowed === false;
}

function entitlementFromApiError(error: YoofloeApiError) {
  const body = error.body;
  if (!body || typeof body !== "object") return null;

  const entitlement = (body as Record<string, unknown>).entitlement;
  if (!entitlement || typeof entitlement !== "object") return null;

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

function isPaywallMessage(message: string) {
  return /pro|plan|subscription|upgrade|not entitled|entitlement|does not currently include obsidian access|obsidian access requires/i.test(message);
}

function requireDesktopModule<T>(specifier: string): T {
  const runtimeRequire = typeof require === "function"
    ? require
    : (globalThis as { require?: NodeJS.Require }).require;

  if (!runtimeRequire) {
    throw new Error("This action is available only in the desktop Obsidian runtime.");
  }

  return runtimeRequire(specifier) as T;
}

type AiDocumentCommandDefinition = {
  id: string;
  name: string;
  documentType: YoofloeAiDocumentType;
};

function formatDate(date: Date, format: YoofloePluginSettings["dateFormat"]) {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");

  switch (format) {
    case "YYYYMMDD":
      return `${yyyy}${mm}${dd}`;
    case "YYYY.MM.DD":
      return `${yyyy}.${mm}.${dd}`;
    case "YYYY-MM-DD":
    default:
      return `${yyyy}-${mm}-${dd}`;
  }
}

async function ensureFolderPath(plugin: YoofloePlugin, path: string) {
  const normalized = normalizePath(path);
  if (!normalized || normalized === ".") return;
  if (await plugin.app.vault.adapter.exists(normalized)) return;

  const segments = normalized.split("/");
  let current = "";
  for (const segment of segments) {
    current = current ? normalizePath(`${current}/${segment}`) : segment;
    if (!(await plugin.app.vault.adapter.exists(current))) {
      await plugin.app.vault.createFolder(current);
    }
  }
}

async function uniqueFilePath(plugin: YoofloePlugin, surface: string) {
  const folder = normalizePath(plugin.settings.savePath);
  const stamp = formatDate(new Date(), plugin.settings.dateFormat);
  let attempt = 1;

  while (true) {
    const suffix = attempt === 1 ? "" : `__${attempt}`;
    const candidate = normalizePath(`${folder}/${stamp}__${surface}${suffix}.md`);
    if (!(await plugin.app.vault.adapter.exists(candidate))) {
      return candidate;
    }
    attempt += 1;
  }
}

export default class YoofloePlugin extends Plugin {
  settings: YoofloePluginSettings = DEFAULT_SETTINGS;
  secretStore!: YoofloeSecretStore;
  googleAuth!: YoofloeGoogleAuthManager;
  tokenStatus: "missing" | "saved" | "verified" | "invalid" = "missing";
  googleConnectionStatus: "not-connected" | "connected" | "reconnect" = "not-connected";
  latestEntitlement: YoofloeEntitlement | null = null;
  private statusEl: HTMLElement | null = null;
  private statusResetTimer: number | null = null;

  async onload() {
    await this.loadSettings();
    const migrationMessages = this.migrateLegacyProviderSettings();
    this.secretStore = new YoofloeSecretStore(this.app);
    this.googleAuth = new YoofloeGoogleAuthManager(this.secretStore);
    this.refreshOnboardingStatuses();
    await this.refreshGoogleConnectionStatus();
    if (migrateLegacySecretsFromSettings(this.settings, this.secretStore) || migrationMessages.length > 0) {
      await this.saveSettings();
      this.refreshOnboardingStatuses();
      await this.refreshGoogleConnectionStatus();
    }
    this.statusEl = this.addStatusBarItem();
    this.setStatus("Yoofloe idle");

    this.addSettingTab(new YoofloeSettingTab(this.app, this));
    this.registerCommands();

    for (const message of migrationMessages) {
      new Notice(message);
    }
  }

  onunload() {
    this.clearStatusResetTimer();
    this.statusEl?.remove();
    this.statusEl = null;
  }

  async loadSettings() {
    const saved = (await this.loadData()) as Partial<YoofloePluginSettings> | null;
    const savedProvider = (saved?.provider || {}) as Partial<YoofloePluginSettings["provider"]> & {
      type?: string;
      model?: string;
    };
    const rawProviderType: string = typeof savedProvider.type === "string" ? savedProvider.type : DEFAULT_SETTINGS.provider.type;
    const legacyModel = typeof savedProvider.model === "string" ? savedProvider.model.trim() : "";
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...saved,
      provider: {
        type: rawProviderType as YoofloePluginSettings["provider"]["type"],
        clientId: typeof savedProvider.clientId === "string" ? savedProvider.clientId : DEFAULT_SETTINGS.provider.clientId,
        googleConnected: !!savedProvider.googleConnected,
        googleLastConnectState: savedProvider.googleLastConnectState || DEFAULT_SETTINGS.provider.googleLastConnectState,
        googleLastConnectMessage: typeof savedProvider.googleLastConnectMessage === "string"
          ? savedProvider.googleLastConnectMessage
          : DEFAULT_SETTINGS.provider.googleLastConnectMessage,
        project: typeof savedProvider.project === "string" ? savedProvider.project : DEFAULT_SETTINGS.provider.project,
        location: typeof savedProvider.location === "string" ? savedProvider.location : DEFAULT_SETTINGS.provider.location,
        googleModel: typeof savedProvider.googleModel === "string" ? savedProvider.googleModel : DEFAULT_SETTINGS.provider.googleModel,
        vertexModel: typeof savedProvider.vertexModel === "string" ? savedProvider.vertexModel : DEFAULT_SETTINGS.provider.vertexModel
      }
    };

    if (!SUPPORTED_PLUGIN_PROVIDERS.has(this.settings.provider.type) && rawProviderType !== "openai" && rawProviderType !== "anthropic") {
      this.settings.provider.type = "none";
    }

    const savedGoogleModel = typeof savedProvider.googleModel === "string" ? savedProvider.googleModel.trim() : "";
    const savedVertexModel = typeof savedProvider.vertexModel === "string" ? savedProvider.vertexModel.trim() : "";

    if (!savedGoogleModel && legacyModel && (rawProviderType === "gemini" || rawProviderType === "gemini-google")) {
      this.settings.provider.googleModel = legacyModel;
    }

    if (!savedVertexModel && legacyModel && rawProviderType === "gemini-vertex") {
      this.settings.provider.vertexModel = legacyModel;
    }

    if (!this.settings.provider.googleModel.trim()) {
      this.settings.provider.googleModel = DEFAULT_SETTINGS.provider.googleModel;
    }

    if (!this.settings.provider.vertexModel.trim()) {
      this.settings.provider.vertexModel = DEFAULT_SETTINGS.provider.vertexModel;
    }

    if (!this.settings.provider.location.trim()) {
      this.settings.provider.location = DEFAULT_SETTINGS.provider.location;
    }
  }

  async saveSettings() {
    this.settings.apiToken = "";
    this.settings.provider.clientId = this.settings.provider.clientId.trim();
    this.settings.provider.googleConnected = !!this.settings.provider.googleConnected;
    if (!this.settings.provider.googleLastConnectState) {
      this.settings.provider.googleLastConnectState = "idle";
    }
    this.settings.provider.googleLastConnectMessage = this.settings.provider.googleLastConnectMessage?.trim() || "";
    this.settings.provider.project = this.settings.provider.project.trim();
    this.settings.provider.location = this.settings.provider.location.trim() || DEFAULT_SETTINGS.provider.location;
    this.settings.provider.googleModel = this.settings.provider.googleModel.trim() || DEFAULT_SETTINGS.provider.googleModel;
    this.settings.provider.vertexModel = this.settings.provider.vertexModel.trim() || DEFAULT_SETTINGS.provider.vertexModel;
    await this.saveData({
      ...this.settings,
      apiToken: "",
      provider: {
        type: this.settings.provider.type,
        clientId: this.settings.provider.clientId,
        googleConnected: this.settings.provider.googleConnected,
        googleLastConnectState: this.settings.provider.googleLastConnectState,
        googleLastConnectMessage: this.settings.provider.googleLastConnectMessage,
        project: this.settings.provider.project,
        location: this.settings.provider.location,
        googleModel: this.settings.provider.googleModel,
        vertexModel: this.settings.provider.vertexModel
      }
    });
    this.refreshOnboardingStatuses();
  }

  refreshOnboardingStatuses() {
    if (!this.secretStore?.isAvailable) {
      this.tokenStatus = "missing";
      this.googleConnectionStatus = "not-connected";
      return;
    }

    if (!this.secretStore.getPat()) {
      this.tokenStatus = "missing";
    } else if (this.tokenStatus === "missing") {
      this.tokenStatus = "saved";
    }

    if (!this.googleAuth?.hasRefreshToken()) {
      this.googleConnectionStatus = this.settings.provider.googleConnected ? "connected" : "not-connected";
    }
  }

  async refreshGoogleConnectionStatus() {
    if (!this.secretStore?.isAvailable || !this.googleAuth?.hasRefreshToken()) {
      this.googleConnectionStatus = this.settings.provider.googleConnected ? "connected" : "not-connected";
      return;
    }

    if (!this.settings.provider.clientId.trim()) {
      this.googleConnectionStatus = "reconnect";
      return;
    }

    this.googleConnectionStatus = "connected";
  }

  private migrateLegacyProviderSettings() {
    const messages: string[] = [];
    const legacyModel = ((this.settings.provider as unknown as { model?: string }).model || "").trim();

    if ((this.settings.provider.type as string) === "openai" || (this.settings.provider.type as string) === "anthropic") {
      this.settings.provider.type = "none";
      messages.push("OpenAI and Anthropic support were removed. Choose Gemini in Settings > Yoofloe if you want AI commands.");
    }

    if ((this.settings.provider.type as string) === "gemini") {
      this.settings.provider.type = "gemini-google";
      if (!this.settings.provider.googleModel.trim() && legacyModel) {
        this.settings.provider.googleModel = legacyModel;
      }
      messages.push("Gemini now uses Google OAuth in v0.3.0. Connect Google in Settings > Yoofloe before running Gemini commands.");
    }

    if (this.settings.provider.type === "gemini-vertex" && !this.settings.provider.vertexModel.trim() && legacyModel) {
      this.settings.provider.vertexModel = legacyModel;
    }

    return messages;
  }

  isGoogleProvider(provider = this.settings.provider.type) {
    return provider === "gemini-google" || provider === "gemini-vertex";
  }

  async connectGoogle() {
    if (!this.secretStore.isAvailable) {
      throw new Error(SECRET_STORAGE_REQUIRED_MESSAGE);
    }

    this.settings.provider.googleLastConnectState = "pending";
    this.settings.provider.googleLastConnectMessage = "Waiting for Google sign-in to finish.";
    await this.saveSettings();
    await this.googleAuth.connect(this.settings.provider.clientId, this.secretStore.getGoogleClientSecret());
    this.settings.provider.googleConnected = true;
    this.settings.provider.googleLastConnectState = "success";
    this.settings.provider.googleLastConnectMessage = "Google OAuth connected and refresh token saved.";
    await this.saveSettings();
    this.googleConnectionStatus = "connected";
  }

  async disconnectGoogle() {
    this.googleAuth.clearSession();
    this.settings.provider.googleConnected = false;
    this.settings.provider.googleLastConnectState = "idle";
    this.settings.provider.googleLastConnectMessage = "";
    await this.saveSettings();
    await this.refreshGoogleConnectionStatus();
  }

  private setStatus(text: string) {
    this.statusEl?.setText(text);
  }

  getEntitlementBannerMessage() {
    return isBlockedEntitlement(this.latestEntitlement) ? PRO_REQUIRED_SETTINGS_MESSAGE : "";
  }

  getEntitlementNoticeMessage() {
    return PRO_REQUIRED_NOTICE;
  }

  getUserFacingErrorMessage(error: unknown, fallbackMessage: string) {
    return this.normalizeUserFacingError(error, fallbackMessage);
  }

  setLatestEntitlement(entitlement: YoofloeEntitlement | null | undefined) {
    this.updateEntitlement(entitlement);
  }

  private updateEntitlement(entitlement: YoofloeEntitlement | null | undefined) {
    if (entitlement) {
      this.latestEntitlement = entitlement;
    }
  }

  private ensureEntitlement(entitlement: YoofloeEntitlement | null | undefined) {
    this.updateEntitlement(entitlement);
    if (isBlockedEntitlement(entitlement)) {
      throw new Error(PRO_REQUIRED_NOTICE);
    }
  }

  private normalizeUserFacingError(error: unknown, fallbackMessage: string) {
    if (error instanceof YoofloeApiError) {
      const entitlement = entitlementFromApiError(error);
      this.updateEntitlement(entitlement);
      if (isBlockedEntitlement(entitlement) || isPaywallMessage(error.message)) {
        if (!entitlement) {
          this.latestEntitlement = {
            allowed: false,
            tier: "",
            source: "plugin",
            status: "paywall"
          };
        }
        return PRO_REQUIRED_NOTICE;
      }
      return error.message;
    }

    if (error instanceof Error) {
      if (isPaywallMessage(error.message)) {
        this.latestEntitlement = {
          allowed: false,
          tier: "",
          source: "plugin",
          status: "paywall"
        };
        return PRO_REQUIRED_NOTICE;
      }
      return error.message;
    }

    return fallbackMessage;
  }

  private clearStatusResetTimer() {
    if (this.statusResetTimer !== null) {
      window.clearTimeout(this.statusResetTimer);
      this.statusResetTimer = null;
    }
  }

  private queueIdleStatusReset(delayMs = 2500) {
    this.clearStatusResetTimer();
    this.statusResetTimer = window.setTimeout(() => {
      this.statusResetTimer = null;
      this.setStatus("Yoofloe idle");
    }, delayMs);
  }

  private requirePat() {
    if (!this.secretStore.isAvailable) {
      throw new Error(SECRET_STORAGE_REQUIRED_MESSAGE);
    }

    const token = this.secretStore.getPat();
    if (!token) {
      this.tokenStatus = "missing";
      throw new Error("Yoofloe API token is missing. Open Settings > Yoofloe and add your pat_yfl_ token.");
    }

    return token;
  }

  private registerCommands() {
    const aiCommands: AiDocumentCommandDefinition[] = [
      { id: "ai-insight-brief", name: "Yoofloe: AI Insight Brief", documentType: "insight-brief" },
      { id: "ai-decision-memo", name: "Yoofloe: AI Decision Memo", documentType: "decision-memo" },
      { id: "ai-action-plan", name: "Yoofloe: AI Action Plan", documentType: "action-plan" },
      { id: "ai-deep-dive", name: "Yoofloe: AI Deep Dive", documentType: "deep-dive" }
    ];

    for (const command of aiCommands) {
      this.addCommand({
        id: command.id,
        name: command.name,
        callback: async () => {
          await this.runAiDocumentCommand(command);
        }
      });
    }

    this.addCommand({
      id: "write-agent-setup-note",
      name: "Yoofloe: Write Agent Setup Note",
      callback: async () => {
        try {
          this.clearStatusResetTimer();
          this.setStatus("Yoofloe writing agent setup note...");
          const filePath = await this.writeAgentSetupNote();
          this.setStatus("Yoofloe idle");
          new Notice(`Yoofloe agent setup note created: ${filePath}`);
        } catch (error) {
          this.setStatus("Yoofloe error");
          new Notice(this.normalizeUserFacingError(error, "Failed to write the Yoofloe agent setup note."));
          this.queueIdleStatusReset();
        }
      }
    });
  }

  private async writeAiFile({
    title,
    type,
    surface,
    bundle,
    body
  }: {
    title: string;
    type: string;
    surface: string;
    bundle: YoofloeBundle;
    body: string;
  }) {
    const filePath = await this.writeContentFile(
      surface,
      renderAiNoteMarkdown({
        title,
        type,
        bundle,
        settings: this.settings,
        pluginVersion: this.manifest.version,
        provider: this.settings.provider.type,
        body
      })
    );

    return filePath;
  }

  private async writeContentFile(surface: string, content: string) {
    await ensureFolderPath(this, this.settings.savePath);
    const filePath = await uniqueFilePath(this, surface);
    await this.app.vault.create(filePath, content);
    return filePath;
  }

  async writeAgentSetupNote() {
    return await this.writeContentFile(
      "agent-direct-setup",
      buildAgentSetupNoteMarkdown({
        pluginVersion: this.manifest.version,
        saveFolder: this.settings.savePath,
        functionsBaseUrl: this.settings.functionsBaseUrl
      })
    );
  }

  async openAgentDirectGuide() {
    const electron = requireDesktopModule<{ shell: { openExternal: (target: string) => Promise<unknown> | unknown; }; }>("electron");
    await Promise.resolve(electron.shell.openExternal(AGENT_DIRECT_GUIDE_URL));
  }

  private async fetchGardenerBriefMarkdown(client: YoofloeClient) {
    try {
      const response = await client.fetchGardenerBrief({
        domains: [...YOOFLOE_DOMAINS],
        range: this.settings.defaultRange,
        scope: this.settings.defaultScope,
        format: "markdown"
      });
      this.ensureEntitlement(response.entitlement);
      return response.rendered?.trim() || null;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (error instanceof YoofloeApiError || /token|401|unauthorized|invalid jwt|pro|plan|subscription|upgrade|not entitled|entitlement/i.test(message)) {
        throw error;
      }
      return null;
    }
  }

  private async runAiDocumentCommand(definition: AiDocumentCommandDefinition) {
    try {
      const token = this.requirePat();
      this.clearStatusResetTimer();
      this.setStatus(`Yoofloe generating ${definition.documentType}...`);

      const document = getAiDocumentDefinition(definition.documentType);
      const focusInstruction = document.requiresFocusInstruction
        ? await requestDeepDiveFocusInstruction(this.app)
        : null;

      if (document.requiresFocusInstruction && !focusInstruction) {
        this.setStatus("Yoofloe idle");
        return;
      }

      const client = new YoofloeClient(this.settings, token);
      const response = await client.fetchBundle({
        domains: [...YOOFLOE_DOMAINS],
        range: this.settings.defaultRange,
        scope: this.settings.defaultScope,
        includeRaw: this.settings.includeRawData,
        includeFrontmatterHints: true
      });
      this.ensureEntitlement(response.entitlement);
      const gardenerBrief = await this.fetchGardenerBriefMarkdown(client);

      const googleAccessToken = this.isGoogleProvider(this.settings.provider.type)
        ? await this.googleAuth.getAccessToken(this.settings.provider.clientId, this.secretStore.getGoogleClientSecret())
        : null;

      const body = await runAiDocumentAnalysis({
        settings: this.settings.provider,
        googleAccessToken,
        bundle: response.bundle,
        documentType: definition.documentType,
        gardenerBrief,
        focusInstruction
      });

      const filePath = await this.writeAiFile({
        title: document.title,
        type: document.type,
        surface: document.surface,
        bundle: response.bundle,
        body
      });

      this.setStatus("Yoofloe idle");
      new Notice(`Yoofloe AI note created: ${filePath}`);
    } catch (error) {
      this.setStatus("Yoofloe error");
      if (error instanceof Error) {
        if (/token|401|unauthorized|invalid jwt/i.test(error.message)) {
          this.tokenStatus = "invalid";
          this.latestEntitlement = null;
        }
        if (/reconnect google|connect your google account|session expired|invalid client id|invalid_client|unauthorized_client/i.test(error.message)) {
          this.settings.provider.googleConnected = false;
          this.settings.provider.googleLastConnectState = "error";
          this.settings.provider.googleLastConnectMessage = error.message;
          await this.saveSettings();
          this.googleConnectionStatus = "reconnect";
        }
      }
      new Notice(this.normalizeUserFacingError(error, "Yoofloe AI command failed."));
      this.queueIdleStatusReset();
    }
  }
}
