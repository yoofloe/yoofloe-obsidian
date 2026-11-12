import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAiSession, OPENAI_ENDPOINT, parseOpenAiDraft, validateOpenAiKey } from '../dist/openai.js';
import { AiPreferences, DEFAULT_OPENAI_OPTIONS } from '../dist/ai-preferences.js';
import { saveAiDraft } from '../dist/notes.js';

// All credentials, records and responses in this file are synthetic. No network transport is used.
const fakeKey = 'sk-offline-fixture-not-a-real-api-key';
const record = { id: '11860a48-22be-4156-99b3-a9458331b6df', kind: 'note', revision: 1, title: 'Zażółć', text: '공부 plan', date: null };
const options = { model: 'offline-test-model' };
const response = (text = 'A synthetic draft', status = 'completed') => ({ status: 200, text: JSON.stringify({ status, output: [
  { type: 'function_call', name: 'never_execute', arguments: '{}' },
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }
], usage: { input_tokens: 12, output_tokens: 8 } }) });
function setup(extra = {}) {
  const calls = []; let keyReads = 0, current = true;
  const session = new OpenAiSession({ current: () => current, key: async () => { keyReads++; return fakeKey; }, transport: async request => { calls.push(request); return response(); }, ...extra });
  return { session, calls, keyReads: () => keyReads, changeVault: () => { current = false; } };
}
function review(session, current) { return session.prepare([record], 'Summarize this record.', options, current); }
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test('default off, enabling and preparing never read a key or send a request', () => {
  const f = setup(); assert.equal(f.session.enabled, false);
  assert.throws(() => review(f.session), /disabled/);
  f.session.enableForSession(true); const r = review(f.session);
  assert.equal(Object.isFrozen(r), true); assert.equal(f.keyReads(), 0); assert.equal(f.calls.length, 0);
  f.session.enableForSession(false); assert.equal(f.calls.length, 0);
});
test('explicit confirmation and a genuine one-use review are required before key access', async () => {
  const f = setup(); f.session.enableForSession(true); const r = review(f.session);
  await assert.rejects(f.session.generate(r, false), /explicitly confirm/);
  await assert.rejects(f.session.generate({ ...r }, true), /explicitly confirm/);
  assert.equal(f.keyReads(), 0); assert.equal(f.calls.length, 0);
  await f.session.generate(r, true); await assert.rejects(f.session.generate(r, true), /one-use/);
  assert.equal(f.keyReads(), 1); assert.equal(f.calls.length, 1);
});
test('one POST sends only reviewed records with storage off and no plugin output-token cap', async () => {
  const f = setup(); f.session.enableForSession(true); const r = review(f.session), draft = await f.session.generate(r, true);
  const request = f.calls[0], body = JSON.parse(request.body);
  assert.equal(request.url, OPENAI_ENDPOINT); assert.equal(request.method, 'POST');
  assert.equal(request.headers.Authorization, `Bearer ${fakeKey}`); assert.equal(request.throw, false);
  assert.equal(body.model, options.model); assert(!('max_output_tokens' in body)); assert(!('max_completion_tokens' in body)); assert.equal(body.store, false); assert.equal(body.stream, false);
  assert.equal(body.input, r.input); assert(!request.body.includes(fakeKey)); assert(!request.body.includes(record.id));
  assert.deepEqual(Object.keys(JSON.parse(body.input).calendar_records[0]), ['kind', 'title', 'text', 'date']);
  assert(!('tools' in body)); assert.deepEqual(draft, { text: 'A synthetic draft', incomplete: false, inputTokens: 12, outputTokens: 8 });
});
test('preset requests use a bounded short-draft profile; unknown custom models keep provider defaults', async () => {
  for (const [model, effort] of [['gpt-6-luna','none'],['gpt-6.1-terra','none'],['gpt-6.1-sol','low'],['gpt-6-astra','low'],['custom-fixture',undefined]]) {
    const f = setup(); f.session.enableForSession(true);
    const r = f.session.prepare([record], 'Short draft', { model, maxOutputTokens: 512 }); // A legacy cap is intentionally ignored.
    assert.equal(r.reasoningEffort, effort); await f.session.generate(r, true);
    const body = JSON.parse(f.calls[0].body); assert.equal(body.reasoning?.effort, effort); assert(!('max_output_tokens' in body));
  }
});
test('invalid model, empty selection, excessive selection and oversized UTF-8 input send nothing', () => {
  const f = setup(); f.session.enableForSession(true);
  for (const bad of [{ model: '' }, { model: '../ key' }, { model: fakeKey }]) assert.throws(() => f.session.prepare([record], 'x', bad));
  assert.throws(() => f.session.prepare([], 'x', options)); assert.throws(() => f.session.prepare(Array(51).fill(record), 'x', options));
  assert.throws(() => f.session.prepare([record], ' ', options)); assert.throws(() => f.session.prepare([record], '한'.repeat(1400), options));
  assert.throws(() => f.session.prepare([{ ...record, text: 'x'.repeat(1024*1024) }], 'x', options), /1 MiB/);
  assert.equal(f.keyReads(), 0); assert.equal(f.calls.length, 0);
});
test('missing, malformed and failing local key reads never invoke the transport', async () => {
  for (const key of [async () => null, async () => 'invalid\r\nheader', async () => { throw Error(fakeKey); }]) {
    const f = setup({ key }); f.session.enableForSession(true);
    await assert.rejects(f.session.generate(review(f.session), true), error => { assert(!error.message.includes(fakeKey)); return true; });
    assert.equal(f.calls.length, 0);
  }
  assert.throws(() => validateOpenAiKey('Bearer '+fakeKey));
});
test('vault, preview and setting changes invalidate a prepared or awaiting-key request', async () => {
  for (const change of ['vault', 'preview', 'setting']) {
    const wait = deferred(); let sourceCurrent = true;
    const f = setup({ key: () => wait.promise }); f.session.enableForSession(true);
    const r = review(f.session, () => sourceCurrent), pending = f.session.generate(r, true);
    if (change === 'vault') f.changeVault();
    if (change === 'preview') sourceCurrent = false;
    if (change === 'setting') f.session.enableForSession(false);
    wait.resolve(fakeKey); await assert.rejects(pending, /changed|disabled/); assert.equal(f.calls.length, 0);
  }
});
test('only one request can be in flight; late output is discarded when the review closes', async () => {
  const wait = deferred(); let calls = 0, sourceCurrent = true;
  const f = setup({ transport: async () => { calls++; return wait.promise; } }); f.session.enableForSession(true);
  const r = review(f.session, () => sourceCurrent), r2 = review(f.session);
  const pending = f.session.generate(r, true); await Promise.resolve();
  assert.equal(f.session.inFlight, true); await assert.rejects(f.session.generate(r2, true)); assert.throws(() => review(f.session), /current request/);
  sourceCurrent = false; wait.resolve(response()); await assert.rejects(pending, /changed/);
  assert.equal(calls, 1); assert.equal(f.session.inFlight, false);
});
test('provider and network failures are redacted and never automatically retried', async () => {
  for (const status of [401, 403, 429, 500]) {
    let calls = 0;
    const f = setup({ transport: async () => { calls++; return { status, text: fakeKey }; } }); f.session.enableForSession(true); const r = review(f.session);
    await assert.rejects(f.session.generate(r, true), error => { assert(!error.message.includes(fakeKey)); return true; });
    await assert.rejects(f.session.generate(r, true)); assert.equal(calls, 1);
  }
  let calls = 0; const f = setup({ transport: async () => { calls++; throw Error(fakeKey); } }); f.session.enableForSession(true);
  await assert.rejects(f.session.generate(review(f.session), true), /not retried.*billed/); assert.equal(calls, 1);
});
test('response parser reads assistant text only and handles incomplete, missing and excessive output', () => {
  assert.equal(parseOpenAiDraft(200, response('Partial', 'incomplete').text).incomplete, true);
  assert.throws(() => parseOpenAiDraft(200, '{}')); assert.throws(() => parseOpenAiDraft(200, '<html>'));
  assert.throws(() => parseOpenAiDraft(200, response('').text), /no text/);
  assert.equal(parseOpenAiDraft(200, response('x'.repeat(66000)).text).text.length, 66000, 'accept drafts above the old 64 KiB limit');
  assert.throws(() => parseOpenAiDraft(200, response('x'.repeat(4*1024*1024+1)).text), /too large/);
});

