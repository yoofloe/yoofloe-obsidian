import { Notice, Plugin, normalizePath } from "obsidian";
import { YoofloeClient } from "./api/yoofloe-client";
import { renderReportMarkdown } from "./generators/markdown";
import { YoofloeSettingTab } from "./settings";
import type { YoofloeBundle, YoofloeDomain, YoofloePluginSettings, YoofloeRange } from "./types";

const DEFAULT_SETTINGS: YoofloePluginSettings = {
  apiToken: "",
  functionsBaseUrl: "https://hhiyerojemcujzcmlzao.supabase.co/functions/v1",
  savePath: "Yoofloe",
  dateFormat: "YYYY-MM-DD",
  language: "en",
  defaultRange: "1M",
  defaultScope: "personal",
  includeRawData: false,
  autoFrontmatter: true
};

type ReportDefinition = {
  title: string;
  type: string;
  surface: string;
  domains: YoofloeDomain[];
  range: YoofloeRange;
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
  private statusEl: HTMLElement | null = null;
  private statusResetTimer: number | null = null;

  async onload() {
    await this.loadSettings();
    this.statusEl = this.addStatusBarItem();
    this.setStatus("Yoofloe idle");

    this.addSettingTab(new YoofloeSettingTab(this.app, this));
    this.registerCommands();
  }

  onunload() {
    this.clearStatusResetTimer();
    this.statusEl?.remove();
    this.statusEl = null;
  }

  async loadSettings() {
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(await this.loadData())
    };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private setStatus(text: string) {
    this.statusEl?.setText(text);
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

  private ensureConfigured() {
    if (!this.settings.apiToken.trim()) {
      throw new Error("Yoofloe API token is missing. Open Settings > Yoofloe and add your pat_yfl_ token.");
    }
  }

  private registerCommands() {
    const domainCommands: Array<{ id: string; name: string; domain: YoofloeDomain; type: string; surface: string }> = [
      { id: "schedule-overview", name: "Yoofloe: Schedule Overview", domain: "schedule", type: "schedule-overview", surface: "schedule-overview" },
      { id: "life-overview", name: "Yoofloe: Life Overview", domain: "life", type: "life-overview", surface: "life-overview" },
      { id: "wellness-report", name: "Yoofloe: Wellness Report", domain: "wellness", type: "wellness-report", surface: "wellness-report" },
      { id: "finance-report", name: "Yoofloe: Finance Report", domain: "finance", type: "finance-report", surface: "finance-report" },
      { id: "business-overview", name: "Yoofloe: Business Overview", domain: "business", type: "business-overview", surface: "business-overview" },
      { id: "journal-recap", name: "Yoofloe: Journal Recap", domain: "journal", type: "journal-recap", surface: "journal-recap" },
      { id: "garden-status", name: "Yoofloe: Garden Status", domain: "garden", type: "garden-status", surface: "garden-status" }
    ];

    for (const command of domainCommands) {
      this.addCommand({
        id: command.id,
        name: command.name,
        callback: async () => {
          await this.runReport({
            title: command.name.replace("Yoofloe: ", ""),
            type: command.type,
            surface: command.surface,
            domains: [command.domain],
            range: this.settings.defaultRange
          });
        }
      });
    }

    const compositeCommands: Array<{ id: string; name: string; type: string; surface: string; range: YoofloeRange }> = [
      { id: "daily-recap", name: "Yoofloe: Daily Recap", type: "daily-recap", surface: "daily-recap", range: "1W" },
      { id: "weekly-review", name: "Yoofloe: Weekly Review", type: "weekly-review", surface: "weekly-review", range: "1W" },
      { id: "monthly-report", name: "Yoofloe: Monthly Report", type: "monthly-report", surface: "monthly-report", range: "1M" }
    ];

    for (const command of compositeCommands) {
      this.addCommand({
        id: command.id,
        name: command.name,
        callback: async () => {
          await this.runReport({
            title: command.name.replace("Yoofloe: ", ""),
            type: command.type,
            surface: command.surface,
            domains: ["schedule", "life", "wellness", "finance", "business", "journal", "garden"],
            range: command.range
          });
        }
      });
    }
  }

  private async runReport(definition: ReportDefinition) {
    try {
      this.ensureConfigured();
      this.clearStatusResetTimer();
      this.setStatus(`Yoofloe syncing ${definition.surface}...`);

      const client = new YoofloeClient(this.settings);
      const response = await client.fetchBundle({
        domains: definition.domains,
        range: definition.range,
        scope: this.settings.defaultScope,
        includeRaw: this.settings.includeRawData,
        includeFrontmatterHints: true
      });

      const filePath = await this.writeBundleFile({
        title: definition.title,
        type: definition.type,
        surface: definition.surface,
        bundle: response.bundle
      });

      this.setStatus("Yoofloe idle");
      new Notice(`Yoofloe note created: ${filePath}`);
    } catch (error) {
      this.setStatus("Yoofloe error");
      new Notice(error instanceof Error ? error.message : "Yoofloe command failed.");
      this.queueIdleStatusReset();
    }
  }

  private async writeBundleFile({
    title,
    type,
    surface,
    bundle
  }: {
    title: string;
    type: string;
    surface: string;
    bundle: YoofloeBundle;
  }) {
    await ensureFolderPath(this, this.settings.savePath);
    const filePath = await uniqueFilePath(this, surface);
    const content = renderReportMarkdown({
      title,
      type,
      bundle,
      settings: this.settings,
      pluginVersion: this.manifest.version,
      provider: "yoofloe-api"
    });

    await this.app.vault.create(filePath, content);
    return filePath;
  }
}
