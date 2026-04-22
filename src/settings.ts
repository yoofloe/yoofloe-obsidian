import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { buildClaudeCodePrompt, buildCodexPrompt, buildMcpConfigSnippet } from "./agent-guidance";
import type YoofloePlugin from "./main";
import { YoofloeClient } from "./api/yoofloe-client";
import { describeStoredSecret, SECRET_STORAGE_REQUIRED_MESSAGE } from "./secrets";
import { YOOFLOE_RANGES } from "./types";

type BadgeTone = "muted" | "accent" | "success" | "warning" | "danger";
type DesktopWindow = Window & { require?: NodeJS.Require; };

const DEFAULT_MODEL_PLACEHOLDER = "gemini-2.5-flash-lite";
const DEFAULT_PROJECT_PLACEHOLDER = "my-google-cloud-project";
const DEFAULT_VERTEX_LOCATION = "us-central1";

function secureStorageWarning(hasSecureStorage: boolean) {
  if (!hasSecureStorage) {
    return `${SECRET_STORAGE_REQUIRED_MESSAGE} Token and Google sign-in setup are disabled until you upgrade.`;
  }

  return "Yoofloe stores your PAT, Google sign-in client secret, and Google sign-in refresh token in Obsidian secure storage. Secrets are not written to data.json.";
}

