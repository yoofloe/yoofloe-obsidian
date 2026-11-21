import test from 'node:test';
import assert from 'node:assert/strict';
import { Diagnostics, DIAGNOSTIC_RETENTION } from '../dist/diagnostics.js';
import { diagnoseTransport, observeHttp } from '../dist/diagnostic-network.js';
import { AgentTask } from '../dist/agent-task.js';
import { providerFiles } from '../dist/provider-files.js';
import { diagnosticFixture, environment, exportedReport } from './fixtures/diagnostics.mjs';

test('transport observations keep the available evidence without copying exception or request data', async () => {
  const { diagnostics } = diagnosticFixture();
  const run = diagnostics.start('assistant', 'privateConversation', { model: 'sk-private-model', action: 'send' });
  run.relateTurn('privateTurn');
  const clientId = crypto.randomUUID();
  const error = Object.assign(new Error('Private body and stack'), {
    cause: { cause: { code: 'ENOTFOUND', hostname: 'api.openai.com', message: 'private host URL' } },
  });
  await assert.rejects(observeHttp(run, 'model_request', { requestNumber: 14, requestBytes: 208784,
    clientId, transport: 'obsidian_http_stream', prompt: 'private prompt' }, async () => { throw error; }), value => value === error);
  assert.deepEqual(diagnoseTransport({ message: 'Generic rejection', headers: { Authorization: 'secret' } }),
    { reason: 'unknown', evidence: 'observation_unavailable' });
  assert.deepEqual(diagnoseTransport({ cause: { response: { status: 502 } } }),
    { reason: 'http', evidence: 'http_response', httpStatus: 502 });
  run.finish('paused', 'continue');
  const copied = await diagnostics.copyReport({ turn: 'privateTurn' });
  const report = exportedReport(copied);
  assert.equal(report.lastFailure.errorCode, 'ENOTFOUND');
  assert.equal(report.lastFailure.requestNumber, 14);
  assert.equal(report.lastFailure.requestBytes, 208784);
  assert.equal(report.lastFailure.clientId, clientId);
  assert.equal(report.events[0].model, 'custom');
  assert.equal(report.lastFailure.remoteConfirmed, undefined);
  assert.doesNotMatch(copied, /privateConversation|privateTurn|sk-private-model|api\.openai\.com|Private body|private host URL|private prompt|Authorization/);
  diagnostics.dispose();
});

test('bounded diagnostic records keep anchors, report interrupted sessions, and expire without touching other records', async () => {
  let now = Date.UTC(2026, 10, 22);
  const { diagnostics, storage, records } = diagnosticFixture(() => now);
  records.set('workspace.json', new ArrayBuffer(12));
  const task = diagnostics.start('assistant', 'inbox');
  task.event('input_tokens', 'failed', { reason: 'dns' });
  task.resume({ contextReused: true });
  task.updateJournal('local', { confirmed: 2, pending: 1, reverted: 0 });
  task.event('journal_save', 'ok');
  for (let count = 0; count < 175; count++) task.event('tool', 'ok', { action: 'read_notes', count });
  task.event('model_request', 'started', { requestNumber: 14 });
  await diagnostics.flush();
  const reopened = new Diagnostics(storage, environment, () => true, () => now);
  const report = exportedReport(await reopened.copyReport({ id: task.id }));
  assert.equal(report.outcome, 'interrupted');
  assert.equal(report.firstFailure.stage, 'input_tokens');
  assert.equal(report.lastSave.stage, 'journal_save');
  assert.equal(report.lastResume.contextReused, true);
  assert.equal(report.events.at(-1).reason, 'session_reopened');
  assert(report.omitted > 50);
  assert.deepEqual(report.changes, { confirmed: 2, pending: 1, reverted: 0 });
  for (let index = 0; index < 35; index++) {
    now++;
    diagnostics.start('calendar', 'inbox').finish('failed', 'review');
  }
  await diagnostics.flush();
  const diagnosticLengths = [...records].filter(([key]) => key.startsWith('diagnostics/')).map(([, value]) => value.byteLength);
  assert.equal(diagnosticLengths.length, 32);
  assert(diagnosticLengths.reduce((sum, size) => sum + size, 0) < 2 * 1024 * 1024);
  now += DIAGNOSTIC_RETENTION + 1;
  reopened.maintain();
  await reopened.flush();
  assert.deepEqual([...records.keys()], ['workspace.json']);
  assert.equal((await reopened.recentIssues()).reports.length, 0);
  diagnostics.dispose();
  reopened.dispose();
});

