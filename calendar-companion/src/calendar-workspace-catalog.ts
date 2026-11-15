import { safeOutbound } from "./agent-policy";
import type { CalendarWorkspaceOperation } from "./calendar-workspace-change";
import type { WorkspaceOccurrence, WorkspaceRecord } from "./calendar-workspace-query";
import { civilDate, validZone } from "./question-query";
import type { RecordKind } from "./record-types";

export type CalendarWorkspaceAction = "create" | "update" | "delete" | "restore" | "move" | "archive" | "link" | "unlink";
export interface CalendarWorkspaceProposalScope {
  financials: boolean;
  attachments: boolean;
}
export type CalendarWorkspaceReferenceResolver = (reference: unknown, kinds: readonly RecordKind[]) => WorkspaceRecord;

interface ValueContext {
  datasetBound: boolean;
  associationId?: string;
  scope?: CalendarWorkspaceProposalScope;
  resolve?: CalendarWorkspaceReferenceResolver;
  verify?: (id: string | null, kinds: readonly RecordKind[]) => void;
  taskFolder?: boolean;
  reviewedOccurrences?: readonly WorkspaceOccurrence[];
}
interface ValueField {
  help: string;
  relatedKinds?: readonly RecordKind[];
  read(value: unknown, context: ValueContext): unknown;
}
type Fields = Readonly<Record<string, ValueField>>;
interface KindPolicy {
  fields: Fields;
  required: readonly string[];
  actions: readonly CalendarWorkspaceAction[];
  moveFields?: readonly string[];
  createAny?: readonly string[];
  financial?: boolean;
}

const encoder = new TextEncoder();
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 72 * 1024;
const noFields: Fields = Object.freeze({});
const noItems: readonly string[] = Object.freeze([]);
const financialProjectFields = new Set(["billable", "currency", "estimatedCost", "actualCost", "estimatedIncome", "actualIncome", "costSource", "incomeSource"]);

function invalidValue(message = "A proposed Calendar field has an invalid value."): never { throw Error(message); }

function fieldsOf(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalidValue("Calendar change values must be a JSON object.");
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalidValue();
  return value as Record<string, unknown>;
}
function field(help: string, read: ValueField["read"], relatedKinds?: readonly RecordKind[]): ValueField {
  return { help, read, relatedKinds };
}
function optional(valueField: ValueField): ValueField {
  return field(valueField.help + " or null", (value, context) => value === null ? null : valueField.read(value, context));
}
function isText(value: unknown, limit: number, multiline = false): value is string {
  if (typeof value !== "string" || value.length > limit || encoder.encode(value).length > limit) return false;
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if ((code < 32 && (!multiline || !"\t\r\n".includes(ch))) || code === 127 || code >= 0xd800 && code <= 0xdfff) return false;
  }
  return true;
}
function stringField(limit: number, options: { nonempty?: boolean; multiline?: boolean } = {}): ValueField {
  return field(options.nonempty ? "nonempty text" : "text", value => {
    if (!isText(value, limit, options.multiline) || options.nonempty && !value.trim()) invalidValue();
    return safeOutbound(value);
  });
}
function matching(help: string, pattern: RegExp): ValueField {
  return field(help, value => typeof value === "string" && pattern.test(value) ? value : invalidValue());
}
function oneOf(...options: string[]): ValueField {
  return field(options.map(option => option || '""').join("/"), value =>
    typeof value === "string" && options.includes(value) ? value : invalidValue());
}
function integer(min: number, max: number): ValueField {
  return field("integer " + min + "–" + max, value =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : invalidValue());
}
function list(item: ValueField, max: number, min = 0): ValueField {
  return field("list of " + item.help, (value, context) => {
    if (!Array.isArray(value) || value.length < min || value.length > max) invalidValue();
    return value.map(entry => item.read(entry, context));
  });
}
function readFields(value: unknown, schema: Fields, required: readonly string[], context: ValueContext): Record<string, unknown> {
  const raw = fieldsOf(value);
  if (!required.every(key => Object.hasOwn(raw, key))) invalidValue("Include all required Calendar fields.");
  return Object.fromEntries(Object.keys(raw).map(key => {
    if (!Object.hasOwn(schema, key)) invalidValue("This Calendar action includes an unsupported field.");
    return [key, schema[key].read(raw[key], context)];
  }));
}
function objectField(help: string, fields: Fields, required: readonly string[]): ValueField {
  return field(help, (value, context) => readFields(value, fields, required, context));
}
const color = matching("#RRGGBB", /^#[0-9a-f]{6}$/i);
const date = field("YYYY-MM-DD", value => civilDate(value) ? value : invalidValue());
const nullableDate = optional(date);
const time = matching("24-hour HH:mm", /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?$/);
const zone = field("IANA time zone", value => validZone(value) ? value : invalidValue());
const boolean = field("boolean", value => typeof value === "boolean" ? value : invalidValue());
const title = stringField(160, { nonempty: true });
const body = stringField(MAX_BODY_BYTES, { multiline: true });
const longTitle = stringField(1000, { nonempty: true });
const shortText = stringField(160);
const order = integer(0, Number.MAX_SAFE_INTEGER);
const weekday = integer(1, 7);
const smallPriority = integer(1, 5);
const commonTags = list(shortText, 100);
const currency = matching("currency ISO code", /^[A-Z]{3}$/);
const decimal = field("nonnegative decimal string", value => {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,23})(?:\.\d{1,12})?$/.test(value)
      || value.replace(".", "").replace(/^0+/, "").length > 28) invalidValue();
  return value;
});
const positiveDecimal = field("positive decimal string", (value, context) =>
  typeof value === "string" && /[1-9]/.test(value) ? decimal.read(value, context) : invalidValue());
