import { App, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import type YoofloePlugin from "./main";
import { buildClaudeCodePrompt, buildCodexPrompt, buildMcpConfigSnippet } from "./agent-guidance";
import { describeStoredSecret, SECRET_STORAGE_REQUIRED_MESSAGE } from "./secrets";
import { YOOFLOE_DOMAINS, YOOFLOE_OUTPUT_TARGETS, YOOFLOE_RANGES } from "./types";
import type { YoofloeDomain, YoofloeOutputTarget, YoofloePairingPhase, YoofloePairingStatus } from "./types";
import {
  YOOFLOE_PAIRING_PENDING_CONTRACT,
  YOOFLOE_WEB_PAIRING_URL
} from "./yoofloe-web";

type BadgeTone = "muted" | "accent" | "success" | "warning" | "danger";
type ByokModelTier = "recommended" | "fast" | "preview" | "compatibility";

interface GeminiByokModel {
  id: string;
  label: string;
  tier: ByokModelTier;
  description: string;
}

const RECOMMENDED_BYOK_MODEL = "gemini-3.5-flash";
const CUSTOM_BYOK_MODEL_OPTION = "__custom_model__";
const GEMINI_BYOK_MODELS: GeminiByokModel[] = [
  {
    id: "gemini-3.5-flash",
    label: "Gemini 3.5 Flash",
    tier: "recommended",
    description: "Recommended latest stable Gemini model for BYOK writing."
  },
  {
    id: "gemini-3.1-flash-lite",
    label: "Gemini 3.1 Flash-Lite",
    tier: "fast",
    description: "Fast, lower-cost Gemini 3.1 option for lightweight writing."
  },
  {
    id: "gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro Preview",
    tier: "preview",
    description: "Advanced reasoning preview; availability and limits may vary."
  },
  {
    id: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    tier: "compatibility",
    description: "Compatibility option for existing Google projects."
  },
  {
    id: "gemini-2.5-flash-lite",
    label: "Gemini 2.5 Flash-Lite",
    tier: "compatibility",
    description: "Older low-cost compatibility option."
  },
  {
    id: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    tier: "compatibility",
    description: "Older high-reasoning compatibility option."
  }
];

const DEFAULT_MODEL_PLACEHOLDER = RECOMMENDED_BYOK_MODEL;
const DEFAULT_PROJECT_PLACEHOLDER = "my-google-cloud-project";
const DEFAULT_VERTEX_LOCATION = "us-central1";
const SENSITIVE_DOMAINS = new Set<YoofloeDomain>(["finance", "business"]);

function domainLabel(domain: YoofloeDomain) {
  switch (domain) {
    case "schedule":
      return "Schedule";
    case "life":
      return "Life";
    case "wellness":
      return "Wellness";
    case "finance":
      return "Finance";
    case "business":
      return "Business";
    case "journal":
      return "Journal";
    case "garden":
      return "Garden";
  }
}

function outputTargetLabel(target: YoofloeOutputTarget) {
  switch (target) {
    case "append-current":
      return "Append to current note";
    case "insert-cursor":
      return "Insert at cursor";
    case "replace-selection":
      return "Replace selection";
    case "new-note":
    default:
      return "New Yoofloe note";
  }
}

function secureStorageWarning(hasSecureStorage: boolean) {
  if (!hasSecureStorage) {
    return `${SECRET_STORAGE_REQUIRED_MESSAGE} Token and Google sign-in setup are disabled until you upgrade Obsidian.`;
  }

  return "Yoofloe stores your PAT, Google sign-in client secret, and Google sign-in refresh token in Obsidian secure storage. Secrets are not written to data.json.";
}

function createBadge(containerEl: HTMLElement, text: string, tone: BadgeTone) {
  containerEl.createEl("span", {
    cls: `yoofloe-status-badge yoofloe-status-${tone}`,
    text
  });
}

function findByokModel(model: string) {
  const normalized = model.trim();
  return GEMINI_BYOK_MODELS.find((option) => option.id === normalized) ?? null;
}

function byokModelDropdownValue(model: string) {
  const normalized = model.trim();
  return findByokModel(normalized) ? normalized : CUSTOM_BYOK_MODEL_OPTION;
}

function byokModelTierLabel(tier: ByokModelTier) {
  switch (tier) {
    case "recommended":
      return "Recommended";
    case "fast":
      return "Fast / low cost";
    case "preview":
      return "Preview";
    case "compatibility":
      return "Compatibility";
  }
}

function byokModelTierTone(tier: ByokModelTier): BadgeTone {
  switch (tier) {
    case "recommended":
      return "success";
    case "fast":
      return "accent";
    case "preview":
      return "warning";
    case "compatibility":
      return "muted";
  }
}

function byokModelOptionLabel(option: GeminiByokModel) {
  return `${option.label} - ${byokModelTierLabel(option.tier)}`;
}

function createByokModelStatus(
  containerEl: HTMLElement,
  model: string,
  onUseRecommended: () => Promise<void>
) {
  const normalized = model.trim() || RECOMMENDED_BYOK_MODEL;
  const option = findByokModel(normalized);
  const row = containerEl.createDiv({ cls: "yoofloe-model-status" });

  if (option) {
    createBadge(row, byokModelTierLabel(option.tier), byokModelTierTone(option.tier));
    row.createEl("span", {
      cls: "yoofloe-model-status-text",
      text: `${option.id}: ${option.description}`
    });
  } else {
    createBadge(row, "Custom", "accent");
    row.createEl("span", {
      cls: "yoofloe-model-status-text",
      text: `${normalized}: custom model ID. Verify that your Google project and location can access it.`
    });
  }

  if (normalized !== RECOMMENDED_BYOK_MODEL) {
    const action = row.createEl("button", {
      cls: "yoofloe-inline-action",
      text: "Use recommended"
    });
    action.type = "button";
    action.addEventListener("click", () => {
      void onUseRecommended();
    });
  }
}

function createByokModelSetting(
  containerEl: HTMLElement,
  config: {
    name: string;
    desc: string;
    currentModel: string;
    emptyNotice: string;
    onSave: (model: string) => Promise<void>;
    onUseRecommended: () => Promise<void>;
  }
) {
  const normalizedCurrent = config.currentModel.trim() || RECOMMENDED_BYOK_MODEL;
  let selectedValue = byokModelDropdownValue(normalizedCurrent);
  let pendingCustomModel = selectedValue === CUSTOM_BYOK_MODEL_OPTION ? normalizedCurrent : "";

  let customInput: HTMLInputElement | null = null;
  const syncCustomInput = () => {
    if (!customInput) return;
    customInput.toggleAttribute("hidden", selectedValue !== CUSTOM_BYOK_MODEL_OPTION);
    customInput.disabled = selectedValue !== CUSTOM_BYOK_MODEL_OPTION;
  };

  new Setting(containerEl)
    .setName(config.name)
    .setDesc(config.desc)
    .addDropdown((dropdown) => {
      for (const option of GEMINI_BYOK_MODELS) {
        dropdown.addOption(option.id, byokModelOptionLabel(option));
      }
      dropdown.addOption(CUSTOM_BYOK_MODEL_OPTION, "Custom model ID...");
      dropdown.setValue(selectedValue).onChange((value) => {
        selectedValue = value;
        syncCustomInput();
      });
    })
    .addText((text) => {
      text
        .setPlaceholder(DEFAULT_MODEL_PLACEHOLDER)
        .setValue(pendingCustomModel)
        .onChange((value) => {
          pendingCustomModel = value.trim();
        });
      text.inputEl.classList.add("yoofloe-input-wide");
      customInput = text.inputEl;
      syncCustomInput();
    })
    .addButton((button) => {
      button
        .setButtonText("Save model")
        .onClick(async () => {
          const nextModel = selectedValue === CUSTOM_BYOK_MODEL_OPTION
            ? pendingCustomModel.trim()
            : selectedValue;

          if (!nextModel || nextModel === CUSTOM_BYOK_MODEL_OPTION) {
            new Notice(config.emptyNotice);
            return;
          }

          await config.onSave(nextModel);
        });
    });

  createByokModelStatus(containerEl, normalizedCurrent, config.onUseRecommended);
}

function createStepSection(
  containerEl: HTMLElement,
  step: string,
  title: string,
  badge: { text: string; tone: BadgeTone; },
  description: string
) {
  const section = containerEl.createDiv({ cls: "yoofloe-step-section" });
  const header = section.createDiv({ cls: "yoofloe-step-header" });
  const titleWrap = header.createDiv({ cls: "yoofloe-step-title-wrap" });
  titleWrap.createEl("div", { cls: "yoofloe-step-label", text: step });
  titleWrap.createEl("div", { cls: "yoofloe-step-title", text: title });
  createBadge(header.createDiv({ cls: "yoofloe-step-badge-wrap" }), badge.text, badge.tone);
  section.createEl("p", { cls: "yoofloe-step-description", text: description });
  return section;
}

function createInfoCard(containerEl: HTMLElement, title: string, body: string) {
  const card = containerEl.createDiv({ cls: "yoofloe-info-card" });
  card.createEl("div", { cls: "yoofloe-info-card-title", text: title });
  card.createEl("p", { cls: "yoofloe-info-card-body", text: body });
  return card;
}

function createChecklistCard(containerEl: HTMLElement, title: string, items: string[]) {
  const card = containerEl.createDiv({ cls: "yoofloe-info-card" });
  card.createEl("div", { cls: "yoofloe-info-card-title", text: title });
  const list = card.createEl("ul", { cls: "yoofloe-help-list" });
  for (const item of items) {
    list.createEl("li", { text: item });
  }
  return card;
}

function createHelpDetails(containerEl: HTMLElement, summaryText: string, items: string[]) {
  const details = containerEl.createEl("details", { cls: "yoofloe-help-details" });
  details.createEl("summary", { text: summaryText });
  const list = details.createEl("ol", { cls: "yoofloe-help-list" });
  for (const item of items) {
    list.createEl("li", { text: item });
  }
  return details;
}

async function copyTextToClipboard(label: string, text: string) {
  try {
    await navigator.clipboard.writeText(text);
    new Notice(`${label} copied.`);
  } catch {
    new Notice(`Could not copy ${label}. Open the public setup guide and copy it manually.`);
  }
}

function tokenBadgeState(plugin: YoofloePlugin) {
  switch (plugin.tokenStatus) {
    case "verified":
      return { text: "Verified", tone: "success" as const };
    case "invalid":
      return { text: "Needs attention", tone: "danger" as const };
    case "saved":
      return { text: "Saved", tone: "accent" as const };
    case "missing":
    default:
      return { text: "Not saved", tone: "warning" as const };
  }
}

const ACTIVE_PAIRING_PHASES: YoofloePairingPhase[] = [
  "starting",
  "browser-opened",
  "waiting-approval",
  "claiming",
  "token-saved",
  "verifying"
];

const PAIRING_UI_STALE_MS = 3 * 60 * 1000;

function isPastTimestamp(value: string) {
  if (!value) return false;
  const time = new Date(value).getTime();
  return !Number.isNaN(time) && time <= Date.now();
}

function isStaleActivePairing(status: YoofloePairingStatus, pairingInFlight = false) {
  if (!ACTIVE_PAIRING_PHASES.includes(status.phase)) return false;
  if (!pairingInFlight) return true;
  if (isPastTimestamp(status.expiresAt)) return true;
  const updatedAt = new Date(status.updatedAt || status.startedAt).getTime();
  return !Number.isNaN(updatedAt) && Date.now() - updatedAt > PAIRING_UI_STALE_MS;
}

function effectivePairingPhase(status: YoofloePairingStatus, pairingInFlight = false): YoofloePairingPhase {
  return isStaleActivePairing(status, pairingInFlight) ? "timed-out" : status.phase;
}

function pairingPhaseBadge(status: YoofloePairingStatus, pairingInFlight = false): { text: string; tone: BadgeTone } {
  const phase = effectivePairingPhase(status, pairingInFlight);
  switch (phase) {
    case "connected":
      return { text: "Connected", tone: "success" };
    case "verification-warning":
      return { text: "Saved, verify", tone: "warning" };
    case "expired":
    case "timed-out":
    case "failed":
      return { text: "Needs retry", tone: "danger" };
    case "starting":
    case "browser-opened":
    case "waiting-approval":
    case "claiming":
    case "token-saved":
    case "verifying":
      return { text: "Connecting", tone: "accent" };
    case "idle":
    default:
      return { text: "Ready", tone: "muted" };
  }
}

function isActivePairingStatus(status: YoofloePairingStatus, pairingInFlight = false) {
  return ACTIVE_PAIRING_PHASES.includes(status.phase) && !isStaleActivePairing(status, pairingInFlight);
}

function formatPairingTimestamp(value: string) {
  if (!value) return "none";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function createPairingStatusCard(containerEl: HTMLElement, plugin: YoofloePlugin) {
  const status = plugin.settings.yoofloePairing;
  const pairingInFlight = plugin.isYoofloePairingInProgress();
  const card = containerEl.createDiv({ cls: "yoofloe-pairing-card" });
  const header = card.createDiv({ cls: "yoofloe-pairing-card-header" });
  header.createEl("div", { cls: "yoofloe-info-card-title", text: "Yoofloe web connection" });
  const badge = pairingPhaseBadge(status, pairingInFlight);
  createBadge(header, badge.text, badge.tone);

  card.createEl("p", {
    cls: "yoofloe-info-card-body",
    text: isStaleActivePairing(status, pairingInFlight)
      ? "Yoofloe web approval was not received in time. Start again to connect."
      : status.message || "Connect through Yoofloe web when you are ready."
  });

  const meta = card.createDiv({ cls: "yoofloe-pairing-meta" });
  const rows = [
    ["Access", status.access === "read-write" ? "Read & write" : "Read access"],
    ["Started", formatPairingTimestamp(status.startedAt)],
    ["Expires", formatPairingTimestamp(status.expiresAt)],
    ["Pairing id", status.pairingIdHint || "none"],
    ["Open mode", status.openMode],
    ["Last endpoint", status.lastEndpointStatus ? `${status.lastEndpointStatus}${status.lastEndpointCode ? ` ${status.lastEndpointCode}` : ""}` : "none"],
    ["Token", status.maskedToken || plugin.tokenStatus],
    ["Token expiry", formatPairingTimestamp(status.tokenExpiresAt)]
  ];

  for (const [label, value] of rows) {
    const row = meta.createDiv({ cls: "yoofloe-pairing-meta-row" });
    row.createEl("span", { cls: "yoofloe-pairing-meta-label", text: label });
    row.createEl("span", { cls: "yoofloe-pairing-meta-value", text: value });
  }

  const actions = card.createDiv({ cls: "yoofloe-pairing-actions" });
  if (plugin.getStoredPat()) {
    const verifyButton = actions.createEl("button", { text: "Verify again" });
    verifyButton.type = "button";
    verifyButton.addEventListener("click", () => {
      verifyButton.disabled = true;
      void plugin.verifyStoredYoofloeToken({ throwOnFailure: false });
    });
  }

  const diagnosticsButton = actions.createEl("button", { text: "Copy diagnostics" });
  diagnosticsButton.type = "button";
  diagnosticsButton.addEventListener("click", () => {
    void plugin.copyPairingDiagnostics();
  });

  return card;
}

function providerChoiceStatus(provider: YoofloePlugin["settings"]["provider"]["type"]) {
  if (provider === "yoofloe-hosted") {
    return { text: "Default", tone: "success" as const };
  }

  if (provider === "none") {
    return { text: "Not configured", tone: "warning" as const };
  }

  return { text: "Selected", tone: "accent" as const };
}

function providerNextSteps(plugin: YoofloePlugin, hasSecureStorage: boolean) {
  const provider = plugin.settings.provider.type;
  const nextSteps: string[] = [];
  const googleStatus = plugin.settings.provider.googleConnected || plugin.googleAuth.hasRefreshToken()
    ? "connected"
    : plugin.googleConnectionStatus;

  if (!hasSecureStorage) {
    nextSteps.push("Upgrade to Obsidian 1.11.5 or newer to enable secure storage.");
    return nextSteps;
  }

  if (provider === "yoofloe-hosted") {
    return nextSteps;
  }

  if (provider === "none") {
    nextSteps.push("Choose Yoofloe hosted or a Gemini BYOK setup to generate AI notes.");
    return nextSteps;
  }

  if (provider === "gemini-google") {
    if (!plugin.settings.provider.clientId.trim()) nextSteps.push("Save your Google sign-in client ID.");
    if (!plugin.secretStore.getGoogleClientSecret()) nextSteps.push("Save your Google sign-in client secret.");
    if (!plugin.settings.provider.project.trim()) nextSteps.push("Save your Google cloud project ID.");
    if (!plugin.settings.provider.googleModel.trim()) nextSteps.push("Save your Gemini model.");
    if (googleStatus === "not-connected") nextSteps.push("Click Connect Google.");
    if (googleStatus === "reconnect") nextSteps.push("Reconnect Google to refresh your session.");
    return nextSteps;
  }

  if (provider === "gemini-vertex") {
    if (!plugin.settings.provider.clientId.trim()) nextSteps.push("Save your Google sign-in client ID.");
    if (!plugin.secretStore.getGoogleClientSecret()) nextSteps.push("Save your Google sign-in client secret.");
    if (!plugin.settings.provider.project.trim()) nextSteps.push("Save your Google cloud project ID.");
    if (!plugin.settings.provider.vertexModel.trim()) nextSteps.push("Save your Vertex model.");
    if (googleStatus === "not-connected") nextSteps.push("Click Connect Google.");
    if (googleStatus === "reconnect") nextSteps.push("Reconnect Google to refresh your session.");
    return nextSteps;
  }

  return nextSteps;
}

function providerHelpText(provider: YoofloePlugin["settings"]["provider"]["type"]) {
  switch (provider) {
    case "yoofloe-hosted":
      return "Default. Yoofloe handles the model path so you can create grounded Markdown without Google Cloud setup.";
    case "gemini-google":
      return "Advanced BYOK. Sign in with Google in your browser, then use Gemini with your own Google cloud project.";
    case "gemini-vertex":
      return "Advanced cloud setup. Use this if you specifically want the cloud setup and know your project and model.";
    case "none":
    default:
      return "Choose Yoofloe hosted or configure an advanced BYOK provider to start generating AI notes.";
  }
}

function providerReadiness(plugin: YoofloePlugin, hasSecureStorage: boolean) {
  const provider = plugin.settings.provider.type;
  const hasGoogleClient = !!plugin.settings.provider.clientId.trim();
  const hasGoogleClientSecret = !!plugin.secretStore.getGoogleClientSecret();
  const hasProject = !!plugin.settings.provider.project.trim();
  const hasGoogleModel = !!plugin.settings.provider.googleModel.trim();
  const hasVertexModel = !!plugin.settings.provider.vertexModel.trim();
  const googleConnected = plugin.settings.provider.googleConnected || plugin.googleAuth.hasRefreshToken() || plugin.googleConnectionStatus === "connected";

  if (provider === "yoofloe-hosted") {
    return hasSecureStorage && plugin.tokenStatus !== "missing" && plugin.tokenStatus !== "invalid"
      ? { text: "Ready", tone: "success" as const }
      : { text: "Connect Yoofloe", tone: "warning" as const };
  }

  if (provider === "none") {
    return { text: "Setup incomplete", tone: "warning" as const };
  }

  if (provider === "gemini-google") {
    return hasSecureStorage && hasGoogleClient && hasGoogleClientSecret && hasProject && hasGoogleModel && googleConnected
      ? { text: "Ready", tone: "success" as const }
      : { text: "Setup incomplete", tone: "warning" as const };
  }

  if (provider === "gemini-vertex") {
    return hasSecureStorage && hasGoogleClient && hasGoogleClientSecret && hasProject && hasVertexModel && googleConnected
      ? { text: "Ready", tone: "success" as const }
      : { text: "Setup incomplete", tone: "warning" as const };
  }

  return { text: "Setup incomplete", tone: "warning" as const };
}

export class YoofloeSettingTab extends PluginSettingTab {
  plugin: YoofloePlugin;

  constructor(app: App, plugin: YoofloePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const hasSecureStorage = this.plugin.secretStore.isAvailable;
    const pat = hasSecureStorage ? this.plugin.secretStore.getPat() : null;
    const googleClientSecret = hasSecureStorage ? this.plugin.secretStore.getGoogleClientSecret() : null;
    const provider = this.plugin.settings.provider.type;
    const usesGoogleOauth = provider === "gemini-google" || provider === "gemini-vertex";
    const isDesktopApp = Platform.isDesktopApp;
    const mobileByokBlocked = usesGoogleOauth && !isDesktopApp;
    const isVertexProvider = provider === "gemini-vertex";
    const providerChoice = providerChoiceStatus(provider);
    const providerStatus = providerReadiness(this.plugin, hasSecureStorage);
    const effectiveProviderStatus = mobileByokBlocked
      ? { text: "Desktop only", tone: "warning" as const }
      : providerStatus;
    const nextSteps = providerNextSteps(this.plugin, hasSecureStorage);
    const effectiveGoogleStatus = this.plugin.settings.provider.googleConnected || this.plugin.googleAuth.hasRefreshToken()
      ? "connected"
      : this.plugin.googleConnectionStatus;
    const saveProviderType = async (value: typeof this.plugin.settings.provider.type) => {
      this.plugin.settings.provider.type = value;
      await this.plugin.saveSettings();
      this.display();
    };
    const saveSavePath = async (value: string) => {
      this.plugin.settings.savePath = value.trim() || "Yoofloe";
      await this.plugin.saveSettings();
    };
    const saveDefaultRange = async (value: typeof this.plugin.settings.defaultRange) => {
      this.plugin.settings.defaultRange = value;
      await this.plugin.saveSettings();
    };
    const saveDefaultDomains = async (domain: YoofloeDomain, enabled: boolean) => {
      const next = new Set(this.plugin.settings.defaultDomains);
      if (enabled) {
        next.add(domain);
      } else {
        next.delete(domain);
      }
      if (next.size === 0) {
        new Notice("Keep at least one default Yoofloe source enabled.");
        this.display();
        return;
      }
      this.plugin.settings.defaultDomains = [...next];
      await this.plugin.saveSettings();
    };
    const saveDefaultOutputTarget = async (value: YoofloeOutputTarget) => {
      this.plugin.settings.defaultOutputTarget = value;
      await this.plugin.saveSettings();
    };
    const saveDefaultTone = async (value: string) => {
      this.plugin.settings.defaultTone = value.trim() || "clear and practical";
      await this.plugin.saveSettings();
    };
    const saveDateFormat = async (value: typeof this.plugin.settings.dateFormat) => {
      this.plugin.settings.dateFormat = value;
      await this.plugin.saveSettings();
    };
    const saveIncludeRawData = async (value: boolean) => {
      this.plugin.settings.includeRawData = value;
      await this.plugin.saveSettings();
    };
    const saveAutoFrontmatter = async (value: boolean) => {
      this.plugin.settings.autoFrontmatter = value;
      await this.plugin.saveSettings();
    };
    const saveFunctionsBaseUrl = async (value: string) => {
      this.plugin.settings.functionsBaseUrl = value.trim();
      await this.plugin.saveSettings();
    };

    new Setting(containerEl).setName("Getting started").setHeading();
    containerEl.createEl("p", {
      cls: "yoofloe-setting-note",
      text: "Connect Yoofloe once, then create grounded Markdown notes from your personal Yoofloe data. Yoofloe-hosted AI writer is the default; Gemini BYOK and MCP stay available under advanced."
    });

    containerEl.createEl("div", {
      cls: "yoofloe-setting-warning",
      text: secureStorageWarning(hasSecureStorage)
    });

    const entitlementBanner = this.plugin.getEntitlementBannerMessage();
    if (entitlementBanner) {
      containerEl.createEl("div", {
        cls: "yoofloe-setting-warning",
        text: entitlementBanner
      });
    }

    const quickStart = containerEl.createDiv({ cls: "yoofloe-quick-start" });
    new Setting(quickStart).setName("Start here").setHeading();
    const statusRow = quickStart.createDiv({ cls: "yoofloe-settings-status-row" });
    createBadge(statusRow, this.plugin.tokenStatus === "verified" || this.plugin.tokenStatus === "saved" ? "Connected" : this.plugin.tokenStatus === "invalid" ? "Reconnect Yoofloe" : "Connect Yoofloe", this.plugin.tokenStatus === "invalid" ? "danger" : this.plugin.tokenStatus === "missing" ? "warning" : "success");
    createBadge(statusRow, "Personal only", "muted");
    createBadge(statusRow, provider === "yoofloe-hosted" ? "Yoofloe AI ready" : provider === "none" ? "AI paused" : "BYOK provider", provider === "yoofloe-hosted" ? "success" : "accent");
    createBadge(statusRow, this.plugin.settings.showAdvancedProvider ? "Advanced provider on" : "Advanced provider off", "muted");
    const quickStartList = quickStart.createEl("ol", { cls: "yoofloe-step-list" });
    [
      "Connect Yoofloe.",
      "Create your first AI note.",
      "Tune defaults when you know what you want."
    ].forEach((item) => quickStartList.createEl("li", { text: item }));
    new Setting(quickStart)
      .setName("First AI note")
      .setDesc("Open the writer pane or create a daily review immediately with the current defaults.")
      .addButton((button) => {
        button
          .setButtonText("Open AI writer")
          .onClick(() => {
            void this.plugin.openWriterView();
          });
      })
      .addButton((button) => {
        button
          .setButtonText("Create first note")
          .setCta()
          .onClick(() => {
            void this.plugin.runHostedWriterFromOptions({
              documentType: "daily-review",
              domains: [...this.plugin.settings.defaultDomains],
              range: "1W",
              scope: "personal",
              tone: this.plugin.settings.defaultTone,
              outputMode: this.plugin.settings.defaultOutputTarget,
              includeRaw: this.plugin.settings.includeRawData
            });
          });
      });

    const tokenSection = createStepSection(
      containerEl,
      "Step 1",
      "Connect Yoofloe",
      tokenBadgeState(this.plugin),
      "Connect through Yoofloe web. The plugin stores the returned PAT in Obsidian secure storage and uses personal-only access by design."
    );

    createInfoCard(tokenSection, "Connect with Yoofloe web", "Open Yoofloe in your browser and sign in there. The plugin never asks for your password. On mobile, Obsidian may copy the pairing link if the browser cannot open automatically.");
    const privacyDetails = tokenSection.createEl("details", { cls: "yoofloe-help-details" });
    privacyDetails.createEl("summary", { text: "Privacy and access" });
    createInfoCard(privacyDetails, "Personal-only scope", "Yoofloe for Obsidian and Yoofloe Obsidian MCP are included with free and pro accounts. Obsidian access is personal-only and does not include couple/shared exports.");
    createInfoCard(privacyDetails, "Hosted writer disclosure", "Yoofloe-hosted AI writer uses the Yoofloe AI service for Markdown generation. Advanced BYOK keeps Google/Gemini calls in your own provider setup.");
    createInfoCard(tokenSection, "Automatic pairing status", YOOFLOE_PAIRING_PENDING_CONTRACT);
    createPairingStatusCard(tokenSection, this.plugin);
    createHelpDetails(tokenSection, "Need help finding your token?", [
      `Click Connect with Yoofloe web or open ${YOOFLOE_WEB_PAIRING_URL}.`,
      "Approve the pairing request after signing in with Yoofloe web.",
      "Return to Obsidian after the token is saved.",
      "If pairing fails, generate or reveal a pat_yfl_ token in web Settings and paste it here."
    ]);

    new Setting(tokenSection)
      .setName("Browser pairing")
      .setDesc("Use your Yoofloe web session to create an Obsidian token. Obsidian will not collect your email or password.")
      .addButton((button) => {
        const pairingActive = isActivePairingStatus(
          this.plugin.settings.yoofloePairing,
          this.plugin.isYoofloePairingInProgress()
        );
        button
          .setButtonText(pairingActive ? "Connecting..." : pat ? "Reconnect with Yoofloe web" : "Connect with Yoofloe web")
          .setDisabled(!hasSecureStorage || pairingActive)
          .onClick(async () => {
            try {
              if (!hasSecureStorage) {
                new Notice(SECRET_STORAGE_REQUIRED_MESSAGE);
                return;
              }

              button.setDisabled(true);
              await this.plugin.connectYoofloeWeb("read");
              this.display();
            } catch (error) {
              new Notice(this.plugin.getUserFacingErrorMessage(error, "Failed to connect with Yoofloe web."));
              this.display();
            } finally {
              button.setDisabled(!hasSecureStorage || isActivePairingStatus(
                this.plugin.settings.yoofloePairing,
                this.plugin.isYoofloePairingInProgress()
              ));
            }
          });
      });

    const manualTokenDetails = tokenSection.createEl("details", { cls: "yoofloe-help-details" });
    manualTokenDetails.createEl("summary", { text: "Use token manually" });

    let pendingPat = "";
    new Setting(manualTokenDetails)
      .setName("Yoofloe API token")
      .setDesc(hasSecureStorage
        ? `Stored in secure storage. ${describeStoredSecret(pat, 8)}`
        : SECRET_STORAGE_REQUIRED_MESSAGE)
      .addText((text) => {
        text
          .setPlaceholder(hasSecureStorage ? "Paste a new pat_yfl_... token to save or replace" : "Requires Obsidian 1.11.5+")
          .setValue("")
          .setDisabled(!hasSecureStorage)
          .onChange((value) => {
            pendingPat = value.trim();
          });
        text.inputEl.type = "password";
        text.inputEl.classList.add("yoofloe-input-wide");
      })
      .addButton((button) => {
        button
          .setButtonText("Save token")
          .setDisabled(!hasSecureStorage)
          .onClick(async () => {
            if (!hasSecureStorage) {
              new Notice(SECRET_STORAGE_REQUIRED_MESSAGE);
              return;
            }

            if (!pendingPat) {
              new Notice("Paste a Yoofloe token before saving.");
              return;
            }

            try {
              this.plugin.secretStore.setPat(pendingPat);
              this.plugin.settings.yoofloeAccessMode = "read";
              this.plugin.tokenStatus = "saved";
              pendingPat = "";
              await this.plugin.saveSettings();
              await this.plugin.verifyStoredYoofloeToken({ throwOnFailure: false });
              new Notice("Yoofloe token saved in secure storage.");
              this.display();
            } catch (error) {
              new Notice(error instanceof Error ? error.message : "Failed to save the Yoofloe token.");
            }
          });
      })
      .addButton((button) => {
        button
          .setButtonText("Verify token")
          .setDisabled(!hasSecureStorage || !pat)
          .onClick(async () => {
            try {
              if (!hasSecureStorage) {
                throw new Error(SECRET_STORAGE_REQUIRED_MESSAGE);
              }

              const token = this.plugin.secretStore.getPat();
              if (!token) {
                throw new Error("Yoofloe API token is missing.");
              }

              button.setDisabled(true);
              const response = await this.plugin.verifyStoredYoofloeToken({ throwOnFailure: true });
              if (!response) {
                throw new Error("Yoofloe token verification did not return a result.");
              }
              new Notice(response.entitlement.allowed
                ? "Yoofloe token is valid."
                : this.plugin.getEntitlementNoticeMessage());
              this.display();
            } catch (error) {
              const userFacingMessage = this.plugin.getUserFacingErrorMessage(error, "Yoofloe token test failed.");
              this.plugin.tokenStatus = userFacingMessage === this.plugin.getEntitlementNoticeMessage() ? "verified" : "invalid";
              if (this.plugin.tokenStatus === "invalid" && error instanceof Error && /token|401|unauthorized|invalid jwt/i.test(error.message)) {
                this.plugin.latestEntitlement = null;
              }
              new Notice(userFacingMessage);
              this.display();
            } finally {
              button.setDisabled(!hasSecureStorage || !this.plugin.secretStore.getPat());
            }
          });
      })
      .addExtraButton((button) => {
        button
          .setIcon("cross")
          .setTooltip("Clear stored token")
          .setDisabled(!hasSecureStorage || !pat)
          .onClick(async () => {
            this.plugin.secretStore.clearPat();
            this.plugin.settings.yoofloeAccessMode = "read";
            this.plugin.tokenStatus = "missing";
            this.plugin.latestEntitlement = null;
            await this.plugin.resetYoofloePairingStatus("Connect through Yoofloe web when you are ready.");
            new Notice("Yoofloe token cleared from secure storage.");
            this.display();
          });
      });

    const agentOptions = {
      pluginVersion: this.plugin.manifest.version,
      saveFolder: this.plugin.settings.savePath,
      functionsBaseUrl: this.plugin.settings.functionsBaseUrl
    };

    const mcpDetails = containerEl.createEl("details", { cls: "yoofloe-help-details yoofloe-advanced-panel" });
    mcpDetails.open = this.plugin.settings.showMcpSetup;
    mcpDetails.createEl("summary", { text: "Advanced: Obsidian MCP wrapper" });
    mcpDetails.addEventListener("toggle", () => {
      this.plugin.settings.showMcpSetup = mcpDetails.open;
      void this.plugin.saveSettings();
    });

    const agentSection = createStepSection(
      mcpDetails,
      "Optional",
      "Connect an MCP-capable agent",
      { text: "Included", tone: "accent" },
      "Use Yoofloe Obsidian MCP when Codex, Claude Code, or another MCP-capable agent should bring its own model path and write grounded documents into this vault."
    );
    createInfoCard(agentSection, "How Agent Direct works", "Download the Yoofloe Obsidian MCP wrapper from the latest release, point your MCP client at the bundled mcp-server.js, and provide YOOFLOE_PAT plus YOOFLOE_VAULT_PATH locally. Do not commit real PAT values into MCP config files.");
    new Setting(agentSection)
      .setName("Agent setup snippets")
      .setDesc("Copy safe placeholders for your agent client and prompt. Replace paths and token values locally.")
      .addButton((button) => {
        button
          .setButtonText("Create setup note")
          .onClick(() => {
            void this.plugin.createMcpSetupNote();
          });
      })
      .addButton((button) => {
        button
          .setButtonText("Copy config")
          .onClick(() => {
            void copyTextToClipboard("MCP config", buildMcpConfigSnippet(agentOptions));
          });
      })
      .addButton((button) => {
        button
          .setButtonText("Copy codex prompt")
          .onClick(() => {
            void copyTextToClipboard("Codex prompt", buildCodexPrompt(agentOptions));
          });
      })
      .addButton((button) => {
        button
          .setButtonText("Copy Claude Code prompt")
          .onClick(() => {
            void copyTextToClipboard("Claude Code prompt", buildClaudeCodePrompt(agentOptions));
          });
      });

    const providerDetails = containerEl.createEl("details", { cls: "yoofloe-help-details yoofloe-advanced-panel" });
    providerDetails.open = this.plugin.settings.showAdvancedProvider;
    providerDetails.createEl("summary", { text: "Advanced: use my own provider" });
    providerDetails.addEventListener("toggle", () => {
      this.plugin.settings.showAdvancedProvider = providerDetails.open;
      void this.plugin.saveSettings();
    });

    const providerSection = createStepSection(
      providerDetails,
      "Step 2",
      "Choose AI provider",
      providerChoice,
      "Keep Yoofloe hosted for the simplest path, or switch to Gemini BYOK if you want your own provider setup."
    );

    createInfoCard(providerSection, "Recommended choice", "Most people should stay with Yoofloe hosted. Choose Gemini only if you specifically want your own Google project and model path.");

    new Setting(providerSection)
      .setName("Model provider")
          .setDesc("Choose the setup Yoofloe should use for insight brief, decision memo, action plan, and deep dive.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("yoofloe-hosted", "Yoofloe hosted")
          .addOption("none", "None");
        if (isDesktopApp || provider === "gemini-google") {
          dropdown.addOption("gemini-google", isDesktopApp ? "Gemini BYOK" : "Gemini BYOK (desktop only)");
        }
        if (isDesktopApp || provider === "gemini-vertex") {
          dropdown.addOption("gemini-vertex", isDesktopApp ? "Vertex BYOK" : "Vertex BYOK (desktop only)");
        }

        dropdown.setValue(provider).onChange((value) => {
          if (!isDesktopApp && (value === "gemini-google" || value === "gemini-vertex")) {
            new Notice("Advanced Google BYOK setup is desktop-only in this version. Use Yoofloe hosted on mobile and tablet.");
            this.display();
            return;
          }
          void saveProviderType(value as typeof this.plugin.settings.provider.type);
        });
      });

    providerSection.createEl("p", {
      cls: "yoofloe-setting-note",
      text: providerHelpText(provider)
    });

    const setupSection = createStepSection(
      providerDetails,
      "Step 3",
      "Finish setup",
      effectiveProviderStatus,
      provider === "yoofloe-hosted"
        ? "No Google setup is required for the default Yoofloe AI Writer."
        : provider === "none"
          ? "Choose Yoofloe hosted or configure Gemini BYOK to start generating AI notes."
          : mobileByokBlocked
            ? "Advanced Google BYOK setup uses desktop OAuth. Switch to Yoofloe hosted on mobile and tablet."
          : "Save each required field below. When this step is ready, you can run AI commands."
    );

    if (mobileByokBlocked) {
      createInfoCard(setupSection, "Desktop-only provider", "Google BYOK uses a local desktop OAuth callback. Yoofloe-hosted AI Writer and Capture remain available on mobile and tablet.");
      new Setting(setupSection)
        .setName("Mobile AI setup")
        .setDesc("Switch to Yoofloe hosted to generate grounded notes on this device.")
        .addButton((button) => {
          button
            .setButtonText("Use Yoofloe hosted")
            .setCta()
            .onClick(() => {
              void saveProviderType("yoofloe-hosted");
            });
        });
    }

    if (provider !== "none" && !mobileByokBlocked && nextSteps.length > 0) {
      createChecklistCard(setupSection, "What is still missing", nextSteps);
    }

    if (usesGoogleOauth && isDesktopApp) {
      let pendingClientId = this.plugin.settings.provider.clientId;
      let pendingClientSecret = "";
      let pendingProject = this.plugin.settings.provider.project;
      let pendingVertexLocation = this.plugin.settings.provider.location;

      createInfoCard(setupSection, "How Google setup works", "You will sign in with Google in your browser. The plugin stores a refresh token in secure storage and uses it only for generation requests. Google calls are made directly from Obsidian with your own Google credentials and project.");
      createHelpDetails(setupSection, "Need help creating a Google sign-in client?", [
        "Open the Google cloud console and select the project you want to use.",
        "Go to Google auth platform, then clients.",
        "Create a new client and choose desktop app.",
        "Copy the client ID that ends with .apps.googleusercontent.com and paste it below."
      ]);

      new Setting(setupSection)
        .setName("Google sign-in client ID")
        .setDesc("Required for sign-in. Use a desktop app client ID from your cloud project.")
        .addText((text) => {
          text
            .setPlaceholder("1234567890-abc123.apps.googleusercontent.com")
            .setValue(this.plugin.settings.provider.clientId)
            .setDisabled(!hasSecureStorage)
            .onChange((value) => {
              pendingClientId = value.trim();
            });
          text.inputEl.classList.add("yoofloe-input-xwide");
        })
        .addButton((button) => {
          button
            .setButtonText("Save client ID")
            .setDisabled(!hasSecureStorage)
            .onClick(async () => {
              if (!pendingClientId) {
                new Notice("Google sign-in client ID is required before saving.");
                return;
              }

              if (!pendingClientId.includes(".apps.googleusercontent.com")) {
                new Notice("Use a desktop app sign-in client ID ending in .apps.googleusercontent.com.");
                return;
              }

              const wasDifferent = pendingClientId !== this.plugin.settings.provider.clientId;
              this.plugin.settings.provider.clientId = pendingClientId;
              if (wasDifferent && this.plugin.googleAuth.hasRefreshToken()) {
                this.plugin.settings.provider.googleConnected = false;
                this.plugin.googleConnectionStatus = "reconnect";
              }
              await this.plugin.saveSettings();
                new Notice("Google sign-in client ID saved.");
              this.display();
            });
        });

      new Setting(setupSection)
        .setName("Google sign-in client secret")
        .setDesc(hasSecureStorage
          ? `Stored in secure storage. ${describeStoredSecret(googleClientSecret)}`
          : SECRET_STORAGE_REQUIRED_MESSAGE)
        .addText((text) => {
          text
            .setPlaceholder(hasSecureStorage
              ? "Paste the desktop app client secret to save or replace"
              : "Requires Obsidian 1.11.5+")
            .setValue("")
            .setDisabled(!hasSecureStorage)
            .onChange((value) => {
              pendingClientSecret = value.trim();
            });
          text.inputEl.type = "password";
          text.inputEl.classList.add("yoofloe-input-wide");
        })
        .addButton((button) => {
          button
            .setButtonText("Save client secret")
            .setDisabled(!hasSecureStorage)
            .onClick(async () => {
              if (!hasSecureStorage) {
                new Notice(SECRET_STORAGE_REQUIRED_MESSAGE);
                return;
              }

              if (!pendingClientSecret) {
                new Notice("Google sign-in client secret is required before saving.");
                return;
              }

              try {
                this.plugin.secretStore.setGoogleClientSecret(pendingClientSecret);
                pendingClientSecret = "";
                await this.plugin.saveSettings();
                new Notice("Google sign-in client secret saved in secure storage.");
                this.display();
              } catch (error) {
                new Notice(error instanceof Error ? error.message : "Failed to save the Google sign-in client secret.");
              }
            });
        })
        .addExtraButton((button) => {
          button
            .setIcon("cross")
            .setTooltip("Clear stored sign-in client secret")
            .setDisabled(!hasSecureStorage || !googleClientSecret)
            .onClick(async () => {
              this.plugin.secretStore.clearGoogleClientSecret();
              await this.plugin.saveSettings();
              new Notice("Google sign-in client secret cleared from secure storage.");
              this.display();
            });
        });

      new Setting(setupSection)
        .setName("Google connection")
        .setDesc(effectiveGoogleStatus === "connected"
          ? "Google is connected and ready to use."
          : effectiveGoogleStatus === "reconnect"
            ? "Your Google session needs to be refreshed. Click Connect Google again."
            : "After you add the client ID below, click Connect Google to sign in in your browser.")
        .addButton((button) => {
          button
            .setButtonText(effectiveGoogleStatus === "reconnect" ? "Reconnect Google" : "Connect Google")
            .setDisabled(!hasSecureStorage)
            .onClick(async () => {
              if (pendingClientId.trim() !== this.plugin.settings.provider.clientId.trim()) {
                new Notice("Save your sign-in client ID before connecting.");
                return;
              }
              if (!this.plugin.secretStore.getGoogleClientSecret()) {
                new Notice("Save your sign-in client secret before connecting.");
                return;
              }

              let noticeMessage = "Google sign-in connected.";
              try {
                button.setDisabled(true);
                await this.plugin.connectGoogle();
              } catch (error) {
                const message = error instanceof Error ? error.message : "Failed to connect Google sign-in.";
                this.plugin.settings.provider.googleLastConnectState = "error";
                this.plugin.settings.provider.googleLastConnectMessage = message;
                await this.plugin.saveSettings();
                if (/google oauth|authorization|refresh token|invalid_grant|invalid_client|unauthorized_client|session expired|desktop app client id/i.test(message)) {
                  this.plugin.googleConnectionStatus = "reconnect";
                }
                noticeMessage = message;
              } finally {
                new Notice(noticeMessage);
                this.display();
              }
            });
        })
        .addButton((button) => {
          button
            .setButtonText("Disconnect account")
            .setDisabled(!hasSecureStorage || effectiveGoogleStatus === "not-connected")
            .onClick(async () => {
              await this.plugin.disconnectGoogle();
              new Notice("Google sign-in disconnected.");
              this.display();
            });
        });

      setupSection.createEl("p", {
        cls: "yoofloe-setting-note",
        text: `Connection diagnostics: saved=${this.plugin.settings.provider.googleConnected ? "yes" : "no"}, client secret=${googleClientSecret ? "present" : "missing"}, refresh token=${this.plugin.googleAuth.hasRefreshToken() ? "present" : "missing"}, runtime=${this.plugin.googleConnectionStatus}`
      });
      if (this.plugin.settings.provider.googleLastConnectState !== "idle" || this.plugin.settings.provider.googleLastConnectMessage) {
        setupSection.createEl("p", {
          cls: "yoofloe-setting-note",
          text: `Last Google connect result: ${this.plugin.settings.provider.googleLastConnectState}${this.plugin.settings.provider.googleLastConnectMessage ? ` — ${this.plugin.settings.provider.googleLastConnectMessage}` : ""}`
        });
      }

      new Setting(setupSection)
        .setName("Google cloud project ID")
        .setDesc("Required for generation requests. Use your cloud project ID, not the project number.")
        .addText((text) => {
          text
            .setPlaceholder(DEFAULT_PROJECT_PLACEHOLDER)
            .setValue(this.plugin.settings.provider.project)
            .onChange((value) => {
              pendingProject = value.trim();
            });
          text.inputEl.classList.add("yoofloe-input-wide");
        })
        .addButton((button) => {
          button
            .setButtonText("Save project ID")
            .onClick(async () => {
              if (!pendingProject) {
                new Notice("Google cloud project ID is required before saving.");
                return;
              }

              this.plugin.settings.provider.project = pendingProject;
              await this.plugin.saveSettings();
              new Notice("Google cloud project ID saved.");
              this.display();
            });
        });

      if (provider === "gemini-google") {
        createByokModelSetting(setupSection, {
          name: "Gemini BYOK model",
          desc: "Only used when Model provider is Gemini BYOK. Yoofloe hosted uses Yoofloe's server-selected model.",
          currentModel: this.plugin.settings.provider.googleModel,
          emptyNotice: "Choose a Gemini model or enter a custom model ID before saving.",
          onSave: async (model) => {
            this.plugin.settings.provider.googleModel = model;
            await this.plugin.saveSettings();
            new Notice("Gemini BYOK model saved.");
            this.display();
          },
          onUseRecommended: async () => {
            this.plugin.settings.provider.googleModel = RECOMMENDED_BYOK_MODEL;
            await this.plugin.saveSettings();
            new Notice("Gemini BYOK model updated to the recommended model.");
            this.display();
          }
        });
      }

      if (isVertexProvider) {
        createByokModelSetting(setupSection, {
          name: "Vertex BYOK model",
          desc: "Only used when Model provider is Vertex BYOK. Yoofloe hosted uses Yoofloe's server-selected model. Availability can depend on your Google project and Vertex location.",
          currentModel: this.plugin.settings.provider.vertexModel,
          emptyNotice: "Choose a Vertex model or enter a custom model ID before saving.",
          onSave: async (model) => {
            this.plugin.settings.provider.vertexModel = model;
            await this.plugin.saveSettings();
            new Notice("Vertex BYOK model saved.");
            this.display();
          },
          onUseRecommended: async () => {
            this.plugin.settings.provider.vertexModel = RECOMMENDED_BYOK_MODEL;
            await this.plugin.saveSettings();
            new Notice("Vertex BYOK model updated to the recommended model.");
            this.display();
          }
        });

        const advanced = setupSection.createEl("details", { cls: "yoofloe-help-details" });
        advanced.createEl("summary", { text: "Advanced cloud settings" });
        new Setting(advanced)
          .setName("Vertex location")
          .setDesc("Most users can keep the default location. Change this only if your cloud deployment uses a different region.")
          .addText((text) => {
            text
              .setPlaceholder(DEFAULT_VERTEX_LOCATION)
              .setValue(this.plugin.settings.provider.location)
              .onChange((value) => {
                pendingVertexLocation = value.trim();
              });
            text.inputEl.classList.add("yoofloe-input-medium");
          })
          .addButton((button) => {
            button
              .setButtonText("Save location")
              .onClick(async () => {
                this.plugin.settings.provider.location = pendingVertexLocation || DEFAULT_VERTEX_LOCATION;
                await this.plugin.saveSettings();
                new Notice("Vertex location saved.");
                this.display();
              });
          });
      }
    }

    if (provider === "yoofloe-hosted") {
      createInfoCard(setupSection, "Hosted model is managed by Yoofloe", "Yoofloe-hosted AI Writer uses your connected Yoofloe PAT and Yoofloe's server-selected model. The BYOK model dropdown only affects advanced Gemini or Vertex BYOK generation.");
    }

    if (provider === "none") {
      createInfoCard(setupSection, "AI generation paused", "Choose Yoofloe hosted or an advanced BYOK setup to generate AI notes.");
    }

    const advancedSection = containerEl.createEl("details", { cls: "yoofloe-help-details" });
    advancedSection.createEl("summary", { text: "Tune defaults" });

    new Setting(advancedSection)
      .setName("Save path")
      .setDesc("Generated Markdown files will be written here inside your vault.")
      .addText((text) => {
        text.setValue(this.plugin.settings.savePath).onChange((value) => {
          void saveSavePath(value);
        });
      });

    new Setting(advancedSection)
      .setName("Default range")
      .setDesc("Used by the insight document commands.")
      .addDropdown((dropdown) => {
        YOOFLOE_RANGES.forEach((range) => {
          dropdown.addOption(range, range);
        });
        dropdown.setValue(this.plugin.settings.defaultRange).onChange((value) => {
          void saveDefaultRange(value as typeof this.plugin.settings.defaultRange);
        });
      });

    const defaultDomainsSection = advancedSection.createDiv({ cls: "yoofloe-default-domain-section" });
    defaultDomainsSection.createEl("div", { cls: "yoofloe-info-card-title", text: "Default sources" });
    defaultDomainsSection.createEl("p", {
      cls: "yoofloe-setting-note",
      text: "Used by the AI writer and hosted command defaults. Finance and business stay off unless you select them."
    });
    const defaultDomainGrid = defaultDomainsSection.createDiv({ cls: "yoofloe-domain-grid" });
    for (const domain of YOOFLOE_DOMAINS) {
      const label = defaultDomainGrid.createEl("label", { cls: "yoofloe-domain-toggle" });
      const checkbox = label.createEl("input", { attr: { type: "checkbox" } });
      checkbox.checked = this.plugin.settings.defaultDomains.includes(domain);
      checkbox.addEventListener("change", () => {
        void saveDefaultDomains(domain, checkbox.checked);
      });
      label.createEl("span", { text: domainLabel(domain) });
      if (SENSITIVE_DOMAINS.has(domain)) {
        label.createEl("span", { cls: "yoofloe-sensitive-label", text: "Sensitive" });
      }
    }

    new Setting(advancedSection)
      .setName("Default output target")
      .setDesc("Where the AI writer sends generated Markdown by default.")
      .addDropdown((dropdown) => {
        YOOFLOE_OUTPUT_TARGETS.forEach((target) => {
          dropdown.addOption(target, outputTargetLabel(target));
        });
        dropdown.setValue(this.plugin.settings.defaultOutputTarget).onChange((value) => {
          void saveDefaultOutputTarget(value as YoofloeOutputTarget);
        });
      });

    new Setting(advancedSection)
      .setName("Default tone")
      .setDesc("Optional style guidance for hosted AI writer output.")
      .addText((text) => {
        text.setValue(this.plugin.settings.defaultTone).onChange((value) => {
          void saveDefaultTone(value);
        });
        text.inputEl.classList.add("yoofloe-input-wide");
      });

    new Setting(advancedSection)
      .setName("Date format")
      .setDesc("Used in generated file names.")
      .addDropdown((dropdown) => {
        ["YYYY-MM-DD", "YYYYMMDD", "YYYY.MM.DD"].forEach((format) => {
          dropdown.addOption(format, format);
        });
        dropdown.setValue(this.plugin.settings.dateFormat).onChange((value) => {
          void saveDateFormat(value as typeof this.plugin.settings.dateFormat);
        });
      });

    new Setting(advancedSection)
      .setName("Include raw data")
      .setDesc("Adds raw JSON sections to generated notes.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.includeRawData).onChange((value) => {
          void saveIncludeRawData(value);
        });
      });

    new Setting(advancedSection)
      .setName("Write frontmatter")
      .setDesc("Adds Yoofloe metadata frontmatter to each generated note.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.autoFrontmatter).onChange((value) => {
          void saveAutoFrontmatter(value);
        });
      });

    new Setting(advancedSection)
      .setName("Functions base URL")
      .setDesc("Defaults to the Yoofloe Supabase edge functions base URL.")
      .addText((text) => {
        text.setValue(this.plugin.settings.functionsBaseUrl).onChange((value) => {
          void saveFunctionsBaseUrl(value);
        });
        text.inputEl.classList.add("yoofloe-input-wide");
      });
  }
}
