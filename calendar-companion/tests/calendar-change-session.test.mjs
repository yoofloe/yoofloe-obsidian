import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { calendarChangeAad, readCalendarChangeDraft } from "../dist/calendar-change.js";
import { CalendarChangeSession } from "../dist/calendar-change-session.js";

const data = JSON.parse(readFileSync(new URL("./fixtures/calendar-change-v4.json", import.meta.url), "utf8"));
const { datasetId, proposalId, proposalDigest, vaultId } = data.request;
const draft = await readCalendarChangeDraft({ datasetId, proposalId, proposalDigest, operations: JSON.parse(data.plaintext).operations });
const root = "Yoofloe Calendar Inbox";
const requestPath = id => `${root}/${id}.change.request.json`;
const replyPath = id => `${root}/${id}.change.reply.json`;

async function replyTo(request, status = "applied") {
  const { version, requestId, datasetId, proposalId, proposalDigest } = request;
  const results = status === "applied" ? JSON.parse(data.replyPlaintext).results : [];
  const bytes = new TextEncoder().encode(JSON.stringify({ version, requestId, datasetId, proposalId, proposalDigest, status, results }));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", new Uint8Array(Buffer.from(request.key, "base64url")), "AES-GCM", false, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: calendarChangeAad(request, "reply") }, key, bytes);
  return JSON.stringify({ format: "yoofloe.calendar.change.reply", version, requestId, iv: Buffer.from(iv).toString("base64url"), ciphertext: Buffer.from(ciphertext).toString("base64url") });
}

function memoryStore() {
  const files = new Map(), dirs = new Set(), calls = [];
  const store = {
    exists: async path => { calls.push("exists"); return files.has(path) || dirs.has(path); },
    mkdir: async path => { calls.push("mkdir"); dirs.add(path); },
    write: async (path, text) => { calls.push("write"); files.set(path, text); },
    read: async path => { calls.push("read"); return files.get(path); },
    size: async path => { calls.push("size"); return files.has(path) ? Buffer.byteLength(files.get(path), "utf8") : null; },
    remove: async path => { calls.push("remove"); files.delete(path); },
  };
  return { store, files, calls };
}

test("one launch marker, authenticated matching reply, and bounded owned cleanup", async () => {
  const { store, files, calls } = memoryStore();
  const session = new CalendarChangeSession({ store, vaultName: () => "Fixture vault", allowed: () => true, now: () => data.now });
  assert.deepEqual(calls, []);
  const launch = new URL(await session.start(draft, { vaultId }));
  const id = launch.searchParams.get("requestId");
  assert.equal(id, session.requestId);
  const request = JSON.parse(files.get(requestPath(id)));
  assert.equal(request.proposalId, proposalId);
  assert.equal(request.action, "review");
  assert(!launch.href.includes(request.key));
  assert.equal(files.size, 1);
  await assert.rejects(session.receive("ignored"), /No matching pending/);
  await assert.rejects(session.receive(id), /No Calendar reply yet/);
  assert.equal(session.requestId, id);
  files.set(replyPath(id), await replyTo(request));
  files.set(`${root}/other.request.json`, "older read transfer");
  const verified = await session.receive(id);
  assert.equal(verified.status, "applied");
  assert.deepEqual([...files.entries()], [[`${root}/other.request.json`, "older read transfer"]]);
  assert.equal(session.requestId, null);
});

test("ignores bad replies and keeps independently changed files when ending a local transfer", async () => {
  const { store, files } = memoryStore();
  const session = new CalendarChangeSession({ store, vaultName: () => "Fixture vault", allowed: () => true, now: () => data.now });
  await session.start(draft, { vaultId });
  const id = session.requestId;
  files.set(replyPath(id), "unverified data");
  await assert.rejects(session.receive(id), /incomplete or invalid/);
  assert.equal(files.size, 2);
  files.set(requestPath(id), "replaced marker");
  await session.cancel();
  assert.equal(files.get(requestPath(id)), "replaced marker");
  assert.equal(files.get(replyPath(id)), "unverified data");
  assert.equal(session.requestId, null);
});

test("waits for Android to expose the written marker without another write", async () => {
  const { store, calls } = memoryStore();
  const size = store.size;
  let stale = 2;
  const delays = [];
  store.size = async path => stale-- > 0 ? null : size(path);
  const session = new CalendarChangeSession({ store, vaultName: () => "Fixture vault", allowed: () => true,
    now: () => data.now, wait: async delay => { delays.push(delay); } });
  const launch = new URL(await session.start(draft, { vaultId, action: "undo" }));
  assert.equal(launch.searchParams.get("requestId"), session.requestId);
  assert.deepEqual(delays, [50, 150]);
  assert.equal(calls.filter(call => call === "write").length, 1);
  assert.equal(calls.filter(call => call === "read").length, 1);
});

test("cannot launch, consume, or clean a transfer after switching vaults during file IO", async () => {
  const { store, files } = memoryStore();
  let vault = "Fixture vault";
  const original = store.write;
  store.write = async (path, text) => { await original(path, text); vault = "Other vault"; };
  const session = new CalendarChangeSession({ store, vaultName: () => vault, allowed: () => true, now: () => data.now });
  await assert.rejects(session.start(draft, { vaultId }), /vault session changed/);
  assert.equal(session.requestId, null);
  assert.equal(files.size, 1, "must not delete the prior vault's files from another vault's session");
});
