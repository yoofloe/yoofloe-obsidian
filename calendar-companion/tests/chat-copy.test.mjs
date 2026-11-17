import assert from 'node:assert/strict';
import test from 'node:test';
import { collectConversationForCopy, copiedMessageText, formatCopiedConversation } from '../dist/chat-copy.js';

function turn(index, patch = {}) {
  return {
    id: 'turn-' + index, conversationId: 'thread', startedAt: index,
    request: 'Request ' + index, answer: 'Answer ' + index, status: 'completed',
    model: 'fixture', requests: 1, inputTokens: 0, outputTokens: 0, actions: [], ...patch,
  };
}

test('whole conversation copy reads every page beyond the visible preview and retains the latest live text', async () => {
  const archive = Array.from({ length: 63 }, (_, index) => turn(index));
  const offsets = [];
  const result = await collectConversationForCopy([
    turn(62, { answer: 'Latest live answer' }), turn(63), turn(100, { conversationId: 'other' }),
  ], 'thread', async offset => {
    offsets.push(offset);
    const page = archive.slice(offset, offset + 20).reverse();
    if (offset) page.push(archive[0]);
    page.push(turn(999, { conversationId: 'other' }));
    return { turns: page, nextOffset: offset + 20 < archive.length ? offset + 20 : null };
  });
  assert.deepEqual(offsets, [0, 20, 40, 60]);
  assert.equal(result.length, 64);
  assert.deepEqual(result.map(row => row.startedAt), Array.from({ length: 64 }, (_, index) => index));
  assert.equal(result[62].answer, 'Latest live answer');
  assert(!formatCopiedConversation(result).includes('999'));
});

test('truncated messages restore their complete tails and steers while preserving live metadata', async () => {
  const full = turn(1, { answer: 'a'.repeat(17000) + '\nTAIL', steers: [{ id: 'steer', text: 's'.repeat(1100) + ' END' }] });
  const preview = { ...full, answer: full.answer.slice(0, 16000), answerTruncated: true,
    workDetailsTruncated: true, steers: [{ id: 'steer', text: 's'.repeat(1000) }], status: 'stopped' };
  let loaded = 0;
  const result = await collectConversationForCopy([preview], 'thread', undefined, async id => {
    loaded++; assert.equal(id, full.id); return full;
  });
  assert.equal(loaded, 1);
  assert.equal(result[0].status, 'stopped');
  assert.equal(copiedMessageText(result[0], 'assistant'), full.answer);
  const formatted = formatCopiedConversation(result);
  assert(formatted.includes('s'.repeat(1100) + ' END'));
  assert(formatted.endsWith('\nTAIL'));
});

test('full archived text fills an in-memory preview without another disk read', async () => {
  const full = turn(1, { request: 'A complete original message.' });
  const rows = await collectConversationForCopy([{ ...full, request: 'A complete', requestTruncated: true }], 'thread',
    async () => ({ turns: [full], nextOffset: null }), async () => assert.fail('A second read is unnecessary'));
  assert.equal(copiedMessageText(rows[0], 'user'), full.request);
});

test('copying a complete selected side does not read a missing archive for the opposite side', async () => {
  for (const role of ['user', 'assistant']) {
    const row = turn(1, role === 'user' ? { answer: 'Truncated answer', answerTruncated: true } :
      { request: 'Truncated request', requestTruncated: true, workDetailsTruncated: true, steers: [{ id: 's', text: 'Partial steer' }] });
    const required = [{ turnId: row.id, role }];
    let loads = 0;
    const rows = await collectConversationForCopy([row], 'thread', undefined, async () => { loads++; return null; }, undefined, required);
    assert.equal(loads, 0);
    const original = role === 'user' ? row.request : row.answer;
    assert.equal(copiedMessageText(rows[0], role), original);
    assert.equal(formatCopiedConversation(rows, required), (role === 'user' ? '## You' : '## Assistant') + '\n\n' + original);
    assert.throws(() => formatCopiedConversation(rows), /full message/);
  }
});

test('a selected truncated side restores only its content and accepts an incomplete opposite side', async () => {
  const preview = turn(1, { answer: 'Partial', answerTruncated: true, requestTruncated: true });
  const fullAnswer = { ...preview, answer: 'Full **answer**\nTAIL', answerTruncated: false };
  const required = [{ turnId: preview.id, role: 'assistant' }];
  const rows = await collectConversationForCopy([preview], 'thread', undefined, async () => fullAnswer, undefined, required);
  assert.equal(rows[0].requestTruncated, true);
  assert.equal(copiedMessageText(rows[0], 'assistant'), fullAnswer.answer);
  assert.equal(formatCopiedConversation(rows, required), '## Assistant\n\n' + fullAnswer.answer);
  await assert.rejects(collectConversationForCopy([preview], 'thread', undefined, async () => null, undefined, required), /full message/);
});

test('selected messages retain conversation order, original Markdown, attachment names and accepted steers', () => {
  const first = turn(1, { request: '  Keep **this**\n\n    code\n', answer: '| A | B |\n|---|---|\n|1|2|\n',
    attachments: [{ name: 'figure.png' }], steers: [{ id: 's1', text: 'Also keep the footer.' }],
    activity: [{ text: 'PRIVATE DIAGNOSTIC' }], fileWarnings: ['cleanup detail'] });
  const next = turn(2);
  const result = formatCopiedConversation([first, next], [
    { turnId: next.id, role: 'assistant' }, { turnId: first.id, role: 'user' }, { turnId: next.id, role: 'assistant' },
  ]);
  assert.equal(result, '## You\n\n' + first.request + '\n\nAttachments\n- figure.png\n\n## You\n\nAlso keep the footer.\n\n## Assistant\n\nAnswer 2');
  assert.equal(copiedMessageText(first, 'assistant'), first.answer);
  assert(!result.includes('PRIVATE DIAGNOSTIC') && !result.includes('cleanup detail'));
  assert.equal(formatCopiedConversation([first], []), '');
  assert.throws(() => formatCopiedConversation([first], [{ turnId: 'missing', role: 'user' }]), /unavailable/);
});

test('copy rejects a missing or mismatched full record and a stalled archive page', async () => {
  const preview = turn(1, { answerTruncated: true });
  for (const full of [null, turn(2), turn(1, { conversationId: 'other' }), preview]) {
    await assert.rejects(collectConversationForCopy([preview], 'thread', undefined, async () => full), /full message/);
  }
  for (const nextOffset of [0, -1, Number.NaN, 1.5]) {
    await assert.rejects(collectConversationForCopy([], 'thread', async () => ({ turns: [], nextOffset })), /completely/);
  }
});

test('copy stops when the vault or conversation changes during a local read', async () => {
  let current = true;
  await assert.rejects(collectConversationForCopy([], 'thread', async () => {
    current = false; return { turns: [turn(1)], nextOffset: null };
  }, undefined, () => current), /conversation changed/);
  current = true;
  await assert.rejects(collectConversationForCopy([turn(1, { requestTruncated: true })], 'thread', undefined, async () => {
    current = false; return turn(1);
  }, () => current), /conversation changed/);
});

test('legacy undated messages retain their relative order and belong to the legacy conversation', async () => {
  const rows = await collectConversationForCopy([
    turn(3, { startedAt: null, conversationId: undefined }),
    turn(1, { startedAt: null, conversationId: undefined }),
    turn(2, { conversationId: undefined }),
    turn(4, { conversationId: 'thread' }),
  ], 'inbox');
  assert.deepEqual(rows.map(row => row.id), ['turn-3', 'turn-1', 'turn-2']);
});
