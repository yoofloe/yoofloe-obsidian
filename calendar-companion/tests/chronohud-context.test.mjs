import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createCipheriv } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CHRONOHUD_AREAS, CHRONOHUD_INBOX, CHRONOHUD_REPLY_BYTES,
  chronohudAad, chronohudCallbackUrl, chronohudExcerptReference, chronohudLaunchUrl, chronohudSearchTerms,
  openChronoHudReply, validateChronoHudQuery,
} from "../dist/chronohud-protocol.js";
import { ChronoHudLookupSession } from "../dist/chronohud-lookup-session.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/chronohud-context-v1.json", import.meta.url), "utf8"));
const { now, request: original } = fixture;
const plaintext = JSON.parse(fixture.plaintext);
const b64 = bytes => Buffer.from(bytes).toString("base64url");
const requestPath = id => CHRONOHUD_INBOX + "/" + id + ".request.json";
const replyPath = id => CHRONOHUD_INBOX + "/" + id + ".reply.json";

function replyTo(request, patch = {}) {
  const data = { ...plaintext, requestId: request.requestId, query: request.query, ...patch };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(request.key, "base64url"), iv);
  cipher.setAAD(chronohudAad(request));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final(), cipher.getAuthTag()]);
  return JSON.stringify({ format: "yoofloe.chronohud.reply", version: 1, requestId: request.requestId, iv: b64(iv), ciphertext: b64(ciphertext) });
}

function memoryStore() {
  const files = new Map(), folders = new Set(), calls = [];
  const store = {
    exists: async path => { calls.push(["exists", path]); return files.has(path) || folders.has(path); },
    mkdir: async path => { calls.push(["mkdir", path]); folders.add(path); },
    write: async (path, value) => { calls.push(["write", path]); files.set(path, value); },
    read: async path => { calls.push(["read", path]); return files.get(path); },
    size: async path => { calls.push(["size", path]); return files.has(path) ? Buffer.byteLength(files.get(path), "utf8") : null; },
    remove: async path => { calls.push(["remove", path]); files.delete(path); },
  };
  return { store, files, calls };
}
function makeSession(store, overrides = {}) {
  return new ChronoHudLookupSession({
    store, vaultName: () => "Fixture vault \uD55C", allowed: () => true, now: () => now,
    wait: async () => {}, ...overrides,
  });
}
async function start(session, files, query = original.query) {
  const launch = new URL(await session.start({ query, vaultId: original.vaultId, inboxHint: "Fixture vault/ChronoHUD Inbox" }));
  const id = launch.searchParams.get("requestId");
  return { launch, id, request: JSON.parse(files.get(requestPath(id))) };
}

test("opens the deterministic shared v1 fixture using the exact routes, AAD, and read-only schema", async () => {
  assert.equal(Buffer.from(chronohudAad(original)).toString("utf8"), fixture.requestAad);
  assert.equal(chronohudLaunchUrl(original), fixture.launchUrl);
  assert.equal(chronohudCallbackUrl(original.requestId), fixture.callbackUrl);
  const raw = JSON.stringify(fixture.reply);
  const actual = await openChronoHudReply(raw, original, now);
  assert.deepEqual(actual, plaintext);
  assert.deepEqual(actual.records.map(record => record.area), CHRONOHUD_AREAS);
  assert.equal(chronohudExcerptReference(0), "H1");
  assert.equal(chronohudExcerptReference(3), "H4");
  assert.throws(() => { actual.records[0].text = "Changed after review"; }, TypeError);
  for (const patch of [
    { vault: b64("different vault") }, { vaultId: original.requestId },
    { nonce: b64(Buffer.alloc(32, 3)) }, { key: b64(Buffer.alloc(32, 4)) },
  ]) await assert.rejects(openChronoHudReply(raw, { ...original, ...patch }, now));
});

