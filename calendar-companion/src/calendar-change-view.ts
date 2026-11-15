import type { AiWorkspace } from "./workspace";
import type { CalendarChangeAction } from "./calendar-change";
import type { CalendarChangeStatus } from "./calendar-change-controller";

const statusLabels: Record<CalendarChangeStatus, string> = {
  draft: "Proposal ready", waiting: "Waiting for Calendar", applied: "Applied in Calendar",
  cancelled: "Cancelled in Calendar", conflict: "Calendar found a conflict", not_found: "No saved result found",
  undone: "Undone in Calendar", rejected: "Rejected by Calendar",
};
const actionLabels = { create: "Add", update: "Edit", delete: "Move to Trash" };
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
  toggle.addEventListener("change", () => controller.setEnabled(toggle.checked));
  label.createSpan({ text: "Draft Calendar changes" });
  container.createEl("p", { text: "Find the existing event or task here before editing or deleting it. Review and apply proposals in the Calendar app.", cls: "y-ai-hint" });
}

export function calendarChangeCard(container: HTMLElement, workspace: AiWorkspace): void {
  if (!workspace.supportsCalendarChanges) return;
  const controller = workspace.calendarChanges, record = controller.state;
  if (!record && !controller.enabled) return;
  const card = container.createEl("section", { cls: "y-ai-card y-ai-calendar-proposal", attr: { "aria-label": "Calendar changes" } });
  if (!record) {
    card.createEl("strong", { text: "Draft Calendar changes" });
    card.createEl("p", { text: "Describe the one-off events or tasks to change. Send uses your message and approved Calendar excerpts.", cls: "y-ai-hint" });
    const cancel = card.createEl("button", { text: "Cancel Calendar mode" });
    cancel.disabled = workspace.settingsLocked;
    cancel.addEventListener("click", () => controller.setEnabled(false));
    return;
  }
  card.createEl("strong", { text: statusLabels[record.status] });
  const details = card.createEl("details");
  details.createEl("summary", { text: `${record.draft.operations.length} proposed change(s)` });
  const list = details.createEl("ol");
  for (const operation of record.draft.operations) {
    const title = operation.opId in record.titles ? record.titles[operation.opId] : operation.kind === "event" ? "Event" : "Task";
    const item = list.createEl("li");
    item.createSpan({ text: `${actionLabels[operation.action]} · ${title}` });
    for (const [field, value] of Object.entries(operation.values ?? {})) {
      const display = value === null ? "Cleared" : typeof value === "boolean" ? value ? "Yes" : "No" : String(value);
      item.createDiv({ text: `${fieldLabels[field]} · ${display}`, cls: "y-ai-hint" });
    }
  }
  if (controller.message) card.createEl("p", { text: controller.message, cls: "y-ai-hint", attr: { role: "status" } });
  const actions = card.createDiv({ cls: "y-ai-calendar-proposal-actions" });
  const button = (text: string, action: () => Promise<unknown>, primary = false) => {
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
    button("Check Calendar reply", async () => { if (controller.requestId) await controller.receive(controller.requestId); });
    button("Close local connection", () => controller.disconnect());
  }
  if (!controller.requestId && controller.canOpen("status")) button("Check status in Calendar", open("status"));
  if (!controller.requestId && record.status !== "waiting") button("Clear proposal", () => controller.clear());
}
