import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type YoofloePlugin from "./main";
import { YoofloeClient } from "./api/yoofloe-client";
import { YOOFLOE_RANGES } from "./types";

export class YoofloeSettingTab extends PluginSettingTab {
  plugin: YoofloePlugin;

  constructor(app: App, plugin: YoofloePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("div", {
      cls: "yoofloe-setting-warning",
      text: "PAT and any optional provider keys are stored locally in Obsidian plugin data. They may be present in plain text inside data.json."
    });

    new Setting(containerEl)
      .setName("Yoofloe API token")
      .setDesc("Paste the pat_yfl_ token generated from Yoofloe Settings > Obsidian Beta.")
      .addText((text) => {
        text.setPlaceholder("pat_yfl_...")
          .setValue(this.plugin.settings.apiToken)
          .onChange(async (value) => {
            this.plugin.settings.apiToken = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.type = "password";
        text.inputEl.style.width = "24rem";
      })
      .addButton((button) => {
        button
          .setButtonText("Test token")
          .onClick(async () => {
            try {
              button.setDisabled(true);
              const client = new YoofloeClient(this.plugin.settings);
              await client.testToken();
              new Notice("Yoofloe token is valid.");
            } catch (error) {
              new Notice(error instanceof Error ? error.message : "Yoofloe token test failed.");
            } finally {
              button.setDisabled(false);
            }
          });
      });

    new Setting(containerEl)
      .setName("Functions base URL")
      .setDesc("Defaults to the Yoofloe Supabase Edge Functions base URL.")
      .addText((text) => {
        text.setValue(this.plugin.settings.functionsBaseUrl).onChange(async (value) => {
          this.plugin.settings.functionsBaseUrl = value.trim();
          await this.plugin.saveSettings();
        });
        text.inputEl.style.width = "24rem";
      });

    new Setting(containerEl)
      .setName("Save path")
      .setDesc("Generated Markdown files will be written here inside your vault.")
      .addText((text) => {
        text.setValue(this.plugin.settings.savePath).onChange(async (value) => {
          this.plugin.settings.savePath = value.trim() || "Yoofloe";
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Default range")
      .setDesc("Used by the domain overview commands.")
      .addDropdown((dropdown) => {
        YOOFLOE_RANGES.forEach((range) => dropdown.addOption(range, range));
        dropdown.setValue(this.plugin.settings.defaultRange).onChange(async (value) => {
          this.plugin.settings.defaultRange = value as typeof this.plugin.settings.defaultRange;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Date format")
      .setDesc("Used in generated file names.")
      .addDropdown((dropdown) => {
        ["YYYY-MM-DD", "YYYYMMDD", "YYYY.MM.DD"].forEach((format) => dropdown.addOption(format, format));
        dropdown.setValue(this.plugin.settings.dateFormat).onChange(async (value) => {
          this.plugin.settings.dateFormat = value as typeof this.plugin.settings.dateFormat;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Include raw data")
      .setDesc("Adds raw JSON sections to generated notes.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.includeRawData).onChange(async (value) => {
          this.plugin.settings.includeRawData = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Write frontmatter")
      .setDesc("Adds Yoofloe metadata frontmatter to each generated note.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.autoFrontmatter).onChange(async (value) => {
          this.plugin.settings.autoFrontmatter = value;
          await this.plugin.saveSettings();
        });
      });
  }
}