test("preserves exact Unicode terms and enforces byte, count, and area limits", () => {
  assert.deepEqual(chronohudSearchTerms("\u0106wiczenie, C\u0301WICZENIE\n \uACC4\uD68D"), original.query.terms);
  const snapshot = validateChronoHudQuery({ ...original.query, terms: [] });
  assert.deepEqual(snapshot.terms, []);
  const terms = ["\uD55C".repeat(26) + "ab"];
  assert.equal(Buffer.byteLength(terms[0], "utf8"), 80);
  const validated = validateChronoHudQuery({ ...original.query, terms, maxRecords: 20, maxTextBytes: 32768 });
  terms[0] = "Changed after approval";
  assert.notEqual(validated.terms[0], terms[0]);
  for (const patch of [
    { areas: [] }, { areas: ["timeline", "timeline"] }, { areas: ["calendar"] }, { areas: Array(1) },
    { terms: ["uppercase\uD800"] }, { terms: [" A"] }, { terms: ["c\u0301wiczenie"] }, { terms: [""] },
    { terms: ["same", "same"] }, { terms: Array(9).fill("term") }, { terms: ["\uD55C".repeat(27)] },
    { terms: ["nul\0byte"] }, { maxRecords: 0 }, { maxRecords: 21 }, { maxTextBytes: 32769 },
    { write: true }, { "areas|terms": [] },
  ]) assert.throws(() => validateChronoHudQuery({ ...original.query, ...patch }));
});

test("rejects unknown reply headers, malformed encodings, corrupted ciphertext, and oversized wrappers", async () => {
  const { iv, ciphertext } = fixture.reply;
  const altered = (ciphertext[0] === "A" ? "B" : "A") + ciphertext.slice(1);
  for (const patch of [
    { requestId: original.vaultId }, { version: 5 }, { format: "yoofloe.calendar.reply" },
    { iv: iv + "=" }, { iv: b64(Buffer.alloc(11)) }, { ciphertext: altered }, { ciphertext: "eA" }, { filename: "reply" },
  ]) await assert.rejects(openChronoHudReply(JSON.stringify({ ...fixture.reply, ...patch }), original, now));
  await assert.rejects(openChronoHudReply("\uD55C".repeat(CHRONOHUD_REPLY_BYTES / 2), original, now), /too large/);
  await assert.rejects(openChronoHudReply("x".repeat(CHRONOHUD_REPLY_BYTES + 1), original, now), /too large/);
});

test("rejects sealed replies whose exact scopes, coverage, civil dates, or text budgets differ", async () => {
  const record = plaintext.records[0];
  const context = plaintext.context;
  for (const patch of [
    { query: { ...original.query, terms: ["changed"] } },
    { query: { ...original.query, areas: [...original.query.areas].reverse() } },
    { query: { ...original.query, maxRecords: 7 } },
    { records: Array(7).fill(record) },
    { records: [{ ...record, area: "notes" }] },
    { records: [{ ...record, privateAnchor: "not a public field" }] },
    { records: [{ ...record, title: "x".repeat(2049) }] },
    { records: [{ ...record, title: "line\nbreak" }] },
    { records: [{ ...record, text: "\0not plain text" }] },
    { records: [{ ...record, date: "2031-02-29" }] },
    { context: { ...context, zone: "Not/A_Time_Zone" } },
    { context: { ...context, matched: 3 } },
    { context: { ...context, matched: 10 } },
    { context: { ...context, scanned: Number.MAX_SAFE_INTEGER + 1 } },
    { context: { ...context, partial: false } },
  ]) await assert.rejects(openChronoHudReply(replyTo(original, patch), original, now));

  const selected = { ...original, query: { ...original.query, areas: ["timeline"], maxTextBytes: 7 } };
  const timeline = { ...plaintext.records[1], text: "\uD55C\uD55C" };
  await assert.rejects(openChronoHudReply(replyTo(selected, { records: [record] }), selected, now), /outside the selected scope/);
  await assert.rejects(openChronoHudReply(replyTo(selected, { records: [timeline, { ...timeline, text: "ab" }] }), selected, now), /excerpt budget/);
  const exact = await openChronoHudReply(replyTo(selected, { records: [{ ...timeline, text: timeline.text + "a" }] }), selected, now);
  assert.equal(Buffer.byteLength(exact.records[0].text, "utf8"), 7);

  const empty = await openChronoHudReply(replyTo(original, {
    context: { ...context, matched: 0, partial: true }, records: [],
  }), original, now);
  assert.deepEqual(empty.records, []);
});

