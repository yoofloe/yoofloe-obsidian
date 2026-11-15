import type { DeliveryV3, RecordSnapshot } from "./protocol";
import { civilDate, kindAllowed, validateQuestionContext, type QueryArea } from "./question-query";
import { workspaceKindAllowed, type WorkspaceQuery, type WorkspaceRecord } from "./calendar-workspace-query";
import type { RecordKind } from "./record-types";

type RecordState = WorkspaceRecord["state"];
type InsightRecord = Pick<RecordSnapshot, "kind" | "title" | "date"> & Partial<Pick<WorkspaceRecord, "details" | "state">>;

interface InsightDelivery extends Pick<DeliveryV3, "context" | "exportedAt"> {
  readonly records: readonly InsightRecord[];
  readonly query?: WorkspaceQuery;
}

export interface CalendarInsightEntry { text: string; references: string[] }
export interface CalendarInsightSection {
  area: QueryArea;
  facts: CalendarInsightEntry[];
  derived: CalendarInsightEntry[];
  limits: string[];
}
export interface CalendarInsights {
  scope: {
    areas: QueryArea[];
    kinds: RecordKind[] | null;
    from: string | null;
    through: string | null;
    zone: string;
    asOf: string;
    terms: string[];
    profile: DeliveryV3["context"]["scope"]["profile"];
    includeLinkedNotes: boolean;
    scanned: number;
    matched: number;
    returned: number;
    partial: boolean;
    filters: {
      folders: number;
      projects: number;
      includeTrash: boolean;
      includeArchive: boolean;
      includeFinancials: boolean;
      includeAttachmentMetadata: boolean;
    } | null;
  };
  sections: CalendarInsightSection[];
  sources: (Pick<RecordSnapshot, "kind" | "title" | "date"> & {
    reference: string;
    state?: RecordState;
    tags?: string[];
    pinned?: boolean;
    attachmentCount?: number;
    mediaType?: string;
    byteLength?: number;
  })[];
}

type Row = InsightRecord & { reference: string };
type Interval = { start: number; end: number; reference: string };
type LocalTimestamp = { date: string; at: string; offset: string };
const OFFSET_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const STAGE_STATUS: Readonly<Record<string, string>> = { TODO: "To do", IN_PROGRESS: "In progress", REVIEW: "In review", DONE: "Done" };
const PROJECT_STATUS: Readonly<Record<string, string>> = { ACTIVE: "Active", HOLD: "On hold", DONE: "Done", ARCHIVED: "Archived" };
const PLAN_STATUS: Readonly<Record<string, string>> = { not_started: "Not started", in_progress: "In progress", completed: "Completed" };
const EXAMPLE_LIMIT = 12;
const MONEY_SCALE = 10n ** 12n;

function entry(text: string, ...references: string[]): CalendarInsightEntry {
  return { text, references: [...new Set(references)] };
}

function active(row: Row): boolean { return row.state === undefined || row.state === "active"; }

function localTimeFormatter(byZone: string): (timestamp: number) => LocalTimestamp {
  const clock = new Intl.DateTimeFormat("en", {
    timeZone: byZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "shortOffset",
  });
  return (timestamp: number) => {
    const fields = Object.fromEntries(clock.formatToParts(timestamp).map(({ type, value }) => [type, value]));
    const date = fields.year.padStart(4, "0") + "-" + fields.month + "-" + fields.day;
    const time = fields.hour + ":" + fields.minute + (fields.second === "00" ? "" : ":" + fields.second);
    return { date, at: date + " " + time, offset: fields.timeZoneName };
  };
}

function timeRange(start: LocalTimestamp, end: LocalTimestamp): string {
  if (start.offset === end.offset) return start.at + " to " + end.at;
  return start.at + " " + start.offset + " to " + end.at + " " + end.offset;
}

