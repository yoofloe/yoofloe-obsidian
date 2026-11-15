import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CalendarWorkspaceLookupSession } from "../dist/calendar-workspace-lookup-session.js";
import { emptyWorkspaceFilters, openWorkspaceLookupReply, workspaceQueryAad, workspaceQueryLaunchUrl } from "../dist/calendar-workspace-query.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/calendar-workspace-lookup-v5.json", import.meta.url), "utf8"));
const { now, request: original } = fixture;
const plaintext = JSON.parse(fixture.plaintext);
const root = "Yoofloe Calendar Inbox";
const requestPath = id => root + "/" + id + ".request.json";
const replyPath = id => root + "/" + id + ".reply.json";

function memoryStore() {
  const files = new Map(), folders = new Set(), calls = [];
  const store = {
    exists: async path => { calls.push(["exists", path]); return files.has(path) || folders.has(path); },
    mkdir: async path => { calls.push(["mkdir", path]); folders.add(path); },
    write: async (path, text) => { calls.push(["write", path]); files.set(path, text); },
    read: async path => { calls.push(["read", path]); return files.get(path); },
    size: async path => { calls.push(["size", path]); return files.has(path) ? Buffer.byteLength(files.get(path), "utf8") : null; },
    remove: async path => { calls.push(["remove", path]); files.delete(path); },
  };
  return { store, files, calls };
}

function makeSession(store, overrides = {}) {
  return new CalendarWorkspaceLookupSession({
    store, vaultName: () => "Fixture vault", allowed: () => true, now: () => now,
    wait: async () => {}, ...overrides,
  });
}

async function replyTo(request, patch = {}) {
  const data = { ...plaintext, requestId: request.requestId, query: request.query, ...patch };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", new Uint8Array(Buffer.from(request.key, "base64url")), "AES-GCM", false, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: workspaceQueryAad(request) }, key,
    new TextEncoder().encode(JSON.stringify(data)));
  return JSON.stringify({ format: "yoofloe.calendar.reply", version: 5, requestId: request.requestId,
    iv: Buffer.from(iv).toString("base64url"), ciphertext: Buffer.from(ciphertext).toString("base64url") });
}

async function start(session, files, query = original.query) {
  const launch = new URL(await session.start({ vaultId: original.vaultId, query, inboxHint: "path hint" }));
  const id = launch.searchParams.get("requestId");
  return { launch, id, request: JSON.parse(files.get(requestPath(id))) };
}

test("reads the deterministic v5 fixture with exact AAD, scoped metadata, and advertised capabilities", async () => {
  assert.equal(new TextDecoder().decode(workspaceQueryAad(original)), fixture.requestAad);
  assert.equal(workspaceQueryLaunchUrl(original), fixture.launchUrl);
  const result = await openWorkspaceLookupReply(JSON.stringify(fixture.reply), original, now);
  assert.deepEqual(result, plaintext);
  assert.equal(result.records[0].details.intervals[0].startAt, "2031-06-03T08:30+02:00");
  assert.deepEqual(result.records[3].details.tags, ["Środowisko"]);
  assert.ok(result.capabilities.writeKinds.some(record => record.kind === "project_stage"));
  await assert.rejects(openWorkspaceLookupReply(JSON.stringify(fixture.reply), { ...original, vaultId: original.requestId }, now));
});

test("verifies a Unicode marker once, consumes an authenticated reply, and rechecks an exact delivery", async () => {
  const { store, files, calls } = memoryStore();
  let stale = 2;
  const delays = [];
  const size = store.size;
  store.size = async path => {
    const value = await size(path);
    return path.endsWith(".request.json") && stale-- > 0 ? null : value;
  };
  const session = makeSession(store, { wait: async delay => { delays.push(delay); } });
  assert.deepEqual(calls, []);
  const lookup = { ...original.query.lookup, terms: ["쪽", "środowisko"] };
  const { launch, id, request } = await start(session, files, { ...original.query, lookup });
  assert.equal(id, session.requestId);
  assert.equal(session.expiresAt, request.expiresAt);
  assert.equal(launch.searchParams.get("version"), "5");
  assert.equal(launch.searchParams.get("vaultId"), original.vaultId);
  assert.deepEqual(delays, [50, 150]);
  assert.equal(calls.filter(([method]) => method === "write").length, 1);
  for (const privateValue of [request.key, request.nonce, "środowisko"]) assert(!launch.href.includes(privateValue));
  const wrong = calls.length;
  await assert.rejects(session.receive(original.requestId), /No matching pending Calendar lookup/);
  assert.equal(calls.length, wrong);
  await assert.rejects(session.receive(id), /No Calendar reply yet/);

  files.set(replyPath(id), await replyTo(request, { context: { ...plaintext.context, scope: lookup } }));
  files.set(requestPath(original.requestId), "fixture v3 request");
  const result = await session.receive(id);
  assert.equal(result.records.length, 4);
  assert.deepEqual([...files.entries()], [[requestPath(original.requestId), "fixture v3 request"]]);
  assert.equal(session.requestId, id);
  assert.doesNotThrow(() => session.assertCanUse(result));
  assert.throws(() => session.assertCanUse({ ...result }), /Review a current Calendar lookup/);
  await assert.rejects(session.receive(id), /No matching pending Calendar lookup/);
  await session.cancel();
  assert.equal(session.requestId, null);
  assert.throws(() => session.assertCanUse(result), /Review a current Calendar lookup/);
});

