import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ResponsesSocketRound } from '../dist/responses-socket.js';
import { AgentTask } from '../dist/agent-task.js';

const outputText = value => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: value }] });
function connection() {
  const events = new EventEmitter(), sent = [];
  const round = new ResponsesSocketRound({
    on: (event, handle) => events.on(event, handle),
    send: (message, done) => { sent.push(JSON.parse(message)); done(); },
    close: () => events.emit('close'),
  }, { setTimeout, clearTimeout });
  const event = (type, value) => events.emit('message', JSON.stringify({ type, ...value }));
  const steer = (type, value) => event('response.steer.' + type, { steer: { previous_response_id: 'original' }, ...value });
  const created = id => event('response.created', { response: { id } });
  const complete = (id, output, status = 'completed') => event('response.' + status, {
    response: { id, status, output, usage: { input_tokens: 10, output_tokens: 5 } },
  });
  return { round, sent, event, steer, created, complete, disconnect: () => events.emit('close') };
}
const hooks = { ready() {}, steer() {}, activity() {}, summary() {} };

test('an accepted steer applies only when a successor starts', async () => {
  const c = connection(), steering = [], activity = [], summaries = [];
  const pending = c.round.request('{"stream":false,"store":false}', {
    ...hooks, steer: value => steering.push(value), activity: (...args) => activity.push(args), summary: text => summaries.push(text),
  });
  assert.deepEqual(c.sent, [{ type: 'response.create', store: false }]);
  assert.equal(c.round.steer('Wait for a response ID'), false);
  c.created('original');
  assert.equal(c.round.steer('Use two examples'), true);
  assert.equal(c.round.steer('Do not submit a second steer to the same response'), false);
  c.steer('accepted');
  c.event('response.web_search_call.searching');
  c.event('response.reasoning_summary_text.done', { text: 'Compared the two inputs' });
  c.complete('original', [outputText('Original partial answer')], 'incomplete');
  assert.deepEqual(steering, ['accepted']);
  c.created('successor');
  c.complete('successor', [outputText('Updated result')]);
  const result = await pending;
  assert.deepEqual(steering, ['accepted', 'applied']);
  assert.equal(c.sent[1].previous_response_id, 'original');
  assert.deepEqual(activity, [['Searching the web', 'working']]);
  assert.deepEqual(summaries, ['Compared the two inputs']);
  assert.match(result.superseded, /Original partial answer/);
  assert.match(result.response, /Updated result/);
});

test('required input defers steering, while an uncertain disconnect preserves the response for review', async () => {
  for (const deferred of [true, false]) {
    const c = connection(), steering = [];
    const pending = c.round.request('{}', { ...hooks, steer: value => steering.push(value) });
    c.created('original');
    c.round.steer('Change direction');
    c.steer('accepted');
    c.complete('original', [outputText('Preserve this')]);
    if (deferred) c.steer('pending', { reason: 'waiting_for_required_input' });
    else c.disconnect();
    const { response, superseded } = await pending;
    assert.match(deferred ? response : superseded, /Preserve this/);
    assert.equal(deferred ? superseded : response, null);
    assert.deepEqual(steering, deferred ? ['accepted', 'deferred'] : ['accepted']);
  }
});

test('native steering counts the successor and carries its instruction across a local tool step', async () => {
  const c = connection(), statuses = [];
  let sockets = 0, http = 0, tools = 0;
  const task = new AgentTask({
    current: () => true, key: async () => 'sk-synthetic-agent-key', gate: { busy: false },
    executor: { execute: async () => { tools++; return { notes: [] }; } },
    liveResponse: async () => ++sockets === 1 ? c.round : null,
    steerStatus: (_note, status) => statuses.push(status),
    transport: async req => {
      http++;
      const input = JSON.parse(req.body).input;
      assert.equal(input.filter(item => item.role === 'user' && item.content === 'Use two examples').length, 1);
      assert(input.some(item => item.type === 'function_call_output' && item.call_id === 'review'));
      assert(!JSON.stringify(input).includes('stale proposal'));
      return { status: 200, text: JSON.stringify({ status: 'completed', output: [outputText('Done')] }) };
    },
  });
  const pending = task.run('Read the note', { model: 'gpt-6-luna' }, 'ask', 3, { mode: 'provided', maximum: 'none' });
  await new Promise(resolve => setImmediate(resolve));
  c.created('original');
  assert(task.addSteer({ id: 'steer-1', text: 'Use two examples' }));
  c.steer('accepted');
  c.complete('original', [outputText('stale proposal')], 'incomplete');
  c.created('successor');
  c.complete('successor', [{ type: 'function_call', call_id: 'review', name: 'read_notes', arguments: '{"notes":[]}' }]);
  await pending;
  assert.deepEqual(statuses, ['sending', 'applied']);
  assert.equal(task.state, 'completed');
  assert.equal(task.requests, 3);
  assert.equal(task.usage.input, 20);
  assert.equal(task.text, 'Done');
  assert.equal(http, 1);
  assert.equal(tools, 1);
});