const percent = field("decimal percent 0–100", (value, context) =>
  typeof value === "string" && Number(value) <= 100 ? decimal.read(value, context) : invalidValue());

function readUuid(value: unknown): string {
  return typeof value === "string" && uuidPattern.test(value) ? value : invalidValue("This change needs a valid Calendar record reference.");
}
function association(kinds: readonly RecordKind[], taskFolder = false): ValueField {
  return field(taskFolder ? "C# (To-Do folder)" : "C# (" + kinds.join("/") + ")", (value, context) => {
    if (!context.datasetBound) invalidValue("Look up the related Calendar records first.");
    const record = context.resolve?.(value, kinds);
    if (taskFolder && record && record.details.taskFolder !== true) invalidValue("Choose an approved To-Do folder as the parent.");
    const id = readUuid(record ? record.sourceId : value);
    context.verify?.(id, kinds);
    return id;
  }, kinds);
}

const recurrenceRule = objectField("{frequency,interval?,until?,count?,weekdays?,monthlyMode?,ordinalWeekday?,weekStart?}", {
  frequency: oneOf("NONE", "DAILY", "WEEKLY", "MONTHLY", "YEARLY"),
  interval: integer(1, 365),
  until: nullableDate,
  count: optional(integer(1, 100000)),
  weekdays: list(weekday, 7),
  monthlyMode: oneOf("DATE", "NTH_WEEKDAY", "LAST_DAY"),
  ordinalWeekday: optional(objectField("{ordinal,weekday}", { ordinal: integer(-1, 5), weekday }, ["ordinal", "weekday"])),
  weekStart: weekday,
}, ["frequency"]);
const recurrence = optional(field(recurrenceRule.help, (value, context) => {
  const rule = fieldsOf(recurrenceRule.read(value, context));
  const ordinal = rule.ordinalWeekday ? fieldsOf(rule.ordinalWeekday).ordinal : null;
  const nth = rule.monthlyMode === "NTH_WEEKDAY";
  if (rule.count != null && (rule.until != null || rule.frequency === "NONE") ||
      (nth || rule.monthlyMode === "LAST_DAY") && rule.frequency !== "MONTHLY" ||
      nth !== (ordinal !== null) || ordinal === 0 ||
      Array.isArray(rule.weekdays) && new Set(rule.weekdays).size !== rule.weekdays.length) invalidValue("Choose a valid recurrence.");
  return rule;
}));

