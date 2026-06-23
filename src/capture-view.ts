import { ItemView, Notice, Setting, WorkspaceLeaf } from "obsidian";
import { buildLocalCaptureCandidates } from "./capture";
import {
  getCaptureDomainOption,
  isCaptureDomainReady,
  YOOFLOE_CAPTURE_DOMAIN_OPTIONS,
  type YoofloeCaptureDomain
} from "./capture-registry";
import type YoofloePlugin from "./main";
import type { CaptureSelectionPayload } from "./main";
import { YOOFLOE_CAPTURE_TARGETS } from "./types";
import type {
  YoofloeCaptureCandidate,
  YoofloeCaptureTarget,
  YoofloeWriteExecuteResult,
  YoofloeWritePreviewResponse
} from "./types";

export const YOOFLOE_CAPTURE_VIEW_TYPE = "yoofloe-capture";

type CaptureSource = "manual" | "selection";

function targetLabel(target: YoofloeCaptureTarget) {
  switch (target) {
    case "task":
      return "Task";
    case "journal":
      return "Journal";
    case "memo":
    default:
      return "Memo";
  }
}

function noteLabel(path: string | undefined) {
  if (!path) return "current note";
  return path.split(/[\\/]/).pop() || path;
}

function selectionStatusTitle(selection: CaptureSelectionPayload) {
  if (!selection.text) return "No selected text";
  return selection.source === "cached" ? "Last selected text" : "Selected text ready";
}

function selectionStatusBody(selection: CaptureSelectionPayload) {
  if (!selection.text) {
    return "Click the note, select text, then use Refresh selected text.";
  }

  const sourceHint = selection.source === "cached" ? "last captured from" : "from";
  return `${selection.text.length} characters ${sourceHint} ${noteLabel(selection.path)}.`;
}

function actionLabel(action: string) {
  switch (action) {
    case "schedule.task.create":
      return "Create task";
    case "schedule.task.complete":
      return "Complete task";
    case "schedule.task.soft_delete":
      return "Move task to Recycle bin";
    case "journal.entry.create":
      return "Create journal entry";
    case "journal.entry.soft_delete":
      return "Move journal item to Recycle bin";
    case "journal.memo.create":
    default:
      return "Create memo";
  }
}

function resultLabel(status: YoofloeWriteExecuteResult["status"]) {
  switch (status) {
    case "applied":
      return "Applied";
    case "blocked":
      return "Blocked";
    case "needs_confirmation":
      return "Needs confirmation";
    case "conflict":
      return "Conflict";
    case "failed":
      return "Failed";
    case "skipped":
    default:
      return "Skipped";
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
      rows: "5"
    }
  });
  textarea.value = args.value;
  textarea.addEventListener("input", () => args.onChange(textarea.value));
  return textarea;
}

