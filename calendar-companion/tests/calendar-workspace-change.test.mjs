import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateCalendarWorkspaceOperation } from "../dist/calendar-workspace-catalog.js";
import { openCalendarChangeReply } from "../dist/calendar-change.js";
import { CalendarWorkspaceChangeSession } from "../dist/calendar-workspace-change-session.js";
import {
  calendarWorkspaceChangeAad, calendarWorkspaceChangeLaunchUrl, createCalendarWorkspaceChangeDraft,
  createCalendarWorkspaceChangeRequest, openCalendarWorkspaceChangeReply, readCalendarWorkspaceChangeDraft,
  validateCalendarWorkspaceChangeOperations,
} from "../dist/calendar-workspace-change.js";

const loadFixture = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const v5 = loadFixture("calendar-workspace-change-v5"), v4 = loadFixture("calendar-change-v4");
const { operations } = JSON.parse(v5.plaintext);
const { datasetId, vaultId, proposalId, proposalDigest } = v5.request;
const knownDraft = { version: 5, datasetId, proposalId, proposalDigest, operations };
const options = { vaultName: "Fixture vault", vaultId, now: v5.now };
const encoder = new TextEncoder(), decoder = new TextDecoder();
const from64 = value => new Uint8Array(Buffer.from(value, "base64url"));
const id = index => `50000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

function fixtureCatalog(operation, activeDataset) {
  if (operation.kind === "event" && ["create", "delete"].includes(operation.action)) return operation;
  if (operation.kind === "task" && operation.action === "update") return operation;
  if (operation.kind === "fixture.note" && operation.action === "patch-rich-text" && activeDataset === datasetId &&
      typeof operation.values?.html === "string") return operation;
  throw Error("The fixture catalog does not allow this operation.");
}

async function sealReply(request, plain) {
  const iv = new Uint8Array(12).fill(115);
  const key = await crypto.subtle.importKey("raw", from64(request.key), "AES-GCM", false, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: calendarWorkspaceChangeAad(request, "reply") }, key, encoder.encode(JSON.stringify(plain)));
  return JSON.stringify({ format: "yoofloe.calendar.change.reply", version: 5, requestId: request.requestId,
    iv: Buffer.from(iv).toString("base64url"), ciphertext: Buffer.from(ciphertext).toString("base64url") });
}

test("uses the agreed v5 bytes, reply and launch without accepting a v4 marker or draft", async () => {
  const draft = await readCalendarWorkspaceChangeDraft(knownDraft, fixtureCatalog);
  assert.deepEqual(draft, knownDraft);
  const request = v5.request;
  assert.equal(decoder.decode(calendarWorkspaceChangeAad(request, "request")), v5.requestAad);
  assert.equal(decoder.decode(calendarWorkspaceChangeAad(request, "reply")), v5.replyAad);
  assert.equal(calendarWorkspaceChangeLaunchUrl(request), v5.launchUrl);
  assert.deepEqual(await openCalendarWorkspaceChangeReply(JSON.stringify(v5.reply), request, draft, v5.now), JSON.parse(v5.replyPlaintext));
  await assert.rejects(openCalendarWorkspaceChangeReply(JSON.stringify(v4.reply), request, draft, v5.now), /No matching Calendar workspace reply/);
  const oldDraft = { datasetId: v4.request.datasetId, proposalId: v4.request.proposalId, proposalDigest: v4.request.proposalDigest, operations: JSON.parse(v4.plaintext).operations };
  await assert.rejects(readCalendarWorkspaceChangeDraft({ ...oldDraft, version: 4 }, fixtureCatalog), /earlier Calendar change protocol/);
  await assert.rejects(readCalendarWorkspaceChangeDraft(oldDraft, fixtureCatalog), /format is not supported/);
  await assert.rejects(openCalendarChangeReply(JSON.stringify(v5.reply), v4.request, oldDraft, v4.now), /No matching Calendar change reply/);
});

test("encrypts extended catalog operations with deep sorted immutable values and stable proposal digests", async () => {
  const raw = {
    opId: id(40), kind: "fixture.note", action: "patch-rich-text", target: { id: "note-native-id", revision: 3 },
    values: { title: "Roadmap", links: [{ label: "Sketch", finished: false }, { ref: { zone: "UTC", day: 2 }, a: [null, 3] }], html: "<p>Rich text</p>" },
  };
  const same = {
    ...raw, values: { html: raw.values.html, links: [{ finished: false, label: "Sketch" }, { a: [null, 3], ref: { day: 2, zone: "UTC" } }], title: raw.values.title },
  };
  const draft = await createCalendarWorkspaceChangeDraft([raw], datasetId, fixtureCatalog);
  assert.equal(draft.proposalDigest, (await createCalendarWorkspaceChangeDraft([same], datasetId, fixtureCatalog)).proposalDigest);
  const before = draft.operations[0].values.links[1].ref.day;
  raw.values.links[1].ref.day = 7;
  assert.equal(draft.operations[0].values.links[1].ref.day, before);
  assert(Object.isFrozen(draft.operations[0].values.links[1].ref));
  const request = await createCalendarWorkspaceChangeRequest(draft, options, fixtureCatalog);
  const key = await crypto.subtle.importKey("raw", from64(request.key), "AES-GCM", false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: from64(request.iv), additionalData: calendarWorkspaceChangeAad(request, "request") }, key, from64(request.ciphertext));
  const decoded = decoder.decode(plaintext);
  assert(decoded.includes('"links":[{"finished":false,"label":"Sketch"},{"a":[null,3],"ref":{"day":2,"zone":"UTC"}}]'));
  const launch = calendarWorkspaceChangeLaunchUrl(request, "primary:Obsidian/Yoofloe Calendar Inbox");
  assert(!launch.includes(request.key) && !launch.includes(request.ciphertext));
  assert.equal(new URL(launch).searchParams.get("version"), "5");
});

test("large rich-text batches up to twelve operations fit while excessive proposals fail closed", async () => {
  const batch = Array.from({ length: 12 }, (_, index) => ({
    opId: id(index + 10), kind: "fixture.note", action: "patch-rich-text", target: { id: `rich-note-${index}`, revision: 1 },
    values: { html: `<p>${"x".repeat(50 * 1024)}</p>` },
  }));
  const draft = await createCalendarWorkspaceChangeDraft(batch, datasetId, fixtureCatalog);
  const request = await createCalendarWorkspaceChangeRequest(draft, options, fixtureCatalog);
  assert.equal(draft.operations.length, 12);
  assert(Buffer.byteLength(JSON.stringify(request)) > 600 * 1024);
  await assert.rejects(createCalendarWorkspaceChangeDraft([...batch, batch[0]], datasetId, fixtureCatalog), /1 to 12/);
  const tooLarge = batch.map(op => ({ ...op, values: { html: "<p>" + "📝".repeat(30000) + "</p>" } }));
  await assert.rejects(createCalendarWorkspaceChangeDraft(tooLarge, datasetId, fixtureCatalog), /too large/);
});

test("leaves domain decisions to the catalog and rejects identity changes, exotic JSON, and duplicate targets", () => {
  assert.throws(() => validateCalendarWorkspaceChangeOperations([{ ...operations[0], action: "unexpected" }], datasetId, fixtureCatalog), /catalog/);
  assert.throws(() => validateCalendarWorkspaceChangeOperations([operations[1]], null, fixtureCatalog), /Read the current Calendar records/);
  assert.throws(() => validateCalendarWorkspaceChangeOperations([operations[1], { ...operations[1], opId: id(43) }], datasetId, fixtureCatalog), /only once/);
  assert.throws(() => validateCalendarWorkspaceChangeOperations([operations[1]], datasetId, op => ({ ...op, target: null })), /changed the identity/);
  const op = { opId: id(42), kind: "fixture.note", action: "patch-rich-text", target: { id: "note", revision: 2 } };
  let getters = 0;
  const unusual = [
    { html: "<p>Test</p>", date: new Date() },
    { html: "<p>Test</p>", count: Infinity },
    { html: "<p>Test</p>", links: Array(1) },
    { html: "<p>Test</p>", get deviceKey() { getters++; return "not a plain data property"; } },
  ];
  for (const values of unusual) assert.throws(() => validateCalendarWorkspaceChangeOperations([{ ...op, values }], datasetId, fixtureCatalog));
  assert.equal(getters, 0);
});

test("v5 review needs an authenticated dataset and status and undo preserve proposal identity", async () => {
  const draft = await createCalendarWorkspaceChangeDraft([operations[0]], null, fixtureCatalog);
  await assert.rejects(createCalendarWorkspaceChangeRequest(draft, options, fixtureCatalog), /Connect to the Calendar dataset/);
  const status = await createCalendarWorkspaceChangeRequest(draft, { ...options, action: "status" }, fixtureCatalog);
  assert.equal(status.datasetId, null);
  assert.equal(status.ciphertext, null);
  assert.equal(status.proposalDigest, draft.proposalDigest);
  assert.equal(status.proposalId, draft.proposalId);
  const bound = await createCalendarWorkspaceChangeDraft([operations[0]], datasetId, fixtureCatalog);
  assert.equal((await createCalendarWorkspaceChangeRequest(bound, options, fixtureCatalog)).datasetId, datasetId);
  await assert.rejects(createCalendarWorkspaceChangeRequest(draft, { ...options, action: "undo" }, fixtureCatalog), /which Calendar dataset/);
  const undo = await createCalendarWorkspaceChangeRequest(draft, { ...options, action: "undo", datasetId }, fixtureCatalog);
  assert.equal(undo.datasetId, datasetId);
  assert.equal(undo.ciphertext, null);
  await assert.rejects(openCalendarWorkspaceChangeReply(JSON.stringify(v5.reply), v5.request, knownDraft, v5.request.expiresAt + 1), /expired/);
});

test("version, direction, vault, dataset and result identity bind authenticated v5 replies", async () => {
  const expected = JSON.parse(v5.replyPlaintext), request = v5.request;
  const open = (raw, marker = request) => openCalendarWorkspaceChangeReply(raw, marker, knownDraft, v5.now);
  await assert.rejects(open(JSON.stringify(v5.reply), { ...request, vaultId: id(3) }), /authenticated/);
  await assert.rejects(open(JSON.stringify(v5.reply), { ...request, action: "status" }), /authenticated/);
  const altered = { ...expected, results: expected.results.map((result, i) => i === 1 ? { ...result, id: "different" } : result) };
  await assert.rejects(open(await sealReply(request, altered)), /does not match/);
  const wrongDataset = { ...expected, datasetId: id(9) };
  await assert.rejects(open(await sealReply(request, wrongDataset)), /different Calendar dataset/);
  const conflict = { ...wrongDataset, status: "conflict", results: [] };
  assert.equal((await open(await sealReply(request, conflict))).status, "conflict", "a different dataset can report a no-effect conflict");
});

const inbox = "Yoofloe Calendar Inbox";
const markerFor = id => `${inbox}/${id}.change.request.json`;
const replyFor = id => `${inbox}/${id}.change.reply.json`;

function localFiles() {
  const files = new Map(), writes = [], waits = [];
  const store = {
    exists: async path => path === inbox || files.has(path),
    mkdir: async () => { assert.fail("inbox is already present"); },
    write: async (path, value) => { writes.push(path); files.set(path, value); },
    read: async path => files.get(path),
    size: async path => files.has(path) ? Buffer.byteLength(files.get(path)) : null,
    remove: async path => files.delete(path),
  };
  const wait = async milliseconds => { waits.push(milliseconds); };
  return { files, writes, waits, store, wait };
}

test("the v5 session verifies a delayed Android marker without rewriting or exposing it, then cleans verified files", async () => {
  const local = localFiles();
  const session = new CalendarWorkspaceChangeSession({
    ...local, vaultName: () => "Fixture vault", allowed: () => true, now: () => v5.now, validate: fixtureCatalog,
  });
  let staleStat = true;
  const original = local.store.size;
  local.store.size = async path => {
    if (staleStat && local.files.has(path)) { staleStat = false; return 0; }
    return original(path);
  };
  const launch = new URL(await session.start(knownDraft, { vaultId }));
  const marker = markerFor(session.requestId);
  assert.equal(launch.searchParams.get("requestId"), session.requestId);
  assert.equal(launch.searchParams.get("version"), "5");
  assert.deepEqual(local.waits, [50]);
  assert.deepEqual(local.writes, [marker]);
  const request = JSON.parse(local.files.get(marker));
  assert(!launch.href.includes(request.key));
  const acknowledged = { ...JSON.parse(v5.replyPlaintext), requestId: request.requestId };
  const reply = replyFor(session.requestId);
  local.files.set(reply, JSON.stringify(v4.reply));
  await assert.rejects(session.receive(session.requestId), /No matching Calendar workspace reply/);
  assert.equal(local.files.size, 2);
  local.files.set(reply, await sealReply(request, acknowledged));
  local.files.set(markerFor(v4.request.requestId), "V4 data");
  assert.deepEqual(await session.receive(session.requestId), acknowledged);
  assert.deepEqual([...local.files], [[markerFor(v4.request.requestId), "V4 data"]]);
  assert.equal(session.requestId, null);
});

test("a lost v5 reply can be checked through a fresh status marker without resending the proposal", async () => {
  const local = localFiles();
  const session = new CalendarWorkspaceChangeSession({
    ...local, vaultName: () => "Fixture vault", allowed: () => true, now: () => v5.now, validate: fixtureCatalog,
  });
  await session.start(knownDraft, { vaultId });
  const originalId = session.requestId;
  await assert.rejects(session.receive(originalId), /No Calendar reply yet/);
  await session.cancel();
  assert.equal(local.files.size, 0);
  await session.start(knownDraft, { vaultId, action: "status" });
  const status = JSON.parse(local.files.get(markerFor(session.requestId)));
  assert.notEqual(originalId, status.requestId);
  assert.equal(status.proposalId, proposalId);
  assert.equal(status.proposalDigest, proposalDigest);
  assert.equal(status.action, "status");
  assert.equal(status.iv, null);
  assert.equal(status.ciphertext, null);
  // Ending one vault's local session does not remove data from another vault.
  local.files.set(markerFor(session.requestId), "other data");
  await session.dispose();
  assert.deepEqual([...local.files.values()], ["other data"]);
});

test("dependency revisions are sorted, immutable and part of the authenticated proposal", async () => {
  const op = operations[1];
  const references = [{ kind: "note_folder", id: id(53), revision: 3 }, { kind: "asset", id: id(54), revision: 4 }];
  const draft = await createCalendarWorkspaceChangeDraft([{ ...op, references }], datasetId, fixtureCatalog);
  const reordered = await createCalendarWorkspaceChangeDraft([{ ...op, references: [...references].reverse() }], datasetId, fixtureCatalog);
  assert.deepEqual(draft.operations[0].references, [...references].reverse());
  assert.equal(draft.proposalDigest, reordered.proposalDigest);
  assert.notEqual(draft.proposalDigest, (await createCalendarWorkspaceChangeDraft([op], datasetId, fixtureCatalog)).proposalDigest);
  references[0].revision = 8;
  assert.equal(draft.operations[0].references[1].revision, 3);
  assert(Object.isFrozen(draft.operations[0].references));
  assert(Object.isFrozen(draft.operations[0].references[0]));
  const modified = { ...draft, operations: [{ ...op, references }] };
  await assert.rejects(readCalendarWorkspaceChangeDraft(modified, fixtureCatalog), /proposal changed/);
  assert.throws(() => validateCalendarWorkspaceChangeOperations(draft.operations, datasetId, operation => ({
    ...operation, references,
  })), /changed the identity/);

  const valid = references[0];
  for (const invalid of [
    [valid, valid], [valid, { ...valid, revision: valid.revision + 1 }],
    [{ ...valid, kind: "unregistered_kind" }], [{ ...valid, id: "a".repeat(1001) }],
    [{ ...valid, revision: 0 }], [{ ...valid, revision: Number.MAX_SAFE_INTEGER + 1 }],
    [{ kind: op.kind, ...op.target }],
    [,,],
    Array.from({ length: 13 }, (_, index) => ({ ...valid, id: id(index) })),
  ]) assert.throws(() => validateCalendarWorkspaceChangeOperations([{ ...op, references: invalid }], datasetId, fixtureCatalog));
  assert.throws(() => validateCalendarWorkspaceChangeOperations([{ ...operations[0], references: [valid] }], null, fixtureCatalog),
    /Look up the related Calendar records/);
});

test("manual transfer exports the owned marker and authenticates an exact reply without adopting an inbox file", async () => {
  const local = localFiles();
  const owner = { synthetic: "owner" };
  let vault = "Fixture vault", identity = owner, allowed = true, now = v5.now;
  const session = new CalendarWorkspaceChangeSession({
    ...local, vaultName: () => vault, vaultIdentity: () => identity, allowed: () => allowed, now: () => now, validate: fixtureCatalog,
  });
  assert.equal(session.exportPending(), null);
  await session.start(knownDraft, { vaultId, action: "review" });
  assert.equal(session.action, "review");
  const requestId = session.requestId;
  const markerPath = markerFor(requestId), replyPath = replyFor(requestId);
  const exported = session.exportPending();
  assert.equal(exported.name, requestId + ".change.request.json");
  assert.equal(exported.contents, local.files.get(markerPath));
  const request = JSON.parse(exported.contents);
  const expected = { ...JSON.parse(v5.replyPlaintext), requestId };
  const reply = { name: requestId + ".change.reply.json", contents: await sealReply(request, expected) };

  // The inbox file is unrelated to this manual import, even when its filename matches.
  local.files.set(replyPath, reply.contents);
  const inboxAccess = [];
  const size = local.store.size;
  const read = local.store.read;
  local.store.size = async path => { inboxAccess.push(path); return size(path); };
  local.store.read = async path => { inboxAccess.push(path); return read(path); };
  vault = "Other vault";
  assert.equal(session.exportPending(), null);
  await assert.rejects(session.receive(requestId, reply), /vault session changed/);
  vault = "Fixture vault";
  identity = { synthetic: "different vault with the same name" };
  assert.equal(session.exportPending(), null);
  await assert.rejects(session.receive(requestId, reply), /vault session changed/);
  identity = owner;
  allowed = false;
  assert.equal(session.exportPending(), null);
  allowed = true;
  now = request.expiresAt + 1;
  assert.equal(session.exportPending(), null);
  await assert.rejects(session.receive(requestId, reply), /expired/);
  now = v5.now;
  for (const wrong of [
    { ...reply, name: "somewhere/" + reply.name },
    { ...reply, name: id(89) + ".change.reply.json" },
    { ...reply, name: exported.name },
  ]) await assert.rejects(session.receive(requestId, wrong), /Choose the reply file/);
  await assert.rejects(session.receive(requestId, { ...reply, contents: "" }), /empty or too large/);
  await assert.rejects(session.receive(requestId, { ...reply, contents: "x".repeat(2 * 1024 * 1024 + 1) }), /too large/);
  const altered = JSON.parse(reply.contents);
  altered.ciphertext = (altered.ciphertext[0] === "A" ? "B" : "A") + altered.ciphertext.slice(1);
  await assert.rejects(session.receive(requestId, { ...reply, contents: JSON.stringify(altered) }), /authenticated/);
  assert(local.files.has(markerPath));
  assert.deepEqual(inboxAccess, []);

  assert.deepEqual(await session.receive(requestId, reply), expected);
  assert.deepEqual(inboxAccess, [markerPath, markerPath]);
  assert.deepEqual([...local.files], [[replyPath, reply.contents]]);
  assert.deepEqual(local.writes, [markerPath]);
  assert.equal(session.exportPending(), null);
  assert.equal(session.requestId, null);
});

test("v5 reference interop fixture authenticates a rich note, approved image and destination folder", async () => {
  const fixture = loadFixture("calendar-workspace-change-references-v5");
  const request = fixture.request;
  const { operations } = JSON.parse(fixture.plaintext);
  const draft = await readCalendarWorkspaceChangeDraft({
    version: 5, proposalId: request.proposalId, proposalDigest: request.proposalDigest, datasetId: request.datasetId, operations,
  }, validateCalendarWorkspaceOperation);
  assert.deepEqual(draft.operations[0].references.map(reference => reference.kind), ["asset", "note_folder"]);
  const key = await crypto.subtle.importKey("raw", from64(request.key), "AES-GCM", false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: from64(request.iv), additionalData: calendarWorkspaceChangeAad(request, "request") },
    key, from64(request.ciphertext),
  );
  assert.equal(decoder.decode(plaintext), fixture.plaintext);
  const reply = await openCalendarWorkspaceChangeReply(JSON.stringify(fixture.reply), request, draft, fixture.now);
  assert.deepEqual(reply, JSON.parse(fixture.replyPlaintext));
});
