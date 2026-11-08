import test from 'node:test';
import assert from 'node:assert/strict';
import { AiSession } from '../dist/ai-session.js';
import { OPENAI_ADAPTER, validateOpenAiKey } from '../dist/openai.js';
import { GEMINI_ADAPTER, GeminiSession, GEMINI_ENDPOINT, parseGeminiDraft, validateGeminiKey } from '../dist/gemini.js';
import { AiPreferences } from '../dist/ai-preferences.js';

// Synthetic credentials and injected transports only. These tests never contact either provider.
const googleKey = 'AIza-offline-fixture-for-tests-only';
const openAiKey = 'sk-offline-fixture-for-tests-only';
const record = { kind: 'task', title: 'Local fixture', text: 'Status: pending', date: null };
const response = (text = 'A fixture draft', reason = 'STOP') => ({ status: 200, text: JSON.stringify({
  candidates: [{ finishReason: reason, content: { role: 'model', parts: [
    { thought: true, text: 'Hidden reasoning' }, { functionCall: { name: 'do_not_execute', args: {} } }, { text },
  ] } }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 15, thoughtsTokenCount: 4 },
}) });

test('Gemini stays off and requires an original one-use approved review before reading its key', async () => {
  let keyReads = 0; const calls = [];
  const session = new GeminiSession({ current: () => true, key: async () => { keyReads++; return googleKey; }, transport: async request => { calls.push(request); return response(); } });
  assert.equal(session.enabled, false); assert.throws(() => session.prepare([record], 'Review', { model: 'gemini-3.5-flash-lite' }), /disabled/);
  session.enableForSession(true); const review = session.prepare([record], 'Review', { model: 'gemini-3.5-flash-lite' });
  assert.equal(review.provider, 'gemini'); assert.equal(keyReads, 0); assert.equal(calls.length, 0);
  await assert.rejects(session.generate(review, false)); await assert.rejects(session.generate({ ...review }, true));
  const draft = await session.generate(review, true); await assert.rejects(session.generate(review, true));
  assert.equal(keyReads, 1); assert.equal(calls.length, 1); assert.equal(draft.text, 'A fixture draft'); assert.equal(draft.thinkingTokens, 4);
  const request = calls[0], body = JSON.parse(request.body);
  assert.equal(request.url, `${GEMINI_ENDPOINT}gemini-3.5-flash-lite:generateContent`);
  assert.equal(request.headers['x-goog-api-key'], googleKey); assert(!request.url.includes(googleKey)); assert(!request.body.includes(googleKey));
  assert.equal(body.contents[0].parts[0].text, review.input); assert(!('generationConfig' in body)); assert(!('maxOutputTokens' in body));
  assert(!('tools' in body)); assert(!('cachedContent' in body)); assert.equal(request.throw, false);
});

test('shared session routes the selected key to a fixed provider endpoint and prevents cross-provider concurrency', async () => {
  const keyReads = [], calls = []; let finish;
  const wait = new Promise(resolve => { finish = resolve; });
  const session = new AiSession({ adapters: [OPENAI_ADAPTER, GEMINI_ADAPTER], current: () => true,
    key: async provider => { keyReads.push(provider); return provider === 'gemini' ? googleKey : openAiKey; },
    transport: async request => { calls.push(request); return wait; } });
  session.enableForSession(true);
  const google = session.prepare([record], 'Review', { provider: 'gemini', model: 'gemini-3.8-flash' });
  const openai = session.prepare([record], 'Review', { provider: 'openai', model: 'gpt-6-luna' });
  const pending = session.generate(google, true); await Promise.resolve();
  await assert.rejects(session.generate(openai, true)); assert.equal(calls.length, 1); assert.deepEqual(keyReads, ['gemini']);
  assert.deepEqual(Object.keys(calls[0].headers), ['x-goog-api-key']); finish(response()); await pending;
  session.enableForSession(false); await assert.rejects(session.generate(openai, true));
});

