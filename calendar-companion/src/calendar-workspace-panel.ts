import { setIcon } from "obsidian";
import { renderCompanionStep } from "./companion-guide";
import { workspaceExcerptReference, workspaceSearchTerms } from "./calendar-workspace-query";
import { buildCalendarInsights, type CalendarInsightEntry, type CalendarInsights } from "./calendar-insights";
import type {
  WorkspaceCapabilities, WorkspaceFilters, WorkspaceFolderKind, WorkspaceLookupDelivery, WorkspaceRecordDetails,
} from "./calendar-workspace-query";
import { AREA_LABELS, civilDate, PERIOD_LABELS, QUERY_AREAS, QUERY_PERIODS, type QueryArea, type QueryPeriod } from "./question-query";
import { RECORD_TYPES, recordLabel, type RecordKind } from "./record-types";

export interface CalendarWorkspacePanelSelection {
  topic: string;
  areas: readonly QueryArea[];
  period: QueryPeriod;
  from: string | null;
  through: string | null;
  kinds: readonly RecordKind[];
  includeLinkedNotes: boolean;
  filters: WorkspaceFilters;
}

export type CalendarWorkspaceSelectionPatch =
  Partial<Omit<CalendarWorkspacePanelSelection, "filters">> & { filters?: Partial<WorkspaceFilters> };

type ProjectChoice = { id: string; label: string };
type FolderChoice = ProjectChoice & { kind: WorkspaceFolderKind };
type Action = () => void | Promise<unknown>;

export interface CalendarWorkspacePanelModel {
  selection: CalendarWorkspacePanelSelection;
  locked?: boolean;
  pending?: "capabilities" | "records" | null;
  message?: string;
  capabilities?: WorkspaceCapabilities | null;
  delivery?: WorkspaceLookupDelivery | null;
  excerptsEnabled?: boolean;
  includedIndices?: ReadonlySet<number> | null;
  setIncluded?(index: number, included: boolean): void;
  canFind?: boolean;
  folderChoices?: readonly FolderChoice[];
  projectChoices?: readonly ProjectChoice[];
  openSections?: Set<string>;
  checkCapabilities: Action;
  findRecords: Action;
  checkReply: Action;
  clearContext: Action;
  updateSelection(patch: CalendarWorkspaceSelectionPatch): void;
  useExcerpts(enabled: boolean): void | Promise<unknown>;
}

const FOLDER_LABELS: Record<WorkspaceFolderKind, string> = {
  note_folder: "Note folder", study_folder: "Study folder", project_folder: "Project folder", task: "Task folder",
};
const FOLDER_AREAS: Record<WorkspaceFolderKind, QueryArea> = {
  note_folder: "notes", study_folder: "study", project_folder: "project", task: "calendar",
};
const FILTER_LABELS = {
  includeArchive: "Include archived records",
  includeTrash: "Include records in Trash",
  includeFinancials: "Include financial records",
  includeAttachmentMetadata: "Include attachment metadata",
} as const;
const FINANCIAL_KINDS = new Set<RecordKind>(["project_income", "project_expense", "project_rate"]);
const CHOICE_LIMIT = 12;
const insightCache = new WeakMap<WorkspaceLookupDelivery, CalendarInsights | null>();

function section(
  parent: HTMLElement, name: string, label: string, openSections?: Set<string>,
): { body: HTMLDetailsElement; title: HTMLSpanElement } {
  const key = "calendar-workspace-" + name;
  const body = parent.createEl("details", { cls: "y-ai-details" });
  body.open = openSections?.has(key) ?? false;
  const summary = body.createEl("summary");
  const title = summary.createSpan({ cls: "y-ai-setting-copy", text: label });
  setIcon(summary.createSpan({ cls: "y-ai-setting-chevron", attr: { "aria-hidden": "true" } }), "chevron-down");
  if (openSections) body.addEventListener("toggle", () => {
    if (!body.isConnected) return;
    if (body.open) openSections.add(key);
    else openSections.delete(key);
  });
  return { body, title };
}

function hint(parent: HTMLElement, text: string): void {
  parent.createEl("p", { cls: "y-ai-hint", text });
}

function field(parent: HTMLElement, text: string): HTMLLabelElement {
  const label = parent.createEl("label", { cls: "y-ai-field" });
  label.createSpan({ text });
  return label;
}