test('idle maintenance expires records and unload saves the final checkpoint after lifecycle signals', async () => {
  let now = Date.now(), sweep;
  const { storage, records } = diagnosticFixture(() => now);
  const timers = {
    setTimeout: () => 1, clearTimeout: () => {},
    setInterval: callback => { sweep = callback; return 2; },
    clearInterval: id => { assert.equal(id, 2); sweep = undefined; },
  };
  const diagnostics = new Diagnostics(storage, environment, () => true, () => now, undefined, timers);
  diagnostics.maintain();
  const assistant = diagnostics.start('assistant', 'inbox');
  const calendar = diagnostics.start('calendar', 'inbox');
  calendar.finish('paused', 'review');
  for (const run of [assistant, calendar]) {
    const original = run.event.bind(run);
    run.event = (stage, ...args) => {
      assert(!run.report.events.some(event => event.stage === stage && stage === 'visibility'));
      original(stage, ...args);
    };
  }
  diagnostics.signal('visibility', { visible: false });
  assistant.event('stream', 'failed', { reason: 'stream_incomplete' });
  assistant.finish('failed', 'review');
  assert.equal(calendar.report.events.filter(event => event.stage === 'visibility').length, 1);
  await diagnostics.dispose();
  assert.equal(sweep, undefined);
  const reopened = new Diagnostics(storage, environment, () => true, () => now, undefined, timers);
  const saved = exportedReport(await reopened.copyReport({ id: assistant.id }));
  assert.equal(saved.outcome, 'failed');
  assert.equal(saved.lastFailure.reason, 'stream_incomplete');
  reopened.maintain();
  await reopened.flush();
  now += DIAGNOSTIC_RETENTION + 1;
  sweep();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(records.size, 0);
  await reopened.dispose();
});

test('file operations confirm success only after validating the provider reply', async () => {
  const { diagnostics } = diagnosticFixture();
  const run = diagnostics.start('assistant', 'inbox');
  const file = { kind: 'image', mime: 'image/png', name: 'private image.png' };
  const ref = { run, reference: 'File 1' };
  const reply = (status, text, bytes = 0) => ({ status, text, arrayBuffer: new ArrayBuffer(bytes) });
  const invalid = providerFiles(async () => reply(200, '{"id":"unexpected"}'));
  await assert.rejects(invalid.upload(file, new ArrayBuffer(2), 'synthetic', () => true, ref), /invalid file reference/);
  await assert.rejects(invalid.removeUpload('file-fixture', 'synthetic', ref), /deletion was not confirmed/);
  const remote = providerFiles(async input => input.url.endsWith('/content')
    ? reply(200, '', 2) : reply(200, '{"id":"cfile_fixture","container_id":"cntr_fixture","object":"container.file","bytes":3}'));
  await assert.rejects(remote.download('cntr_fixture', 'cfile_fixture', 'synthetic', () => true, 10, ref), /size could not be confirmed/);
  for (const stage of ['upload', 'delete_upload', 'download']) {
    const outcomes = run.report.events.filter(event => event.stage === stage);
    assert(outcomes.some(event => event.outcome === 'received' && event.httpStatus === 200));
    assert.equal(outcomes.at(-1).outcome, 'unconfirmed');
    assert.equal(outcomes.at(-1).reason, 'response_invalid');
    assert(!outcomes.some(event => event.outcome === 'ok'));
  }
  const deleted = providerFiles(async () => reply(404, ''));
  await deleted.removeUpload('file-fixture', 'synthetic', ref);
  assert.equal(run.report.events.at(-1).outcome, 'ok');
  await diagnostics.dispose();
});

test('a new local failure is recorded when Continue encounters an invalid follow-up', async () => {
  const { diagnostics } = diagnosticFixture();
  const run = diagnostics.start('assistant', 'inbox');
  let requests = 0;
  const task = new AgentTask({ current: () => true, key: async () => 'sk-synthetic-agent-key', gate: { busy: false },
    diagnostics: run, executor: { execute: async () => assert.fail('This task never receives a tool call') },
    transport: async () => { requests++; throw Error('Unable to resolve host api.openai.com: private detail'); },
  });
  await task.run('First request', { model: 'gpt-6.2-sol' }, 'ask', 'none');
  assert.equal(task.state, 'paused');
  assert.equal(run.report.lastFailure.reason, 'dns');
  run.finish('paused', 'continue');
  assert(task.addSteer({ id: crypto.randomUUID(), text: 'Follow-up', context: { attachments: [], needsReview: true } }));
  run.resume();
  await task.resume('none');
  assert.equal(task.state, 'failed');
  assert.equal(requests, 1);
  assert.equal(run.report.firstFailure.reason, 'dns');
  assert.equal(run.report.lastFailure.stage, 'prepare');
  assert.equal(run.report.lastFailure.sequence > run.report.lastResume.sequence, true);
  await diagnostics.dispose();
});