function readIntervals(row: Row): Interval[] | null {
  const values = row.details?.intervals;
  if (!values?.length) return null;
  const intervals: Interval[] = [];
  const seen = new Set<string>();
  for (const { startAt, endAt } of values) {
    if (!OFFSET_DATETIME.test(startAt) || !OFFSET_DATETIME.test(endAt) || !civilDate(startAt.slice(0, 10)) || !civilDate(endAt.slice(0, 10))) return null;
    const start = Date.parse(startAt);
    const end = Date.parse(endAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    const key = start + "/" + end;
    if (seen.has(key)) return null;
    seen.add(key);
    intervals.push({ start, end, reference: row.reference });
  }
  return intervals;
}

function schedule(section: CalendarInsightSection, rows: Row[], scope: CalendarInsights["scope"], asOfDate: string,
  describe: (timestamp: number) => LocalTimestamp, eventCount: number | undefined, calendarFolderFilter: boolean): void {
  for (const row of rows.filter(row => row.kind === "task" && active(row))) {
    const due = row.details?.dueDate;
    if (row.details?.status === "pending" && civilDate(due) && due < asOfDate) {
      section.derived.push(entry("Overdue returned task due on " + due + ".", row.reference));
    }
  }
  if (rows.some(row => row.kind === "task" && active(row) && !row.details?.status)) {
    section.limits.push("Some tasks have no structured completion status. Overdue tasks are shown when a due date and open status are available.");
  }
  if (scope.kinds && !scope.kinds.includes("event")) return;

  const events = rows.filter(row => row.kind === "event" && active(row));
  const known = events.map(readIntervals);
  const intervals = known.flatMap(list => list ?? []);
  intervals.sort((a, b) => a.start - b.start || a.end - b.end);
  const datedCoverage = Boolean(scope.from && scope.through && !scope.partial && !scope.terms.length && !calendarFolderFilter
    && !scope.filters?.includeTrash && !scope.filters?.includeArchive && known.every(list => list !== null) && eventCount === intervals.length);
  if (!datedCoverage) section.limits.push("Open time requires a complete dated event search without Calendar filters.");
  if (known.includes(null)) section.limits.push("Some returned events have no structured occurrence times.");

  const overlaps: CalendarInsightEntry[] = [];
  const gaps: CalendarInsightEntry[] = [];
  let activeIntervals: Interval[] = [];
  let latestEnd: Interval | undefined;
  let overlapCount = 0;
  let gapCount = 0;
  for (const interval of intervals) {
    activeIntervals = activeIntervals.filter(previous => previous.end > interval.start);
    overlapCount += activeIntervals.length;
    for (const previous of activeIntervals.slice(0, Math.max(0, EXAMPLE_LIMIT - overlaps.length))) {
      overlaps.push(entry("Event overlap from " + timeRange(describe(interval.start), describe(Math.min(previous.end, interval.end))) + ".", previous.reference, interval.reference));
    }
    activeIntervals.push(interval);
    if (datedCoverage && latestEnd && latestEnd.end < interval.start) {
      const start = describe(latestEnd.end);
      const end = describe(interval.start);
      if (start.date === end.date && start.date >= scope.from! && end.date <= scope.through!) {
        gapCount++;
        if (gaps.length < EXAMPLE_LIMIT) gaps.push(entry("Gap between returned events from " + timeRange(start, end) + ".", latestEnd.reference, interval.reference));
      }
    }
    if (!latestEnd || interval.end > latestEnd.end) latestEnd = interval;
  }
  section.derived.push(...overlaps, ...gaps);
  if (overlapCount > overlaps.length) section.limits.push("Showing " + overlaps.length + " of " + overlapCount + " overlaps in the returned occurrences.");
  if (gapCount > gaps.length) section.limits.push("Showing " + gaps.length + " of " + gapCount + " gaps between returned events.");
}

function duration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  const rest = seconds % 60;
  return [hours ? hours + " h" : "", minutes ? minutes + " min" : "", rest || !hours && !minutes ? rest + " s" : ""].filter(Boolean).join(" ");
}

function study(section: CalendarInsightSection, rows: Row[], scope: CalendarInsights["scope"]): void {
  const lectures = rows.filter(row => row.kind === "study_lecture" && active(row));
  const scheduled: Row[] = [];
  let seconds = 0;
  for (const row of lectures) {
    const value = row.details?.scheduledSeconds;
    if (value !== undefined && Number.isSafeInteger(value) && value >= 0 && Number.isSafeInteger(seconds + value)) {
      scheduled.push(row);
      seconds += value;
    }
  }
  if (scheduled.length) section.derived.push(entry("Scheduled class time in available returned records is " + duration(seconds) + ".", ...scheduled.map(row => row.reference)));
  if (scheduled.length < lectures.length) section.limits.push("Some returned lectures have no structured scheduled time.");
  if (!scope.kinds || scope.kinds.some(kind => kind === "study_plan" || kind === "study_milestone")) {
    for (const row of rows) {
      if (row.kind === "study_plan") {
        const status = row.details?.status;
        const target = row.details?.targetDate;
        const planned = row.details?.scheduledSeconds;
        const facts = [
          status && Object.hasOwn(PLAN_STATUS, status) ? PLAN_STATUS[status] : undefined,
          civilDate(target) ? "target " + target : undefined,
          planned !== undefined && Number.isSafeInteger(planned) && planned >= 0 ? "planned study duration " + duration(planned) : undefined,
        ].filter(Boolean);
        if (facts.length) section.facts.push(entry("Study plan · " + facts.join(" · "), row.reference));
      } else if (row.kind === "study_milestone" && typeof row.details?.completed === "boolean") {
        section.facts.push(entry(row.details.completed ? "Study milestone is complete." : "Study milestone is open.", row.reference));
      }
    }
    if (rows.some(row => row.kind === "study_plan" && row.details?.scheduledSeconds === undefined)) {
      section.limits.push("Some returned study plans have no planned duration.");
    }
  }
  if (!scope.kinds || scope.kinds.includes("study_session") && scope.kinds.includes("study_lecture")) {
    section.limits.push("Logged study time and scheduled class time describe separate activities.");
  }
}