function toggle(
  parent: HTMLElement, label: string, checked: boolean, disabled: boolean,
  change: (value: boolean) => void, accessibleLabel = label,
): void {
  const row = parent.createEl("label", { cls: "y-ai-context-toggle" });
  const input = row.createEl("input", { type: "checkbox", attr: { "aria-label": accessibleLabel } });
  input.checked = checked;
  input.disabled = disabled;
  row.createSpan({ text: label });
  input.addEventListener("change", () => change(input.checked));
}

function button(parent: HTMLElement, text: string, action: Action, disabled = false, primary = false): HTMLButtonElement {
  const control = parent.createEl("button", { text, cls: primary ? "mod-cta" : undefined, attr: { type: "button" } });
  control.disabled = disabled;
  control.addEventListener("click", () => { if (!control.disabled) void action(); });
  return control;
}

function withChoice<T>(values: readonly T[], value: T, selected: boolean): T[] {
  return selected ? [...values.filter(item => item !== value), value] : values.filter(item => item !== value);
}

function kindArea(kind: RecordKind, group: typeof RECORD_TYPES[number][1]): QueryArea {
  switch (group) {
    case "Notes": case "Media": return "notes";
    case "Calendar": return "calendar";
    case "Study": return "study";
    case "Project": return "project";
    case "Garden": return "garden";
    case "Flow": return "flow";
    case "Relationships":
      if (kind.startsWith("study_")) return "study";
      if (kind.startsWith("project_")) return "project";
      return kind === "focus_context" ? "garden" : "notes";
  }
}

function validKind(selection: CalendarWorkspacePanelSelection, kind: RecordKind, capabilities?: WorkspaceCapabilities | null): boolean {
  const type = RECORD_TYPES.find(item => item[0] === kind);
  if (!type || capabilities && !capabilities.readKinds.includes(kind)) return false;
  if (kind === "asset" && !selection.filters.includeAttachmentMetadata) return false;
  if (FINANCIAL_KINDS.has(kind) && !selection.filters.includeFinancials) return false;
  return selection.areas.includes(kindArea(kind, type[1])) || kind === "note" && selection.includeLinkedNotes;
}

function folderInScope(selection: CalendarWorkspacePanelSelection, kind: WorkspaceFolderKind): boolean {
  return selection.areas.includes(FOLDER_AREAS[kind]) ||
    (kind === "note_folder" && selection.includeLinkedNotes && selection.kinds.includes("note"));
}

function hasIncompatibleFilters(selection: CalendarWorkspacePanelSelection): boolean {
  return selection.filters.folders.some(folder => !folderInScope(selection, folder.kind)) ||
    (selection.filters.projects.length > 0 && !selection.areas.includes("project"));
}

function nativeChoices(model: CalendarWorkspacePanelModel): { folders: FolderChoice[]; projects: ProjectChoice[] } {
  const folders = new Map<string, FolderChoice>();
  const projects = new Map<string, ProjectChoice>();
  for (const record of model.delivery?.records ?? []) {
    if (record.state !== "active") continue;
    if (record.kind === "note_folder" || record.kind === "study_folder" || record.kind === "project_folder" ||
        record.kind === "task" && record.details.taskFolder === true) {
      folders.set(record.kind + ":" + record.sourceId, { kind: record.kind, id: record.sourceId, label: record.title });
    } else if (record.kind === "project") {
      projects.set(record.sourceId, { id: record.sourceId, label: record.title });
    }
  }
  for (const folder of model.folderChoices ?? []) folders.set(folder.kind + ":" + folder.id, folder);
  for (const project of model.projectChoices ?? []) projects.set(project.id, project);
  return { folders: [...folders.values()], projects: [...projects.values()] };
}

