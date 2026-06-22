import { ItemView, Notice, Setting, WorkspaceLeaf } from "obsidian";
import type YoofloePlugin from "./main";
import { YOOFLOE_DOMAINS, YOOFLOE_OUTPUT_TARGETS, YOOFLOE_RANGES } from "./types";
import type {
  YoofloeAiDocumentType,
  YoofloeDomain,
  YoofloeHostedWriterRequest,
  YoofloeOutputTarget,
  YoofloeRange
} from "./types";

export const YOOFLOE_WRITER_VIEW_TYPE = "yoofloe-ai-writer";

type WriterPreset = {
  id: YoofloeAiDocumentType;
  label: string;
  description: string;
  domains: YoofloeDomain[];
  range: YoofloeRange;
  tone: string;
  sensitive?: boolean;
};

const DEFAULT_WRITER_DOMAINS: YoofloeDomain[] = ["schedule", "life", "wellness", "journal", "garden"];
const SENSITIVE_DOMAINS = new Set<YoofloeDomain>(["finance", "business"]);

const PRESETS: WriterPreset[] = [
  {
    id: "daily-review",
    label: "Daily review",
    description: "Signals, friction, next actions, and reflection prompts.",
    domains: DEFAULT_WRITER_DOMAINS,
    range: "1W",
    tone: "clear and practical"
  },
  {
    id: "weekly-plan",
    label: "Weekly plan",
    description: "A realistic plan from schedule, life, wellness, journal, and garden context.",
    domains: DEFAULT_WRITER_DOMAINS,
    range: "1W",
    tone: "focused and calm"
  },
  {
    id: "decision-memo",
    label: "Decision memo",
    description: "Tradeoffs, recommended direction, evidence, and open questions.",
    domains: DEFAULT_WRITER_DOMAINS,
    range: "1M",
    tone: "analytical"
  },
  {
    id: "wellness-check",
    label: "Wellness check",
    description: "Patterns and gentle adjustments without medical claims.",
    domains: ["life", "wellness", "journal"],
    range: "1M",
    tone: "warm and grounded"
  },
  {
    id: "finance-snapshot",
    label: "Finance snapshot",
    description: "Cashflow signals and practical next steps.",
    domains: ["finance"],
    range: "1M",
    tone: "concise and careful",
    sensitive: true
  },
  {
    id: "free-prompt",
    label: "Free prompt",
    description: "Use selected Yoofloe sources with your own instruction.",
    domains: DEFAULT_WRITER_DOMAINS,
    range: "1M",
    tone: "clear and practical"
  }
];

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

function createTextareaField(
  container: HTMLElement,
  args: {
    id: string;
    label: string;
    description: string;
    placeholder: string;
    value: string;
    className: string;
    onChange: (value: string) => void;
  }
) {
  const field = container.createDiv({ cls: "yoofloe-pane-field" });
  const label = field.createEl("label", {
    cls: "yoofloe-pane-field-label",
    text: args.label,
    attr: { for: args.id }
  });
  label.createEl("span", { cls: "yoofloe-pane-field-description", text: args.description });
  const textarea = field.createEl("textarea", {
    cls: args.className,
    attr: {
      id: args.id,
      placeholder: args.placeholder,
      rows: "4"
    }
  });
  textarea.value = args.value;
  textarea.addEventListener("input", () => args.onChange(textarea.value));
  return textarea;
}

