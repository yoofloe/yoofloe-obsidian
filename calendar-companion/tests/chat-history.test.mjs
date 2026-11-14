import test from 'node:test';
import assert from 'node:assert/strict';
import { readChat, chatPreview, confirmedChangeCount, taskFailure, validChatId } from '../dist/chat-history.js';
test('local conversation previews are bounded and explicitly mark full records available without altering the original',()=>{
 const turn={id:crypto.randomUUID(),request:'q'.repeat(5000),answer:'a'.repeat(50000),startedAt:Date.now(),model:'fixture',status:'completed',requests:12,inputTokens:100,outputTokens:100,actions:[{kind:'rename',path:'A.md',target:'B.md'}]};
 const preview=chatPreview(turn);assert.equal(preview.request.length,4000);assert.equal(preview.answer.length,16000);assert(preview.requestTruncated&&preview.answerTruncated);assert.equal(turn.answer.length,50000);assert.equal(readChat(preview).actions[0].target,'B.md');
 for(const id of ['../secret','a/b','a\\b',''])assert(!validChatId(id));assert.equal(readChat({...turn,id:'../secret'}),null);assert.equal(readChat({...turn,answer:3}),null);
});

test('a saved 0.8.5 turn shows its final request failure apart from upload cleanup', () => {
  const error = 'OpenAI request 4 could not resolve the OpenAI host.';
  const warning = 'Some uploaded files could not be deleted immediately. Their requested expiry is one hour from upload.';
  const turn = readChat({ id: 'old-turn', request: 'Edit', answer: 'I will edit.', status: 'failed',
    actions: [{ kind: 'edit', path: 'Fixture.md' }], fileWarnings: [warning],
    activity: [error, warning].map((text, id) => ({ id, at: id, kind: 'blocked', state: 'blocked', text })) });
  assert.equal(confirmedChangeCount(turn), 1);
  assert.equal(taskFailure(turn), error);
  assert.equal(taskFailure({ ...turn, status: 'completed' }), '');
  assert.equal(taskFailure(readChat(chatPreview(turn))), error);
});