function picker<T>(
  parent: HTMLElement, name: string, choices: readonly T[], selected: readonly T[],
  key: (value: T) => string, label: (value: T) => string, disabled: boolean, change: (values: T[]) => void,
): void {
  const group = parent.createDiv({ attr: { role: "group", "aria-label": name } });
  const available = choices.filter(choice => !selected.some(item => key(item) === key(choice)));
  if (choices.length || selected.length) {
    const select = field(group, name).createEl("select", { attr: { "aria-label": name } });
    select.createEl("option", { value: "", text: "Choose…" });
    for (const choice of available) select.createEl("option", { value: key(choice), text: label(choice) });
    select.disabled = disabled || !available.length || selected.length >= CHOICE_LIMIT;
    select.addEventListener("change", () => {
      const choice = available.find(entry => key(entry) === select.value);
      if (choice) change([...selected, choice]);
    });
  }
  if (selected.length) {
    const row = group.createDiv({ cls: "y-ai-row" });
    for (const choice of selected) {
      const text = label(choice);
      const remove = button(row, text + " ×", () => change(selected.filter(item => key(item) !== key(choice))), disabled);
      remove.setAttribute("aria-label", "Remove filter " + text);
    }
  }
}

function filters(
  parent: HTMLElement, model: CalendarWorkspacePanelModel, disabled: boolean,
  selection: () => CalendarWorkspacePanelSelection, apply: (patch: CalendarWorkspaceSelectionPatch) => void,
): () => void {
  const { body } = section(parent, "filters", "Additional filters", model.openSections);
  for (const [key, label] of Object.entries(FILTER_LABELS) as [keyof typeof FILTER_LABELS, string][]) {
    toggle(body, label, selection().filters[key], disabled, value => apply({ filters: { [key]: value } }));
  }
  toggle(body, "Include linked notes", selection().includeLinkedNotes, disabled, includeLinkedNotes => apply({ includeLinkedNotes }));
  const choices = nativeChoices(model);
  const folderKey = (value: { kind: WorkspaceFolderKind; id: string }) => value.kind + ":" + value.id;
  const selectors = body.createDiv();
  const renderPickers = () => {
    selectors.empty();
    const selected = selection();
    const projectsInScope = selected.areas.includes("project");
    const folderName = (value: { kind: WorkspaceFolderKind; id: string }) => {
      const label = choices.folders.find(choice => folderKey(choice) === folderKey(value))?.label;
      const name = label ? FOLDER_LABELS[value.kind] + " · " + label : FOLDER_LABELS[value.kind];
      return folderInScope(selected, value.kind) ? name : name + " · outside search scope";
    };
    const projectName = (id: string) => {
      const name = choices.projects.find(project => project.id === id)?.label || "Selected project";
      return projectsInScope ? name : name + " · outside search scope";
    };
    const folders = choices.folders.filter(folder => folderInScope(selected, folder.kind));
    const projects = projectsInScope ? choices.projects.map(item => item.id) : [];
    picker(selectors, "Filter by Calendar folders", folders, selected.filters.folders, folderKey, folderName, disabled, values => {
      apply({ filters: { folders: values.map(({ kind, id }) => ({ kind, id })) } });
    });
    picker(selectors, "Filter by projects", projects, selected.filters.projects, id => id, projectName, disabled, values => {
      apply({ filters: { projects: values } });
    });
    if (!folders.length || projectsInScope && !projects.length)
      hint(selectors, "Folder and project choices come from approved Calendar results in the search scope.");
  };
  renderPickers();
  return renderPickers;
}

function renderCapabilities(parent: HTMLElement, model: CalendarWorkspacePanelModel): void {
  const capabilities = model.capabilities ?? model.delivery?.capabilities;
  if (!capabilities) return;
  const { readKinds, writeKinds } = capabilities;
  const { body } = section(parent, "capabilities", "Calendar capabilities · " + readKinds.length + " record types",
    model.openSections);
  hint(body, readKinds.length ? readKinds.map(recordLabel).join(" · ") : "Calendar reports no record types available for lookup.");
  if (!writeKinds.length) {
    hint(body, "Calendar reports no supported changes for this connection.");
    return;
  }
  body.createEl("strong", { text: "Changes available for review in Calendar" });
  const list = body.createEl("ul", { cls: "y-ai-hint" });
  for (const { kind, actions } of writeKinds) list.createEl("li", { text: recordLabel(kind) + " · " + actions.join(", ") });
}

function addInsightList(parent: HTMLElement, label: string, entries: readonly CalendarInsightEntry[]): void {
  if (!entries.length) return;
  parent.createEl("strong", { text: label });
  const list = parent.createEl("ul");
  for (const entry of entries) list.createEl("li", {
    text: entry.text + (entry.references.length ? " · " + entry.references.join(", ") : ""),
  });
}