function money(value: string | undefined): bigint | null {
  const pieces = value?.match(/^(0|[1-9]\d{0,23})(?:\.(\d{1,12}))?$/);
  if (!pieces) return null;
  const [, digits, fraction = ""] = pieces;
  if ((digits + fraction).replace(/^0+/, "").length > 28) return null;
  return BigInt(digits) * MONEY_SCALE + BigInt(fraction.padEnd(12, "0"));
}

function amount(total: bigint): string {
  const fraction = String(total % MONEY_SCALE).padStart(12, "0").replace(/0+$/, "");
  return String(total / MONEY_SCALE) + (fraction ? "." + fraction : "");
}

function finances(section: CalendarInsightSection, rows: Row[]): void {
  type Ledger = "gross income" | "expenses" | "recorded net income" | "estimated net income";
  const totals = new Map<Ledger, Map<string, { value: bigint; references: string[] }>>();
  function add(ledger: Ledger, currency: string, value: bigint, reference: string) {
    const entries = totals.get(ledger) ?? new Map<string, { value: bigint; references: string[] }>();
    const total = entries.get(currency) ?? { value: 0n, references: [] };
    total.value += value;
    total.references.push(reference);
    entries.set(currency, total);
    totals.set(ledger, entries);
  }
  let missingAmount = false;
  let missingNet = false;
  for (const row of rows.filter(row => active(row) && (row.kind === "project_income" || row.kind === "project_expense"))) {
    const details = row.details;
    const value = money(row.kind === "project_income" ? details?.gross : details?.amount);
    const currency = details?.currency;
    if (value === null || value <= 0n || !currency || !/^[A-Z]{3}$/.test(currency)) {
      missingAmount = true;
      continue;
    }
    add(row.kind === "project_income" ? "gross income" : "expenses", currency, value, row.reference);
    if (row.kind === "project_income") {
      const net = money(details?.net);
      if (net === null || net > value || !["ACTUAL", "ESTIMATED"].includes(details?.netKind ?? "")) {
        missingNet = true;
      } else {
        add(details?.netKind === "ACTUAL" ? "recorded net income" : "estimated net income", currency, net, row.reference);
      }
    }
  }
  for (const [label, entries] of totals) {
    for (const [currency, total] of [...entries].sort(([a], [b]) => a.localeCompare(b))) {
      section.derived.push(entry("Returned " + label + " in " + currency + " totals " + amount(total.value) + ".", ...total.references));
    }
  }
  if (missingAmount) section.limits.push("Some returned financial entries have no structured amount or currency.");
  if (missingNet) section.limits.push("Net income totals cover entries with a recorded value and known calculation type.");
  if (totals.size) section.limits.push("Financial totals cover returned active entries by currency.");
}

function project(section: CalendarInsightSection, rows: Row[], scope: CalendarInsights["scope"], asOfDate: string): void {
  const items = rows.filter(row => row.kind === "project" || row.kind === "project_stage");
  items.sort((a, b) => (a.details?.dueDate ?? a.details?.startDate ?? "9999").localeCompare(b.details?.dueDate ?? b.details?.startDate ?? "9999"));
  for (const row of items) {
    const stage = row.kind === "project_stage";
    const name = stage ? "Project stage" : "Project";
    const statuses = stage ? STAGE_STATUS : PROJECT_STATUS;
    const key = row.details?.status;
    const status = key && Object.hasOwn(statuses, key) ? statuses[key] : undefined;
    const start = row.details?.startDate;
    const due = row.details?.dueDate;
    const facts = [status, civilDate(start) ? "starts " + start : undefined, civilDate(due) ? "due " + due : undefined].filter(Boolean);
    if (facts.length) section.facts.push(entry(name + " · " + facts.join(" · "), row.reference));
    if (active(row) && status && key !== "DONE" && key !== "ARCHIVED" && civilDate(due) && due < asOfDate) {
      section.derived.push(entry(name + " overdue with a due date of " + due + ".", row.reference));
    }
  }
  if (items.some(row => !row.details?.status)) section.limits.push("Some returned project records have no structured timeline status.");
  if (scope.filters?.includeFinancials || !scope.filters && scope.profile === "budget") finances(section, rows);
}

