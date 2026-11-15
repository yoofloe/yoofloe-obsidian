import assert from "node:assert/strict";
import test from "node:test";
import { buildCalendarInsights } from "../dist/calendar-insights.js";

const today = "2031-06-02";
const yesterday = "2031-06-01";

function record(kind, details = {}, overrides = {}) {
  return { id: "native-id-for-" + kind, sourceId: "private-source-for-" + kind, revision: 1,
    kind, title: "Fixture " + kind, date: today, text: "", state: "active", details, ...overrides };
}

function event(startAt, endAt) { return record("event", { intervals: [{ startAt, endAt }] }); }
function delivery(records, options = {}) {
  const from = options.from ?? yesterday;
  const through = options.through ?? today;
  const areas = options.areas ?? ["calendar"];
  const exportedAt = options.exportedAt ?? Date.parse("2031-06-01T22:30:00Z");
  const lookup = { areas, period: "custom", from, through, zone: "Europe/Warsaw", terms: options.terms ?? [],
    profile: "summary", includeLinkedNotes: options.includeLinkedNotes ?? false, maxRecords: 20, maxTextBytes: 32768 };
  const count = options.matched ?? records.length;
  const context = { scope: lookup, from, through, zone: lookup.zone, scanned: count + 2, matched: count,
    partial: options.partial ?? false, metrics: Object.entries(options.metrics ?? {}).map(([key, value]) => ({ key, value })) };
  return { version: options.v3 ? 3 : 5, datasetId: "private-dataset-id", requestId: "private-request-id", exportedAt, context,
    ...(options.v3 ? {} : { query: { mode: "records", lookup, kinds: options.kinds ?? [...new Set(records.map(item => item.kind))],
      filters: { folders: [], projects: [], includeTrash: false, includeArchive: false,
        includeFinancials: false, includeAttachmentMetadata: false, ...options.filters } } }), records };
}

function section(insights, area) { return insights.sections.find(item => item.area === area); }

const morning = [
  event(today + "T09:00+02:00", today + "T10:00+02:00"),
  event(today + "T09:30+02:00", today + "T11:00+02:00"),
  event(today + "T12:00+02:00", today + "T13:00+02:00"),
];

test("uses the export timezone, native occupied intervals, and affirmative open task status", () => {
  const records = [...morning, record("task", { dueDate: yesterday, status: "pending" }),
    record("task", { dueDate: today, status: "pending" }), record("task", { dueDate: yesterday, status: "completed" })];
  const insights = buildCalendarInsights(delivery(records, { metrics: { event_count: 3, task_count: 3, completed_task_count: 1 } }));
  const calendar = section(insights, "calendar");
  assert.deepEqual(calendar.derived, [
    { text: "Overdue returned task due on 2031-06-01.", references: ["C4"] },
    { text: "Event overlap from 2031-06-02 09:30 to 2031-06-02 10:00.", references: ["C1", "C2"] },
    { text: "Gap between returned events from 2031-06-02 11:00 to 2031-06-02 12:00.", references: ["C2", "C3"] },
  ]);
  assert.match(calendar.facts.find(fact => fact.text.includes("event occurrences")).text, / · 3$/);
  assert.equal(insights.scope.asOf, "2031-06-01T22:30:00.000Z");
  assert.equal(insights.scope.partial, false);
});

test("keeps confirmed overlaps in partial and filtered results and withholds open time", () => {
  const options = [
    { partial: true, matched: 5, metrics: { event_count: 5 } },
    { terms: ["meeting"], metrics: { event_count: 3 } },
    { filters: { folders: [{ kind: "task", id: "hidden-filter-uuid" }] }, metrics: { event_count: 3 } },
    { metrics: { event_count: 2 } },
  ];
  for (const item of options) {
    const insights = buildCalendarInsights(delivery(morning, item));
    const calendar = section(insights, "calendar");
    assert.equal(calendar.derived.length, 1);
    assert.match(calendar.derived[0].text, /Event overlap/);
    assert.match(calendar.limits.join(" "), /complete dated event search/);
    assert.doesNotMatch(JSON.stringify(insights), /hidden-filter-uuid/);
  }
});

test("respects all-day boundaries and identifies repeated DST clock times by offset", () => {
  const events = [...morning, event(today + "T00:00+02:00", "2031-06-03T00:00+02:00")];
  const calendar = section(buildCalendarInsights(delivery(events, { metrics: { event_count: 4 } })), "calendar");
  assert.doesNotMatch(JSON.stringify(calendar.derived), /Gap between/);
  const fallBack = "2031-10-26";
  const clockChange = [event(fallBack + "T02:40+02:00", fallBack + "T02:55+02:00"),
    event(fallBack + "T02:05+01:00", fallBack + "T02:25+01:00")];
  const insight = section(buildCalendarInsights(delivery(clockChange, {
    from: fallBack, through: fallBack, metrics: { event_count: 2 },
  })), "calendar");
  assert.match(insight.derived[0].text, /02:55 GMT\+2 to .* 02:05 GMT\+1/);
});