test("capability lookup returns a local lease without record context", async () => {
  const { store, files } = memoryStore();
  const session = makeSession(store);
  const { id, request } = await start(session, files, { mode: "capabilities", lookup: null, filters: emptyWorkspaceFilters(), kinds: [] });
  files.set(replyPath(id), await replyTo(request, { context: null, records: [] }));
  const result = await session.receive(id);
  assert.equal(result.context, null);
  assert.deepEqual(result.records, []);
  assert.equal(files.size, 0);
  assert.doesNotThrow(() => session.assertCanUse(result));
});

test("wrong approved scope and bad ciphertext do not consume the marker or delete a reply", async () => {
  const { store, files } = memoryStore();
  const session = makeSession(store);
  const { id, request } = await start(session, files);
  const path = replyPath(id);
  const changed = { ...request.query, lookup: { ...request.query.lookup, terms: ["changed"] } };
  files.set(path, await replyTo(request, { query: changed }));
  await assert.rejects(session.receive(id), /reply could not be verified/);
  assert.equal(files.size, 2);
  const raw = "raw invalid bytes";
  files.set(path, raw);
  await assert.rejects(session.receive(id), /reply could not be verified/);
  await session.cancel();
  assert.deepEqual([...files.entries()], [[path, raw]]);
});

test("preserves same-size replacements of the marker and authenticated reply", async () => {
  const { store, files, calls } = memoryStore();
  const session = makeSession(store);
  const { id, request } = await start(session, files);
  const requestFile = requestPath(id), replyFile = replyPath(id);
  const reply = await replyTo(request);
  files.set(requestFile, files.get(requestFile).replace("calendar.request", "Calendar.request"));
  files.set(replyFile, reply);
  const read = store.read;
  store.read = async path => {
    const value = await read(path);
    if (path === replyFile) files.set(replyFile, reply.replace("calendar.reply", "Calendar.reply"));
    return value;
  };
  const result = await session.receive(id);
  assert.equal(result.datasetId, plaintext.datasetId);
  assert.equal(files.size, 2);
  assert(!calls.some(([op]) => op === "remove"));
});

test("checks a vault object's identity before every filesystem step even when names match", async () => {
  const { store, files, calls } = memoryStore();
  let vault = {};
  const exists = store.exists;
  store.exists = async path => {
    const value = await exists(path);
    if (path.endsWith(".request.json")) vault = {};
    return value;
  };
  const session = makeSession(store, { vaultIdentity: () => vault });
  await assert.rejects(session.start({ vaultId: original.vaultId, query: original.query }), /vault session changed/);
  assert.equal(files.size, 0);
  assert.equal(session.requestId, null);
  assert(!calls.some(([op, path]) => op === "exists" && path.endsWith(".reply.json")));
});

test("owner changes during receipt prevent a late file read or cleanup", async () => {
  const { store, files, calls } = memoryStore();
  let vault = {};
  const session = makeSession(store, { vaultIdentity: () => vault });
  const { id, request } = await start(session, files);
  files.set(replyPath(id), await replyTo(request));
  const size = store.size;
  store.size = async path => {
    const value = await size(path);
    if (path === replyPath(id)) vault = {};
    return value;
  };
  const before = calls.length;
  await assert.rejects(session.receive(id), /vault session changed/);
  assert.deepEqual(calls.slice(before), [["size", replyPath(id)]]);
  assert.equal(files.size, 2);
});

test("unload cancels an in-flight write and an approved lease expires without reopening it", async () => {
  const { store, files, calls } = memoryStore();
  const originalWrite = store.write;
  const duringWrite = makeSession(store, { canClean: () => true });
  store.write = async (path, content) => {
    await originalWrite(path, content);
    await duringWrite.dispose();
  };
  await assert.rejects(duringWrite.start({ vaultId: original.vaultId, query: original.query }), /vault session changed/);
  assert.equal(files.size, 0);
  assert.equal(calls.filter(([op]) => op === "write").length, 1);

  store.write = originalWrite;
  let clock = now;
  const session = makeSession(store, { now: () => clock });
  const { id, request } = await start(session, files);
  files.set(replyPath(id), await replyTo(request));
  const result = await session.receive(id);
  clock = request.expiresAt + 1;
  const before = calls.length;
  assert.throws(() => session.assertCanUse(result), /lookup expired/);
  assert.equal(calls.length, before);
  await session.dispose();
  assert.equal(files.size, 0);
});