function reminderList(...anchors: string[]): ValueField {
  const reminderFields = {
    anchor: oneOf(...anchors), offsetMinutes: optional(integer(0, 10080)), dayOffset: optional(integer(-7, 0)), localTime: optional(time),
  };
  const reminder = field("{anchor,offsetMinutes? or dayOffset+localTime}", (value, context) => {
    const fields = readFields(value, context.resolve ? reminderFields : { ...reminderFields, id: field("identity", readUuid) },
      context.resolve ? ["anchor"] : ["id", "anchor"], context);
    const clock = fields.anchor === "ALL_DAY_CLOCK";
    if (clock ? fields.offsetMinutes != null || fields.localTime == null || fields.dayOffset == null
      : fields.offsetMinutes == null || fields.localTime != null || fields.dayOffset != null) invalidValue("Choose a valid reminder time.");
    return context.resolve ? { ...fields, id: crypto.randomUUID() } : fields;
  });
  return list(reminder, 5);
}

const temporalFields = {
  originalStart: stringField(64, { nonempty: true }), timeBasis: oneOf("DATE", "UTC", "ZONED"),
  timezone: optional(zone), originalOffset: optional(matching("UTC offset", /^(?:Z|[+-](?:0\d|1[0-8]):[0-5]\d)$/)),
};
const occurrence = field("{originalStart,timeBasis:DATE/UTC/ZONED,timezone?,originalOffset?}", (value, context) => {
  if (!context.associationId) invalidValue("Choose an existing recurring event for this occurrence.");
  const input = readFields(value, context.resolve ? temporalFields : { ...temporalFields, seriesId: field("series identity", readUuid) },
    context.resolve ? ["originalStart", "timeBasis"] : ["originalStart", "timeBasis", "seriesId"], context);
  const start = input.originalStart as string;
  const basis = input.timeBasis;
  const originalDate = start.slice(0, 10);
  if (input.seriesId !== undefined && input.seriesId !== context.associationId ||
    (basis === "DATE" ? !civilDate(start) || input.timezone != null || input.originalOffset != null
      : !civilDate(originalDate) || (basis === "UTC"
        ? !isUtcInstant(start) || input.timezone != null || input.originalOffset != null
        : start[10] !== "T" || !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?$/.test(start.slice(11))
        || input.timezone == null || input.originalOffset == null))) invalidValue("The occurrence does not match the selected event.");
  if (context.resolve) {
    const reviewed = context.reviewedOccurrences?.find(item =>
      item.originalStart === input.originalStart && item.timeBasis === input.timeBasis &&
      (item.timezone ?? null) === (input.timezone ?? null) && (item.originalOffset ?? null) === (input.originalOffset ?? null));
    if (!reviewed) invalidValue("Look up the selected occurrence in Calendar before proposing a change.");
    return { ...reviewed, seriesId: context.associationId };
  }
  return { ...input, seriesId: context.associationId };
});

const studySourceKinds = { study_session: "SESSION", study_folder: "FOLDER", study_lecture: "LECTURE", study_plan: "PLAN", study_milestone: "MILESTONE" } as const;
const projectSourceKinds = { project: "PROJECT", project_stage: "STAGE" } as const;
const scheduleKinds = { event: "EVENT", task: "TASK" } as const;
const plannerKinds = { ...scheduleKinds, note: "NOTE" } as const;
const linksToProject = {
  note: ["NOTES", "NOTE"], event: ["SCHEDULE", "EVENT"], task: ["SCHEDULE", "TASK"],
  study_session: ["STUDY", "SESSION"], study_lecture: ["STUDY", "LECTURE"], study_plan: ["STUDY", "PLAN"], study_milestone: ["STUDY", "MILESTONE"],
} as const;

function endpoint(accepted: Readonly<Partial<Record<RecordKind, string>>>): ValueField {
  const kinds = Object.keys(accepted) as RecordKind[];
  const nativeKind = oneOf(...Object.values(accepted));
  return field("C# (" + kinds.join("/") + ")", (value, context) => {
    if (!context.datasetBound) invalidValue("Look up both records before creating a Calendar link.");
    if (!context.resolve) {
      const endpoint = readFields(value, { kind: nativeKind, id: field("identity", readUuid) }, ["kind", "id"], context);
      const kind = kinds.find(candidate => accepted[candidate] === endpoint.kind)!;
      context.verify?.(endpoint.id as string, [kind]);
      return endpoint;
    }
    const record = context.resolve(value, kinds);
    return { kind: accepted[record.kind], id: readUuid(record.sourceId) };
  }, kinds);
}

