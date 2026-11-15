import { Platform } from "obsidian";
import type { AiWorkspace } from "./workspace";
import type { CalendarChangeAction } from "./calendar-change";
import type { CalendarChangeStatus } from "./calendar-change-controller";
import { isRecordKind, recordLabel } from "./record-types";

const statusLabels: Record<CalendarChangeStatus, string> = {
  draft: "Proposal ready", waiting: "Waiting for Calendar", applied: "Applied in Calendar",
  cancelled: "Cancelled in Calendar", conflict: "Calendar found a conflict", not_found: "No saved result found",
  undone: "Undone in Calendar", rejected: "Rejected by Calendar",
};
const actionLabels: Record<string, string> = {
  create: "Add", update: "Edit", delete: "Move to Trash", restore: "Restore",
  archive: "Archive", unarchive: "Unarchive", move: "Move", link: "Link", unlink: "Unlink",
};
const fieldLabels: Record<string, string> = {
  title: "Title", description: "Description", start: "Start", end: "End",
  allDay: "All day", timezone: "Time zone", dueDate: "Due date", status: "Status",
};

export function calendarChangeToggle(container: HTMLElement, workspace: AiWorkspace): void {
  if (!workspace.supportsCalendarChanges) return;
  const controller = workspace.calendarChanges;
  const label = container.createEl("label", { cls: "y-ai-context-toggle" });
  const toggle = label.createEl("input", { type: "checkbox", attr: { "aria-label": "Draft Calendar changes" } });
  toggle.checked = controller.enabled;
  toggle.disabled = workspace.settingsLocked || !controller.enabled && !controller.canDraft;
  toggle.addEventListener("change", () => workspace.setCalendarDraft(toggle.checked));
  label.createSpan({ text: "Draft Calendar changes" });
  container.createEl("p", { text: "Find the existing event or task here before editing or deleting it. Review and apply proposals in the Calendar app.", cls: "y-ai-hint" });
}

export function workspaceCalendarChangeToggle(container: HTMLElement, workspace: AiWorkspace): void {
  const access = workspace.workspaceCalendar;
  if (!access?.capabilities?.writeKinds.length) return;
  const controller = workspace.workspaceCalendarChanges;
  const label = container.createEl("label", { cls: "y-ai-context-toggle" });
  const toggle = label.createEl("input", { type: "checkbox", attr: { "aria-label": "Draft workspace changes" } });
  toggle.checked = controller.enabled;
  toggle.disabled = workspace.settingsLocked || !controller.enabled && (!controller.canDraft || !access.datasetId);
  toggle.addEventListener("change", () => workspace.setWorkspaceCalendarDraft(toggle.checked));
  label.createSpan({ text: "Draft workspace changes" });
  container.createEl("p", { text: "Select and include existing records before editing them. Calendar reviews and applies proposals.", cls: "y-ai-hint" });
}

export function calendarChangeCard(container: HTMLElement, workspace: AiWorkspace): void {
  if (workspace.supportsCalendarChanges || workspace.calendarChanges.state) renderCard(container, workspace, false);
  if (workspace.workspaceCalendar || workspace.workspaceCalendarChanges.state) renderCard(container, workspace, true);
}
function renderCard(container: HTMLElement, workspace: AiWorkspace, extended: boolean): void {
  const controller = extended ? workspace.workspaceCalendarChanges : workspace.calendarChanges, record = controller.state;
  const name = extended ? "Draft workspace changes" : "Draft Calendar changes";
  if (!record && !controller.enabled) return;
  const card = container.createEl("section", { cls: "y-ai-card y-ai-calendar-proposal", attr: { "aria-label": "Calendar changes" } });
  if (!record) {
    card.createEl("strong", { text: name });
    card.createEl("p", { text: extended ? "Describe the change. Send uses your message and selected workspace excerpts." :
      "Describe the one-off events or tasks to change. Send uses your message and approved Calendar excerpts.", cls: "y-ai-hint" });
    const cancel = card.createEl("button", { text: "Cancel Calendar mode" });
    cancel.disabled = workspace.settingsLocked;
    cancel.addEventListener("click", () => extended ? workspace.setWorkspaceCalendarDraft(false) : workspace.setCalendarDraft(false));
    return;
  }
  card.createEl("strong", { text: statusLabels[record.status] });
  const details = card.createEl("details");
  details.createEl("summary", { text: `${record.draft.operations.length} proposed change(s)` });
  const list = details.createEl("ol");
  for (const operation of record.draft.operations) {
    const title = record.titles[operation.opId] ?? (isRecordKind(operation.kind) ? recordLabel(operation.kind) : "Calendar record");
    const item = list.createEl("li");
    item.createSpan({ text: `${actionLabels[operation.action]} · ${title}` });
    for (const [field, value] of Object.entries(operation.values ?? {})) {
      const display = value === null ? "Cleared" : typeof value === "boolean" ? value ? "Yes" : "No" :
        typeof value === "object" ? JSON.stringify(value) : String(value);
      const label = fieldLabels[field] ?? field.replace(/[A-Z]/g, letter => " " + letter.toLowerCase());
      item.createDiv({ text: `${label} · ${display.length > 800 ? display.slice(0, 800) + "…" : display}`, cls: "y-ai-hint" });
    }
  }
  if (!Platform.isAndroidApp) {
    card.createEl("p", { text: "Review Calendar proposals in Obsidian on Android.", cls: "y-ai-hint" });
    return;
  }
  if (extended && record.draft.datasetId !== workspace.workspaceCalendar?.datasetId)
    card.createEl("p", { text: "Check the original Calendar connection to review this proposal.", cls: "y-ai-hint" });
  if (controller.message) card.createEl("p", { text: controller.message, cls: "y-ai-hint", attr: { role: "status" } });
  const actions = card.createDiv({ cls: "y-ai-calendar-proposal-actions" });
  const button = (text: string, action: () => Promise<unknown> | void, primary = false) => {
    const element = actions.createEl("button", { text, ...(primary ? { cls: "mod-cta" } : {}) });
    element.disabled = workspace.settingsLocked;
    element.addEventListener("click", () => { if (!element.disabled) void action(); });
  };
  const open = (action: CalendarChangeAction) => async () => {
    const url = await controller.open(action);
    if (url) container.ownerDocument.defaultView?.open(url, "_self");
  };
  if (controller.canOpen("review")) button("Review in Calendar", open("review"), true);
  if (controller.canOpen("undo")) button("Undo in Calendar", open("undo"), true);
  if (controller.requestId) {
    button("Check Calendar reply", async () => {
      const id = controller.requestId;
      if (id) await controller.receive(id);
    });
    button("Close local connection", () => controller.disconnect());
  }
  if (!controller.requestId && controller.canOpen("status")) button("Check status in Calendar", open("status"));
  if (!controller.requestId && record.status !== "waiting") button("Clear proposal", () => controller.clear());
}
