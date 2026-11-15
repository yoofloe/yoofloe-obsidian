import assert from "node:assert/strict";
import { test } from "node:test";
import { workspaceDraftTool, prepareCalendarWorkspaceDraft } from "../dist/calendar-workspace-draft.js";
import { validateCalendarWorkspaceOperation } from "../dist/calendar-workspace-catalog.js";
import { readCalendarWorkspaceChangeDraft } from "../dist/calendar-workspace-change.js";

const dataset = "7ca873a2-a670-41d4-b541-4ea4f7b569a1";
const requestId = "c9793e64-8487-44fd-9b84-380e4e8482a3";
const baseActions = ["create", "update", "delete", "restore"];

function record(kind, index, extra = {}) {
  const sourceId = "7c2b2292-c844-42e7-8e00-" + String(index).padStart(12, "0");
  return { kind, id: kind + "/" + sourceId, sourceId, title: "Fictional " + kind, text: "", date: null,
    state: "active", revision: 24 + index, details: {}, ...extra };
}

function lookup({ records = [], writeKinds = [], kinds, filters = {}, mode = "records" } = {}) {
  const readKinds = kinds ?? Array.from(new Set([...records.map(item => item.kind), ...writeKinds.map(item => item.kind)]));
  return {
    version: 5, requestId, datasetId: dataset, exportedAt: Date.parse("2031-06-01T11:00:00Z"),
    context: null, records, capabilities: { readKinds, writeKinds },
    query: {
      mode, lookup: mode === "records" ? {
        areas: ["calendar", "study", "project", "notes"], period: "custom", from: "2031-06-01", through: "2031-06-30",
        zone: "Europe/Warsaw", terms: [], profile: "summary", includeLinkedNotes: false, maxRecords: 20, maxTextBytes: 32768,
      } : null,
      kinds: mode === "records" ? readKinds : [],
      filters: { folders: [], projects: [], includeTrash: false, includeArchive: false, includeFinancials: false, includeAttachmentMetadata: false, ...filters },
    },
  };
}

const write = (kind, actions = baseActions) => ({ kind, actions });
const change = (kind, action, record = null, values = null) =>
  ({ kind, action, record, valuesJson: values === null ? null : JSON.stringify(values) });
const prepare = (delivery, ...operations) => prepareCalendarWorkspaceDraft({ operations }, delivery);

test("capability-only lookup offers compatible creations and binds their draft to the native dataset", async () => {
  const delivery = lookup({ mode: "capabilities", writeKinds: [
    write("task", ["create", "update"]), write("project_income"), write("asset"), write("focus_session"),
    write("note_link", ["create", "link"]), write("study_milestone"), write("project_stage"),
  ] });
  const tool = workspaceDraftTool(delivery);
  assert.equal(tool.name, "draft_calendar_workspace_changes");
  assert.equal(tool.strict, true);
  assert.deepEqual(tool.parameters.properties.operations.items.properties.kind.enum, ["task"]);
  assert.deepEqual(tool.parameters.properties.operations.items.properties.action.enum, ["create"]);
  assert.equal(workspaceDraftTool(lookup({ writeKinds: [write("event", ["delete"]), write("note_link", ["link"])] })), null);
  const { draft, titles } = await prepare(delivery, change("task", "create", null, { title: "Synthetic task" }));
  assert.equal(draft.version, 5);
  assert.equal(draft.datasetId, dataset);
  assert.equal(draft.operations[0].target, null);
  assert.equal(titles[draft.operations[0].opId], "Synthetic task");
  await assert.rejects(prepare(delivery, change("task", "update", "C1", { title: "Other" })), /unavailable/);
  await assert.rejects(prepare(delivery, change("task", "create", null, { title: "Synthetic task", parentId: "C1" })), /current Calendar lookup/);
});