const projectEndpoint = field("C# or {record:C#,occurrence?}", (value, context) => {
  if (!context.datasetBound) invalidValue("Look up both records before creating a Project link.");
  if (context.resolve) {
    const input = typeof value === "string" ? { record: value } : fieldsOf(value);
    if (!Object.hasOwn(input, "record") || Object.keys(input).some(key => key !== "record" && key !== "occurrence")) invalidValue();
    const record = context.resolve(input.record, Object.keys(linksToProject) as RecordKind[]);
    const [domain, kind] = linksToProject[record.kind as keyof typeof linksToProject];
    const id = readUuid(record.sourceId);
    if (!Object.hasOwn(input, "occurrence")) return { domain, kind, id };
    if (record.kind !== "event") invalidValue("Only an event link can select a recurring occurrence.");
    if (record.details.origin) invalidValue("Choose the original series to link an occurrence.");
    return { domain, kind, id, occurrence: occurrence.read(input.occurrence, {
      ...context, associationId: id, reviewedOccurrences: record.details.occurrences,
    }) };
  }
  const target = fieldsOf(value);
  const id = readUuid(target.id);
  const kind = Object.entries(linksToProject).find(([, [domain, kind]]) => domain === target.domain && kind === target.kind)?.[0];
  if (!kind || Object.keys(target).some(key => !["domain", "kind", "id", "occurrence"].includes(key))) invalidValue();
  context.verify?.(id, [kind as RecordKind]);
  if (target.occurrence != null) {
    if (target.kind !== "EVENT") invalidValue("Only an event link can select a recurring occurrence.");
    occurrence.read(target.occurrence, { ...context, associationId: id });
  }
  return target;
}, Object.keys(linksToProject) as RecordKind[]);

const plainTags = /^(?:p|br|div|span|h[1-3]|strong|b|em|i|u|s|strike|ul|ol|li|blockquote|mark)$/i;
const richBody = field("rich HTML with basic formatting; approved images as <img src=\"C#\">", (value, context) => {
  const raw = body.read(value, context) as string;
  // Never parse model markup into the Obsidian document. Calendar sanitizes this closed subset again before saving.
  return raw.replace(/<[^<>]*>|</g, token => {
    const simple = /^<\/?([a-z][a-z0-9]*)(?:\s*\/)?>$/i.exec(token);
    if (simple && (plainTags.test(simple[1]) || /^<\/a>$/i.test(token))) return token;
    if (/^<ol start="[1-9]\d{0,4}">$/i.test(token) || /^<a href="(?:https?:\/\/|mailto:)[^"<>\s]{1,2048}">$/i.test(token)) return token;
    const image = /^<img src="([^"]+)"(?: alt="([^"<>\r\n]{0,160})")?\s*\/?>$/i.exec(token);
    if (!image) invalidValue("Use supported rich note formatting or append plain text.");
    if (!context.datasetBound) invalidValue("Look up existing attachment metadata first.");
    if (context.resolve) {
      if (!context.scope?.attachments) invalidValue("Include attachment metadata in the approved Calendar lookup.");
      const record = context.resolve(image[1], ["asset"]);
      if (!record.details.mediaType?.startsWith("image/")) invalidValue("Choose an existing image from the Calendar lookup.");
      return '<img src="yoofloe-asset://' + readUuid(record.sourceId) + '"' + (image[2] === undefined ? "" : ' alt="' + image[2] + '"') + '>';
    }
    if (!image[1].startsWith("yoofloe-asset://")) invalidValue("Only existing Calendar images may be used in a note.");
    const id = readUuid(image[1].slice("yoofloe-asset://".length));
    context.verify?.(id, ["asset"]);
    return token;
  });
});

const checklist = list(objectField("{text,checked?}", { text: longTitle, checked: boolean }, ["text"]), 500);
const slots = list(objectField("{weekday,start,end,endNextDay?}", {
  weekday, start: time, end: time, endNextDay: boolean,
}, ["weekday", "start", "end"]), 28, 1);
const dates = { startDate: nullableDate, dueDate: nullableDate };
const folderFields = { title, color, tags: commonTags, order };
const eventTime = field("YYYY-MM-DD or UTC instant", value => civilDate(value) || isUtcInstant(value) ? value : invalidValue());