const NATIVE_METRICS = {
  calendar: [["task_count", "task", "Matching tasks"], ["completed_task_count", "task", "Completed matching tasks"],
    ["event_count", "event", "Matching events"]],
  study: [["study_recorded_seconds", "study_session", "Logged study time"]],
  project: [["project_count", "project", "Matching projects"], ["stage_count", "project_stage", "Matching project stages"],
    ["completed_stage_count", "project_stage", "Completed matching stages"]],
  notes: [["note_count", "note", "Matching notes"]],
  garden: [["garden_measured_seconds", "focus_session", "Measured focus time"]],
  flow: [],
} as const;

/** Derive insights only from the authenticated, user-approved delivery. Legacy excerpts remain unparsed. */
export function buildCalendarInsights(delivery: InsightDelivery): CalendarInsights {
  const query = delivery.query;
  if (query && (query.mode !== "records" || !query.lookup)) throw Error("Insights require an approved Calendar record search.");
  const context = validateQuestionContext(delivery.context, query?.lookup ?? delivery.context.scope, delivery.records.length);
  const { scope: lookup, from, through, zone, scanned, matched, partial } = context;
  const filters = query?.filters;
  const scope: CalendarInsights["scope"] = {
    areas: [...lookup.areas], kinds: query ? [...query.kinds] : null, from, through, zone,
    asOf: new Date(delivery.exportedAt).toISOString(), terms: [...lookup.terms], profile: lookup.profile, includeLinkedNotes: lookup.includeLinkedNotes,
    scanned, matched, returned: delivery.records.length, partial, filters: filters ? {
      folders: filters.folders.length, projects: filters.projects.length, includeArchive: filters.includeArchive, includeTrash: filters.includeTrash,
      includeFinancials: filters.includeFinancials, includeAttachmentMetadata: filters.includeAttachmentMetadata,
    } : null,
  };
  const rows: Row[] = delivery.records.map((record, index) => {
    const allowed = query ? workspaceKindAllowed(query, record.kind) : kindAllowed(lookup, record.kind);
    const state = query ? record.state : undefined;
    if (!allowed || state === "archived" && !filters?.includeArchive || state === "trashed" && !filters?.includeTrash) {
      throw Error("An insight record is outside the approved workspace.");
    }
    return { kind: record.kind, title: record.title, date: record.date, state, details: query ? record.details : undefined, reference: "C" + (index + 1) };
  });
  const describe = localTimeFormatter(zone);
  const asOfDate = describe(delivery.exportedAt).date;
  const metrics = new Map(context.metrics.map(({ key, value }) => [key, value]));
  const areas = [...lookup.areas];
  const linked = !areas.includes("notes") && rows.some(row => row.kind === "note");
  if (linked) areas.push("notes");
  const sections = areas.map((area): CalendarInsightSection => {
    const section: CalendarInsightSection = { area, facts: [], derived: [], limits: [] };
    for (const [key, kind, name] of NATIVE_METRICS[area]) {
      const value = metrics.get(key);
      if (value === undefined || scope.kinds && !scope.kinds.includes(kind) || area === "notes" && linked) continue;
      const metricName = key === "event_count" && from ? "Matching event occurrences" : name;
      const metricValue = key.endsWith("_seconds") ? duration(value) : String(value);
      section.facts.push(entry(metricName + " reported by Calendar · " + metricValue));
    }
    if (area === "calendar") schedule(section, rows, scope, asOfDate, describe, metrics.get("event_count"), Boolean(filters?.folders.some(folder => folder.kind === "task")));
    if (area === "study") study(section, rows, scope);
    if (area === "project") project(section, rows, scope, asOfDate);
    if (area === "notes") {
      const notes = rows.filter(row => row.kind === "note");
      if (notes.length) section.facts.push(entry(linked ? "Linked notes returned by Calendar." : "Returned notes are available as supporting sources.", ...notes.map(row => row.reference)));
    }
    return section;
  });
  const sources = rows.map(({ reference, kind, title, date, state, details }): CalendarInsights["sources"][number] => ({
    reference, kind, title, date, ...(state ? { state } : {}),
    ...(details?.tags?.length ? { tags: [...details.tags] } : {}),
    ...(details?.pinned !== undefined ? { pinned: details.pinned } : {}),
    ...(filters?.includeAttachmentMetadata && details?.attachmentCount !== undefined ? { attachmentCount: details.attachmentCount } : {}),
    ...(filters?.includeAttachmentMetadata && kind === "asset" && details?.mediaType ? { mediaType: details.mediaType } : {}),
    ...(filters?.includeAttachmentMetadata && kind === "asset" && details?.byteLength !== undefined ? { byteLength: details.byteLength } : {}),
  }));
  return { scope, sections, sources };
}