test('request failures expose status and allowlisted diagnostics without echoing private provider content', () => {
  assert.throws(() => parseOpenAiDraft(400, JSON.stringify({error:{type:'invalid_request_error',code:'unsupported_value',param:'tools[0].model',message:fakeKey}})), error => {
    assert.match(error.message,/HTTP 400; invalid_request_error; unsupported_value; parameter: tools\[0\]\.model/); assert(!error.message.includes(fakeKey)); return true;
  });
  for (const raw of [fakeKey, JSON.stringify({error:{type:fakeKey,code:fakeKey,param:'input.private-note.md',message:fakeKey}}), ' '.repeat(65537)+fakeKey]) {
    assert.throws(() => parseOpenAiDraft(502,raw), error => { assert.match(error.message,/HTTP 502/); assert(!error.message.includes(fakeKey)); assert(!error.message.includes('private-note')); return true; });
  }
  for (const param of ['input'+'.content'.repeat(6000),'model.model','tools[0].model.model','input[0].file_id']) {
    assert.throws(() => parseOpenAiDraft(400,JSON.stringify({error:{type:'invalid_request_error',param}})), error => { assert(error.message.length < 160); assert(!error.message.includes('parameter:')); return true; });
  }
  assert.throws(() => parseOpenAiDraft(400,JSON.stringify({error:{param:'input[0].content[1].file_id'}})), /parameter: input\[0\]\.content\[1\]\.file_id/);
});
function preferenceHost(binding = 'local-fixture://vault-one') {
  let value = { keep: 42 }, current = true, saves = 0; const secrets = new Map();
  return { current: () => current, binding: () => binding, load: async () => value, save: async next => { saves++; value = next; },
    secrets: () => ({ getSecret: id => secrets.get(id) ?? null, setSecret: (id, key) => secrets.set(id, key) }),
    data: () => value, saves: () => saves, secretValues: secrets, invalidate: () => { current = false; } };
}
test('settings store options locally and key only in vault-bound secret storage; reload remains disabled', async () => {
  const host = preferenceHost(), prefs = new AiPreferences(host);
  assert.deepEqual(await prefs.read(), DEFAULT_OPENAI_OPTIONS); assert.equal(await prefs.hasKey(), false);
  await prefs.save(options); await prefs.saveKey(fakeKey);
  assert.deepEqual(host.data(), { keep: 42, openai: options }); assert(!JSON.stringify(host.data()).includes(fakeKey));
  assert.equal(host.saves(), 1); assert.equal(await prefs.hasKey(), true); assert.equal(await prefs.key(), fakeKey);
  const id = [...host.secretValues.keys()][0]; assert.match(id, /^ycc-openai-[a-f0-9]{40}$/); assert(!id.includes('vault-one'));
  const next = new OpenAiSession({ current: () => true, key: () => prefs.key(), transport: () => { throw Error('Forbidden network'); } });
  assert.equal(next.enabled, false); await prefs.clearKey(); assert.equal(await prefs.hasKey(), false);
});
test('old output caps are ignored, the recommended default fills blanks and custom model IDs are retained', async () => {
  const host = preferenceHost(), prefs = new AiPreferences(host);
  assert.equal((await prefs.read()).model, 'gpt-6-luna');
  await host.save({openai:{model:'',maxOutputTokens:512}}); assert.deepEqual(await prefs.read(), {model:'gpt-6-luna'});
  await prefs.save({model:'my-existing-model',maxOutputTokens:512}); assert.deepEqual(await prefs.read(), {model:'my-existing-model'});
  assert(!('maxOutputTokens' in host.data().openai));
  await assert.rejects(prefs.save({model:fakeKey})); assert.equal((await prefs.read()).model, 'my-existing-model');
});
test('same-name vaults use separate secret IDs; changed vault and unavailable storage refuse key writes', async () => {
  const first = preferenceHost('local-fixture://one/Shared'), second = preferenceHost('local-fixture://two/Shared');
  await new AiPreferences(first).saveKey(fakeKey); await new AiPreferences(second).saveKey(fakeKey);
  assert.notEqual([...first.secretValues.keys()][0], [...second.secretValues.keys()][0]);
  first.invalidate(); await assert.rejects(new AiPreferences(first).saveKey(fakeKey), /vault changed/);
  const missing = preferenceHost(); missing.secrets = () => null;
  await assert.rejects(new AiPreferences(missing).saveKey(fakeKey), /unavailable/); assert.equal(missing.saves(), 0);
});
test('closing a vault during preference load prevents settings writes', async () => {
  const host = preferenceHost(), wait = deferred(); host.load = () => wait.promise;
  const pending = new AiPreferences(host).save(options); host.invalidate(); wait.resolve({});
  await assert.rejects(pending, /vault changed/); assert.equal(host.saves(), 0);
});
test('draft saving is create-only, literal and guarded, without any Calendar write operation', async () => {
  const files = new Map(), dirs = new Set(); let current = true;
  const store = { mkdir: async path => dirs.add(path), create: async (path, text) => { assert(!files.has(path)); files.set(path, text); } };
  const draft = { text: '<img src=x>\n![[Private]]\n![remote](https://example.test/a.png)', incomplete: false, inputTokens: null, outputTokens: null };
  const path = await saveAiDraft(draft, store, () => { if (!current) throw Error('closed'); });
  assert.match(path, /^Yoofloe Calendar\/AI drafts\/[a-f0-9-]+\.md$/); assert(!files.get(path).includes('<img')); assert(!files.get(path).includes('\n![['));
  assert(!files.get(path).includes('\n![remote]')); assert.equal(files.size, 1);
  current = false; await assert.rejects(saveAiDraft(draft, store, () => { throw Error('closed'); })); assert.equal(files.size, 1);
});