function createBadge(containerEl: HTMLElement, text: string, tone: BadgeTone) {
  containerEl.createEl("span", {
    cls: `yoofloe-status-badge yoofloe-status-${tone}`,
    text
  });
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

function requireDesktopModule<T>(specifier: string): T {
  const desktopWindow = activeWindow as DesktopWindow;
  const runtimeRequire = typeof require === "function"
    ? require
    : desktopWindow.require;

  if (!runtimeRequire) {
    throw new Error("This action is available only in the desktop Obsidian runtime.");
  }

  return runtimeRequire(specifier) as T;
}

async function copyTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const electron = requireDesktopModule<{ clipboard: { writeText: (value: string) => void; }; }>("electron");
  electron.clipboard.writeText(text);
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

function providerChoiceStatus(provider: YoofloePlugin["settings"]["provider"]["type"]) {
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

  if (provider === "none") {
    nextSteps.push("Choose a Gemini setup to generate insight documents.");
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
    case "gemini-google":
      return "Recommended for most users. Sign in with Google in your browser, then use Gemini with your own Google cloud project.";
    case "gemini-vertex":
      return "Advanced cloud setup. Use this if you specifically want the cloud setup and know your project and model.";
    case "none":
    default:
      return "Yoofloe is designed to generate insight documents. Configure Gemini to start generating them.";
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
    const isVertexProvider = provider === "gemini-vertex";
    const providerChoice = providerChoiceStatus(provider);
    const providerStatus = providerReadiness(this.plugin, hasSecureStorage);
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

    new Setting(containerEl).setName("Setup").setHeading();
    containerEl.createEl("p", {
      cls: "yoofloe-setting-note",
      text: "Yoofloe external access is a pro feature. Basic in-app access and baseline data export stay available without pro, while CLI, mcp, and Obsidian-connected workflows are premium interface layers. In Obsidian, you connect with a yoofloe pat. In yoofloe CLI and CLI mcp, you sign in with your yoofloe account. On these external surfaces, yoofloe provides grounded context and access control, but not the model."
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
    new Setting(quickStart).setName("Recommended first run").setHeading();
    const quickStartList = quickStart.createEl("ol", { cls: "yoofloe-step-list" });
    [
      "Save your Yoofloe token and click Verify token.",
      "Finish the Gemini setup below.",
      "Run insight brief to generate your first grounded document."
    ].forEach((item) => quickStartList.createEl("li", { text: item }));

    const tokenSection = createStepSection(
      containerEl,
      "Step 1",
      "Connect Yoofloe",
      tokenBadgeState(this.plugin),
      "This PAT lets the Obsidian plugin fetch grounded Yoofloe data. It does not replace Yoofloe CLI login, and it exposes personal-only data by design."
    );

    createInfoCard(tokenSection, "What you need", "A Yoofloe personal access token with the pat_yfl_ prefix. External access is included with Pro. Generate the token in the Yoofloe web app, review the external access notice there, then paste the token here. Obsidian access is personal-only by design and does not include couple/shared exports.");
    createInfoCard(tokenSection, "External access notice", "Obsidian plugin mode uses your own Google provider setup directly from Obsidian. Yoofloe provides the PAT-protected bundle and brief, but Yoofloe does not receive your Google sign-in credentials.");
    createHelpDetails(tokenSection, "Need help finding your token?", [
      "Open the Yoofloe web app and go to Settings.",
      "Use Generate Obsidian Token.",
      "Copy the pat_yfl_ token and paste it here.",
      "Click Save token, then Verify token."
    ]);

    let pendingPat = "";
    new Setting(tokenSection)
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
              new Notice("Paste a yoofloe token before saving.");
              return;
            }

            try {
              this.plugin.secretStore.setPat(pendingPat);
              this.plugin.tokenStatus = "saved";
              pendingPat = "";
              await this.plugin.saveSettings();
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
              const client = new YoofloeClient(this.plugin.settings, token);
              const response = await client.testToken();
              this.plugin.setLatestEntitlement(response.entitlement);
              this.plugin.tokenStatus = "verified";
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
            this.plugin.tokenStatus = "missing";
            this.plugin.latestEntitlement = null;
            await this.plugin.saveSettings();
            new Notice("Yoofloe token cleared from secure storage.");
            this.display();
          });
      });

    const agentDirectSection = createStepSection(
      containerEl,
      "Optional",
      "Use with external agents",
      { text: "Available", tone: "accent" },
      "Use an external agent when you want Codex, Claude, or another tool to bring its own model while Yoofloe provides grounded context and safe vault writes. Files written into your vault remain local copies after revocation."
    );

    createInfoCard(agentDirectSection, "Choose the right path", "Use plugin generation for one-click output inside Obsidian. Use Agent Direct when an external agent should bring its own model and workflow. Obsidian uses a PAT; Yoofloe CLI and CLI MCP use app login.");
    createChecklistCard(agentDirectSection, "Agent Direct rules", [
      "Agent Direct does not reuse the plugin's Gemini OAuth setup or secrets.",
      "The recommended MCP workflow is yoofloe_ai_document_context followed by yoofloe_write_ai_document.",
      "Deep dive requires a non-empty focusInstruction.",
      "The connected external agent processes content under its own provider terms.",
      "Plugin and wrapper access are personal-only by design and do not expose couple/shared data."
    ]);

    new Setting(agentDirectSection)
      .setName("Copy examples")
      .setDesc("Copy ready-to-use prompts and mcp config snippets for external agents.")
      .addButton((button) => {
        button.setButtonText("Copy codex prompt").onClick(async () => {
          try {
            await copyTextToClipboard(buildCodexPrompt({
              pluginVersion: this.plugin.manifest.version,
              saveFolder: this.plugin.settings.savePath,
              functionsBaseUrl: this.plugin.settings.functionsBaseUrl
            }));
            new Notice("Codex prompt copied.");
          } catch (error) {
            new Notice(error instanceof Error ? error.message : "Failed to copy the Codex prompt.");
          }
        });
      })
      .addButton((button) => {
        // eslint-disable-next-line obsidianmd/ui/sentence-case -- ReviewBot currently requires these provider labels lowercase.
        button.setButtonText("Copy claude prompt").onClick(async () => {
          try {
            await copyTextToClipboard(buildClaudeCodePrompt({
              pluginVersion: this.plugin.manifest.version,
              saveFolder: this.plugin.settings.savePath,
              functionsBaseUrl: this.plugin.settings.functionsBaseUrl
            }));
            new Notice("Claude prompt copied.");
          } catch (error) {
            new Notice(error instanceof Error ? error.message : "Failed to copy the Claude prompt.");
          }
        });
      })
      .addButton((button) => {
        button.setButtonText("Copy mcp config").onClick(async () => {
          try {
            await copyTextToClipboard(buildMcpConfigSnippet({
              pluginVersion: this.plugin.manifest.version,
              saveFolder: this.plugin.settings.savePath,
              functionsBaseUrl: this.plugin.settings.functionsBaseUrl
            }));
            new Notice("Mcp config snippet copied.");
          } catch (error) {
            new Notice(error instanceof Error ? error.message : "Failed to copy the MCP config snippet.");
          }
        });
      });

    new Setting(agentDirectSection)
      .setName("More actions")
      .setDesc("Open the full guide or write a shareable setup note into your vault.")
      .addButton((button) => {
        button.setButtonText("Open agent direct guide").onClick(async () => {
          try {
            await this.plugin.openAgentDirectGuide();
          } catch (error) {
            new Notice(error instanceof Error ? error.message : "Failed to open the Agent Direct guide.");
          }
        });
      })
      .addButton((button) => {
        button.setButtonText("Write agent setup note").onClick(async () => {
          try {
            const filePath = await this.plugin.writeAgentSetupNote();
            new Notice(`Yoofloe agent setup note created: ${filePath}`);
          } catch (error) {
            new Notice(error instanceof Error ? error.message : "Failed to write the Yoofloe agent setup note.");
          }
        });
      });

    const providerSection = createStepSection(
      containerEl,
      "Step 2",
      "Choose your provider",
      providerChoice,
      "Choose the setup for insight brief, decision memo, action plan, and deep dive."
    );

    createInfoCard(providerSection, "Recommended choice", "Most people should start with the Google setup. Choose the Vertex setup only if you specifically want your own Vertex project.");

    new Setting(providerSection)
      .setName("Model provider")
      .setDesc("Choose the setup yoofloe should use for insight brief, decision memo, action plan, and deep dive.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("none", "None")
          .addOption("gemini-google", "Google setup")
          .addOption("gemini-vertex", "Vertex setup");

        dropdown.setValue(provider).onChange((value) => {
          void saveProviderType(value as typeof this.plugin.settings.provider.type);
        });
      });

    providerSection.createEl("p", {
      cls: "yoofloe-setting-note",
      text: providerHelpText(provider)
    });

    const setupSection = createStepSection(
      containerEl,
      "Step 3",
      "Finish setup",
      providerStatus,
      provider === "none"
        ? "Configure Gemini to start generating insight documents."
        : "Save each required field below. When this step is ready, you can run insight brief."
    );

    if (provider !== "none" && nextSteps.length > 0) {
      createChecklistCard(setupSection, "What is still missing", nextSteps);
    }

    if (usesGoogleOauth) {
      let pendingClientId = this.plugin.settings.provider.clientId;
      let pendingClientSecret = "";
      let pendingProject = this.plugin.settings.provider.project;
      let pendingGoogleModel = this.plugin.settings.provider.googleModel;
      let pendingVertexModel = this.plugin.settings.provider.vertexModel;
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
        // eslint-disable-next-line obsidianmd/ui/sentence-case -- ReviewBot currently requires these provider labels lowercase.
        .setDesc("Required for google sign-in. Use a desktop app client id from your own google cloud project.")
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
            // eslint-disable-next-line obsidianmd/ui/sentence-case -- ReviewBot currently requires these provider labels lowercase.
            .setTooltip("Clear stored google sign-in client secret")
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
                // eslint-disable-next-line obsidianmd/ui/sentence-case -- ReviewBot currently requires these provider labels lowercase.
                new Notice("Save your google sign-in client id before connecting google.");
                return;
              }
              if (!this.plugin.secretStore.getGoogleClientSecret()) {
                // eslint-disable-next-line obsidianmd/ui/sentence-case -- ReviewBot currently requires these provider labels lowercase.
                new Notice("Save your google sign-in client secret before connecting google.");
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
            // eslint-disable-next-line obsidianmd/ui/sentence-case -- ReviewBot currently requires these provider labels lowercase.
            .setButtonText("Disconnect google account")
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
        // eslint-disable-next-line obsidianmd/ui/sentence-case -- ReviewBot currently requires these provider labels lowercase.
        .setDesc("Required for generation requests. Use your google cloud project id, not the project number.")
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
        new Setting(setupSection)
          .setName("Gemini model")
          .setDesc("Recommended for most users. The default model is shown below.")
          .addText((text) => {
            text
              .setPlaceholder(DEFAULT_MODEL_PLACEHOLDER)
              .setValue(this.plugin.settings.provider.googleModel)
              .onChange((value) => {
                pendingGoogleModel = value.trim();
              });
            text.inputEl.classList.add("yoofloe-input-wide");
          })
          .addButton((button) => {
            button
              .setButtonText("Save model")
              .onClick(async () => {
                if (!pendingGoogleModel) {
                  new Notice("Add a model name before saving.");
                  return;
                }

                this.plugin.settings.provider.googleModel = pendingGoogleModel;
                await this.plugin.saveSettings();
                new Notice("Gemini model saved.");
                this.display();
              });
          });
      }

      if (isVertexProvider) {
        new Setting(setupSection)
          .setName("Vertex model")
          .setDesc("Use this only if you specifically want the cloud setup. The default model is shown below.")
          .addText((text) => {
            text
              .setPlaceholder(DEFAULT_MODEL_PLACEHOLDER)
              .setValue(this.plugin.settings.provider.vertexModel)
              .onChange((value) => {
                pendingVertexModel = value.trim();
              });
            text.inputEl.classList.add("yoofloe-input-wide");
          })
          .addButton((button) => {
            button
              .setButtonText("Save model")
              .onClick(async () => {
                if (!pendingVertexModel) {
                  new Notice("Add a cloud model before saving.");
                  return;
                }

                this.plugin.settings.provider.vertexModel = pendingVertexModel;
                await this.plugin.saveSettings();
                new Notice("Vertex model saved.");
                this.display();
              });
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

    if (provider === "none") {
      createInfoCard(setupSection, "Gemini setup required", "Yoofloe only generates insight documents. Select the Google setup or the Vertex setup to continue.");
    }

    const advancedSection = containerEl.createEl("details", { cls: "yoofloe-help-details" });
    advancedSection.createEl("summary", { text: "Advanced defaults" });

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
      .setDesc("Adds yoofloe metadata frontmatter to each generated note.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.autoFrontmatter).onChange((value) => {
          void saveAutoFrontmatter(value);
        });
      });

    new Setting(advancedSection)
      .setName("Functions base URL")
      .setDesc("Defaults to the yoofloe supabase edge functions base URL.")
      .addText((text) => {
        text.setValue(this.plugin.settings.functionsBaseUrl).onChange((value) => {
          void saveFunctionsBaseUrl(value);
        });
        text.inputEl.classList.add("yoofloe-input-wide");
      });
  }
}