test("targets and hierarchy relationships resolve only against matching approved C references", async () => {
  const session = record("study_session", 1);
  const folder = record("study_folder", 2);
  const note = record("note", 3);
  const delivery = lookup({
    records: [session, folder, note],
    writeKinds: [write("study_session", ["update", "move"]), write("study_folder", ["move"])],
  });
  const { draft, titles } = await prepare(delivery, change("study_session", "move", "C1", { folderId: "C2" }));
  assert.deepEqual(draft.operations[0].target, { id: session.sourceId, revision: session.revision });
  assert.deepEqual(draft.operations[0].values, { folderId: folder.sourceId });
  assert.deepEqual(draft.operations[0].references, [{ kind: folder.kind, id: folder.sourceId, revision: folder.revision }]);
  assert.throws(() => validateCalendarWorkspaceOperation({ ...draft.operations[0], references: [] }, dataset), /reviewed revision/);
  assert.throws(() => validateCalendarWorkspaceOperation({ ...draft.operations[0], references: [{ kind: "study_session", id: folder.sourceId, revision: folder.revision }] }, dataset), /reviewed revision/);
  assert.equal(titles[draft.operations[0].opId], session.title);
  assert.equal((await readCalendarWorkspaceChangeDraft(draft, validateCalendarWorkspaceOperation)).proposalDigest, draft.proposalDigest);
  for (const invalid of [
    change("study_session", "move", "C1", { folderId: note.sourceId }),
    change("study_session", "move", "C1", { folderId: "C3" }),
    change("study_session", "move", folder.sourceId, { folderId: "C2" }),
    change("study_session", "move", "C2", { folderId: "C2" }),
    change("study_folder", "move", "C2", { parentId: "C2" }),
    change("study_session", "move", "C1", { folderId: { id: folder.sourceId, revision: 1 } }),
    change("study_session", "move", "C1", { title: "Move cannot edit title" }),
    change("study_session", "delete", "C1"),
  ]) await assert.rejects(prepare(delivery, invalid));
  await assert.rejects(prepare(delivery, change("study_session", "move", "C1", { folderId: "C2" }),
    change("study_session", "update", "C1", { title: "Duplicate target" })), /only once/);
});

test("restoration and archive require an approved current record in the matching state", async () => {
  const active = record("project", 1);
  const archived = record("project", 2, { state: "archived" });
  const trashed = record("project", 3, { state: "trashed" });
  const delivery = lookup({ records: [active, archived, trashed], writeKinds: [write("project", [...baseActions, "archive"])],
    filters: { includeTrash: true, includeArchive: true } });
  const { draft } = await prepare(delivery, change("project", "archive", "C1"), change("project", "restore", "C3"),
    change("project", "update", "C2", { status: "ACTIVE" }));
  assert.deepEqual(draft.operations.map(item => item.action), ["archive", "restore", "update"]);
  for (const operation of [
    change("project", "archive", "C2"), change("project", "delete", "C3"), change("project", "restore", "C1"),
    change("project", "update", "C1", { status: "ARCHIVED" }),
    change("project", "delete", "C1", { permanent: true }),
  ]) await assert.rejects(prepare(delivery, operation));
});

test("Schedule prepares explicit recurrence scopes, app-owned reminder IDs and validated checklist values", async () => {
  const original = { originalStart: "2031-06-15T10:00:00", timeBasis: "ZONED", timezone: "Europe/Warsaw", originalOffset: "+02:00" };
  const event = record("event", 1, { details: { occurrences: [original] } });
  const delivery = lookup({ records: [event], writeKinds: [write("event"), write("task"), write("dday"), write("event_template")] });
  const { draft } = await prepare(delivery,
    change("event", "update", "C1", { scope: "following", occurrence: original, title: "Synthetic reschedule" }),
    change("task", "create", null, { title: "Checklist", checklist: [{ text: "First item", checked: false }],
      dueDate: "2031-06-16", dueTime: "10:00", dueTimezone: "Europe/Warsaw",
      recurrence: { frequency: "WEEKLY", weekdays: [1, 3] }, reminders: [{ anchor: "TASK_DUE", offsetMinutes: 15 }] }),
    change("dday", "create", null, { title: "Countdown", targetDate: "2031-06-24", recurrence: "YEARLY" }),
    change("event_template", "create", null, { name: "Appointment", startTime: "09:00" }));
  assert.equal(draft.operations[0].values.occurrence.seriesId, event.sourceId);
  assert.match(draft.operations[1].values.reminders[0].id, /^[a-f0-9-]{36}$/i);
  assert.deepEqual(draft.operations[1].values.checklist, [{ text: "First item", checked: false }]);
  for (const operation of [
    change("event", "update", "C1", { scope: "occurrence", occurrence: { ...original, seriesId: event.sourceId } }),
    change("event", "update", "C1", { scope: "following" }),
    change("event", "update", "C1", { scope: "following", occurrence: { ...original, originalStart: "2031-06-16T10:00:00" } }),
    change("event", "update", "C1", { scope: "occurrence", occurrence: { ...original, originalOffset: "+01:00" } }),
    change("event", "update", "C1", { title: "No scope for a known series" }),
    change("event", "update", "C1", { scope: "occurrence", occurrence: original, recurrence: { frequency: "DAILY" } }),
    change("task", "create", null, { title: "Unsafe ID", reminders: [{ anchor: "TASK_DUE", offsetMinutes: 0, id: event.sourceId }] }),
    change("dday", "create", null, { title: "Invalid date", targetDate: "2031-02-30", recurrence: "YEARLY" }),
  ]) await assert.rejects(prepare(delivery, operation));
});

