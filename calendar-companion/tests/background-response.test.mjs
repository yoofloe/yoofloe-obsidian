import test from 'node:test';
import assert from 'node:assert/strict';
import { backgroundAccess, backgroundEnvelope, readResponseReceipts } from '../dist/background-response.js';

const id = 'resp_synthetic_001', key = 'sk-synthetic-android-recovery';
const reply = { status: 200, text: JSON.stringify({ object: 'response', id, status: 'completed', output: [] }) };
function page() {
  const doc = new EventTarget();
  doc.visibilityState = 'visible';
  doc.defaultView = { setTimeout, clearTimeout };
  return doc;
}

test('status and cancellation use only a validated original response ID at the fixed provider endpoint', async () => {
  const calls = [], access = backgroundAccess(async request => { calls.push(request); return reply; }, page());
  assert.equal(await access.retrieve(id, key), reply);
  assert.equal(await access.cancel(id, key), reply);
  for (const wrong of ['req_123', '../other', 'resp_a/b', 'resp_x?secret=s', 'https://invalid/', 'resp_' + 'a'.repeat(181)])
    assert.throws(() => access.cancel(wrong, key));
  assert.throws(() => access.retrieve(id, 'invalid\nkey'));
  assert.deepEqual(calls.map(r => [r.method, r.url]), [
    ['GET', 'https://api.openai.com/v1/responses/' + id],
    ['POST', 'https://api.openai.com/v1/responses/' + id + '/cancel'],
  ]);
  assert(calls.every(r => !r.body && !r.url.includes(key) && r.headers.Authorization === 'Bearer ' + key));
});

test('hidden or aborted lookup stops waiting and ignores its late native response', async () => {
  const doc = page();
  let calls = 0, resolve;
  const access = backgroundAccess(() => { calls++; return new Promise(done => { resolve = done; }); }, doc);
  const controller = new AbortController();
  const flight = access.retrieve(id, key, controller.signal);
  const waiting = access.wait(60000, controller.signal);
  doc.visibilityState = 'hidden'; doc.dispatchEvent(new Event('visibilitychange'));
  await assert.rejects(flight, /interrupted/); await waiting;
  resolve(reply);
  await assert.rejects(access.retrieve(id, key, controller.signal));
  doc.visibilityState = 'visible'; controller.abort();
  await assert.rejects(access.retrieve(id, key, controller.signal));
  assert.equal(calls, 1);
});

test('app switches reuse a pending status check after one native replacement', async () => {
  const pending = [];
  const access = backgroundAccess(() => new Promise(resolve => { pending.push(resolve); }), page());
  for (let switchNumber = 0; switchNumber < 5; switchNumber++) {
    const controller = new AbortController();
    const lookup = access.retrieve(id, key, controller.signal, true);
    controller.abort();
    await assert.rejects(lookup, /interrupted/);
  }
  assert.equal(pending.length, 2);
  await assert.rejects(access.retrieve(id, 'sk-synthetic-different-project'), /still finishing/);
  const existing = access.retrieve(id, key);
  assert.equal(pending.length, 2);
  pending[1](reply);
  assert.equal(await existing, reply);
  const next = access.retrieve(id, key);
  assert.equal(pending.length, 3);
  pending[2](reply);
  pending[0](reply);
  assert.equal(await next, reply);
});

test('stored references and provider state require matching IDs and a valid turn', () => {
  const turnId = crypto.randomUUID();
  assert.deepEqual(backgroundEnvelope(reply.text, id), { id, status: 'completed' });
  for (const raw of ['{}', 'partial', JSON.stringify({ id, object: 'response', status: 'unknown' })])
    assert.throws(() => backgroundEnvelope(raw));
  assert.throws(() => backgroundEnvelope(reply.text, 'resp_another'));
  assert.deepEqual(readResponseReceipts([{ turnId, responseId: id, requestNumber: 2 },
    { turnId, responseId: '../private', requestNumber: 3 },
    { turnId: 'invalid/id', responseId: id, requestNumber: 1 },
    { turnId, responseId: id, requestNumber: -1 }]), [{ turnId, responseId: id, requestNumber: 2 }]);
});
