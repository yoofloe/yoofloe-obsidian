import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  calendarChangeAad, calendarChangeLaunchUrl, createCalendarChangeDraft, createCalendarChangeRequest,
  openCalendarChangeReply, readCalendarChangeDraft, validateCalendarChangeOperations,
} from "../dist/calendar-change.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/calendar-change-v4.json", import.meta.url), "utf8"));
const { operations } = JSON.parse(fixture.plaintext);
const { datasetId, vaultId, proposalId, proposalDigest } = fixture.request;
const knownDraft = { datasetId, proposalId, proposalDigest, operations };
const encode = text => new TextEncoder().encode(text);
const base64url = value => Buffer.from(value, "base64url");

async function sealFixtureReply(request, plaintext) {
  const iv = new Uint8Array(12).fill(120);
  const raw = new Uint8Array(base64url(request.key));
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: calendarChangeAad(request, "reply") }, key, encode(JSON.stringify(plaintext)));
  return JSON.stringify({ format: "yoofloe.calendar.change.reply", version: 4, requestId: request.requestId,
    iv: Buffer.from(iv).toString("base64url"), ciphertext: Buffer.from(ciphertext).toString("base64url") });
}

test("native-compatible deterministic review and reply authenticate the exact v4 fixture", async () => {
  const draft = await readCalendarChangeDraft(knownDraft);
  const request = fixture.request;
  assert.deepEqual(draft, knownDraft);
  assert.equal(new TextDecoder().decode(calendarChangeAad(request, "request")), fixture.requestAad);
  assert.equal(new TextDecoder().decode(calendarChangeAad(request, "reply")), fixture.replyAad);
  assert.equal(calendarChangeLaunchUrl(request), fixture.launchUrl);
  assert.deepEqual(await openCalendarChangeReply(JSON.stringify(fixture.reply), request, draft, fixture.now), JSON.parse(fixture.replyPlaintext));
});

test("a fresh review encrypts the stable proposal and exposes no data or key in the URL", async () => {
  const draft = await createCalendarChangeDraft(operations, datasetId);
  assert.equal(draft.proposalDigest, fixture.request.proposalDigest);
  const options = { vaultName: "Fixture vault", vaultId, now: fixture.now };
  const request = await createCalendarChangeRequest(draft, options);
  const next = await createCalendarChangeRequest(draft, options);
  for (const field of ["requestId", "nonce", "key", "iv"]) assert.notEqual(request[field], next[field], field);
  const key = await crypto.subtle.importKey("raw", new Uint8Array(base64url(request.key)), "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(base64url(request.iv)), additionalData: calendarChangeAad(request, "request") }, key, new Uint8Array(base64url(request.ciphertext)));
  assert.equal(new TextDecoder().decode(plain), fixture.plaintext);
  const launch = new URL(calendarChangeLaunchUrl(request, "primary:Obsidian/Yoofloe Calendar Inbox"));
  assert.deepEqual(Array.from(launch.searchParams.keys()), ["version", "requestId", "vault", "vaultId", "inbox"]);
  assert(!launch.href.includes(request.key) && !launch.href.includes(request.ciphertext));
});

test("operation schema rejects stale-load bypass, recurrence, duplicates and malformed calendar values", async () => {
  assert.throws(() => validateCalendarChangeOperations(operations, null), /Read the current Calendar records/);
  assert.throws(() => validateCalendarChangeOperations([{ ...operations[0], values: { ...operations[0].values, recurrence: "weekly" } }], null), /unsupported fields/);
  assert.throws(() => validateCalendarChangeOperations([{ ...operations[0], values: { ...operations[0].values, allDay: true, start: "2026-02-30", end: "2026-03-01" } }], null), /ISO dates/);
  assert.throws(() => validateCalendarChangeOperations([{ ...operations[0], values: { ...operations[0].values, start: "2026-11-16T08:00:00Z" } }], null), /end must follow/);
  assert.throws(() => validateCalendarChangeOperations([{ ...operations[1], values: { dueDate: "2026-02-29" } }], datasetId), /due date/);
  assert.throws(() => validateCalendarChangeOperations([operations[1], operations[1]], datasetId), /duplicate change identity/);
  assert.throws(() => validateCalendarChangeOperations([operations[1], { ...operations[1], opId: operations[2].opId }], datasetId), /only once/);
  const allDay = { ...operations[0], values: { ...operations[0].values, allDay: true, start: "2026-11-20", end: "2026-11-21" } };
  assert.deepEqual(validateCalendarChangeOperations([allDay], null), [allDay]);
  await assert.rejects(readCalendarChangeDraft({ ...knownDraft, operations: [allDay] }), /proposal changed/);
});

test("create-only status recovers without guessing the dataset, and undo requires its verified identity", async () => {
  const draft = await createCalendarChangeDraft([operations[0]], null);
  const options = { vaultName: "Fixture vault", vaultId, now: fixture.now };
  const review = await createCalendarChangeRequest(draft, options);
  const status = await createCalendarChangeRequest(draft, { ...options, action: "status" });
  assert.equal(review.datasetId, null);
  assert.equal(status.datasetId, null);
  for (const field of ["proposalId", "proposalDigest"]) assert.equal(status[field], review[field]);
  assert.equal(status.iv, null);
  assert.equal(status.ciphertext, null);
  await assert.rejects(createCalendarChangeRequest(draft, { ...options, action: "undo" }), /which Calendar dataset/);
  const undo = await createCalendarChangeRequest(draft, { ...options, action: "undo", datasetId });
  assert.equal(undo.datasetId, datasetId);
  assert.equal(undo.ciphertext, null);
  await assert.rejects(createCalendarChangeRequest(knownDraft, { ...options, action: "status", datasetId: null }), /does not match/);
});

test("rejects expired, tampered, foreign and mismatched replies, even if a wrong result is authenticated", async () => {
  const expected = JSON.parse(fixture.replyPlaintext);
  const draft = await readCalendarChangeDraft(knownDraft), req = fixture.request;
  const open = (raw, request = req, time = fixture.now) => openCalendarChangeReply(raw, request, draft, time);
  await assert.rejects(open(JSON.stringify(fixture.reply), req, req.expiresAt + 1), /expired/);
  await assert.rejects(open(JSON.stringify(fixture.reply), { ...req, vaultId: "30000000-0000-4000-8000-000000000555" }), /authenticated/);
  const cipher = fixture.reply.ciphertext;
  await assert.rejects(open(JSON.stringify({ ...fixture.reply, ciphertext: (cipher[0] === "A" ? "B" : "A") + cipher.slice(1) })), /authenticated/);
  await assert.rejects(open(await sealFixtureReply(req, { ...expected, results: expected.results.map((row, i) => i === 1 ? { ...row, id: "other-task" } : row) })), /does not match/);
  await assert.rejects(open(await sealFixtureReply(req, { ...expected, status: "cancelled" })), /Invalid Calendar change results/);
  await assert.rejects(open(await sealFixtureReply(req, { ...expected, datasetId: "30000000-0000-4000-8000-000000000555" })), /different Calendar dataset/);
  const conflict = { ...expected, status: "conflict", datasetId: "30000000-0000-4000-8000-000000000555", results: [] };
  assert.deepEqual(await open(await sealFixtureReply(req, conflict)), conflict);
});