test("exports an exact Desktop marker and imports an authenticated reply without touching a vault reply path", async () => {
  const { store, files, calls } = memoryStore();
  const session = makeSession(store);
  assert.equal(session.exportPending(), null);
  const { id, request } = await start(session, files);
  const marker = session.exportPending();
  assert.deepEqual(marker, { name: id + ".request.json", contents: files.get(requestPath(id)) });
  marker.contents = "modified copy";
  assert.equal(session.exportPending().contents, files.get(requestPath(id)));

  const raw = await replyTo(request);
  const otherCopy = replyPath(id);
  files.set(otherCopy, raw);
  const before = calls.length;
  const result = await session.receive(id, { name: id + ".reply.json", contents: raw });
  assert.equal(result.datasetId, plaintext.datasetId);
  assert.deepEqual(calls.slice(before), [["size", requestPath(id)], ["read", requestPath(id)], ["remove", requestPath(id)]]);
  assert.deepEqual([...files.entries()], [[otherCopy, raw]]);
  assert.doesNotThrow(() => session.assertCanUse(result));
  assert.equal(session.exportPending(), null);
});

test("rejects wrong Desktop filename, oversize UTF-8 input, and failed authentication while keeping the pending marker", async () => {
  const { store, files, calls } = memoryStore();
  const session = makeSession(store);
  const { id, request } = await start(session, files);
  const name = id + ".reply.json";
  const raw = await replyTo(request);
  const marker = session.exportPending();
  const before = calls.length;
  await assert.rejects(session.receive(id, { name: "../" + name, contents: raw }), /Choose the Calendar reply file/);
  await assert.rejects(session.receive(id, { name, contents: "한".repeat(100_000) }), /empty or too large/);
  const { ciphertext } = JSON.parse(raw);
  const changed = (ciphertext[0] === "a" ? "b" : "a") + ciphertext.slice(1);
  await assert.rejects(session.receive(id, { name, contents: raw.replace(ciphertext, changed) }), /could not be verified/);
  assert.equal(calls.length, before);
  assert.equal(files.size, 1);
  assert.deepEqual(session.exportPending(), marker);
});

test("Desktop export and import stop after a vault identity change or expiry", async () => {
  for (const unauthorized of ["owner", "expiry"]) {
    const { store, files, calls } = memoryStore();
    let vault = {};
    let time = now;
    const session = makeSession(store, { vaultIdentity: () => vault, now: () => time });
    const { id, request } = await start(session, files);
    const contents = await replyTo(request);
    if (unauthorized === "owner") vault = {};
    else time = request.expiresAt + 1;
    const before = calls.length;
    assert.equal(session.exportPending(), null);
    await assert.rejects(session.receive(id, { name: id + ".reply.json", contents }), /vault session changed|lookup expired/);
    assert.equal(calls.length, before);
  }
});

test("reads native recurrence metadata and lowercase financial types from the exact selected scope", async () => {
  const query = { ...original.query, kinds: ["event", "project_income"], filters: { ...original.query.filters, includeFinancials: true } };
  const request = { ...original, query };
  const event = { ...plaintext.records[0], details: { ...plaintext.records[0].details, occurrences: [
    { originalStart:"2031-06-03T08:30:00",timeBasis:"ZONED",timezone:"Europe/Warsaw",originalOffset:"+02:00" },
  ] } };
  const income = { ...plaintext.records[2], kind:"project_income", title:"Synthetic budget row", details:{ currency:"PLN",gross:"100.25",net:"75.5",netKind:"estimated" } };
  const capabilities = { ...plaintext.capabilities, readKinds:["event","project_income"] };
  const context = { ...plaintext.context, matched: 2 };
  const result = await openWorkspaceLookupReply(await replyTo(request, { records:[event,income], capabilities, context }),request,now);
  assert.deepEqual(result.records[0].details.occurrences,event.details.occurrences);
  assert.equal(result.records[1].details.netKind,"ESTIMATED");
  assert.equal(result.records[1].details.net,"75.5");
  await assert.rejects(openWorkspaceLookupReply(await replyTo(request, { records:[
    { ...event, details:{ ...event.details, occurrences:[] } }, income
  ], capabilities, context }),request,now), /unsupported record detail/);
  const withoutProject = { ...query, lookup:{ ...query.lookup,areas:["calendar"] }, kinds:["event"],
    filters:{ ...query.filters, projects:[original.vaultId] } };
  const { store, calls } = memoryStore();
  await assert.rejects(makeSession(store).start({vaultId:original.vaultId,query:withoutProject}),/outside the selected workspaces/);
  assert.equal(calls.length,0);
});

test("manual lookup accepts an authenticated clock-skewed export within the exact live request window", async () => {
  const { store, files } = memoryStore();
  const session = makeSession(store);
  const { id, request } = await start(session, files);
  const reply = await replyTo(request, { exportedAt: now + 80_000 });
  files.set(replyPath(id), reply);
  await assert.rejects(session.receive(id), /could not be verified/);
  const wrongTime = await replyTo(request, { exportedAt: request.expiresAt + 1 });
  await assert.rejects(session.receive(id, { name: id + ".reply.json", contents: wrongTime }), /could not be verified/);
  const accepted = await session.receive(id, { name: id + ".reply.json", contents: reply });
  assert.equal(accepted.exportedAt, now + 80_000);
  assert(!files.has(requestPath(id)));
  assert(files.has(replyPath(id)));
});