function isUtcInstant(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?Z$/.test(value)
    && civilDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
}
const crud = ["create", "update", "delete", "restore"] as const;
const move = [...crud, "move"] as const;
const linkActions = ["create", "update", "delete", "link", "unlink"] as const;
const eventScope = { scope: oneOf("occurrence", "following", "series"), occurrence };
const noCreateScope = new Set(["scope", "occurrence"]);
const taskFolderFields = new Set(["type", "title", "description", "parentId", "sortOrder"]);
const taskFolderParent = optional(association(["task"], true));

const catalog: Partial<Record<RecordKind, KindPolicy>> = {
  event: { actions: crud, required: ["title", "start", "end", "allDay", "timezone"], fields: {
    title: longTitle, description: body, start: eventTime, end: eventTime, allDay: boolean, timezone: zone, color,
    location: stringField(2000), recurrence, reminderMinutes: optional(integer(0, 10080)),
    reminders: optional(reminderList("EVENT_START", "ALL_DAY_CLOCK")), ...eventScope,
  } },
  task: { actions: move, moveFields: ["parentId", "sortOrder"], required: ["title"], fields: {
    type: oneOf("task", "folder"), title: longTitle, description: body, ...dates, status: oneOf("pending", "completed"),
    parentId: optional(association(["task"])), sortOrder: order,
    priority: integer(2, 3), tags: list(stringField(100), 100), checklist, recurrence, reminders: optional(reminderList("TASK_DUE", "TASK_TIMEBOX")),
    reminderMinutes: optional(integer(0, 10080)), dueTime: optional(time), dueTimezone: optional(zone),
    timeboxDate: nullableDate, timeboxStart: optional(time), timeboxDuration: integer(1, 1440),
  } },
  dday: { actions: crud, required: ["title", "targetDate"], fields: {
    title: longTitle, targetDate: date, recurrence: oneOf("NONE", "MONTHLY", "YEARLY"),
  } },
  event_template: { actions: crud, required: ["name"], fields: {
    name: stringField(200, { nonempty: true }), eventTitle: stringField(1000), description: body, location: stringField(2000),
    durationMinutes: integer(1, 5256000), allDay: boolean, startTime: optional(time), color, recurrence,
    reminders: reminderList("EVENT_START", "ALL_DAY_CLOCK"),
  } },
  study_session: { actions: move, moveFields: ["folderId", "order"], required: ["title"], fields: {
    title, date, time, durationSeconds: integer(0, 86400), category: shortText, customCategory: shortText,
    focusLevel: oneOf("", "high", "medium", "low"), confidence: oneOf("", "hard", "medium", "easy"),
    text: body, color, tags: commonTags, folderId: optional(association(["study_folder"])), order, pinned: boolean,
  } },
  study_folder: { actions: move, moveFields: ["parentId", "order"], required: ["title"], fields: {
    ...folderFields, parentId: optional(association(["study_folder"])),
  } },
  study_semester: { actions: crud, required: ["name"], fields: {
    name: title, startDate: nullableDate, endDate: nullableDate, timezone: zone,
  } },
  study_lecture: { actions: crud, required: ["subject"], fields: {
    subject: title, professor: shortText, room: shortText, credits: optional(percent), slots, color,
    memo: stringField(20000, { multiline: true }),
    semester: field("C# (study_semester) or empty string to clear", (value, context) => {
      if (value === "") return value;
      if (context.resolve) return title.read(context.resolve(value, ["study_semester"]).title, context);
      context.verify?.(null, ["study_semester"]);
      return title.read(value, context);
    }),
  } },
  study_plan: { actions: crud, required: ["name"], fields: {
    name: title, description: stringField(20000, { multiline: true }), targetDate: nullableDate,
    priority: oneOf("high", "medium", "low"), status: oneOf("not_started", "in_progress", "completed"), color, lectureId: optional(association(["study_lecture"])),
  } },
  study_milestone: { actions: move, moveFields: ["planId", "order"], required: ["planId", "title"], fields: {
    title, planId: association(["study_plan"]), completed: boolean, dueDate: nullableDate, order,
  } },
  study_link: { actions: linkActions, required: ["source", "target"], fields: {
    source: endpoint(studySourceKinds), target: endpoint(plannerKinds),
  } },
  project_folder: { actions: move, moveFields: ["parentId", "order"], required: ["title"], fields: {
    ...folderFields, parentId: optional(association(["project_folder"])),
  } },
  project: { actions: [...move, "archive"], moveFields: ["parentId", "order", "planningOrder"], required: ["name"], fields: {
    name: title, parentId: optional(association(["project_folder"])), client: shortText,
    details: stringField(10000, { multiline: true }), tags: commonTags, color, priority: smallPriority, ...dates,
    status: oneOf("ACTIVE", "HOLD", "DONE"), billable: oneOf("yes", "no", "na"),
    complexity: oneOf("None", "S", "M", "L", "XL"), showInPlanning: boolean, currency,
    estimatedCost: optional(decimal), actualCost: optional(decimal), estimatedIncome: optional(decimal), actualIncome: optional(decimal),
    costSource: oneOf("MANUAL", "ENTRIES"), incomeSource: oneOf("MANUAL", "ENTRIES"), order, planningOrder: order,
  } },
  project_stage: { actions: move, moveFields: ["order"], required: ["projectId", "name"], fields: {
    projectId: association(["project"]), name: title, ...dates, status: oneOf("TODO", "IN_PROGRESS", "REVIEW", "DONE"), order,
  } },
  project_income: { actions: crud, required: ["gross"], financial: true, fields: {
    projectId: optional(association(["project"])), date, month: matching("YYYY-MM", /^\d{4}-(?:0[1-9]|1[0-2])$/), currency,
    gross: positiveDecimal, net: optional(decimal), netKind: oneOf("ACTUAL", "ESTIMATED"),
    deductionRate: optional(percent), agreedTotal: optional(decimal), paymentPercent: optional(percent), paymentKind: oneOf("UNSPECIFIED", "PARTIAL", "FULL"),
    type: oneOf("project", "bonus", "other"), client: shortText, paymentMethod: oneOf("bank_transfer", "card", "cash", "platform_payout", "other"),
    invoice: shortText, notes: stringField(10000, { multiline: true }), tags: commonTags,
  } },
  project_expense: { actions: crud, required: ["amount"], financial: true, fields: {
    projectId: optional(association(["project"])), date, month: matching("YYYY-MM", /^\d{4}-(?:0[1-9]|1[0-2])$/), currency,
    amount: positiveDecimal, vendor: shortText, description: stringField(1000),
    category: shortText, notes: stringField(10000, { multiline: true }), tags: commonTags,
  } },
  project_rate: { actions: crud, required: ["from", "to", "rate"], financial: true, fields: { from: currency, to: currency, rate: positiveDecimal, date } },
  project_link: { actions: linkActions, required: ["source", "target"], fields: {
    source: endpoint(projectSourceKinds), target: projectEndpoint,
  } },
  note: { actions: move, moveFields: ["folderId"], required: [], createAny: ["title", "contentHtml", "appendText"], fields: {
    title: stringField(1000), contentHtml: richBody, appendText: stringField(MAX_BODY_BYTES, { nonempty: true, multiline: true }),
    folderId: optional(association(["note_folder"])), date: nullableDate, tags: list(stringField(100), 100), pinned: boolean, color,
  } },
  note_folder: { actions: move, moveFields: ["parentId", "sortOrder"], required: ["title"], fields: {
    title: stringField(500, { nonempty: true }), parentId: optional(association(["note_folder"])), sortOrder: order,
  } },
  note_link: { actions: ["create", "delete", "restore", "link", "unlink"], required: ["noteId", "targetId"], fields: {
    noteId: association(["note"]), targetId: association(["task", "event"]), targetType: oneOf("event", "task"),
    scope: oneOf("RECORD", "SERIES", "OCCURRENCE"), occurrence,
  } },
};