test("Study joins class slots, semesters and milestone parents from the reviewed lookup", async () => {
  const semester = record("study_semester", 1, { title: "Spring 2031" });
  const plan = record("study_plan", 2);
  const delivery = lookup({ records: [semester, plan], writeKinds: [write("study_lecture"), write("study_milestone")] });
  const { draft } = await prepare(delivery,
    change("study_lecture", "create", null, { subject: "Synthetic lecture", semester: "C1", credits: "3.5",
      slots: [{ weekday: 1, start: "09:00", end: "10:00" }] }),
    change("study_milestone", "create", null, { title: "Milestone", planId: "C2" }));
  assert.equal(draft.operations[0].values.semester, semester.title);
  assert.deepEqual(draft.operations[0].references, [{ kind: semester.kind, id: semester.sourceId, revision: semester.revision }]);
  assert.equal(draft.operations[0].values.credits, "3.5");
  assert.equal(draft.operations[1].values.planId, plan.sourceId);
  await assert.rejects(prepare(delivery, change("study_milestone", "create", null, { title: "Milestone", planId: "C1" })), /matching record/);
  await assert.rejects(prepare(delivery, change("study_lecture", "create", null, { subject: "Synthetic lecture", semester: semester.title })), /current Calendar lookup/);
});

test("Project monetary records and fields need the explicit finance scope and canonical decimal strings", async () => {
  const project = record("project", 1);
  const writeKinds = [write("project"), write("project_income"), write("project_expense"), write("project_rate")];
  const unapproved = lookup({ records: [project], writeKinds });
  assert.deepEqual(workspaceDraftTool(unapproved).parameters.properties.operations.items.properties.kind.enum, ["project"]);
  await assert.rejects(prepare(unapproved, change("project_income", "create", null, { gross: "29.20" })), /unavailable/);
  await assert.rejects(prepare(unapproved, change("project", "update", "C1", { currency: "PLN" })), /unsupported field/);

  const approved = lookup({ records: [project], writeKinds, filters: { includeFinancials: true } });
  const { draft } = await prepare(approved,
    change("project_income", "create", null, { projectId: "C1", gross: "29.20", currency: "PLN" }),
    change("project_expense", "create", null, { amount: "18.00", currency: "PLN", category: "Synthetic" }),
    change("project_rate", "create", null, { from: "EUR", to: "PLN", rate: "4.2581" }));
  assert.equal(draft.operations[0].values.projectId, project.sourceId);
  assert.equal(draft.operations[0].values.gross, "29.20");
  await assert.rejects(prepare(approved, change("project_expense", "create", null, { amount: 18 })));
  await assert.rejects(prepare(approved, change("project_rate", "create", null, { from: "EUR", to: "EUR", rate: "1" })), /different currencies/);
});

test("related Calendar, Study and Project links encode native kinds from approved lookups", async () => {
  const note = record("note", 1);
  const event = record("event", 2);
  const study = record("study_session", 3);
  const project = record("project", 4);
  const delivery = lookup({ records: [note, event, study, project], writeKinds: [
    write("note_link", ["link", "unlink"]), write("study_link", ["link", "unlink"]), write("project_link", ["link", "unlink"]),
  ] });
  const { draft } = await prepare(delivery,
    change("note_link", "link", null, { noteId: "C1", targetId: "C2" }),
    change("study_link", "link", null, { source: "C3", target: "C1" }),
    change("project_link", "link", null, { source: "C4", target: "C3" }));
  assert.deepEqual(draft.operations[0].values, { noteId: note.sourceId, targetId: event.sourceId, targetType: "event" });
  assert.deepEqual(draft.operations[1].values, { source: { kind: "SESSION", id: study.sourceId }, target: { kind: "NOTE", id: note.sourceId } });
  assert.deepEqual(draft.operations[2].values, { source: { kind: "PROJECT", id: project.sourceId }, target: { domain: "STUDY", kind: "SESSION", id: study.sourceId } });
  assert.deepEqual(draft.operations[0].references.map(ref => ref.kind), ["event", "note"]);
  assert.deepEqual(draft.operations[1].references.map(ref => ref.kind), ["note", "study_session"]);
  assert.deepEqual(draft.operations[2].references.map(ref => ref.kind), ["project", "study_session"]);
  await assert.rejects(prepare(delivery, change("study_link", "link", null, { source: { kind: "SESSION", id: study.sourceId }, target: "C1" })));
  await assert.rejects(prepare(delivery, change("note_link", "link", null, { noteId: "C1", targetId: "C2", targetType: "task" })));
});

