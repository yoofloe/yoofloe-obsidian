import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationIntent, readUserDirections } from '../dist/conversation-intent.js';

const turn = (id, request, patch = {}) => ({ id, request, answer: 'Private answer', status: 'completed',
  conversationId: 'same-chat', model: 'fixture', requests: 1, inputTokens: 0, outputTokens: 0, actions: [], ...patch });

test('recent directions survive target changes and carry applied corrections without old source content', () => {
  const rows = [turn('a', 'Add Polish readings in parentheses.', { sourcePath: 'Old.md', referenceSnapshot: { text: 'PRIVATE TEXT' } }),
    turn('b', 'Do it for this document too.', { steers: [{ text: 'Keep the original formatting.' }] }),
    turn('c', 'Unrelated secret work', { conversationId: 'another-chat' })];
  const result = conversationIntent(rows, 'same-chat', new Set());
  assert.deepEqual(result.map(row => row.request), [rows[0].request, rows[1].request]);
  assert.deepEqual(result[1].corrections, ['Keep the original formatting.']);
  assert(!JSON.stringify(result).includes('PRIVATE'));
  assert(!JSON.stringify(result).includes('Private answer'));
  assert(!JSON.stringify(result).includes('Old.md'));
  assert(!JSON.stringify(result).includes('Unrelated secret work'));
});

test('intent uses a bounded local budget and excludes duplicate covered requests and credentials', () => {
  const rows = Array.from({ length: 80 }, (_, index) => turn(String(index), `Request ${index} ` + '가'.repeat(2300)));
  rows.push(turn('credential', 'sk-proj-' + 'a'.repeat(30)), turn('latest', 'Use the current note.'));
  const result = conversationIntent(rows, 'same-chat', new Set(['Use the current note.']));
  assert(result.length > 0 && result.length <= 8);
  assert(Buffer.byteLength(JSON.stringify(result), 'utf8') < 16100);
  assert(result.every(row => row.partial));
  assert(!JSON.stringify(result).includes('sk-proj-'));
  assert(!result.some(row => row.request === 'Use the current note.'));
});

test('repeated follow-ups retain the original direction after the visible history rolls off and the conversation reopens', () => {
  const original = turn('original', 'Add the Polish reading of every number in parentheses.');
  let remembered = conversationIntent([original], 'same-chat', new Set());
  let recent = [original];
  for (let index = 0; index < 65; index++) {
    recent = [...recent, turn('follow-' + index, 'Do this document too.')].slice(-50);
    remembered = conversationIntent(recent, 'same-chat', new Set(), remembered);
  }
  assert(!recent.some(row => row.id === original.id));
  assert.equal(remembered.length, 2);
  const restored = readUserDirections(JSON.parse(JSON.stringify(remembered)));
  assert.equal(conversationIntent(recent, 'same-chat', new Set(), restored)[0].request, original.request);
  assert.deepEqual(readUserDirections([{ request: 'sk-proj-' + 'a'.repeat(30), corrections: [], status: 'completed' }]), []);
});