function localInsights(delivery: WorkspaceLookupDelivery): CalendarInsights | null {
  if (!delivery.context) return null;
  if (insightCache.has(delivery)) return insightCache.get(delivery) ?? null;
  try {
    const insights = buildCalendarInsights({ ...delivery, context: delivery.context });
    insightCache.set(delivery, insights);
    return insights;
  } catch {
    insightCache.set(delivery, null);
    return null;
  }
}

function renderInsights(parent: HTMLElement, insights: CalendarInsights, openSections?: Set<string>): void {
  const { body } = section(parent, "insights", "Local Calendar summary", openSections);
  for (const group of insights.sections) {
    if (!group.facts.length && !group.derived.length && !group.limits.length) continue;
    const card = body.createEl("section", { cls: "y-ai-card", attr: { "aria-label": AREA_LABELS[group.area] } });
    card.createEl("h3", { text: AREA_LABELS[group.area] });
    addInsightList(card, "Facts from Calendar", group.facts);
    addInsightList(card, "Calculated from the approved results", group.derived);
    for (const limit of group.limits) hint(card, limit);
  }
  if (!body.querySelector("section")) hint(body, "This search returned no facts or calculations to summarize.");
}

function renderRecordDetails(parent: HTMLElement, details: WorkspaceRecordDetails): void {
  const metadata: string[] = [];
  if (details.tags?.length) metadata.push("Tags · " + details.tags.join(", "));
  if (details.pinned) metadata.push("Pinned");
  if (details.attachmentCount !== undefined) metadata.push("Attachments · " + details.attachmentCount);
  if (details.mediaType) metadata.push(details.mediaType);
  if (details.byteLength !== undefined) metadata.push(details.byteLength.toLocaleString() + " bytes");
  if (metadata.length) hint(parent, metadata.join(" · "));
  const fields = [
    ["Status", details.status], ["Completed", details.completed === undefined ? undefined : details.completed ? "Yes" : "No"],
    ["Starts", details.startDate], ["Due", details.dueDate], ["Target date", details.targetDate],
    ["Recorded seconds", details.recordedSeconds], ["Scheduled seconds", details.scheduledSeconds],
    ["Currency", details.currency], ["Gross", details.gross], ["Net", details.net], ["Net basis", details.netKind],
    ["Amount", details.amount], ["From currency", details.fromCurrency], ["To currency", details.toCurrency], ["Rate", details.rate],
  ] as const;
  if (!fields.some(([, value]) => value !== undefined) && !details.intervals?.length) return;
  const list = parent.createEl("ul", { cls: "y-ai-hint" });
  for (const [label, value] of fields) {
    if (value !== undefined) list.createEl("li", { text: label + " · " + value });
  }
  for (const interval of details.intervals ?? []) list.createEl("li", { text: interval.startAt + " to " + interval.endAt });
}

