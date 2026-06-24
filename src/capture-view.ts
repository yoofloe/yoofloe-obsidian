import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import { buildLocalCaptureCandidates } from "./capture";
import {
  getCaptureDomainOption,
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
    case "auto":
      return "Auto suggest";
    case "journal":
      return "Journal";
    case "task":
      return "Task";
    case "event":
      return "Event";
    case "goal":
      return "Goal";
    case "study-item":
      return "Study";
    case "study-lecture":
      return "Lecture";
    case "study-plan":
      return "Study plan";
    case "activity":
      return "Activity log";
    case "condition":
      return "Condition";
    case "meal":
      return "Meal";
    case "ritual":
      return "Ritual";
    case "exercise":
      return "Exercise";
    case "business-item":
      return "Business item";
    case "finance-transaction":
      return "Finance transaction";
    case "memo":
    default:
      return "Memo";
  }
}

function targetDescription(target: YoofloeCaptureTarget) {
  switch (target) {
    case "auto":
      return "Let Yoofloe choose the best write target from your text.";
    case "journal":
      return "Create a dated personal journal entry.";
    case "task":
      return "Create a personal schedule task.";
    case "event":
      return "Create a personal calendar event.";
    case "goal":
      return "Create a personal goal.";
    case "study-item":
      return "Create a study log or study item.";
    case "study-lecture":
      return "Create a timetable lecture.";
    case "study-plan":
      return "Create a study plan.";
    case "activity":
      return "Create a life activity record.";
    case "condition":
      return "Create a wellness condition log.";
    case "meal":
      return "Create a meal log.";
    case "ritual":
      return "Create a wellness ritual.";
    case "exercise":
      return "Create an exercise record.";
    case "business-item":
      return "Create a personal business item. Sensitive confirmation required.";
    case "finance-transaction":
      return "Create a personal finance transaction. Amount review required.";
    case "memo":
    default:
      return "Create a personal journal memo.";
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
    case "goals.goal.create":
      return "Create goal";
    case "schedule.task.create":
      return "Create task";
    case "schedule.event.create":
      return "Create event";
    case "schedule.task.complete":
      return "Complete task";
    case "schedule.task.soft_delete":
      return "Move task to Recycle bin";
    case "journal.entry.create":
      return "Create journal entry";
    case "journal.entry.soft_delete":
      return "Move journal item to Recycle bin";
    case "study.item.create":
      return "Create study item";
    case "study.lecture.create":
      return "Create lecture";
    case "study.plan.create":
      return "Create study plan";
    case "activity.item.create":
      return "Create activity";
    case "wellness.condition.create":
      return "Create condition log";
    case "wellness.meal.create":
      return "Create meal log";
    case "wellness.ritual.create":
      return "Create ritual";
    case "exercise.item.create":
      return "Create exercise";
    case "business.item.create":
      return "Create business item";
    case "finance.transaction.create":
      return "Create finance transaction";
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

type CandidateFieldSpec = {
  key: string;
  label: string;
  placeholder?: string;
  textarea?: boolean;
  required?: boolean;
  inputType?: string;
};

const CANDIDATE_FIELD_SPECS: Record<string, CandidateFieldSpec[]> = {
  memo: [
    { key: "title", label: "Title", required: true },
    { key: "content", label: "Content", textarea: true, required: true },
    { key: "date", label: "Date", placeholder: "YYYY-MM-DD" }
  ],
  journal: [
    { key: "title", label: "Title", required: true },
    { key: "content", label: "Content", textarea: true, required: true },
    { key: "date", label: "Date", placeholder: "YYYY-MM-DD" }
  ],
  task: [
    { key: "title", label: "Title", required: true },
    { key: "description", label: "Details", textarea: true },
    { key: "dueDate", label: "Due date", placeholder: "YYYY-MM-DD" },
    { key: "priority", label: "Priority" }
  ],
  event: [
    { key: "title", label: "Title", required: true },
    { key: "description", label: "Details", textarea: true },
    { key: "start", label: "Start", placeholder: "YYYY-MM-DD HH:mm", required: true },
    { key: "end", label: "End", placeholder: "YYYY-MM-DD HH:mm" },
    { key: "location", label: "Location" }
  ],
  goal: [
    { key: "title", label: "Title", required: true },
    { key: "description", label: "Description", textarea: true },
    { key: "targetValue", label: "Target value", inputType: "number" },
    { key: "currentValue", label: "Current value", inputType: "number" },
    { key: "unit", label: "Unit" },
    { key: "targetDate", label: "Target date", placeholder: "YYYY-MM-DD" }
  ],
  "study-item": [
    { key: "title", label: "Title", required: true },
    { key: "description", label: "Description", textarea: true },
    { key: "date", label: "Date", placeholder: "YYYY-MM-DD" }
  ],
  "study-lecture": [
    { key: "subject", label: "Subject", required: true },
    { key: "dayOfWeek", label: "Day" },
    { key: "startTime", label: "Start time", placeholder: "09:00", required: true },
    { key: "endTime", label: "End time", placeholder: "10:00", required: true },
    { key: "room", label: "Room" }
  ],
  "study-plan": [
    { key: "name", label: "Plan name", required: true },
    { key: "description", label: "Description", textarea: true },
    { key: "status", label: "Status" },
    { key: "targetDate", label: "Target date", placeholder: "YYYY-MM-DD" }
  ],
  activity: [
    { key: "title", label: "Title", required: true },
    { key: "description", label: "Description", textarea: true },
    { key: "date", label: "Date", placeholder: "YYYY-MM-DD" },
    { key: "duration", label: "Duration", inputType: "number" }
  ],
  condition: [
    { key: "title", label: "Title", required: true },
    { key: "notes", label: "Notes", textarea: true },
    { key: "value", label: "Value" },
    { key: "unit", label: "Unit" },
    { key: "date", label: "Date", placeholder: "YYYY-MM-DD" }
  ],
  meal: [
    { key: "title", label: "Meal", required: true },
    { key: "notes", label: "Notes", textarea: true },
    { key: "date", label: "Date", placeholder: "YYYY-MM-DD" },
    { key: "time", label: "Time", placeholder: "12:30" }
  ],
  ritual: [
    { key: "title", label: "Ritual", required: true },
    { key: "description", label: "Description", textarea: true },
    { key: "frequency", label: "Frequency" },
    { key: "duration", label: "Duration", inputType: "number" },
    { key: "vibe", label: "Vibe" }
  ],
  exercise: [
    { key: "title", label: "Exercise", required: true },
    { key: "notes", label: "Notes", textarea: true },
    { key: "date", label: "Date", placeholder: "YYYY-MM-DD" },
    { key: "duration", label: "Duration", inputType: "number" },
    { key: "distance", label: "Distance", inputType: "number" },
    { key: "sets", label: "Sets", inputType: "number" },
    { key: "reps", label: "Reps", inputType: "number" }
  ],
  "business-item": [
    { key: "title", label: "Title", required: true },
    { key: "description", label: "Description", textarea: true },
    { key: "status", label: "Status" },
    { key: "priority", label: "Priority" },
    { key: "tabCategory", label: "Business tab" },
    { key: "due_date", label: "Due date", placeholder: "YYYY-MM-DD" }
  ],
  "finance-transaction": [
    { key: "title", label: "Title", required: true },
    { key: "amount", label: "Amount", required: true, inputType: "number" },
    { key: "currency", label: "Currency", required: true },
    { key: "type", label: "Type", placeholder: "expense, income, transfer" },
    { key: "category", label: "Category" },
    { key: "date", label: "Date", placeholder: "YYYY-MM-DD", required: true },
    { key: "description", label: "Description", textarea: true }
  ]
};

function fieldSpecsForCandidate(candidate: YoofloeCaptureCandidate) {
  return CANDIDATE_FIELD_SPECS[candidate.itemType] || CANDIDATE_FIELD_SPECS.memo;
}

function displayFieldValue(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string" || typeof value === "number") return String(value);
  return "";
}

export class YoofloeCaptureView extends ItemView {
  private source: CaptureSource = "manual";
  private domain: YoofloeCaptureDomain = "auto";
  private target: YoofloeCaptureTarget = "memo";
  private text = "";
  private preview: YoofloeWritePreviewResponse | null = null;
  private selectedCandidateIds = new Set<string>();
  private editedFields: Record<string, Record<string, unknown>> = {};
  private confirmations: Record<string, boolean> = {};
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
    if (domainOption.status === "blocked") {
      this.preview = null;
      this.results = [];
      this.message = `${domainOption.label} is available as a read-only insight source, not a capture writeback target.`;
      this.render();
      return;
    }

    const effectiveTarget = this.target === "auto" ? domainOption.defaultTarget || "auto" : this.target;
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
      this.confirmations = {};
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
      this.confirmations = {};
      this.results = [];
      this.message = "No Yoofloe data changes yet. Review the cards, edit fields if needed, then apply to Yoofloe.";
    } catch (error) {
      this.preview = null;
      this.message = this.plugin.getUserFacingErrorMessage(error, "Yoofloe Capture preview failed.");
    }
    this.render();
  }

  private async applySelected() {
    const blocker = this.applyBlocker();
    if (blocker) {
      this.message = blocker;
      this.render();
      return;
    }

    const approvedCandidateIds = [...this.selectedCandidateIds];
    const confirmations: Record<string, boolean> = { confirmSoftDelete: false };
    for (const candidateId of approvedCandidateIds) {
      if (this.confirmations[candidateId]) {
        confirmations[`confirm:${candidateId}`] = true;
      }
    }

    try {
      const response = await this.plugin.executeCaptureWrite({
        previewId: this.preview!.previewId,
        approvedCandidateIds,
        editedFields: this.editedFields,
        confirmations,
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
    if (edited !== undefined && edited !== null) return displayFieldValue(edited);
    return displayFieldValue(original);
  }

  private effectiveCandidateFields(candidate: YoofloeCaptureCandidate): Record<string, unknown> {
    return {
      ...candidate.normalizedFields,
      ...(this.editedFields[candidate.candidateId] || {}),
      scope: "personal"
    };
  }

  private missingRequiredFields(candidate: YoofloeCaptureCandidate) {
    const fields = this.effectiveCandidateFields(candidate);
    return fieldSpecsForCandidate(candidate)
      .filter((spec) => spec.required)
      .filter((spec) => !displayFieldValue(fields[spec.key]).trim())
      .map((spec) => spec.label);
  }

  private selectedCandidates() {
    return (this.preview?.candidates || []).filter((candidate) => this.selectedCandidateIds.has(candidate.candidateId));
  }

  private applyBlocker() {
    if (!this.preview) return "Preview changes first.";
    if (this.preview.previewId === "local-preview") return "Connect Yoofloe before applying this capture.";
    if (!this.plugin.getStoredPat()) return "Connect Yoofloe before applying this capture.";
    if (this.plugin.settings.yoofloeAccessMode !== "read-write") return "Enable write access before applying this capture.";
    const selected = this.selectedCandidates();
    if (selected.length === 0) return "Choose at least one preview card to apply.";
    for (const candidate of selected) {
      const missing = this.missingRequiredFields(candidate);
      if (missing.length > 0) return `${candidate.title}: fill ${missing.join(", ")} before applying.`;
      if (candidate.requiresConfirmation && !this.confirmations[candidate.candidateId]) {
        return `${candidate.title}: confirm this sensitive write before applying.`;
      }
    }
    return "";
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

    const fieldGrid = card.createDiv({ cls: "yoofloe-capture-field-grid" });
    for (const spec of fieldSpecsForCandidate(candidate)) {
      const field = fieldGrid.createDiv({ cls: "yoofloe-capture-field-row" });
      field.createEl("label", {
        cls: "yoofloe-capture-field-label",
        text: `${spec.label}${spec.required ? " *" : ""}`
      });
      if (spec.textarea) {
        const input = field.createEl("textarea", {
          cls: "yoofloe-capture-field-input yoofloe-capture-textarea-small",
          attr: {
            rows: "3",
            placeholder: spec.placeholder || ""
          }
        });
        input.value = this.candidateField(candidate, spec.key);
        input.addEventListener("input", () => this.setCandidateField(candidate.candidateId, spec.key, input.value));
      } else {
        const input = field.createEl("input", {
          cls: "yoofloe-capture-field-input",
          attr: {
            type: spec.inputType || "text",
            placeholder: spec.placeholder || ""
          }
        });
        input.value = this.candidateField(candidate, spec.key);
        input.addEventListener("input", () => this.setCandidateField(candidate.candidateId, spec.key, input.value));
      }
    }

    if (candidate.requiresConfirmation) {
      const confirmRow = card.createDiv({ cls: "yoofloe-capture-confirmation" });
      const confirm = confirmRow.createEl("input", {
        attr: {
          type: "checkbox"
        }
      });
      confirm.checked = Boolean(this.confirmations[candidate.candidateId]);
      confirm.addEventListener("change", () => {
        this.confirmations[candidate.candidateId] = confirm.checked;
      });
      confirmRow.createEl("span", {
        text: "I reviewed this sensitive Yoofloe write and want to apply it."
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
      text: "Preview exact personal Yoofloe fields before anything changes, then apply only the cards you approve."
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
    const pairing = this.plugin.settings.yoofloePairing;
    if (pairing.phase !== "idle" && pairing.phase !== "connected") {
      header.createEl("div", {
        cls: "yoofloe-capture-message",
        text: pairing.message
      });
    }

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
        description: "Write what you want to create in Yoofloe. You will review fields before applying.",
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

    container.createDiv({ cls: "yoofloe-capture-section-label", text: "Yoofloe area" });
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
      titleRow.createEl("span", {
        cls: `yoofloe-status-badge yoofloe-domain-status-${option.status}`,
        text: option.status === "blocked" ? "Insight only" : "Ready"
      });
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

    container.createDiv({ cls: "yoofloe-capture-section-label", text: "What do you want to create?" });
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
        text: targetDescription(target)
      });
      button.addEventListener("click", () => {
        this.target = target;
        this.render();
      });
    }

    const actionRow = container.createDiv({ cls: "yoofloe-writer-actions" });
    const previewButton = actionRow.createEl("button", {
      cls: "mod-cta yoofloe-writer-generate",
      text: "Preview changes",
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
      connectButton.toggleAttribute("disabled", true);
      void (async () => {
        try {
          await this.plugin.connectYoofloeWeb("read-write");
          this.message = "Yoofloe read & write access is connected.";
        } catch (error) {
          this.message = this.plugin.getUserFacingErrorMessage(error, "Failed to connect Yoofloe write access.");
        } finally {
          this.render();
        }
      })();
    });

    if (this.message) {
      container.createEl("div", { cls: "yoofloe-capture-message", text: this.message });
    }

    if (this.preview) {
      const previewSection = container.createDiv({ cls: "yoofloe-capture-preview" });
      previewSection.createEl("h3", { text: "Will write to Yoofloe" });
      previewSection.createEl("p", {
        cls: "yoofloe-capture-preview-note",
        text: "No Yoofloe data changes yet. Review the exact fields below, then apply approved cards."
      });
      for (const candidate of this.preview.candidates) {
        this.renderCandidate(previewSection, candidate);
      }
    }

    this.renderResults(container);

    if (this.preview) {
      const blocker = this.applyBlocker();
      const bar = container.createDiv({ cls: "yoofloe-capture-sticky-actions" });
      const statusId = "yoofloe-capture-apply-status";
      bar.createDiv({
        cls: blocker ? "yoofloe-capture-apply-status is-blocked" : "yoofloe-capture-apply-status",
        text: blocker || `${this.selectedCandidates().length} card(s) ready to apply.`,
        attr: { id: statusId }
      });
      const applyButton = bar.createEl("button", {
        cls: "mod-cta yoofloe-capture-apply-button",
        text: this.preview.previewId === "local-preview" ? "Connect to apply" : "Apply to Yoofloe",
        attr: {
          type: "button",
          "aria-describedby": statusId
        }
      });
      applyButton.addEventListener("click", () => {
        if (this.preview?.previewId === "local-preview") {
          applyButton.toggleAttribute("disabled", true);
          void (async () => {
            try {
              await this.plugin.connectYoofloeWeb("read-write");
              this.message = "Yoofloe read & write access is connected. Preview again before applying.";
            } catch (error) {
              this.message = this.plugin.getUserFacingErrorMessage(error, "Failed to connect Yoofloe write access.");
            } finally {
              this.render();
            }
          })();
          return;
        }
        void this.applySelected();
      });
    }

    const manage = container.createEl("details", { cls: "yoofloe-help-details yoofloe-advanced-panel" });
    manage.createEl("summary", { text: "Manage recent items" });
    manage.createEl("p", {
      cls: "yoofloe-setting-note",
      text: "Recent-item editing and wider Yoofloe management are planned after the capture flow proves safe."
    });
  }
}
