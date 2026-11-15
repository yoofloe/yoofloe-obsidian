import { closedObject, safeOutbound } from "./agent-policy";
import { createCalendarChangeDraft, type CalendarChangeDraft, type CalendarChangeOperation } from "./calendar-change";
import type { DeliveryV3 } from "./protocol";

const text = { type: ["string", "null"] } as const;
const fields = {
  kind: { type: "string", enum: ["event", "task"] },
  action: { type: "string", enum: ["create", "update", "delete"] },
  record: { ...text, description: "Use the C reference in the current Calendar lookup for an update or deletion. Use null when creating." },
  title: text, description: text, start: text, end: text,
  allDay: { type: ["boolean", "null"] }, timezone: text, dueDate: text,
  clearDueDate: { type: "boolean" }, status: { type: ["string", "null"], enum: ["pending", "completed", null] },
};
export const CALENDAR_DRAFT_TOOL = {
  type: "function", name: "draft_calendar_changes", strict: true,
  description: "Prepare a local proposal for one-off Calendar events or ordinary tasks. It never applies changes. Use only the user's explicit request. Changes to existing records require a C reference from this request. For all-day events use ISO dates with an exclusive end date. For timed events use UTC instants and an IANA time zone. Null fields leave existing values alone. For deletion use null fields and clearDueDate=false. For recurring records tell the user to edit them in Calendar.",
  parameters: {
    type: "object", additionalProperties: false, required: ["operations"],
    properties: { operations: { type: "array", minItems: 1, maxItems: 12, items: {
      type: "object", additionalProperties: false, required: Object.keys(fields), properties: fields,
    } } },
  },
};

/** Only a C reference in the current, reviewed lookup can become a native record ID. */
export async function prepareCalendarChangeDraft(value: unknown, delivery: DeliveryV3 | null): Promise<{
  draft: CalendarChangeDraft;
  titles: Record<string, string>;
}> {
  closedObject(value, ["operations"]);
  if (!Array.isArray(value.operations) || !value.operations.length || value.operations.length > 12)
    throw Error("Choose between one and twelve Calendar changes.");
  const titles: Record<string, string> = {};
  const operations = value.operations.map(raw => {
    closedObject(raw, Object.keys(fields));
    const { kind, action, record, clearDueDate } = raw;
    if ((kind !== "event" && kind !== "task") || (action !== "create" && action !== "update" && action !== "delete") ||
        typeof clearDueDate !== "boolean") throw Error("That Calendar action is not supported.");
    const opId = crypto.randomUUID();
    let target: CalendarChangeOperation["target"] = null;
    if (action === "create") {
      if (record !== null) throw Error("New Calendar entries cannot replace a lookup record.");
    } else {
      if (typeof record !== "string" || !/^C[1-9][0-9]*$/.test(record))
        throw Error("Look up the existing event or task in Calendar first.");
      const match = delivery?.records[Number(record.slice(1)) - 1];
      if (!match || match.kind !== kind) throw Error("Choose a matching event or task from the current Calendar lookup.");
      target = { id: match.sourceId, revision: match.revision };
      safeOutbound(match.title);
      titles[opId] = match.title;
    }
    const values: Record<string, unknown> = {};
    for (const field of ["title", "description", "start", "end", "allDay", "timezone", "dueDate", "status"]) {
      if (raw[field] !== null) values[field] = raw[field];
    }
    if (clearDueDate) {
      if (kind !== "task" || action !== "update" || raw.dueDate !== null) throw Error("Only an existing task's due date can be cleared.");
      values.dueDate = null;
    }
    if (action === "delete" && Object.keys(values).length) throw Error("Review deletion as a separate action without changed fields.");
    if (typeof values.title === "string" && action === "create") titles[opId] = values.title;
    return { opId, kind, action, target, values: action === "delete" ? null : values } as CalendarChangeOperation;
  });
  safeOutbound(JSON.stringify(operations));
  return { draft: await createCalendarChangeDraft(operations, delivery?.datasetId ?? null), titles };
}
