import { setIcon } from "obsidian";
import {
  CHRONOHUD_AREAS, CHRONOHUD_MAX_RECORDS, CHRONOHUD_MAX_TEXT_BYTES, chronohudExcerptReference, chronohudSearchTerms,
  validateChronoHudQuery,
  type ChronoHudArea, type ChronoHudDelivery,
} from "./chronohud-protocol";

const AREA_LABELS: Record<ChronoHudArea, string> = {
  dashboard: "Date cards",
  timeline: "Timeline",
  mandalart: "Mandalart",
  matrix: "Eisenhower matrix",
};

export interface ChronoHudPanelDraft {
  areas: readonly ChronoHudArea[];
  terms: string;
}

type Action = () => void | Promise<unknown>;

export interface ChronoHudPanelModel {
  draft: ChronoHudPanelDraft;
  manual: boolean;
  locked?: boolean;
  pending?: boolean;
  busy?: boolean;
  message?: string;
  delivery?: ChronoHudDelivery | null;
  includedIndices: ReadonlySet<number>;
  excerptsEnabled: boolean;
  openSections?: Set<string>;
  updateDraft(patch: Partial<ChronoHudPanelDraft>): void;
  requestContext: Action;
  checkReply: Action;
  saveRequest?: Action;
  clearContext: Action;
  setIncluded(index: number, included: boolean): void;
  useExcerpts(enabled: boolean): void | Promise<unknown>;
}

function hint(parent: HTMLElement, text: string): void {
  parent.createEl("p", { cls: "y-ai-hint", text });
}

function toggle(
  parent: HTMLElement, text: string, accessibleLabel: string, checked: boolean, disabled: boolean,
  change: (checked: boolean) => void,
): void {
  const label = parent.createEl("label", { cls: "y-ai-context-toggle" });
  const input = label.createEl("input", { type: "checkbox", attr: { "aria-label": accessibleLabel } });
  input.checked = checked;
  input.disabled = disabled;
  label.createSpan({ text });
  input.addEventListener("change", () => change(input.checked));
}

function button(parent: HTMLElement, text: string, action: Action, disabled: boolean, primary = false): HTMLButtonElement {
  const control = parent.createEl("button", { text, cls: primary ? "mod-cta" : undefined, attr: { type: "button" } });
  control.disabled = disabled;
  control.addEventListener("click", () => { if (!control.disabled) void action(); });
  return control;
}

function approvedExcerpt(
  parent: HTMLElement, title: string, key: string, openSections?: Set<string>,
): HTMLDetailsElement {
  const details = parent.createEl("details", { cls: "y-ai-details" });
  details.open = openSections?.has(key) ?? false;
  const summary = details.createEl("summary");
  summary.createSpan({ cls: "y-ai-setting-copy", text: title });
  setIcon(summary.createSpan({ cls: "y-ai-setting-chevron", attr: { "aria-hidden": "true" } }), "chevron-down");
  details.addEventListener("toggle", () => {
    if (!details.isConnected || !openSections) return;
    if (details.open) openSections.add(key);
    else openSections.delete(key);
  });
  return details;
}

function renderDelivery(parent: HTMLElement, model: ChronoHudPanelModel, locked: boolean): void {
  const delivery = model.delivery;
  if (!delivery) return;
  const records = parent.createDiv({ attr: { role: "group", "aria-label": "Approved ChronoHUD excerpts" } });
  const { query, context } = delivery;
  const scope = query.areas.map(area => AREA_LABELS[area]).join(", ");
  hint(records, `${scope} · ${context.zone}`);
  hint(records, query.terms.length ? `Search terms · ${query.terms.join(", ")}` : "Recent snapshot");
  hint(records, `${delivery.records.length} of ${context.matched} matches returned · ${context.scanned} scanned` +
    (context.partial ? " · Partial coverage" : ""));

  const prefix = `chronohud-record-${delivery.requestId}-`;
  for (const key of model.openSections ?? []) {
    if (key.startsWith("chronohud-record-") && !key.startsWith(prefix)) model.openSections?.delete(key);
  }
  let selectedCount = 0;
  for (const [index, record] of delivery.records.entries()) {
    const reference = chronohudExcerptReference(index);
    const excerpt = approvedExcerpt(records, `${reference} · ${record.title}`, prefix + reference, model.openSections);
    hint(excerpt, record.date ? `${AREA_LABELS[record.area]} · ${record.date}` : AREA_LABELS[record.area]);
    if (record.text) excerpt.createEl("pre", { text: record.text });
    const selected = model.includedIndices.has(index);
    if (selected) selectedCount++;
    toggle(excerpt, `Include excerpt ${reference}`, `Include excerpt ${reference} from ChronoHUD`, selected, locked,
      included => model.setIncluded(index, included));
  }

  if (delivery.records.length) {
    const send = parent.createDiv({ cls: "y-ai-card" });
    const sendLabel = "Use selected excerpts in the next AI message";
    toggle(send, sendLabel, sendLabel, selectedCount > 0 && model.excerptsEnabled, locked || selectedCount === 0,
      enabled => { void model.useExcerpts(enabled); });
    hint(send, selectedCount === 0 ? "Choose excerpts to include." :
      `${selectedCount} selected. Sending the next message shares the selected excerpts with OpenAI.`);
  } else {
    hint(records, "No excerpts were included in this reply.");
  }
  button(parent.createDiv({ cls: "y-ai-calendar-proposal-actions" }), "Remove ChronoHUD excerpts", model.clearContext, locked);
}