test('key formats reject the other provider and URL/header secrets before any transport', async () => {
  assert.throws(() => validateGeminiKey(openAiKey)); assert.throws(() => validateOpenAiKey(googleKey));
  for (const value of ['Bearer '+googleKey, 'https://example.test/?key='+googleKey, googleKey+'\r\nextra']) assert.throws(() => validateGeminiKey(value));
  let calls = 0;
  const session = new GeminiSession({ current: () => true, key: async () => openAiKey, transport: async () => { calls++; return response(); } });
  session.enableForSession(true);
  for (const model of ['../key', 'gemini bad', googleKey, openAiKey, 'https://example.test/model']) assert.throws(() => session.prepare([record], 'Review', { model }));
  const review = session.prepare([record], 'Review', { model: 'gemini-custom-fixture' }); await assert.rejects(session.generate(review, true)); assert.equal(calls, 0);
});

test('Gemini parser exposes text only, preserves partial output and rejects blocked or malformed responses', () => {
  const draft = parseGeminiDraft(200, response('Partial fixture', 'MAX_TOKENS').text);
  assert.equal(draft.incomplete, true); assert.equal(draft.text, 'Partial fixture'); assert(!draft.text.includes('Hidden reasoning'));
  for (const raw of ['{}','<html>', response('Blocked', 'SAFETY').text, response('').text]) assert.throws(() => parseGeminiDraft(200, raw));
  const wrongRole = JSON.parse(response().text); wrongRole.candidates[0].content.role = 'user'; assert.throws(() => parseGeminiDraft(200, JSON.stringify(wrongRole)));
  assert.equal(parseGeminiDraft(200, response('x'.repeat(66000)).text).text.length, 66000);
  assert.throws(() => parseGeminiDraft(200, response('x'.repeat(4*1024*1024+1)).text), /too large/);
});

test('provider errors and uncertain network failures stay redacted with no automatic retry', async () => {
  for (const status of [400,401,403,429,500]) {
    let calls = 0;
    const session = new GeminiSession({ current: () => true, key: async () => googleKey,
      transport: async () => { calls++; return { status, text: JSON.stringify({ error: { message: googleKey } }) }; } });
    session.enableForSession(true); const review = session.prepare([record], 'Review', { model: 'gemini-3.5-flash-lite' });
    await assert.rejects(session.generate(review, true), error => !error.message.includes(googleKey));
    await assert.rejects(session.generate(review, true)); assert.equal(calls, 1);
  }
  let calls = 0;
  const session = new GeminiSession({ current: () => true, key: async () => googleKey, transport: async () => { calls++; throw Error(googleKey); } });
  session.enableForSession(true);
  await assert.rejects(session.generate(session.prepare([record], 'Review', { model: 'gemini-3.5-flash-lite' }), true), /not retried.*billed/); assert.equal(calls, 1);
});

test('local preferences keep provider model drafts and secret IDs separate without changing existing OpenAI credentials', async () => {
  let value = { keep: 42, openai: { model: 'my-existing-openai-model', maxOutputTokens: 512 } };
  const secrets = new Map(), host = { current: () => true, binding: () => 'local-fixture://vault', load: async () => value, save: async next => { value = next; },
    secrets: () => ({ getSecret: id => secrets.get(id) ?? null, setSecret: (id, key) => secrets.set(id, key) }) };
  const preferences = new AiPreferences(host);
  assert.equal(await preferences.readProvider(), 'openai'); await preferences.saveKey(openAiKey);
  await preferences.selectProvider('gemini'); assert.equal((await preferences.read('gemini')).model, 'gemini-3.5-flash-lite');
  assert.equal(await preferences.hasKey('gemini'), false); await preferences.saveKey(googleKey, 'gemini'); await preferences.save({ model: 'gemini-account-custom' }, 'gemini');
  assert.equal(await preferences.key(), openAiKey); assert.equal(await preferences.key('gemini'), googleKey);
  assert.equal((await preferences.read()).model, 'my-existing-openai-model'); assert.equal(value.keep, 42);
  const ids = [...secrets.keys()]; assert(ids.some(id => /^ycc-openai-[a-f0-9]{40}$/.test(id))); assert(ids.some(id => /^ycc-gemini-[a-f0-9]{40}$/.test(id)));
  assert(!JSON.stringify(value).includes(googleKey)); assert(!JSON.stringify(value).includes(openAiKey));
  await preferences.clearKey('gemini'); assert.equal(await preferences.key('gemini'), null); assert.equal(await preferences.key(), openAiKey);
});
