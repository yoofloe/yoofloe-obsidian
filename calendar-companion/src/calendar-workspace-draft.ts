import { closedObject, safeOutbound } from "./agent-policy";
import {
  createCalendarWorkspaceChangeDraft, MAX_CALENDAR_WORKSPACE_CHANGE_OPERATIONS,
  type CalendarWorkspaceChangeDraft, type CalendarWorkspaceChangeReference, type CalendarWorkspaceOperation,
} from "./calendar-workspace-change";
import {
  calendarWorkspaceCanCreate, calendarWorkspaceFieldGuide, calendarWorkspaceSupportsAction, isCalendarWorkspaceCreate,
  prepareCalendarWorkspaceValues, validateCalendarWorkspaceOperation,
  type CalendarWorkspaceAction, type CalendarWorkspaceProposalScope,
} from "./calendar-workspace-catalog";
import { workspaceExcerptReference, workspaceKindAllowed, type WorkspaceLookupDelivery, type WorkspaceOccurrence, type WorkspaceRecord } from "./calendar-workspace-query";
import type { RecordKind } from "./record-types";

const fields = ["kind", "action", "record", "valuesJson"];
const maximumValuesBytes = 84 * 1024;
const encoder = new TextEncoder();

function proposalScope(lookup: WorkspaceLookupDelivery): CalendarWorkspaceProposalScope {
  return {
    financials: lookup.query.mode === "records" && lookup.query.filters.includeFinancials,
    attachments: lookup.query.mode === "records" && lookup.query.filters.includeAttachmentMetadata &&
      lookup.capabilities.readKinds.includes("asset") && workspaceKindAllowed(lookup.query, "asset"),
  };
}

function approvedRecord(record: WorkspaceRecord, lookup: WorkspaceLookupDelivery): boolean {
  return lookup.query.mode === "records" && lookup.capabilities.readKinds.includes(record.kind) &&
    workspaceKindAllowed(lookup.query, record.kind) &&
    (record.state !== "trashed" || lookup.query.filters.includeTrash) &&
    (record.state !== "archived" || lookup.query.filters.includeArchive);
}

/** Advertised app operations intersect the approved lookup and the plugin's closed catalog. */
function availableActions(lookup: WorkspaceLookupDelivery, scope: CalendarWorkspaceProposalScope): Map<RecordKind, CalendarWorkspaceAction[]> {
  const result = new Map<RecordKind, CalendarWorkspaceAction[]>();
  const approved = lookup.records.filter(record => approvedRecord(record, lookup));
  const activeKinds = new Set(approved.filter(record => record.state === "active").map(record => record.kind));
  for (const { kind, actions } of lookup.capabilities.writeKinds) {
    const allow = lookup.query.mode === "capabilities" || workspaceKindAllowed(lookup.query, kind);
    if (!allow) continue;
    const available = actions.filter((action): action is CalendarWorkspaceAction => {
      if (!calendarWorkspaceSupportsAction(kind, action, scope)) return false;
      if (isCalendarWorkspaceCreate(action)) return calendarWorkspaceCanCreate(kind, activeKinds);
      return approved.some(record => record.kind === kind && mayTarget(record, action));
    });
    if (available.length) result.set(kind, available);
  }
  return result;
}

/** Allows a proposal only. The local review controls when to open Calendar's confirmation screen. */
export function workspaceDraftTool(lookup: WorkspaceLookupDelivery) {
  const scope = proposalScope(lookup);
  const registry = availableActions(lookup, scope);
  if (!registry.size) return null;
  const fieldGuides = Array.from(registry, ([kind, actions]) => calendarWorkspaceFieldGuide(kind, actions, scope));
  const kinds = Array.from(registry.keys());
  const actions = Array.from(new Set(Array.from(registry.values()).flat()));
  return {
    type: "function" as const, name: "draft_calendar_workspace_changes" as const, strict: true as const,
    description: [
      "Prepare a local Calendar proposal using the user's explicit edit request. The Calendar app reviews and applies it.",
      "Use the current Calendar C# reference for an existing target, and null for create/link.",
      "Use a JSON object serialized as valuesJson. Use null for simple delete, restore, archive or unlink. Include only fields to change. Omit unspecified fields.",
      "Use C# for related records. Use an occurrence key from the current lookup for a recurring occurrence or following dates. A detached event defaults to its original occurrence.",
      "Use appendText to add paragraphs; contentHtml replaces the complete note body.",
      "Checklist, reminder and class-slot arrays replace the complete list. Only propose them when the intended full list is known.",
    ].join("\n"),
    parameters: {
      type: "object", additionalProperties: false, required: ["operations"],
      properties: { operations: {
        type: "array", minItems: 1, maxItems: MAX_CALENDAR_WORKSPACE_CHANGE_OPERATIONS,
        items: {
          type: "object", additionalProperties: false, required: fields,
          properties: {
            kind: { type: "string", enum: kinds },
            action: { type: "string", enum: actions },
            record: { type: ["string", "null"], description: "A current C# reference or null for a new item or link." },
            valuesJson: { type: ["string", "null"], description: ["An object serialized as JSON text or null.", ...fieldGuides].join("\n") },
          },
        },
      } },
    },
  };
}

function resolveReference(value: unknown, lookup: WorkspaceLookupDelivery, kinds: readonly RecordKind[]): WorkspaceRecord {
  if (typeof value !== "string" || !/^C[1-9]\d{0,5}$/.test(value) || lookup.query.mode !== "records")
    throw Error("Choose a C reference from the current Calendar lookup.");
  const record = lookup.records.find((_, index) => workspaceExcerptReference(lookup, index) === value);
  if (!record || !kinds.includes(record.kind) || !approvedRecord(record, lookup))
    throw Error("Choose a matching record from the approved Calendar lookup.");
  return record;
}