function renderDelivery(parent: HTMLElement, model: CalendarWorkspacePanelModel): void {
  const delivery = model.delivery;
  if (!delivery?.context || delivery.query.mode !== "records") return;
  const approved = delivery.context;
  const body = parent.createDiv({ attr: { role: "group", "aria-label": "Approved Calendar excerpts" } });
  const range = approved.from && approved.through ? approved.from + " to " + approved.through : "Any date";
  const scope = [approved.scope.areas.map(area => AREA_LABELS[area]).join(", "), range, approved.zone];
  hint(body, scope.join(" · "));
  hint(body, approved.scanned + " scanned · " + approved.matched + " matched · " + delivery.records.length + " returned" +
    (approved.partial ? " · Partial coverage" : ""));
  const enabled = Object.entries(FILTER_LABELS).filter(([key]) => delivery.query.filters[key as keyof typeof FILTER_LABELS])
    .map(([, label]) => label.replace(/^Include /, ""));
  if (approved.scope.includeLinkedNotes) enabled.push("linked notes");
  if (enabled.length) hint(body, "Included by choice · " + enabled.join(", "));
  if (!delivery.records.length) hint(body, "No Calendar records matched this approved search.");
  const sourceKey = "record-" + delivery.requestId + "-";
  for (const key of model.openSections ?? []) {
    if (key.startsWith("calendar-workspace-record-") && !key.startsWith("calendar-workspace-" + sourceKey))
      model.openSections?.delete(key);
  }
  let selectedCount = 0;
  for (const [index, record] of delivery.records.entries()) {
    const reference = workspaceExcerptReference(delivery, index);
    const { body: source } = section(body, sourceKey + reference, reference + " · " + (record.title.trim() || "Untitled"),
      model.openSections);
    const metadata = [recordLabel(record.kind), record.date,
      record.state === "archived" ? "Archived" : record.state === "trashed" ? "In Trash" : null].filter(Boolean);
    hint(source, metadata.join(" · "));
    const selected = model.includedIndices?.has(index) ?? true;
    if (selected) selectedCount++;
    if (model.setIncluded) toggle(source, "Include excerpt " + reference, selected, !!model.locked || !!model.pending, checked => {
      model.setIncluded?.(index, checked);
    });
    if (record.text) source.createEl("pre", { text: record.text });
    renderRecordDetails(source, record.details);
  }
  const insights = localInsights(delivery);
  if (insights) renderInsights(parent, insights, model.openSections);
  else hint(parent, "The approved excerpts are available, but a local summary could not be calculated.");
  if (delivery.records.length) {
    const action = parent.createDiv({ cls: "y-ai-card", attr: { role: "group", "aria-label": "Calendar excerpts for OpenAI" } });
    toggle(action, "Use approved excerpts with OpenAI", model.excerptsEnabled === true,
      !!model.locked || !!model.pending || !selectedCount, enabled => { void model.useExcerpts(enabled); });
    const disclosure = selectedCount === 1 ? "1 excerpt selected" : selectedCount + " excerpts selected";
    hint(action, disclosure + ". Send in the composer shares the selected excerpts with OpenAI.");
  }
  button(parent, "Remove approved Calendar sources", model.clearContext, !!model.locked || !!model.pending);
}