export class YoofloeWriterView extends ItemView {
  private documentType: YoofloeAiDocumentType = "daily-review";
  private selectedDomains = new Set<YoofloeDomain>(DEFAULT_WRITER_DOMAINS);
  private range: YoofloeRange = "1W";
  private outputTarget: YoofloeOutputTarget = "new-note";
  private tone = "clear and practical";
  private prompt = "";
  private includeRaw = false;
  private includeCurrentNoteContext = false;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: YoofloePlugin
  ) {
    super(leaf);
  }

  getViewType() {
    return YOOFLOE_WRITER_VIEW_TYPE;
  }

  getDisplayText() {
    return "Yoofloe AI writer";
  }

  getIcon() {
    return "sparkles";
  }

  onOpen(): Promise<void> {
    this.selectedDomains = new Set(this.plugin.settings.defaultDomains.length
      ? this.plugin.settings.defaultDomains
      : DEFAULT_WRITER_DOMAINS);
    this.range = this.plugin.settings.defaultRange;
    this.outputTarget = this.plugin.settings.defaultOutputTarget;
    this.tone = this.plugin.settings.defaultTone || "clear and practical";
    this.includeRaw = this.plugin.settings.includeRawData;
    this.render();
    return Promise.resolve();
  }

  private applyPreset(preset: WriterPreset) {
    this.documentType = preset.id;
    this.selectedDomains = new Set(preset.domains);
    this.range = preset.range;
    this.tone = preset.tone;
    this.render();
  }

  private buildRequest(): YoofloeHostedWriterRequest {
    return {
      documentType: this.documentType,
      domains: [...this.selectedDomains],
      range: this.range,
      scope: "personal",
      prompt: this.prompt.trim(),
      tone: this.tone.trim() || undefined,
      outputMode: this.outputTarget,
      includeRaw: this.includeRaw,
      currentNoteContext: {
        enabled: this.includeCurrentNoteContext
      }
    };
  }

  private render() {
    const container = this.contentEl;
    container.empty();
    container.addClass("yoofloe-writer-view");

    const header = container.createDiv({ cls: "yoofloe-writer-header" });
    header.createEl("div", { cls: "yoofloe-writer-kicker", text: "Yoofloe AI writer" });
    header.createEl("h2", { text: "Create a grounded note" });
    header.createEl("p", {
      text: "Choose a preset, review the sources, then generate Markdown from your personal Yoofloe data."
    });

    const status = header.createDiv({ cls: "yoofloe-writer-status-row" });
    status.createEl("span", {
      cls: `yoofloe-status-badge yoofloe-status-${this.plugin.tokenStatus === "invalid" ? "danger" : this.plugin.tokenStatus === "missing" ? "warning" : "success"}`,
      text: this.plugin.tokenStatus === "missing"
        ? "Connect Yoofloe"
        : this.plugin.tokenStatus === "invalid"
          ? "Reconnect Yoofloe"
          : "Connected"
    });
    status.createEl("span", { cls: "yoofloe-status-badge yoofloe-status-muted", text: "Personal only" });
    status.createEl("span", { cls: "yoofloe-status-badge yoofloe-status-accent", text: "Yoofloe AI ready" });

    const presetGrid = container.createDiv({ cls: "yoofloe-preset-grid" });
    for (const preset of PRESETS) {
      const button = presetGrid.createEl("button", {
        cls: `yoofloe-preset-button${preset.id === this.documentType ? " is-active" : ""}`,
        attr: {
          type: "button",
          "aria-pressed": preset.id === this.documentType ? "true" : "false"
        }
      });
      const titleRow = button.createSpan({ cls: "yoofloe-card-title-row" });
      titleRow.createEl("span", { cls: "yoofloe-preset-title", text: preset.label });
      if (preset.sensitive) {
        titleRow.createEl("span", { cls: "yoofloe-sensitive-label", text: "Sensitive" });
      }
      button.createEl("span", { cls: "yoofloe-preset-description", text: preset.description });
      button.addEventListener("click", () => this.applyPreset(preset));
    }

    createTextareaField(container, {
      id: "yoofloe-writer-free-prompt",
      label: "Free prompt",
      description: "Optional. Required only when the preset needs your own instruction.",
      placeholder: "What should Yoofloe help you write?",
      value: this.prompt,
      className: "yoofloe-writer-prompt",
      onChange: (value) => {
        this.prompt = value;
      }
    });

    const customize = container.createEl("details", { cls: "yoofloe-writer-customize" });
    customize.createEl("summary", { text: "Customize sources" });

    const domainGrid = customize.createDiv({ cls: "yoofloe-domain-grid" });
    for (const domain of YOOFLOE_DOMAINS) {
      const label = domainGrid.createEl("label", { cls: "yoofloe-domain-toggle" });
      const checkbox = label.createEl("input", { attr: { type: "checkbox" } });
      checkbox.checked = this.selectedDomains.has(domain);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          this.selectedDomains.add(domain);
        } else {
          this.selectedDomains.delete(domain);
        }
      });
      label.createEl("span", { text: domainLabel(domain) });
      if (SENSITIVE_DOMAINS.has(domain)) {
        label.createEl("span", { cls: "yoofloe-sensitive-label", text: "Sensitive" });
      }
    }

    new Setting(customize)
      .setName("Range")
      .setDesc("How much Yoofloe context the writer should consider.")
      .addDropdown((dropdown) => {
        for (const range of YOOFLOE_RANGES) {
          dropdown.addOption(range, range);
        }
        dropdown.setValue(this.range).onChange((value) => {
          this.range = value as YoofloeRange;
        });
      });

    new Setting(customize)
      .setName("Output target")
      .setDesc("Where the generated Markdown should go.")
      .addDropdown((dropdown) => {
        for (const target of YOOFLOE_OUTPUT_TARGETS) {
          dropdown.addOption(target, outputTargetLabel(target));
        }
        dropdown.setValue(this.outputTarget).onChange((value) => {
          this.outputTarget = value as YoofloeOutputTarget;
        });
      });

    new Setting(customize)
      .setName("Tone")
      .setDesc("Optional style guidance for the writer.")
      .addText((text) => {
        text.setValue(this.tone).onChange((value) => {
          this.tone = value;
        });
      });

    new Setting(customize)
      .setName("Include raw data")
      .setDesc("Adds raw context to the hosted writer request when available.")
      .addToggle((toggle) => {
        toggle.setValue(this.includeRaw).onChange((value) => {
          this.includeRaw = value;
        });
      });

    new Setting(customize)
      .setName("Use current note context")
      .setDesc("Opt in before sending the current note or selection as context.")
      .addToggle((toggle) => {
        toggle.setValue(this.includeCurrentNoteContext).onChange((value) => {
          this.includeCurrentNoteContext = value;
        });
      });

    const preview = container.createDiv({ cls: "yoofloe-context-preview" });
    preview.createEl("div", { cls: "yoofloe-info-card-title", text: "Context preview" });
    preview.createEl("p", {
      text: `${[...this.selectedDomains].map(domainLabel).join(", ") || "No Yoofloe domains selected"} over ${this.range}. Finance and Business stay off unless selected.`
    });

    const actionRow = container.createDiv({ cls: "yoofloe-writer-actions" });
    const generateButton = actionRow.createEl("button", {
      cls: "mod-cta yoofloe-writer-generate",
      text: "Generate note",
      attr: { type: "button" }
    });
    generateButton.addEventListener("click", () => {
      void (async () => {
        if (this.selectedDomains.size === 0) {
          new Notice("Choose at least one Yoofloe source.");
          return;
        }

        try {
          generateButton.disabled = true;
          generateButton.setText("Generating...");
          await this.plugin.runHostedWriterFromOptions(this.buildRequest());
        } finally {
          generateButton.disabled = false;
          generateButton.setText("Generate note");
        }
      })();
    });
  }
}
