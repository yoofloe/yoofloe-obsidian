import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateInput, verifyInputBudget } from '../dist/input-budget.js';
import { AgentTask } from '../dist/agent-task.js';

const countReply = n => ({status:200,text:JSON.stringify({object:'response.input_tokens',input_tokens:n})});
test('local input estimates include Unicode and reserve output space for known models', () => {
  const short=estimateInput({model:'gpt-6.1-sol',input:'Short'});
  const larger=estimateInput({model:'gpt-6.1-sol',input:'한글 😀 '.repeat(1000)});
  assert(larger.estimated>short.estimated);
  assert.equal(short.inputLimit,913808);
  assert.equal(estimateInput({model:'custom-model',input:'Text'}).inputLimit,null);
});
test('files and opaque compaction are counted with the complete request context before generation', async () => {
  const body={model:'gpt-6.1-sol',instructions:'Synthetic instruction',input:[{role:'user',content:[{type:'input_image',file_id:'file-fixture'}]},{type:'compaction',encrypted_content:'opaque'}],
    tools:[{type:'function',name:'read_note'}],store:false,stream:false};
  let calls=0;
  const result=await verifyInputBudget(body,'synthetic',()=>true,async req=>{
    calls++;assert.equal(req.url,'https://api.openai.com/v1/responses/input_tokens');
    const input=JSON.parse(req.body);assert.deepEqual(input.input,body.input);assert.deepEqual(input.tools,body.tools);
    assert.equal(input.instructions,body.instructions);assert.equal(input.store,undefined);return countReply(5000);
  });
  assert.equal(calls,1);assert.equal(result.exact,5000);assert(result.hasFiles&&result.hasCompaction);
});
test('an oversized uploaded file blocks model generation and confirms upload cleanup', async () => {
  let modelRequests=0,cleanups=0;
  const task=new AgentTask({
    current:()=>true,key:async()=>'sk-synthetic-agent-key',gate:{busy:false},
    executor:{execute:async()=>({})},
    transport:async()=>{modelRequests++;throw Error('Generation must not start');},
    countTokens:async()=>countReply(1000000),
    attachments:{hasUploads:true,prepare:async()=>({parts:[{type:'input_file',file_id:'file-fixture'}],fileIds:['file-fixture']}),
      cleanup:async()=>{cleanups++;return true;}},
  });
  await task.run('Synthetic file analysis',{model:'gpt-6.1-sol',effort:'low'},'ask',4);
  assert.equal(task.state,'failed');assert.equal(modelRequests,0);assert.equal(task.requests,0);assert.equal(cleanups,1);
  assert.match(task.message,/input budget/);
});
test('Stop after a token-count request prevents the next model request', async () => {
  let release,started;const ready=new Promise(resolve=>{started=resolve;});let requests=0;
  const task=new AgentTask({
    current:()=>true,key:async()=>'sk-synthetic-agent-key',gate:{busy:false},executor:{execute:async()=>({})},
    transport:async()=>{requests++;throw Error('Must not start');},
    countTokens:async()=>{started();return await new Promise(resolve=>{release=resolve;});},
  });
  const pending=task.run('a'.repeat(100000),{model:'gpt-6.1-sol',effort:'low'},'ask',4);
  await ready;task.stop();release(countReply(1000));await pending;
  assert.equal(requests,0);assert.equal(task.state,'stopped');
});
test('unreadable or failed counts do not masquerade as a safe input estimate', async () => {
  const body={model:'gpt-6.1-sol',input:[{type:'input_image',file_id:'file-fixture'}]};
  await assert.rejects(verifyInputBudget(body,'synthetic',()=>true,async()=>({status:200,text:'{"object":"response.input_tokens","input_tokens":"900"}'})),/did not confirm/);
  await assert.rejects(verifyInputBudget(body,'synthetic',()=>true,async()=>({status:403,text:'private diagnostic'})),/HTTP 403/);
});