type ChangeValues = Record<string, unknown> | null;

function decodeValues(value: unknown): ChangeValues {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > maximumValuesBytes || encoder.encode(value).byteLength > maximumValuesBytes)
    throw Error("Calendar change values must be a bounded JSON object.");
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw Error("Calendar change values must be a JSON object."); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw Error("Calendar change values must be a JSON object.");
  return parsed as Record<string, unknown>;
}

function reviewedTarget(record: WorkspaceRecord | null, values: ChangeValues): {
  target: CalendarWorkspaceOperation["target"];
  values: ChangeValues;
  reviewedOccurrences?: readonly WorkspaceOccurrence[];
  detached?: CalendarWorkspaceChangeReference;
} {
  const target = record ? { id: record.sourceId, revision: record.revision } : null;
  if (record?.kind !== "event") return { target, values };
  const { origin, occurrences } = record.details;
  if (!origin) {
    if (occurrences?.length && values?.scope === undefined)
      throw Error("Choose which occurrence, the following occurrences, or the whole series.");
    return { target, values, reviewedOccurrences: occurrences };
  }

  const scope = values?.scope === undefined ? "occurrence" : values.scope;
  if (scope !== "occurrence" && scope !== "following")
    throw Error("Select the original series from the Calendar lookup to change the whole series.");
  const { seriesId, seriesRevision, ...original } = origin;
  return {
    target: { id: seriesId, revision: seriesRevision },
    values: { ...values, scope, occurrence: values && Object.hasOwn(values, "occurrence") ? values.occurrence : original },
    reviewedOccurrences: [original],
    detached: { kind: record.kind, id: record.sourceId, revision: record.revision },
  };
}

function mayTarget(record: WorkspaceRecord, action: CalendarWorkspaceAction, values?: ChangeValues): boolean {
  if (action === "restore") return record.state === "trashed" ||
    record.kind === "event" && !record.details.origin && record.state === "active" && (values === undefined || values?.scope === "occurrence");
  return record.state !== "trashed" && (action !== "archive" || record.state === "active");
}

function createTitle(values: CalendarWorkspaceOperation["values"]): string | undefined {
  for (const name of ["title", "name", "subject", "eventTitle", "description"]) {
    const value = values?.[name];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

/** Resolve model references using the authenticated lookup supplied to this provider turn. */
export async function prepareCalendarWorkspaceDraft(value: unknown, lookup: WorkspaceLookupDelivery): Promise<{
  draft: CalendarWorkspaceChangeDraft;
  titles: Record<string, string>;
}> {
  if (lookup.version !== 5) throw Error("Connect to a compatible version of Calendar first.");
  closedObject(value, ["operations"]);
  if (!Array.isArray(value.operations) || !value.operations.length || value.operations.length > MAX_CALENDAR_WORKSPACE_CHANGE_OPERATIONS)
    throw Error("Choose between one and twelve Calendar changes.");
  const scope = proposalScope(lookup);
  const available = availableActions(lookup, scope);
  const titles: Record<string, string> = {};
  const operations: CalendarWorkspaceOperation[] = value.operations.map((entry: unknown) => {
    closedObject(entry, fields);
    const { kind, action, record, valuesJson } = entry;
    const recordKind = kind as RecordKind;
    const actionName = action as CalendarWorkspaceAction;
    if (typeof kind !== "string" || typeof action !== "string" || !available.get(recordKind)?.includes(actionName))
      throw Error("That Calendar action is unavailable for the approved lookup.");
    const creates = isCalendarWorkspaceCreate(actionName);
    if (creates && record !== null) throw Error("A new Calendar item or link cannot replace an existing record.");
    const existing = creates ? null : resolveReference(record, lookup, [recordKind]);
    const reviewed = reviewedTarget(existing, decodeValues(valuesJson));
    const { target } = reviewed;
    const references = new Map<string, CalendarWorkspaceChangeReference>();
    if (reviewed.detached) references.set("event:" + reviewed.detached.id, reviewed.detached);
    const resolveRelated = (reference: unknown, kinds: readonly RecordKind[]) => {
      const related = resolveReference(reference, lookup, kinds);
      if (related.state !== "active") throw Error("Choose an active related Calendar record.");
      if (existing && related.kind === existing.kind && related.sourceId === existing.sourceId)
        throw Error("A Calendar record cannot contain itself.");
      const key = related.kind + ":" + related.sourceId;
      const reviewed = references.get(key);
      if (reviewed && reviewed.revision !== related.revision) throw Error("Look up the related Calendar record again.");
      references.set(key, { kind: related.kind, id: related.sourceId, revision: related.revision });
      return related;
    };
    const values = prepareCalendarWorkspaceValues(recordKind, actionName, reviewed.values, target, scope, resolveRelated, {
      taskFolder: existing?.details.taskFolder, reviewedOccurrences: reviewed.reviewedOccurrences,
    });
    if (existing && !mayTarget(existing, actionName, values))
      throw Error("Choose a Calendar record in the correct state for this action.");
    const opId = crypto.randomUUID();
    const title = existing?.title ?? createTitle(values);
    if (title) titles[opId] = safeOutbound(title);
    return { opId, kind: recordKind, action: actionName, target, values, ...(references.size ? { references: Array.from(references.values()) } : {}) };
  });
  // Native review binds each proposal to the dataset that advertised these capabilities, even for creates.
  return { draft: await createCalendarWorkspaceChangeDraft(operations, lookup.datasetId, validateCalendarWorkspaceOperation), titles };
}