function kindPolicy(kind: string): KindPolicy | undefined {
  return Object.hasOwn(catalog, kind) ? catalog[kind as RecordKind] : undefined;
}

export function isCalendarWorkspaceCreate(action: string): boolean { return action === "create" || action === "link"; }

export function calendarWorkspaceSupportsAction(kind: RecordKind, action: string, scope: CalendarWorkspaceProposalScope): action is CalendarWorkspaceAction {
  const policy = kindPolicy(kind);
  return Boolean(policy?.actions.includes(action as CalendarWorkspaceAction) && (!policy.financial || scope.financials));
}

export function calendarWorkspaceCanCreate(kind: RecordKind, activeKinds: ReadonlySet<RecordKind>): boolean {
  const policy = kindPolicy(kind)!;
  return policy.required.every(name => policy.fields[name].relatedKinds?.some(related => activeKinds.has(related)) ?? true);
}

function actionFields(kind: string, action: string, policy: KindPolicy, context?: ValueContext): Fields {
  if (action === "move") return Object.fromEntries((policy.moveFields ?? []).map(name => [name, policy.fields[name]]));
  if ((action === "delete" || action === "restore") && kind === "event") return eventScope;
  if (action === "restore") {
    if (kind === "note") return { folderId: policy.fields.folderId };
    if (kind === "task" || kind === "note_folder") return { parentId: policy.fields.parentId };
  }
  if (action === "delete" || action === "restore" || action === "archive" || action === "unlink") return noFields;
  return Object.fromEntries(Object.entries(policy.fields).filter(([name]) =>
    !(kind === "event" && action === "create" && noCreateScope.has(name)) &&
    !(kind === "task" && action !== "create" && name === "type") &&
    !(kind === "project_stage" && action === "update" && name === "projectId") &&
    !(kind === "project" && context?.scope && !context.scope.financials && financialProjectFields.has(name)) &&
    !(kind === "note_link" && context?.resolve && name === "targetType")));
}
export function calendarWorkspaceFieldGuide(kind: RecordKind, actions: readonly CalendarWorkspaceAction[], scope: CalendarWorkspaceProposalScope): string {
  const policy = kindPolicy(kind)!;
  const availableFields = Object.assign({}, ...actions.map(action => actionFields(kind, action, policy, { datasetBound: true, scope }))) as Fields;
  const note = kind === "note_link";
  const fields = Object.entries(availableFields).filter(([name]) => !(note && name === "targetType")).map(([name, value]) => {
    const help = name === "contentHtml" && !scope.attachments ? "rich HTML with basic formatting" : value.help;
    return name + "=" + help;
  });
  const required = actions.some(isCalendarWorkspaceCreate) && policy.required.length ? " Required for create/link: " + policy.required.join(", ") + "." : "";
  const folder = kind === "task" ? " Create To-Do folders with type=folder. Folder fields are title, description, parentId (To-Do folder) and sortOrder." : "";
  return kind + " (" + actions.join("/") + "): " + fields.join(", ") + "." + required + folder;
}