test("checks export time against its original window and distinguishes Desktop clock skew", async () => {
  const later = now + 80_000;
  const raw = replyTo(original, { exportedAt: later });
  await assert.rejects(openChronoHudReply(raw, original, now), /export time/);
  assert.equal((await openChronoHudReply(raw, original, now, true)).exportedAt, later);
  for (const exportedAt of [original.createdAt - 1, original.expiresAt + 1, 1.25])
    await assert.rejects(openChronoHudReply(replyTo(original, { exportedAt }), original, now, true), /export time/);
  await assert.rejects(openChronoHudReply(raw, original, original.expiresAt + 1, true), /expired/);
});

test("writes one marker after user action, reads exact reply files, and prevents replay", async () => {
  const { store, files, calls } = memoryStore();
  const calendar = "Yoofloe Calendar Inbox/" + original.requestId + ".request.json";
  files.set(calendar, "Calendar is independent");
  files.set(replyPath(original.requestId), "Unrelated ChronoHUD file");
  let stale = 2;
  const delays = [];
  const size = store.size;
  store.size = async path => {
    const result = await size(path);
    return path.endsWith(".request.json") && stale-- > 0 ? null : result;
  };
  const session = makeSession(store, { wait: async delay => { delays.push(delay); } });
  assert.deepEqual(calls, []);
  await assert.rejects(session.start({ vaultId: original.vaultId, query: { ...original.query, areas: [] } }), /ChronoHUD area/);
  assert.deepEqual(calls, []);
  const { launch, id, request } = await start(session, files);
  assert.equal(session.requestId, id);
  assert.equal(session.expiresAt, now + 600_000);
  assert.deepEqual(Object.keys(request), Object.keys(original));
  assert.equal(Buffer.from(request.key, "base64url").length, 32);
  assert.equal(Buffer.from(request.nonce, "base64url").length, 32);
  assert.deepEqual([...launch.searchParams.keys()], ["version", "requestId", "vault", "vaultId", "inbox"]);
  assert.equal(launch.searchParams.get("inbox"), b64("Fixture vault/ChronoHUD Inbox"));
  assert.deepEqual(delays, [50, 150]);
  assert.equal(calls.filter(([op]) => op === "write").length, 1);

  const before = calls.length;
  await assert.rejects(session.receive(original.requestId), /No matching pending ChronoHUD lookup/);
  assert.equal(calls.length, before);
  await assert.rejects(session.receive(id), /No ChronoHUD reply yet/);
  files.set(replyPath(id), replyTo(request));
  const delivery = await session.receive(id);
  assert.equal(delivery.records.length, 4);
  assert.deepEqual([...files.keys()], [calendar, replyPath(original.requestId)]);
  assert.doesNotThrow(() => session.assertCanUse(delivery));
  assert.throws(() => session.assertCanUse({ ...delivery }), /Review a current ChronoHUD lookup/);
  await assert.rejects(session.receive(id), /No matching pending ChronoHUD lookup/);
  await session.cancel();
  assert.equal(session.requestId, null);
  assert.throws(() => session.assertCanUse(delivery), /Review a current ChronoHUD lookup/);
});

test("preserves a failed reply, and never removes a similarly named replacement", async () => {
  const { store, files, calls } = memoryStore();
  const session = makeSession(store);
  const { id, request } = await start(session, files);
  const marker = requestPath(id), path = replyPath(id);
  const rejected = replyTo(request, { query: { ...request.query, terms: ["changed"] } });
  files.set(path, rejected);
  await assert.rejects(session.receive(id), /could not be verified/);
  assert.equal(files.get(path), rejected);
  assert.ok(session.exportPending());

  const authentic = replyTo(request);
  const replacementMarker = files.get(marker).replace("chronohud.request", "Chronohud.request");
  const replacementReply = authentic.replace("chronohud.reply", "Chronohud.reply");
  files.set(marker, replacementMarker);
  files.set(path, authentic);
  const read = store.read;
  store.read = async name => {
    const value = await read(name);
    if (name === path) files.set(name, replacementReply);
    return value;
  };
  const accepted = await session.receive(id);
  assert.equal(accepted.records.length, 4);
  assert.deepEqual([...files.entries()], [[marker, replacementMarker], [path, replacementReply]]);
  assert(!calls.some(([op]) => op === "remove"));
});