export class YoofloeCaptureView extends ItemView {
  private source: CaptureSource = "manual";
  private domain: YoofloeCaptureDomain = "auto";
  private target: YoofloeCaptureTarget = "memo";
  private text = "";
  private preview: YoofloeWritePreviewResponse | null = null;
  private selectedCandidateIds = new Set<string>();
  private editedFields: Record<string, Record<string, unknown>> = {};
  private results: YoofloeWriteExecuteResult[] = [];
  private message = "";

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: YoofloePlugin
  ) {
    super(leaf);
  }

  getViewType() {
    return YOOFLOE_CAPTURE_VIEW_TYPE;
  }

  getDisplayText() {
    return "Yoofloe capture";
  }

  getIcon() {
    return "send";
  }

  onOpen(): Promise<void> {
    this.render();
    return Promise.resolve();
  }

  private getSelectedTextPayload(allowCached = true) {
    return this.plugin.getCaptureSelectionPayload({ allowCached });
  }

  private refreshSelectedText() {
    const selection = this.plugin.refreshCaptureSelectionPayload();
    this.message = selection.text
      ? `Selected text ready (${selection.text.length} characters from ${noteLabel(selection.path)}).`
      : "No selected text found. Click the note body, select text, then try again.";
    this.preview = null;
    this.results = [];
    this.render();
  }

  private currentText() {
    if (this.source === "selection") {
      return this.getSelectedTextPayload().text;
    }
    return this.text.trim();
  }

  private async previewCapture() {
    const selectionPayload = this.source === "selection" ? this.getSelectedTextPayload(true) : null;
    const text = this.source === "selection" ? selectionPayload?.text || "" : this.text.trim();
    if (!text) {
      this.message = this.source === "selection"
        ? "No selected text found. Click the note body, select text, then use Refresh selected text before previewing."
        : "Add something to capture before previewing.";
      this.preview = null;
      this.results = [];
      this.render();
      return;
    }

    const domainOption = getCaptureDomainOption(this.domain);
    if (!isCaptureDomainReady(this.domain)) {
      this.preview = null;
      this.results = [];
      this.message = domainOption.status === "blocked"
        ? `${domainOption.label} is available as a read-only insight source, not a capture writeback target.`
        : `${domainOption.label} capture is planned next. ${domainOption.description}`;
      this.render();
      return;
    }

    const effectiveTarget = domainOption.defaultTarget || this.target;
    const token = this.plugin.getStoredPat();
    if (!token) {
      const candidates = buildLocalCaptureCandidates(text, effectiveTarget);
      this.preview = {
        success: true,
        previewId: "local-preview",
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        candidates
      };
      this.selectedCandidateIds = new Set(candidates.map((candidate) => candidate.candidateId));
      this.message = "Connect Yoofloe to apply this preview to your account.";
      this.results = [];
      this.render();
      return;
    }

    try {
      const response = await this.plugin.previewCaptureWrite({
        source: this.source,
        text,
        notePath: selectionPayload?.path,
        selectionOnly: this.source === "selection",
        target: effectiveTarget,
        domain: this.domain,
        scope: "personal"
      });
      this.preview = response;
      this.selectedCandidateIds = new Set(response.candidates.map((candidate) => candidate.candidateId));
      this.editedFields = {};
      this.results = [];
      this.message = "Review the cards, edit fields if needed, then apply selected.";
    } catch (error) {
      this.preview = null;
      this.message = this.plugin.getUserFacingErrorMessage(error, "Yoofloe Capture preview failed.");
    }
    this.render();
  }

  private async applySelected() {
    if (!this.preview || this.preview.previewId === "local-preview") {
      this.message = "Connect Yoofloe before applying this capture.";
      this.render();
      return;
    }

    const approvedCandidateIds = [...this.selectedCandidateIds];
    if (approvedCandidateIds.length === 0) {
      this.message = "Choose at least one candidate to apply.";
      this.render();
      return;
    }

    try {
      const response = await this.plugin.executeCaptureWrite({
        previewId: this.preview.previewId,
        approvedCandidateIds,
        editedFields: this.editedFields,
        confirmations: { confirmSoftDelete: false },
        clientRequestId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        scope: "personal"
      });
      this.results = response.results;
      this.message = response.success
        ? "Yoofloe Capture applied."
        : "No selected capture was applied. Review the result cards.";
    } catch (error) {
      const text = this.plugin.getUserFacingErrorMessage(error, "Yoofloe Capture apply failed.");
      this.message = text;
      if (/write access|TOKEN_SCOPE_INSUFFICIENT|Reconnect Yoofloe/i.test(text)) {
        new Notice("Reconnect Yoofloe with write access to apply capture cards.");
      }
    }
    this.render();
  }

  private setCandidateField(candidateId: string, field: string, value: string) {
    this.editedFields[candidateId] = {
      ...(this.editedFields[candidateId] || {}),
      [field]: value
    };
  }

  private candidateField(candidate: YoofloeCaptureCandidate, field: string) {
    const edited = this.editedFields[candidate.candidateId]?.[field];
    const original = candidate.normalizedFields[field];
    return typeof edited === "string" ? edited : typeof original === "string" ? original : "";
  }

  private renderCandidate(container: HTMLElement, candidate: YoofloeCaptureCandidate) {
    const card = container.createDiv({ cls: "yoofloe-capture-card" });
    const header = card.createDiv({ cls: "yoofloe-capture-card-header" });
    const checkbox = header.createEl("input", { attr: { type: "checkbox" } });
    checkbox.checked = this.selectedCandidateIds.has(candidate.candidateId);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        this.selectedCandidateIds.add(candidate.candidateId);
      } else {
        this.selectedCandidateIds.delete(candidate.candidateId);
      }
    });
    const title = header.createDiv();
    title.createEl("div", { cls: "yoofloe-capture-card-title", text: candidate.title });
    const subtitle = title.createDiv({ cls: "yoofloe-capture-card-subtitle" });
    subtitle.createSpan({ text: actionLabel(candidate.action) });
    subtitle.createSpan({ cls: "yoofloe-capture-meta-chip", text: candidate.menu || candidate.domain || "Yoofloe" });
    if (candidate.riskTier) {
      subtitle.createSpan({ cls: `yoofloe-capture-meta-chip yoofloe-risk-${candidate.riskTier}`, text: `${candidate.riskTier} risk` });
    }

    if (candidate.sourceSnippet) {
      card.createEl("p", { cls: "yoofloe-capture-snippet", text: candidate.sourceSnippet });
    }

    new Setting(card)
      .setName("Title")
      .addText((text) => {
        text
          .setValue(this.candidateField(candidate, "title"))
          .onChange((value) => this.setCandidateField(candidate.candidateId, "title", value));
      });

    if (candidate.itemType === "task") {
      new Setting(card)
        .setName("Details")
        .addTextArea((text) => {
          text
            .setValue(this.candidateField(candidate, "description"))
            .onChange((value) => this.setCandidateField(candidate.candidateId, "description", value));
          text.inputEl.classList.add("yoofloe-capture-textarea-small");
        });
      new Setting(card)
        .setName("Due date")
        .addText((text) => {
          text
            .setPlaceholder("YYYY-MM-DD")
            .setValue(this.candidateField(candidate, "dueDate"))
            .onChange((value) => this.setCandidateField(candidate.candidateId, "dueDate", value));
        });
    } else {
      new Setting(card)
        .setName("Content")
        .addTextArea((text) => {
          text
            .setValue(this.candidateField(candidate, "content"))
            .onChange((value) => this.setCandidateField(candidate.candidateId, "content", value));
          text.inputEl.classList.add("yoofloe-capture-textarea");
        });
    }

    for (const warning of candidate.warnings || []) {
      card.createEl("div", { cls: "yoofloe-capture-warning", text: warning });
    }
  }

  private renderResults(container: HTMLElement) {
    if (this.results.length === 0) return;
    const section = container.createDiv({ cls: "yoofloe-capture-results" });
    section.createEl("h3", { text: "Results" });
    for (const result of this.results) {
      const row = section.createDiv({ cls: `yoofloe-capture-result yoofloe-capture-result-${result.status.replace("_", "-")}` });
      row.createEl("strong", { text: resultLabel(result.status) });
      row.createEl("span", { text: result.message || result.itemId || result.candidateId });
    }
  }

  private render() {
    const container = this.contentEl;
    container.empty();
    container.addClass("yoofloe-capture-view");

    const header = container.createDiv({ cls: "yoofloe-writer-header" });
    header.createEl("div", { cls: "yoofloe-writer-kicker", text: "Yoofloe capture" });
    header.createEl("h2", { text: "Capture to Yoofloe" });
    header.createEl("p", {
      text: "Send selected ideas from Obsidian into personal Yoofloe data after previewing them first."
    });

    const status = header.createDiv({ cls: "yoofloe-writer-status-row" });
    status.createEl("span", {
      cls: `yoofloe-status-badge yoofloe-status-${this.plugin.tokenStatus === "missing" ? "warning" : this.plugin.tokenStatus === "invalid" ? "danger" : "success"}`,
      text: this.plugin.tokenStatus === "missing" ? "Connect Yoofloe" : this.plugin.tokenStatus === "invalid" ? "Reconnect Yoofloe" : "Connected"
    });
    status.createEl("span", { cls: "yoofloe-status-badge yoofloe-status-muted", text: "Personal only" });
    status.createEl("span", {
      cls: `yoofloe-status-badge yoofloe-status-${this.plugin.settings.yoofloeAccessMode === "read-write" ? "success" : "muted"}`,
      text: this.plugin.settings.yoofloeAccessMode === "read-write" ? "Read & write" : "Read access"
    });
    status.createEl("span", { cls: "yoofloe-status-badge yoofloe-status-muted", text: "Preview before apply" });

    const sourceRow = container.createDiv({
      cls: "yoofloe-capture-source-row",
      attr: { role: "group", "aria-label": "Capture source" }
    });
    for (const source of ["manual", "selection"] as CaptureSource[]) {
      const button = sourceRow.createEl("button", {
        cls: `yoofloe-capture-toggle${this.source === source ? " is-active" : ""}`,
        text: source === "manual" ? "Write manually" : "Use selected text",
        attr: {
          type: "button",
          "aria-pressed": this.source === source ? "true" : "false"
        }
      });
      button.addEventListener("click", () => {
        this.source = source;
        if (source === "selection") {
          const selected = this.getSelectedTextPayload(false);
          this.message = selected.text
            ? "Selected text will be sent only when you click Preview."
            : "Select text in an open note first, or use Refresh selected text after selecting.";
        }
        this.render();
      });
    }

    if (this.source === "manual") {
      createTextareaField(container, {
        id: "yoofloe-capture-text",
        label: "Capture text",
        description: "Write the memo, journal entry, or task you want to send to Yoofloe.",
        placeholder: "Capture to Yoofloe...",
        value: this.text,
        className: "yoofloe-capture-input",
        onChange: (value) => {
          this.text = value;
        }
      });
    } else {
      const selected = this.getSelectedTextPayload();
      const selectionCard = container.createDiv({ cls: "yoofloe-info-card yoofloe-selection-card" });
      selectionCard.createEl("div", { cls: "yoofloe-info-card-title", text: selectionStatusTitle(selected) });
      selectionCard.createEl("p", { cls: "yoofloe-info-card-body", text: selectionStatusBody(selected) });
      const refreshButton = selectionCard.createEl("button", {
        cls: "yoofloe-inline-action yoofloe-selection-refresh",
        text: "Refresh selected text",
        attr: {
          type: "button"
        }
      });
      refreshButton.addEventListener("click", () => this.refreshSelectedText());
    }

    container.createDiv({ cls: "yoofloe-capture-section-label", text: "Menu" });
    const domainGrid = container.createDiv({ cls: "yoofloe-capture-domain-grid" });
    for (const option of YOOFLOE_CAPTURE_DOMAIN_OPTIONS) {
      const button = domainGrid.createEl("button", {
        cls: `yoofloe-preset-button yoofloe-capture-domain${this.domain === option.domain ? " is-active" : ""}${option.sensitive ? " is-sensitive" : ""}`,
        attr: {
          type: "button",
          "aria-pressed": this.domain === option.domain ? "true" : "false"
        }
      });
      const titleRow = button.createDiv({ cls: "yoofloe-capture-domain-title-row" });
      titleRow.createEl("span", { cls: "yoofloe-preset-title", text: option.label });
      titleRow.createEl("span", { cls: `yoofloe-status-badge yoofloe-domain-status-${option.status}`, text: option.status === "ready" ? "Ready" : option.status });
      if (option.sensitive) {
        titleRow.createEl("span", { cls: "yoofloe-sensitive-label", text: "Sensitive" });
      }
      button.createEl("span", { cls: "yoofloe-preset-description", text: option.description });
      button.addEventListener("click", () => {
        this.domain = option.domain;
        if (option.defaultTarget) {
          this.target = option.defaultTarget;
        }
        this.preview = null;
        this.results = [];
        this.message = option.status === "ready" ? "" : option.description;
        this.render();
      });
    }

    container.createDiv({ cls: "yoofloe-capture-section-label", text: "Target suggestion" });
    const targetGrid = container.createDiv({ cls: "yoofloe-capture-target-grid" });
    for (const target of YOOFLOE_CAPTURE_TARGETS) {
      const button = targetGrid.createEl("button", {
        cls: `yoofloe-preset-button yoofloe-capture-target${this.target === target ? " is-active" : ""}`,
        attr: {
          type: "button",
          "aria-pressed": this.target === target ? "true" : "false"
        }
      });
      const titleRow = button.createSpan({ cls: "yoofloe-card-title-row" });
      titleRow.createEl("span", { cls: "yoofloe-preset-title", text: targetLabel(target) });
      button.createEl("span", {
        cls: "yoofloe-preset-description",
        text: target === "task"
          ? "Create a personal schedule task."
          : target === "journal"
            ? "Create a personal journal entry."
            : "Create a personal journal memo."
      });
      button.addEventListener("click", () => {
        this.target = target;
        this.render();
      });
    }

    const actionRow = container.createDiv({ cls: "yoofloe-writer-actions" });
    const previewButton = actionRow.createEl("button", {
      cls: "mod-cta yoofloe-writer-generate",
      text: "Preview",
      attr: { type: "button" }
    });
    previewButton.addEventListener("click", () => {
      void this.previewCapture();
    });
    const connectButton = actionRow.createEl("button", {
      text: this.plugin.getStoredPat()
        ? this.plugin.settings.yoofloeAccessMode === "read-write"
          ? "Refresh write access"
          : "Enable write access"
        : "Connect Yoofloe",
      attr: { type: "button" }
    });
    connectButton.addEventListener("click", () => {
      void this.plugin.connectYoofloeWeb("read-write");
    });

    if (this.message) {
      container.createEl("div", { cls: "yoofloe-capture-message", text: this.message });
    }

    if (this.preview) {
      const previewSection = container.createDiv({ cls: "yoofloe-capture-preview" });
      previewSection.createEl("h3", { text: "Preview candidates" });
      for (const candidate of this.preview.candidates) {
        this.renderCandidate(previewSection, candidate);
      }

      const applyRow = previewSection.createDiv({ cls: "yoofloe-writer-actions" });
      const applyButton = applyRow.createEl("button", {
        cls: "mod-cta yoofloe-writer-generate",
        text: this.preview.previewId === "local-preview" ? "Connect to apply" : "Apply selected",
        attr: { type: "button" }
      });
      applyButton.addEventListener("click", () => {
        if (this.preview?.previewId === "local-preview") {
          void this.plugin.connectYoofloeWeb("read-write");
          return;
        }
        void this.applySelected();
      });
    }

    this.renderResults(container);

    const manage = container.createEl("details", { cls: "yoofloe-help-details yoofloe-advanced-panel" });
    manage.createEl("summary", { text: "Manage recent items" });
    manage.createEl("p", {
      cls: "yoofloe-setting-note",
      text: "Recent-item editing and wider Yoofloe management are planned after the capture flow proves safe."
    });
  }
}