function eventRules(values: Record<string, unknown>, action: string): void {
  const scope = values.scope;
  if ((scope === "occurrence" || scope === "following") !== Object.hasOwn(values, "occurrence")) invalidValue("Select the original occurrence and its scope together.");
  if (scope === "occurrence" && Object.hasOwn(values, "recurrence")) invalidValue("Only a series can change its recurrence.");
  if (scope === "following" && action === "restore") invalidValue("Restore the recurring series or the single occurrence.");
  const { start, end, allDay } = values;
  if (typeof allDay === "boolean" && (start === undefined || end === undefined)) invalidValue("Include the start and end when changing whether an event is all day.");
  const dates = allDay ?? civilDate(start ?? end);
  if ([start, end].some(timeValue => timeValue !== undefined && !(dates ? civilDate(timeValue) : isUtcInstant(timeValue)))) invalidValue("Use local dates for all-day events and UTC instants for timed events.");
  if (typeof start === "string" && typeof end === "string" && Date.parse(start) >= Date.parse(end)) invalidValue("The end must be after the start.");
}

function validateValues(kind: string, action: string, raw: unknown, context: ValueContext): Record<string, unknown> | null {
  const policy = kindPolicy(kind);
  if (!policy || !policy.actions.includes(action as CalendarWorkspaceAction) || policy.financial && context.scope && !context.scope.financials)
    invalidValue("That Calendar operation is unavailable for this lookup.");
  const byAction = actionFields(kind, action, policy, context);
  const required = isCalendarWorkspaceCreate(action) ? policy.required : noItems;
  if (raw === null) {
    if (!isCalendarWorkspaceCreate(action) && (Object.keys(byAction).length === 0 || action === "restore" || kind === "event" && action === "delete")) return null;
    invalidValue("Include values for the proposed change.");
  }
  const input = fieldsOf(raw);
  if (!Object.keys(input).length || Object.keys(input).length > 64 || policy.createAny && action === "create" && !policy.createAny.some(name => Object.hasOwn(input, name)))
    invalidValue("Include values for the proposed change.");
  const folder = kind === "task" && (context.taskFolder === true || action === "create" && input.type === "folder");
  const allowed = folder ? Object.fromEntries(Object.entries(byAction).filter(([name]) => taskFolderFields.has(name)).map(
    ([name, spec]) => [name, name === "parentId" ? taskFolderParent : spec],
  )) : byAction;
  if (kind === "note_link" && isCalendarWorkspaceCreate(action)) {
    const target = context.resolve?.(input.targetId, ["event", "task"]);
    const linkKind = target?.kind ?? input.targetType;
    if (linkKind !== "event" && linkKind !== "task") invalidValue("Choose an event or To-Do for this note link.");
    if (input.occurrence !== undefined && target?.details.origin) invalidValue("Choose the original series to link an occurrence.");
    const associationId = linkKind === "event" ? association(["event"]).read(input.targetId, context) as string : undefined;
    const values = readFields(input, { ...allowed, targetId: association([linkKind]) }, required, {
      ...context, associationId, reviewedOccurrences: target?.details.occurrences,
    });
    if ((values.scope === "OCCURRENCE") !== Object.hasOwn(values, "occurrence") || linkKind !== "event" && values.scope === "SERIES")
      invalidValue("Select a valid note link scope.");
    return { ...values, targetType: linkKind };
  }
  const values = readFields(input, allowed, required, context);
  if (kind === "event") eventRules(values, action);
  if (kind === "note" && Object.hasOwn(values, "contentHtml") && Object.hasOwn(values, "appendText"))
    invalidValue("Choose a replacement body or append new paragraphs.");
  if (kind === "project_rate" && values.from !== undefined && values.from === values.to)
    invalidValue("Choose two different currencies.");
  return values;
}

