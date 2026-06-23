import { ItemView, Notice, Setting, WorkspaceLeaf } from "obsidian";
import type YoofloePlugin from "./main";
import { YOOFLOE_DOMAINS, YOOFLOE_RANGES } from "./types";
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

type WriterDestinationMode = "new-note" | "current-note";
type WriterOutputStatus = {
  kind: "success" | "warning" | "error";
  message: string;
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

function destinationFromOutputTarget(target: YoofloeOutputTarget): WriterDestinationMode {
  return target === "new-note" ? "new-note" : "current-note";
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
  private destinationMode: WriterDestinationMode = "new-note";
  private newNoteTitle = "Daily review";
  private newNoteTitleEdited = false;
  private lastOutputStatus: WriterOutputStatus | null = null;
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
    this.destinationMode = destinationFromOutputTarget(this.plugin.settings.defaultOutputTarget);
    this.tone = this.plugin.settings.defaultTone || "clear and practical";
    this.includeRaw = this.plugin.settings.includeRawData;
    this.newNoteTitle = this.suggestedNewNoteTitle();
    this.newNoteTitleEdited = false;
    this.lastOutputStatus = null;
    this.render();
    return Promise.resolve();
  }

  private currentPreset() {
    return PRESETS.find((preset) => preset.id === this.documentType) || PRESETS[0];
  }

  private suggestedNewNoteTitle() {
    return this.currentPreset().label;
  }

  private applyPreset(preset: WriterPreset) {
    this.documentType = preset.id;
    this.selectedDomains = new Set(preset.domains);
    this.range = preset.range;
    this.tone = preset.tone;
    if (!this.newNoteTitleEdited || !this.newNoteTitle.trim()) {
      this.newNoteTitle = preset.label;
      this.newNoteTitleEdited = false;
    }
    this.lastOutputStatus = null;
    this.render();
  }

  private buildRequest(): YoofloeHostedWriterRequest {
    const outputMode: YoofloeOutputTarget = this.destinationMode === "new-note" ? "new-note" : "insert-cursor";
    return {
      documentType: this.documentType,
      domains: [...this.selectedDomains],
      range: this.range,
      scope: "personal",
      prompt: this.prompt.trim(),
      tone: this.tone.trim() || undefined,
      outputMode,
      includeRaw: this.includeRaw,
      currentNoteContext: {
        enabled: this.includeCurrentNoteContext
      }
    };
  }

  private getGenerationBlocker() {
    if (this.selectedDomains.size === 0) {
      return "Choose at least one Yoofloe source.";
    }

    if (this.destinationMode === "current-note" && !this.plugin.getCurrentWriterMarkdownTarget()) {
      return "Open a Markdown note before choosing Current note.";
    }

    return null;
  }

  private renderDestination(container: HTMLElement) {
    const target = this.plugin.getCurrentWriterMarkdownTarget();
    const section = container.createDiv({ cls: "yoofloe-writer-destination" });
    section.createEl("div", { cls: "yoofloe-info-card-title", text: "Destination" });
    section.createEl("p", {
      cls: "yoofloe-destination-description",
      text: "Choose exactly where the generated Markdown should go."
    });

    const chooser = section.createDiv({ cls: "yoofloe-destination-choice", attr: { role: "group", "aria-label": "AI writer destination" } });
    const destinations: Array<{ mode: WriterDestinationMode; label: string; description: string }> = [
      { mode: "new-note", label: "New note", description: "Create and open a new Yoofloe note." },
      { mode: "current-note", label: "Current note", description: "Insert at the cursor in an open note." }
    ];

    for (const destination of destinations) {
      const button = chooser.createEl("button", {
        cls: `yoofloe-destination-button${this.destinationMode === destination.mode ? " is-active" : ""}`,
        attr: {
          type: "button",
          "aria-pressed": this.destinationMode === destination.mode ? "true" : "false"
        }
      });
      button.createEl("span", { cls: "yoofloe-destination-button-title", text: destination.label });
      button.createEl("span", { cls: "yoofloe-destination-button-description", text: destination.description });
      button.addEventListener("click", () => {
        this.destinationMode = destination.mode;
        this.lastOutputStatus = null;
        this.render();
      });
    }

    if (this.destinationMode === "new-note") {
      const titleField = section.createDiv({ cls: "yoofloe-destination-detail" });
      const label = titleField.createEl("label", {
        cls: "yoofloe-pane-field-label",
        text: "Note title",
        attr: { for: "yoofloe-writer-new-note-title" }
      });
      label.createEl("span", {
        cls: "yoofloe-pane-field-description",
        text: "Used for the file name and heading. Leave blank to use the AI title."
      });
      const input = titleField.createEl("input", {
        cls: "yoofloe-destination-title-input",
        attr: {
          id: "yoofloe-writer-new-note-title",
          type: "text",
          placeholder: this.suggestedNewNoteTitle()
        }
      });
      input.value = this.newNoteTitle;
      input.addEventListener("input", () => {
        this.newNoteTitle = input.value;
        this.newNoteTitleEdited = true;
        this.lastOutputStatus = null;
      });
      return;
    }

    const targetDetail = section.createDiv({ cls: "yoofloe-destination-detail" });
    targetDetail.createEl("div", { cls: "yoofloe-destination-current-label", text: "Current note target" });
    if (target) {
      targetDetail.createEl("div", {
        cls: "yoofloe-destination-target-badge",
        text: `${target.title} - Insert at cursor`
      });
      targetDetail.createEl("div", { cls: "yoofloe-destination-path", text: target.path });
    } else {
      targetDetail.createEl("div", {
        cls: "yoofloe-destination-warning",
        text: "Open a Markdown note first. Yoofloe will not silently create a new note for this choice."
      });
    }
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

    this.renderDestination(container);

    if (this.lastOutputStatus) {
      container.createDiv({
        cls: `yoofloe-writer-output-status is-${this.lastOutputStatus.kind}`,
        text: this.lastOutputStatus.message,
        attr: {
          role: "status",
          "aria-live": "polite"
        }
      });
    }

    const actionRow = container.createDiv({ cls: "yoofloe-writer-actions" });
    const generateButton = actionRow.createEl("button", {
      cls: "mod-cta yoofloe-writer-generate",
      text: "Generate note",
      attr: { type: "button" }
    });
    generateButton.addEventListener("click", () => {
      void (async () => {
        const blocker = this.getGenerationBlocker();
        if (blocker) {
          this.lastOutputStatus = { kind: "warning", message: blocker };
          new Notice(blocker);
          this.render();
          return;
        }

        try {
          generateButton.disabled = true;
          generateButton.setText("Generating...");
          const currentTarget = this.destinationMode === "current-note"
            ? this.plugin.getCurrentWriterMarkdownTarget()
            : null;
          const result = await this.plugin.runHostedWriterFromOptions(this.buildRequest(), {
            titleOverride: this.destinationMode === "new-note" ? this.newNoteTitle.trim() : undefined,
            fallbackTitle: this.currentPreset().label,
            currentNotePath: currentTarget?.path
          });
          if (result.output.mode === "blocked") {
            this.lastOutputStatus = { kind: "warning", message: result.output.message };
          } else if (result.output.mode === "current-note") {
            this.lastOutputStatus = { kind: "success", message: `Inserted into ${result.output.path}.` };
          } else {
            this.lastOutputStatus = { kind: "success", message: `Created and opened ${result.output.path}.` };
          }
          this.render();
        } catch (error) {
          this.lastOutputStatus = {
            kind: "error",
            message: this.plugin.getUserFacingErrorDetails(error, "Yoofloe AI Writer failed.")
          };
          this.render();
        } finally {
          if (generateButton.isConnected) {
            generateButton.disabled = false;
            generateButton.setText("Generate note");
          }
        }
      })();
    });
  }
}
