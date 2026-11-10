import test from 'node:test';
import assert from 'node:assert/strict';
import { readChat, chatPreview, validChatId } from '../dist/chat-history.js';
test('local conversation previews are bounded and explicitly mark full records available without altering the original',()=>{
 const turn={id:crypto.randomUUID(),request:'q'.repeat(5000),answer:'a'.repeat(50000),startedAt:Date.now(),model:'fixture',status:'completed',requests:12,inputTokens:100,outputTokens:100,actions:[{kind:'rename',path:'A.md',target:'B.md'}]};
 const preview=chatPreview(turn);assert.equal(preview.request.length,4000);assert.equal(preview.answer.length,16000);assert(preview.requestTruncated&&preview.answerTruncated);assert.equal(turn.answer.length,50000);assert.equal(readChat(preview).actions[0].target,'B.md');
 for(const id of ['../secret','a/b','a\\b',''])assert(!validChatId(id));assert.equal(readChat({...turn,id:'../secret'}),null);assert.equal(readChat({...turn,answer:3}),null);
});