export function prepareCalendarWorkspaceValues(
  kind: RecordKind, action: CalendarWorkspaceAction, value: unknown,
  target: CalendarWorkspaceOperation["target"], scope: CalendarWorkspaceProposalScope,
  resolve: CalendarWorkspaceReferenceResolver,
  reviewed: Pick<ValueContext, "taskFolder" | "reviewedOccurrences"> = {},
): Record<string, unknown> | null {
  return validateValues(kind, action, value, { ...reviewed, datasetBound: true, associationId: target?.id, scope, resolve });
}

/** Validate local and restored drafts independently from model parsing and native business rules. */
export function validateCalendarWorkspaceOperation(operation: CalendarWorkspaceOperation, datasetId: string | null): CalendarWorkspaceOperation {
  const creates = isCalendarWorkspaceCreate(operation.action);
  if (creates !== (operation.target === null) || !creates && datasetId === null) invalidValue("Look up the matching Calendar record before proposing changes.");
  if (operation.target) {
    if (operation.kind === "note_link") {
      if (!/^(?:link|planner_link)\|.+$/.test(operation.target.id)) invalidValue("Choose an existing Calendar note link.");
    } else readUuid(operation.target.id);
  }
  const references = operation.references ?? [];
  const used = new Set<number>();
  const verify = (id: string | null, kinds: readonly RecordKind[]) => {
    const matching = references.filter(ref => (id === null || id === ref.id) && kinds.includes(ref.kind));
    if (matching.length !== 1) invalidValue("This Calendar change is missing the reviewed revision for a related record.");
    used.add(references.indexOf(matching[0]));
  };
  const values = validateValues(operation.kind, operation.action, operation.values, { datasetBound: datasetId !== null, associationId: operation.target?.id, verify });
  // A detached event's reviewed row is an additional dependency of its original series operation.
  if (operation.kind === "event" && values?.occurrence && references.length) verify(null, ["event"]);
  if (used.size !== references.length) invalidValue("This Calendar change contains an unrelated record reference.");
  return operation;
}