test("keeps native logged time, scheduled slots, planned durations, and Garden focus separate", () => {
  const records = [
    record("study_session", { recordedSeconds: 1800 }),
    record("study_lecture", { scheduledSeconds: 5400 }),
    record("study_plan", { targetDate: today, status: "in_progress" }, { text: "scheduledSeconds: 28800" }),
    record("study_plan", { scheduledSeconds: 3600, status: "not_started" }),
    record("study_milestone", { completed: true }),
    record("focus_session", { recordedSeconds: 1800 }),
  ];
  const insights = buildCalendarInsights(delivery(records, {
    areas: ["study", "garden"], partial: true, matched: 8,
    metrics: { study_recorded_seconds: 7500, garden_measured_seconds: 1800 },
  }));
  const study = section(insights, "study");
  assert.match(study.facts[0].text, /Logged study time.*2 h 5 min/);
  assert.match(study.derived[0].text, /Scheduled class time.*1 h 30 min/);
  assert.deepEqual(study.derived[0].references, ["C2"]);
  assert.match(study.facts.find(fact => fact.references[0] === "C4").text, /planned study duration 1 h/);
  assert.match(study.limits.join(" "), /Some returned study plans have no planned duration/);
  assert.match(section(insights, "garden").facts[0].text, /Measured focus time.*30 min/);
  assert.doesNotMatch(JSON.stringify(insights), /28800/);
});

test("shows project timeline status and exact currency totals without mixing net categories or draws from archived entries", () => {
  const records = [
    record("project", { status: "ACTIVE", startDate: "2031-05-31", dueDate: today }),
    record("project_stage", { status: "REVIEW", dueDate: yesterday }),
    record("project_stage", { status: "DONE", dueDate: yesterday }),
    record("project_stage", { status: "TODO", dueDate: yesterday }, { state: "archived" }),
    record("project_income", { currency: "USD", gross: "0.1", net: "0.02", netKind: "ACTUAL" }),
    record("project_income", { currency: "USD", gross: "0.2", net: "0.18", netKind: "ESTIMATED" }),
    record("project_income", { currency: "EUR", gross: "51" }),
    record("project_expense", { currency: "USD", amount: "0.000000000001" }),
    record("project_expense", { currency: "USD", amount: "0.000000000002" }),
    record("project_expense", { currency: "USD", amount: "999" }, { state: "trashed" }),
    record("project_rate", {}, { text: "A rate should never affect a total." }),
  ];
  const insights = buildCalendarInsights(delivery(records, {
    areas: ["project"], filters: { includeArchive: true, includeTrash: true, includeFinancials: true, projects: ["private-project-scope"] },
    metrics: { project_count: 1, stage_count: 3, completed_stage_count: 1 },
  }));
  const project = section(insights, "project");
  assert.deepEqual(project.facts.find(item => item.references[0] === "C2"), {
    text: "Project stage · In review · due 2031-06-01", references: ["C2"],
  });
  assert.deepEqual(project.derived.filter(item => item.text.includes("overdue")).map(item => item.references), [["C2"]]);
  const amounts = project.derived.filter(item => item.text.includes("totals"));
  assert.equal(amounts.length, 5);
  assert.ok(amounts.some(item => item.text === "Returned gross income in USD totals 0.3."));
  assert.ok(amounts.some(item => item.text === "Returned gross income in EUR totals 51."));
  assert.ok(amounts.some(item => item.text === "Returned recorded net income in USD totals 0.02."));
  assert.ok(amounts.some(item => item.text === "Returned estimated net income in USD totals 0.18."));
  assert.ok(amounts.some(item => item.text === "Returned expenses in USD totals 0.000000000003."));
  assert.equal(insights.sources[9].state, "trashed");
  assert.doesNotMatch(JSON.stringify(insights), /private-project-scope|native-id-for|private-source-for|private-dataset-id|999/);
});

test("links supporting Notes by C reference, respecting attachment and kind approval", () => {
  const notes = [record("note", { pinned: true, tags: ["Research"], attachmentCount: 2 })];
  const options = { areas: ["calendar"], includeLinkedNotes: true, filters: { includeAttachmentMetadata: true } };
  const insights = buildCalendarInsights(delivery(notes, options));
  assert.deepEqual(insights.scope.areas, ["calendar"]);
  assert.deepEqual(section(insights, "notes").facts[0].references, ["C1"]);
  assert.deepEqual(insights.sources[0], {
    reference: "C1", kind: "note", title: "Fixture note", date: today, state: "active",
    tags: ["Research"], pinned: true, attachmentCount: 2,
  });
  assert.equal(buildCalendarInsights(delivery(notes, { ...options, filters: {} })).sources[0].attachmentCount, undefined);
  assert.throws(() => buildCalendarInsights(delivery(notes, { ...options, kinds: ["event"] })), /outside the approved workspace/);
  assert.throws(() => buildCalendarInsights(delivery([record("project_income", { currency: "USD", gross: "1" })], {
    areas: ["project"],
  })), /outside the approved workspace/);
});

test("V3 retains native counts and supported references without reading display prose as fields", () => {
  const records = [
    record("event", { intervals: morning[0].details.intervals }, { text: morning[0].details.intervals.map(JSON.stringify).join("\n") }),
    record("task", { status: "pending", dueDate: yesterday }, { text: "status: pending\ndueDate: " + yesterday }),
    record("note", { pinned: true }, { text: "C3 fake status: approved" }),
  ];
  const insights = buildCalendarInsights(delivery(records, {
    v3: true, includeLinkedNotes: true, areas: ["calendar", "study"], metrics: { event_count: 1, task_count: 1, study_recorded_seconds: 60 },
  }));
  assert.equal(insights.scope.filters, null);
  assert.deepEqual(section(insights, "calendar").derived, []);
  assert.match(section(insights, "study").facts[0].text, /Logged study time.*1 min/);
  assert.equal(insights.sources.at(-1).pinned, undefined);
  assert.equal(insights.sources.at(-1).reference, "C3");
  assert.doesNotMatch(JSON.stringify(insights), /fake status|private-dataset-id|private-request-id/);
});