test('a full device store leaves diagnostics copyable in memory and does not block the operation', async () => {
  const { storage, diagnostics } = diagnosticFixture();
  storage.write = async () => { throw new DOMException('Private vault path', 'QuotaExceededError'); };
  const task = diagnostics.start('assistant', 'inbox');
  const returned = await observeHttp(task, 'input_tokens', {}, async () => ({ status: 200 }));
  assert.equal(returned.status, 200);
  task.finish('completed', 'none');
  const text = await diagnostics.copyReport({ id: task.id });
  assert.equal(exportedReport(text).storageUnconfirmed, true);
  assert.doesNotMatch(text, /Private vault path/);
  diagnostics.dispose();
});

test('automatic compaction of a large input keeps tool results and logs the reduced follow-up without its content', async () => {
  const { diagnostics } = diagnosticFixture();
  const run = diagnostics.start('assistant', 'inbox');
  const payloads = [], sizes = [], countTokens = [];
  const encrypted = 'opaque-compact-state';
  const previous = 'PRIVATE HISTORY WORD '.repeat(12000);
  const response = output => ({ status: 200, text: JSON.stringify({ status: 'completed', output }) });
  const task = new AgentTask({ current: () => true, key: async () => 'sk-synthetic-agent-key', gate: { busy: false },
    diagnostics: run, executor: { execute: async () => ({ syntheticRead: true }) },
    countTokens: async req => {
      const body = JSON.parse(req.body);
      const tokens = Buffer.byteLength(JSON.stringify(body.input)) > 100000 ? 65000 : 1200;
      countTokens.push(tokens);
      return { status: 200, text: JSON.stringify({ object: 'response.input_tokens', input_tokens: tokens }) };
    },
    transport: async req => {
      sizes.push(Buffer.byteLength(req.body));
      payloads.push(JSON.parse(req.body));
      if (payloads.length === 1) return response([
        { type: 'compaction', id: 'cmp_fixture', encrypted_content: encrypted },
        { type: 'function_call', call_id: 'read-fixture', name: 'read_notes', arguments: '{"notes":[]}' },
      ]);
      return response([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Private answer' }] }]);
    },
  });
  await task.run('Private latest prompt', { model: 'gpt-6.2-sol' }, 'ask', 'none', undefined, undefined,
    { autoCompact: true, items: [{ role: 'user', content: previous }] });
  assert.equal(task.state, 'completed');
  assert.deepEqual(countTokens, [65000, 1200]);
  assert.deepEqual(payloads[0].context_management, [{ type: 'compaction', compact_threshold: 32000 }]);
  assert(sizes[1] < sizes[0] / 10);
  assert.equal(payloads[1].input[0].encrypted_content, encrypted);
  assert(payloads[1].input.some(item => item.type === 'function_call_output' && item.call_id === 'read-fixture'));
  run.finish('completed', 'none');
  const text = await diagnostics.copyReport({ id: run.id });
  const output = exportedReport(text);
  assert(output.events.some(event => event.stage === 'compaction' && event.action === 'applied'));
  assert.deepEqual(output.events.filter(event => event.stage === 'model_request' && event.outcome === 'started').map(event => event.requestBytes), sizes);
  assert.doesNotMatch(text, /opaque-compact-state|PRIVATE HISTORY WORD|Private latest prompt|Private answer/);
  diagnostics.dispose();
});

test('an HTTP 200 with an incomplete Android stream is distinguished from an unobserved response', async () => {
  const { diagnostics } = diagnosticFixture();
  const run = diagnostics.start('assistant', 'inbox');
  let requests = 0;
  const task = new AgentTask({ current: () => true, key: async () => 'sk-synthetic-agent-key', gate: { busy: false },
    diagnostics: run, streamResponses: true,
    executor: { execute: async () => assert.fail('An unconfirmed output item cannot authorize work') },
    transport: async () => {
      requests++;
      return { status: 200, text: 'event: response.in_progress\ndata: {"type":"response.in_progress","opaque":"PRIVATE BODY"}\n\n' };
    },
  });
  await task.run('Private draft', { model: 'gpt-6.2-sol' }, 'ask', 'none');
  assert.equal(task.state, 'failed');
  assert.equal(requests, 1);
  run.finish('failed', 'review');
  const text = await diagnostics.copyReport({ id: run.id });
  const report = exportedReport(text);
  assert.equal(report.lastFailure.stage, 'stream');
  assert.equal(report.lastFailure.reason, 'stream_incomplete');
  assert.equal(report.lastFailure.httpStatus, 200);
  assert.equal(report.automaticRetries, 0);
  assert.doesNotMatch(text, /Private draft|PRIVATE BODY/);
  diagnostics.dispose();
});