test("rich note writes accept related image metadata only after opt-in and reject model-specified asset URIs", async () => {
  const note = record("note", 1);
  const asset = record("asset", 2, { details: { mediaType: "image/png" } });
  const writeKinds = [write("note"), write("asset")];
  const approving = lookup({ records: [note, asset], writeKinds, filters: { includeAttachmentMetadata: true } });
  const unapproved = lookup({ records: [note, asset], writeKinds });
  const operation = change("note", "update", "C1", { contentHtml: '<h2>Title</h2><p><strong>Text</strong></p><img src="C2" alt="Synthetic">' });
  const { draft } = await prepare(approving, operation);
  const body = draft.operations[0].values.contentHtml;
  assert.match(body, /<strong>Text<\/strong>/);
  assert.ok(body.includes('src="yoofloe-asset://' + asset.sourceId + '"'));
  assert.deepEqual(draft.operations[0].references, [{ kind: asset.kind, id: asset.sourceId, revision: asset.revision }]);
  assert.equal((await readCalendarWorkspaceChangeDraft(draft, validateCalendarWorkspaceOperation)).operations[0].values.contentHtml, body);
  await assert.rejects(prepare(unapproved, operation), /Include attachment metadata/);
  for (const contentHtml of [
    '<img src="yoofloe-asset://' + asset.sourceId + '">',
    '<img src="https://example.invalid/remote-image.png">',
    '<img src="C2" onerror="bad">',
    '<a href="file:///device/path">Path</a>',
    '<script>bad</script>',
  ]) await assert.rejects(prepare(approving, change("note", "update", "C1", { contentHtml })));
  const append = await prepare(unapproved, change("note", "update", "C1", { appendText: "Line one\nLine two" }));
  assert.equal(append.draft.operations[0].values.appendText, "Line one\nLine two");
});

test("To-Do folder writes use native subtype fields and only approved folder parents", async () => {
  const parent = record("task", 1, { title: "Top level", details: { taskFolder: true } });
  const folder = record("task", 2, { title: "List", details: { taskFolder: true } });
  const task = record("task", 3, { title: "Ordinary task", details: { taskFolder: false } });
  const trashed = record("task", 4, { state: "trashed", details: { taskFolder: true } });
  const delivery = lookup({
    records: [parent, folder, task, trashed], writeKinds: [write("task", [...baseActions, "move"])], filters: { includeTrash: true },
  });
  const parentReference = [{ kind: "task", id: parent.sourceId, revision: parent.revision }];
  const { draft } = await prepare(delivery,
    change("task", "create", null, { type: "folder", title: "New list", parentId: "C1", sortOrder: 2 }),
    change("task", "move", "C2", { parentId: "C1", sortOrder: 4 }),
    change("task", "move", "C3", { parentId: "C1", sortOrder: 6 }),
    change("task", "restore", "C4", { parentId: "C1" }));
  assert.deepEqual(draft.operations.map(operation => operation.references), Array.from({ length: 4 }, () => parentReference));
  assert.equal(draft.operations[0].values.type, "folder");
  assert.deepEqual(draft.operations[1].values, { parentId: parent.sourceId, sortOrder: 4 });
  const rename = await prepare(delivery, change("task", "update", "C2", { title: "Renamed list" }));
  assert.equal(rename.draft.operations[0].values.title, "Renamed list");
  const remove = await prepare(delivery, change("task", "delete", "C2"));
  assert.equal(remove.draft.operations[0].values, null);
  const root = await prepare(delivery, change("task", "move", "C2", { parentId: null }));
  assert.equal(root.draft.operations[0].values.parentId, null);
  for (const operation of [
    change("task", "create", null, { type: "folder", title: "Invalid", dueDate: "2031-06-22" }),
    change("task", "update", "C2", { status: "completed" }),
    change("task", "update", "C2", { type: "task" }),
    change("task", "move", "C2", { parentId: "C3" }),
    change("task", "move", "C2", { parentId: trashed.sourceId }),
    change("task", "restore", "C4", { parentId: "C3" }),
  ]) await assert.rejects(prepare(delivery, operation));
});