/** Render Calendar controls without launching the companion or sending a provider request. */
export function renderCalendarWorkspacePanel(el: HTMLElement, model: CalendarWorkspacePanelModel): void {
  const parent = el.createEl("section", { attr: { "aria-label": "Find Calendar records" } });
  const locked = !!model.locked;
  const capabilities = model.capabilities ?? model.delivery?.capabilities;
  if (model.message) parent.createEl("p", { cls: "y-ai-status", text: model.message, attr: { role: "status" } });

  if (model.pending) {
    renderCompanionStep(parent, "Approve in Calendar", model.pending === "capabilities"
      ? "If asked, choose this vault’s Yoofloe Calendar Inbox. Tap Share capabilities, then return to Obsidian."
      : "Review the search in Calendar, then tap Find relevant records. Return to Obsidian to review the excerpts.");
    const actions = parent.createDiv({ cls: "y-ai-calendar-proposal-actions" });
    button(actions, "Check Calendar reply", model.checkReply, locked, true);
    button(actions, "Cancel Calendar request", model.clearContext, locked);
    return;
  }
  if (!capabilities) {
    renderCompanionStep(parent, "Connect Calendar", "In Calendar, choose this vault’s Yoofloe Calendar Inbox if prompted, then tap Share capabilities.");
    button(parent, "Check Calendar connection", model.checkCapabilities, locked, true);
    return;
  }
  if (model.delivery) {
    renderCompanionStep(parent, "Review Calendar excerpts", "Choose the excerpts to include in your next message.");
    renderDelivery(parent, model);
  } else {
    renderCompanionStep(parent, "Choose Calendar records", "Choose what to look up. Calendar will ask you to approve the excerpts it shares.");
  }
  let selection = model.selection;

  const topic = field(parent, "Search terms (optional)").createEl("input", { type: "text", attr: { "aria-label": "Search terms (optional)" } });
  topic.value = selection.topic;
  topic.maxLength = 640;
  topic.disabled = locked;
  hint(parent, "Separate search terms with commas. Set dates below.");

  const workspaces = section(parent, "workspaces", "Workspaces", model.openSections);
  const workspaceGrid = workspaces.body.createDiv({ cls: "y-ai-models" });
  const kinds = section(parent, "types", "Record types", model.openSections);
  const kindsGrid = kinds.body.createDiv({ cls: "y-ai-models" });
  const period = field(parent, "Date range").createEl("select", { attr: { "aria-label": "Date range" } });
  for (const value of QUERY_PERIODS) period.createEl("option", { value, text: PERIOD_LABELS[value] });
  period.value = selection.period;
  period.disabled = locked;
  const dates = parent.createDiv({ cls: "y-ai-models" });
  dates.hidden = selection.period !== "custom";
  const from = field(dates, "From date").createEl("input", { type: "date", attr: { "aria-label": "From date" } });
  const through = field(dates, "Through date").createEl("input", { type: "date", attr: { "aria-label": "Through date" } });
  from.value = selection.from ?? "";
  through.value = selection.through ?? "";
  from.disabled = through.disabled = locked;

  const refreshFilters = filters(parent, model, locked, () => selection, apply);
  const actions = parent.createDiv({ cls: "y-ai-calendar-proposal-actions" });
  const findButton = button(actions, "Find records in Calendar", model.findRecords, locked, true);
  button(actions, "Refresh Calendar connection", model.checkCapabilities, locked);
  const guidance = parent.createEl("p", { cls: "y-ai-hint", attr: { role: "status" } });

  function refresh() {
    workspaces.title.setText("Workspaces · " + selection.areas.length + " selected");
    kinds.title.setText("Record types · " + selection.kinds.length + " selected");
    const terms = workspaceSearchTerms(selection.topic);
    let problem = "";
    if (terms.length > 8 || terms.some(term => new TextEncoder().encode(term).length > 80)) {
      problem = "Use up to eight search terms, each up to 80 UTF-8 bytes.";
    } else if (selection.period === "any" && !terms.length) {
      problem = "Enter a search term for Any date, or choose a date range.";
    } else if (hasIncompatibleFilters(selection)) problem = "Remove folder or project filters outside the search scope, or include their workspace.";
    else if (!selection.areas.length || !selection.kinds.length) problem = "Choose at least one workspace and record type.";
    else if (selection.kinds.some(kind => !validKind(selection, kind, capabilities)))
      problem = "Review the selected record types and their required filters.";
    else if (selection.period === "custom" && (!civilDate(selection.from) || !civilDate(selection.through) || selection.from > selection.through))
      problem = "Choose a valid start and end date.";
    findButton.disabled = locked || model.canFind === false || !!problem;
    guidance.setText(locked ? "" : problem);
    guidance.hidden = locked || !problem;
  }

  function drawKinds() {
    kindsGrid.empty();
    let available = 0;
    for (const [kind, , label] of RECORD_TYPES) {
      const selected = selection.kinds.includes(kind);
      const allowed = validKind(selection, kind, capabilities);
      if (!allowed && !selected) continue;
      available++;
      toggle(kindsGrid, label + (allowed ? "" : " · unavailable"), selected, locked, checked => {
        apply({ kinds: withChoice(selection.kinds, kind, checked) }, !allowed);
      }, label + " record type");
    }
    if (!available) hint(kindsGrid, "Record types appear when you select a workspace or enable its additional filters.");
  }

  function apply(patch: CalendarWorkspaceSelectionPatch, refreshKinds = true) {
    selection = { ...selection, ...patch, filters: { ...selection.filters, ...patch.filters } };
    if (refreshKinds) drawKinds();
    refresh();
    model.updateSelection(patch);
    if (patch.areas || patch.kinds || patch.includeLinkedNotes !== undefined || patch.filters?.folders || patch.filters?.projects)
      refreshFilters();
  }

  for (const area of QUERY_AREAS) {
    toggle(workspaceGrid, AREA_LABELS[area], selection.areas.includes(area), locked, checked => {
      apply({ areas: withChoice(selection.areas, area, checked) });
    });
  }
  const updateTopic = () => {
    if (topic.value !== selection.topic) apply({ topic: topic.value }, false);
  };
  topic.addEventListener("input", event => {
    if (!("isComposing" in event) || !event.isComposing) updateTopic();
  });
  topic.addEventListener("compositionend", updateTopic);
  period.addEventListener("change", () => {
    const value = period.value as QueryPeriod;
    dates.hidden = value !== "custom";
    apply({ period: value }, false);
  });
  from.addEventListener("change", () => apply({ from: from.value || null }, false));
  through.addEventListener("change", () => apply({ through: through.value || null }, false));
  drawKinds();
  refresh();
  renderCapabilities(parent, model);
}