test("Desktop uses exact filenames, bounded input, and never cleans a vault reply it did not read", async () => {
  const { store, files, calls } = memoryStore();
  const session = makeSession(store);
  const { id, request } = await start(session, files);
  const name = id + ".reply.json";
  const raw = replyTo(request, { exportedAt: now + 80_000 });
  const marker = session.exportPending();
  assert.deepEqual(marker, { name: id + ".request.json", contents: files.get(requestPath(id)) });
  files.set(replyPath(id), raw);
  const before = calls.length;
  await assert.rejects(session.receive(id, { name: "../" + name, contents: raw }), /Choose the ChronoHUD reply file/);
  await assert.rejects(session.receive(id, { name, contents: "\uD55C".repeat(100_000) }), /empty or too large/);
  assert.equal(calls.length, before);
  const accepted = await session.receive(id, { name, contents: raw });
  assert.equal(accepted.exportedAt, now + 80_000);
  assert.deepEqual(calls.slice(before), [["size", requestPath(id)], ["read", requestPath(id)], ["remove", requestPath(id)]]);
  assert.deepEqual([...files.entries()], [[replyPath(id), raw]]);
  assert.equal(session.exportPending(), null);
});

test("blocks oversized same-vault replies before reading their contents", async () => {
  const { store, files, calls } = memoryStore();
  const session = makeSession(store);
  const { id } = await start(session, files);
  files.set(replyPath(id), "x".repeat(CHRONOHUD_REPLY_BYTES + 1));
  const before = calls.length;
  await assert.rejects(session.receive(id), /empty or too large/);
  assert.deepEqual(calls.slice(before), [["size", replyPath(id)]]);
  await session.cancel();
  assert(files.has(replyPath(id)));
});

test("detects a same-name vault switch during an asynchronous receipt and does not touch the new vault", async () => {
  const { store, files, calls } = memoryStore();
  let owner = {};
  const session = makeSession(store, { vaultIdentity: () => owner, canClean: () => true });
  const { id, request } = await start(session, files);
  files.set(replyPath(id), replyTo(request));
  const size = store.size;
  store.size = async path => {
    const result = await size(path);
    if (path === replyPath(id)) owner = {};
    return result;
  };
  const before = calls.length;
  await assert.rejects(session.receive(id), /vault session changed/);
  assert.deepEqual(calls.slice(before), [["size", replyPath(id)]]);
  assert.equal(files.size, 2);
});

test("disposal during a marker write cleans the exact owned file; approval and expiry are checked again after receipt", async () => {
  const { store, files, calls } = memoryStore();
  const duringWrite = makeSession(store, { canClean: () => true });
  const write = store.write;
  store.write = async (path, data) => {
    await write(path, data);
    await duringWrite.dispose();
  };
  await assert.rejects(duringWrite.start({ query: original.query, vaultId: original.vaultId }), /vault session changed/);
  assert.equal(files.size, 0);
  assert.equal(calls.filter(([op]) => op === "write").length, 1);
  store.write = write;

  for (const end of ["expired", "revoked"]) {
    let allowed = true, clock = now;
    const session = makeSession(store, { allowed: () => allowed, now: () => clock });
    const { id, request } = await start(session, files);
    files.set(replyPath(id), replyTo(request));
    const delivery = await session.receive(id);
    if (end === "expired") clock = request.expiresAt + 1;
    else allowed = false;
    const before = calls.length;
    assert.throws(() => session.assertCanUse(delivery), /expired|vault session changed/);
    assert.equal(calls.length, before);
    await session.dispose();
  }
});