test("detached events use the authenticated original series and occurrence while pinning the selected row", async () => {
  const series = record("event", 1, { revision: 137 });
  const occurrence = { originalStart: "2031-06-15T10:00:00", timeBasis: "ZONED", timezone: "Europe/Warsaw", originalOffset: "+02:00" };
  const detached = record("event", 2, { title: "Rescheduled occurrence", details: {
    origin: { ...occurrence, seriesId: series.sourceId, seriesRevision: series.revision },
  } });
  const delivery = lookup({ records: [detached], writeKinds: [write("event")] });
  const { draft, titles } = await prepare(delivery, change("event", "update", "C1", { title: "New occurrence title" }));
  const operation = draft.operations[0];
  assert.deepEqual(operation.target, { id: series.sourceId, revision: series.revision });
  assert.deepEqual(operation.values.occurrence, { ...occurrence, seriesId: series.sourceId });
  assert.equal(operation.values.scope, "occurrence");
  assert.deepEqual(operation.references, [{ kind: "event", id: detached.sourceId, revision: detached.revision }]);
  assert.equal(titles[operation.opId], detached.title);
  assert.equal((await readCalendarWorkspaceChangeDraft(draft, validateCalendarWorkspaceOperation)).proposalDigest, draft.proposalDigest);
  const following = await prepare(delivery, change("event", "update", "C1", { scope: "following", title: "This and following" }));
  assert.equal(following.draft.operations[0].values.scope, "following");
  const remove = await prepare(delivery, change("event", "delete", "C1"));
  assert.equal(remove.draft.operations[0].values.occurrence.originalStart, occurrence.originalStart);
  for (const invalid of [
    change("event", "update", "C1", { scope: "series", title: "Needs the original series" }),
    change("event", "update", "C1", { scope: "following", occurrence: { ...occurrence, originalStart: "2031-06-17T10:00:00" } }),
    change("event", "update", "C1", { scope: "occurrence", occurrence: { ...occurrence, seriesId: series.sourceId } }),
    change("event", "update", detached.sourceId, { title: "Raw target" }),
  ]) await assert.rejects(prepare(delivery, invalid));
  const missing = lookup({ records: [series], writeKinds: [write("event")] });
  await assert.rejects(prepare(missing, change("event", "update", "C1", { scope: "occurrence", occurrence, title: "Guessed" })),
    /Look up the selected occurrence/);
  assert.equal((await prepare(missing, change("event", "update", "C1", { title: "One-off update" }))).draft.operations[0].target.id, series.sourceId);
});

test("links to recurrence accept only occurrences supplied by the reviewed series", async () => {
  const occurrence = { originalStart: "2031-06-15", timeBasis: "DATE" };
  const event = record("event", 1, { details: { occurrences: [occurrence] } });
  const note = record("note", 2);
  const project = record("project", 3);
  const delivery = lookup({ records: [event, note, project], writeKinds: [write("note_link", ["link"]), write("project_link", ["link"])] });
  const { draft } = await prepare(delivery,
    change("note_link", "link", null, { noteId: "C2", targetId: "C1", scope: "OCCURRENCE", occurrence }),
    change("project_link", "link", null, { source: "C3", target: { record: "C1", occurrence } }));
  assert.deepEqual(draft.operations[0].values.occurrence, { ...occurrence, seriesId: event.sourceId });
  assert.deepEqual(draft.operations[1].values.target.occurrence, draft.operations[0].values.occurrence);
  await assert.rejects(prepare(delivery, change("note_link", "link", null,
    { noteId: "C2", targetId: "C1", scope: "OCCURRENCE", occurrence: { ...occurrence, originalStart: "2031-06-17" } })), /Look up the selected occurrence/);
  await assert.rejects(prepare(delivery, change("project_link", "link", null,
    { source: "C3", target: { record: "C1", occurrence: { ...occurrence, originalStart: "2031-06-17" } } })), /Look up the selected occurrence/);
});