export function renderChronoHudPanel(el: HTMLElement, model: ChronoHudPanelModel): void {
  const parent = el.createEl("section", { attr: { "aria-label": "Find context in ChronoHUD" } });
  const locked = !!model.locked || !!model.busy;
  const editingLocked = locked || !!model.pending;
  let draft = model.draft;
  hint(parent, model.manual
    ? "Open the saved request on Android and approve it in ChronoHUD. Import the reply here and delete the request copy after use."
    : "Choose what to look up, then review and approve the export in ChronoHUD on this device.");
  if (model.message) parent.createEl("p", { cls: "y-ai-status", text: model.message, attr: { role: "status" } });

  const areas = parent.createDiv({ cls: "y-ai-models", attr: { role: "group", "aria-label": "ChronoHUD areas" } });
  for (const area of CHRONOHUD_AREAS) {
    const label = AREA_LABELS[area];
    toggle(areas, label, label + " in ChronoHUD", draft.areas.includes(area), editingLocked, checked => {
      apply({ areas: CHRONOHUD_AREAS.filter(value => value === area ? checked : draft.areas.includes(value)) });
    });
  }
  const termsLabel = parent.createEl("label", { cls: "y-ai-field" });
  termsLabel.createSpan({ text: "Search terms (optional)" });
  const termsInput = termsLabel.createEl("input", {
    type: "text", attr: { "aria-label": "Search terms (optional) for ChronoHUD", autocomplete: "off" },
  });
  termsInput.value = draft.terms;
  termsInput.disabled = editingLocked;
  hint(parent, "Separate terms with commas, or leave blank for a recent snapshot.");
  const updateTerms = () => {
    if (termsInput.value !== draft.terms) apply({ terms: termsInput.value });
  };
  termsInput.addEventListener("input", event => {
    if (!("isComposing" in event) || !event.isComposing) updateTerms();
  });
  termsInput.addEventListener("compositionend", updateTerms);

  const actions = parent.createDiv({ cls: "y-ai-calendar-proposal-actions" });
  let request: HTMLButtonElement | undefined;
  if (model.pending) {
    button(actions, model.manual ? "Import ChronoHUD reply" : "Check ChronoHUD reply", model.checkReply, locked, true);
    if (model.manual && model.saveRequest) button(actions, "Save request again", model.saveRequest, locked);
    button(actions, "Cancel ChronoHUD request", model.clearContext, locked);
  } else {
    request = button(actions, model.manual ? "Save ChronoHUD request" : "Open ChronoHUD to approve", model.requestContext, locked, true);
  }
  const guidance = parent.createEl("p", { cls: "y-ai-hint", attr: { role: "status" } });

  function refresh(): void {
    let problem = "";
    if (!editingLocked) {
      try {
        validateChronoHudQuery({
          areas: draft.areas, terms: chronohudSearchTerms(draft.terms),
          maxRecords: CHRONOHUD_MAX_RECORDS, maxTextBytes: CHRONOHUD_MAX_TEXT_BYTES,
        });
      } catch (error) {
        problem = error instanceof Error ? error.message : "Review the selected areas and terms.";
      }
    }
    if (request) request.disabled = locked || !!problem;
    guidance.setText(problem);
    guidance.hidden = !problem;
  }

  function apply(patch: Partial<ChronoHudPanelDraft>): void {
    draft = { ...draft, ...patch };
    refresh();
    model.updateDraft(patch);
  }

  refresh();
  renderDelivery(parent, model, editingLocked);
}
