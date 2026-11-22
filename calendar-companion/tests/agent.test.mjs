import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedPath, vaultPath, safeOutbound } from '../dist/agent-policy.js';
import { AgentTask, AGENT_INSTRUCTION } from '../dist/agent-task.js';
import { agentTools, parseAgentReply } from '../dist/agent-protocol.js';
import { holdRequestScreen } from '../dist/openai-request.js';
test('rename instructions permit user-requested filenames instead of conflicting preservation guidance',()=>{assert(AGENT_INSTRUCTION.includes('unless the user requests a rename or move'));assert(!AGENT_INSTRUCTION.includes('Existing filenames and user edits must be preserved.'));});
const policy={sourcePath:'Work/A.md',folder:'Work',readScope:'vault',writeScope:'current',mode:'edit',configDir:'.obsidian',excluded:['Private']};
const reply=output=>({status:200,text:JSON.stringify({status:'completed',output,usage:{input_tokens:10,output_tokens:5,output_tokens_details:{reasoning_tokens:2}}})});
const call=(id='c1')=>({type:'function_call',call_id:id,name:'read_notes',arguments:'{"notes":[]}'});
const text=message=>({type:'message',role:'assistant',content:[{type:'output_text',text:message}]});
const stream = (...events) => ({
 status:200,
 text:events.map(event=>['event: '+event.type,'data: '+JSON.stringify(event),'',''].join('\r\n')).join(''),
 headers:{'x-request-id':'req_0123456789abcdef0123456789abcdef'},
});
test('Android waits for each final stream event and retains confirmed tools, reasoning and usage', async () => {
 const attempts = [], operations = [];
 const task = new AgentTask({current:()=>true,key:async()=> 'sk-synthetic-agent-key',gate:{busy:false},streamResponses:true,
  executor:{execute:async name=>{operations.push(name);return {text:'Overview received'};}},
  transport:async req=>{
   const body=JSON.parse(req.body);
   attempts.push(body);
   assert.equal(body.stream,true);
   assert.equal(body.store,false);
   if(attempts.length===1) return stream(
    {type:'response.output_item.done',item:{...call('ignored'),name:'create_note'}},
    {type:'response.completed',response:JSON.parse(reply([{type:'reasoning',id:'r',encrypted_content:'opaque'},call()]).text)},
   );
   return stream({type:'response.completed',response:JSON.parse(reply([text('Polish · dziewięć')]).text)});
  }});
 await task.run('Read',{model:'gpt-6.1-sol',effort:'xhigh'},'edit',3);
 assert.equal(task.state,'completed');
 assert.equal(task.text,'Polish · dziewięć');
 assert.deepEqual(operations,['read_notes']);
 assert.deepEqual(task.usage,{input:20,output:10,reasoning:4});
 assert(attempts[1].input.some(item=>item.encrypted_content==='opaque'));
 assert(attempts[1].input.some(item=>item.type==='function_call_output'&&item.call_id==='c1'));
});
test('Android reuses a finalized compaction item that is missing from the terminal response', async () => {
 const attempts = [], tools = [];
 const compacted = {type:'compaction', id:'cmp_streamed', encrypted_content:'opaque-stream-context'};
 const earlier = {type:'reasoning', id:'reasoning_earlier', encrypted_content:'opaque-earlier-reasoning'};
 const later = {type:'reasoning', id:'reasoning_later', encrypted_content:'opaque-later-reasoning'};
 const finished = output => ({type:'response.completed',response:JSON.parse(reply(output).text)});
 const task = new AgentTask({current:()=>true,key:async()=> 'sk-synthetic-agent-key',gate:{busy:false},streamResponses:true,
  executor:{execute:async name=>{tools.push(name);return {text:'Retained range'};}},
  transport:async req=>{
   const body=JSON.parse(req.body);
   if(attempts.push(body)===1) return stream(
    {type:'response.output_item.done',output_index:0,item:earlier},
    {type:'response.output_item.done',output_index:1,item:compacted},
    {type:'response.output_item.added',output_index:2,item:later},
    {type:'response.output_item.done',output_index:3,item:call('keep')},
    {type:'response.output_item.done',output_index:4,item:{...call('unconfirmed'),name:'create_note'}},
    finished([later,call('keep')]),
   );
   assert.equal(attempts.length,2);
   assert.deepEqual(body.input[0],compacted);
   assert.deepEqual(body.input[1],later);
   assert(body.input.some(item=>item.type==='function_call_output' && item.call_id==='keep'));
   assert(!body.input.some(item=>item.call_id==='unconfirmed' || item.content==='Earlier context'));
   return stream(finished([text('Continued after compaction')]));
  },
 });
 await task.run('Read',{model:'gpt-6.2-sol'},'ask',2,undefined,undefined,
  {autoCompact:true,items:[{role:'user',content:'Earlier context'}]});
 assert.equal(task.state,'completed');
 assert.deepEqual(task.compaction,compacted);
 assert.deepEqual(tools,['read_notes']);
});

test('Android holds the next model request while hidden and keeps the task available to continue', async () => {
 let visible=false, counts=0, requests=0, held=false;
 const task=new AgentTask({current:()=>true,key:async()=> 'sk-synthetic-agent-key',gate:{busy:false},streamResponses:true,
  appVisible:()=>visible,holdScreen:()=>{assert.equal(held,false);held=true;return ()=>{held=false;};},
  executor:{execute:async()=>assert.fail('No tool request is expected')},
  countTokens:async()=>{
   assert.equal(held,true, 'The screen lock also covers token counting');
   if(++counts===1) visible=false;
   return {status:200,text:JSON.stringify({object:'response.input_tokens',input_tokens:35000})};
  },
  transport:async()=>{
   requests++;
   return stream({type:'response.completed',response:JSON.parse(reply([text('Completed')]).text)});
  },
 });
 await task.run('Read',{model:'gpt-6.2-sol'},'ask',2,undefined,undefined,
   {autoCompact:true,items:[{role:'user',content:'Fixture context '.repeat(7000)}]});
 assert.equal(task.connectionPauseReason,'app_hidden');
 assert.equal(task.canResume,true);
 assert.equal(counts,0);
 assert.equal(requests,0);
 visible=true;
 await task.resume(2);
 assert.equal(task.connectionPauseReason,'app_hidden');
 assert.equal(counts,1);
 assert.equal(task.requests,0);
 visible=true;
 await task.resume(2);
 assert.equal(task.state,'completed');
 assert.equal(requests,1);
 assert.equal(counts,1, 'Continue reuses the count for the identical unsent request');
 assert.equal(held,false);
});

test('Android rechecks a paused count after an instruction change, a credential change or the upload expiry window', async t => {
 let now=Date.now();
 t.mock.method(Date,'now',()=>now);
 for(const change of ['steer','credential','expired-file']) {
  let visible=true, counts=0, key='sk-synthetic-agent-key', sent=0;
  const attachments=change==='expired-file' ? {hasUploads:true,prepare:async()=>({parts:[{type:'input_image',file_id:'file-fixture'}],fileIds:['file-fixture']}),cleanup:async()=>true} : undefined;
  const task=new AgentTask({current:()=>true,appVisible:()=>visible,key:async()=>key,gate:{busy:false},streamResponses:true,attachments,
   countTokens:async()=>{if(++counts===1)visible=false;return {status:200,text:JSON.stringify({object:'response.input_tokens',input_tokens:35555})}},
   executor:{execute:async()=>assert.fail('No tools expected')},
   transport:async()=>{sent++;return stream({type:'response.completed',response:JSON.parse(reply([text('Done')]).text)})},
  });
  await task.run('Read',{model:'gpt-6.2-sol'},'ask',2,undefined,undefined,{autoCompact:true,items:[{role:'user',content:'Long test context '.repeat(7000)}]});
  assert.equal(task.canResume,true);
  if(change==='steer')assert(task.addSteer({id:crypto.randomUUID(),text:'Additional instruction',at:Date.now()}));
  else if(change==='credential')key='sk-synthetic-replacement';
  else now+=61*60*1000;
  visible=true;
  await task.resume(2);
  assert.equal(sent,1);
  assert.equal(counts,2,change);
  assert.equal(task.state,'completed');
 }
});

test('Android releases a screen lock when a request ends before the lock is acquired', async () => {
 let finishLock, releases=0;
 const wakeLock={request:async kind=>{
  assert.equal(kind,'screen');
  return new Promise(resolve=>{finishLock=resolve;});
 }};
 const release=holdRequestScreen(wakeLock);
 release();
 finishLock({released:false,release:async()=>{releases++;}});
 await new Promise(resolve=>setImmediate(resolve));
 release();
 assert.equal(releases,1);
});

test('a task screen lock follows visibility during preparation and releases on finish', async () => {
 const owner=new EventTarget();owner.visibilityState='visible';
 const locks=[];
 const wakeLock={request:async()=>{const lock={released:false,release:async()=>{lock.released=true}};locks.push(lock);return lock}};
 const release=holdRequestScreen(wakeLock,owner);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(locks.length,1);
 owner.visibilityState='hidden';owner.dispatchEvent(new Event('visibilitychange'));
 assert.equal(locks[0].released,true);
 owner.visibilityState='visible';owner.dispatchEvent(new Event('visibilitychange'));
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(locks.length,2);
 release();
 owner.dispatchEvent(new Event('visibilitychange'));
 assert.equal(locks[1].released,true);
 assert.equal(locks.length,2);
});

test('Android keeps a confirmed incomplete answer and never executes a partial or cut-off tool', async () => {
 for(const completeStream of [false,true]) {
  let sent=0,writes=0;
  const tool={...call(),name:'create_note'};
  const task=new AgentTask({current:()=>true,key:async()=> 'sk-synthetic-agent-key',gate:{busy:false},streamResponses:true,
   executor:{execute:async()=>{writes++;}},
   transport:async()=>{
    sent++;
    const item={type:'response.output_item.done',item:tool};
    const compact={type:'response.output_item.done',output_index:0,item:{type:'compaction',encrypted_content:'opaque-before-interruption'}};
    return completeStream ? stream(compact,item,{type:'response.incomplete',response:{status:'incomplete',output:[text('Partial answer'),tool]}}) :
     stream(compact,item,{type:'response.in_progress',response:{status:'in_progress',output:[tool]}});
   }});
  await task.run('Write',{model:'gpt-6.1-sol'},'edit',3,undefined,undefined,{autoCompact:true,items:[]});
  assert.equal(task.compaction,null);
  assert.equal(sent,1);
  assert.equal(writes,0);
  assert.equal(task.state,'failed');
  if(completeStream) assert.equal(task.text,'Partial answer');
  else {
   assert.match(task.message,/stream ended before the result was confirmed/i);
   assert.match(task.message,/Obsidian HTTP stream.*HTTP 200.*OpenAI ID req_/);
  }
 }
});
test('Android pauses when the transport reports HTTP 200 without returning the response body', async () => {
  let requests = 0;
  const task = new AgentTask({
    current: () => true, key: async () => 'sk-synthetic-agent-key', gate: { busy: false }, streamResponses: true,
    executor: { execute: async () => assert.fail('The unconfirmed request cannot authorize tool execution') },
    transport: async () => {
      if (++requests === 1) throw { status: 200, message: 'Private interrupted response detail' };
      return stream({ type: 'response.completed', response: JSON.parse(reply([text('Continued.')]).text) });
    },
  });
  await task.run('Read', { model: 'gpt-6.1-sol' }, 'ask', 2);
  assert.equal(task.canResume, true);
  assert.equal(task.connectionPauseReason, 'response_unconfirmed');
  assert.equal(requests, 1);
  assert.match(task.message, /HTTP 200 without a usable confirmation/);
  assert.doesNotMatch(task.message, /Private interrupted response detail/);
  await task.resume(2);
  assert.equal(task.state, 'completed');
  assert.equal(requests, 2);
});

test('Android keeps explicit HTTP errors terminal even when an inner cause looks like a network interruption', async () => {
  let requests = 0;
  const task = new AgentTask({
    current: () => true, key: async () => 'sk-synthetic-agent-key', gate: { busy: false }, streamResponses: true,
    executor: { execute: async () => assert.fail('The request cannot authorize tool execution') },
    transport: async () => {
      requests++;
      throw { status: '429', cause: { name: 'AbortError', message: 'private transport details' } };
    },
  });
  await task.run('Read', { model: 'gpt-6.1-sol' }, 'ask', 'none');
  assert.equal(task.state, 'failed');
  assert.equal(task.canResume, false);
  assert.equal(requests, 1);
  assert.match(task.message, /HTTP 429 reported by Obsidian/);
  assert.doesNotMatch(task.message, /private transport details/);
});

test('data scope and write scope are independent, paths/secrets/configuration never bypass local guards',()=>{
 assert(allowedPath(policy,'Other/B.md','read'));assert(!allowedPath(policy,'Other/B.md','edit'));assert(!allowedPath(policy,'Work/New.md','create'));
 for(const path of ['../A.md','/A.md','C:/A.md','Work/../A.md','.obsidian/settings.md','Private/A.md','Yoofloe AI/Backups/a.md'])assert(!allowedPath(policy,path,'read'));
 assert.throws(()=>vaultPath('Work\\A.md'));assert.throws(()=>safeOutbound('sk-proj-'+ 'a'.repeat(40)));
 assert(!agentTools('ask').some(t=>t.name==='apply_changes'));assert(agentTools('edit').some(t=>t.name==='rename_note'));assert(!agentTools('edit').some(t=>t.name==='propose_trash'));
});
test('All actions exposes every supported tool while keeping independently chosen note scopes',()=>{
 const all={...policy,mode:'all'};
 assert.deepEqual(agentTools('all').map(t=>t.name),agentTools('organize').map(t=>t.name));
 for(const name of ['apply_changes','create_note','update_properties','rename_note','create_folder','propose_trash'])assert(agentTools('all').some(t=>t.name===name));
 assert(allowedPath(all,'Work/A.md','organize'));assert(!allowedPath(all,'Other/B.md','organize'));assert(allowedPath(all,'Other/B.md','read'));
 for(const path of ['.obsidian/settings.md','Private/A.md','Yoofloe AI/Backups/a.md','../outside.md'])assert(!allowedPath({...all,writeScope:'vault'},path,'organize'));
 for(const path of ['private/New.md','PRIVATE/New.md','yoofloe ai/backups/New.md'])assert(!allowedPath({...all,writeScope:'vault'},path,'create'));
 assert(!allowedPath({...all,writeScope:'folder',folder:'Work'},'work/New.md','edit'),'case folding must never broaden a permission scope');
 assert.equal(all.readScope,'vault');assert.equal(all.writeScope,'current');
});
test('a paid step can request a local tool, then continue with encrypted reasoning and one explicit budget',async()=>{
 let calls=0,tools=0;const gate={busy:false};
 const task=new AgentTask({current:()=>true,key:async()=> 'sk-synthetic-agent-key',gate,executor:{execute:async(name)=>{tools++;assert.equal(name,'read_notes');return {text:'Reviewed note',version:'v1'};}},transport:async req=>{
  const body=JSON.parse(req.body);assert.equal(body.store,false);assert.equal(body.parallel_tool_calls,false);assert.equal(body.reasoning.effort,'high');assert(!('max_output_tokens'in body));
  if(calls++===0)return reply([{type:'reasoning',id:'r',encrypted_content:'opaque'},call()]);
  assert(body.input.some(i=>i.type==='reasoning'&&i.encrypted_content==='opaque'));assert(body.input.some(i=>i.type==='function_call_output'&&i.call_id==='c1'));return reply([text('Read the note.')]);
 }});
 assert.equal(calls,0);await task.run('{"request":"Read"}',{model:'gpt-6-luna',effort:'high'},'ask',2);
 assert.equal(calls,2);assert.equal(tools,1);assert.equal(task.text,'Read the note.');assert.deepEqual(task.usage,{input:20,output:10,reasoning:4});assert.equal(gate.busy,false);
});
test('stopping preserves an in-flight answer but prevents tool execution and further model requests',async()=>{
 let finish,calls=0,tools=0;const task=new AgentTask({current:()=>true,key:async()=> 'sk-synthetic-agent-key',gate:{busy:false},executor:{execute:async()=>{tools++;}},transport:async()=>{calls++;return await new Promise(r=>{finish=r;});}});
 const pending=task.run('Read',{model:'gpt-6-luna'},'edit',4);for(let i=0;i<20&&!finish;i++)await new Promise(r=>setTimeout(r,1));task.stop();finish(reply([text('Paid answer retained'),call()]));await pending;
 assert.equal(task.text,'Paid answer retained');assert.equal(calls,1);assert.equal(tools,0);
});
test('duplicate tool IDs execute once, budgets stop loops and network errors never retry',async()=>{
 let tools=0,calls=0;const task=new AgentTask({current:()=>true,key:async()=> 'sk-synthetic-agent-key',gate:{busy:false},executor:{execute:async()=>{tools++;return {ok:true};}},transport:async()=>{calls++;return reply([call()]);}});
 await task.run('Read',{model:'gpt-6-luna'},'ask',2);assert.equal(calls,2);assert.equal(tools,1);assert(task.message.includes('limit'));
 const fail=new AgentTask({current:()=>true,key:async()=> 'sk-synthetic-agent-key',gate:{busy:false},executor:{execute:async()=>{}},transport:async()=>{throw Error('provider secret details');}});await fail.run('Read',{model:'gpt-6-luna'},'ask',4);assert.equal(fail.requests,1);assert(!fail.message.includes('provider secret'));
 assert.throws(()=>parseAgentReply(200,'{"status":"completed","output":[]}'));
});

test('a timeout at the third HTTP step keeps prior usage and records only safe request metadata', async () => {
  const ids = [], toolCalls = [];
  const task = new AgentTask({
    current: () => true,
    key: async () => 'sk-synthetic-agent-key',
    gate: { busy: false },
    executor: { execute: async name => {
      toolCalls.push(name);
      return { notes: [{ path: 'Synthetic.md', text: 'Private fixture note body' }] };
    } },
    transport: async request => {
      ids.push(request.headers['X-Client-Request-Id']);
      if (ids.length === 1) return { ...reply([{ ...call('outline'), name: 'read_outline', arguments: '{}' }]),
        headers: { 'X-Request-ID': 'req_a0123456789abcde0123456789abcdef', 'OpenAI-Processing-Ms': '27', 'Unrelated': 'private header' } };
      if (ids.length === 2) return reply([call('notes')]);
      assert(JSON.parse(request.body).input.some(item => item.type === 'function_call_output' && item.call_id === 'notes'));
      throw new Error('java.net.SocketTimeoutException: Private fixture note body and sk-synthetic-agent-key');
    },
  });
  await task.run('Private fixture prompt', { model: 'gpt-6.1-sol', effort: 'high' }, 'ask', 'none');
  assert.deepEqual(toolCalls, ['read_outline', 'read_notes']);
  assert.equal(task.state, 'failed');
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 3);
  assert(ids.every(id => /^[a-f0-9-]{36}$/.test(id)));
  assert.deepEqual(task.usage, { input: 20, output: 10, reasoning: 4 });
  assert.match(task.message, /OpenAI request 3 timed out.*No retry was made/);
  assert(task.message.includes(ids[2]));
  assert.match(task.message, /Obsidian HTTP · \d+ ms · \d+ B/);
  assert.match(task.events.find(event => event.kind === 'response').text, /HTTP 200.*OpenAI ID req_a0123456789abcde0123456789abcdef.*OpenAI 27 ms/);
  assert.doesNotMatch(JSON.stringify(task.events), /Private fixture|sk-synthetic|private header/);
});

test('returned HTTP, host-reported HTTP and unreadable responses retain safe diagnostics', async () => {
  const scenarios = [
    [async () => ({ status: 429, text: '{"error":{"code":"insufficient_quota","param":"input[123].content[456].file_id"}}', headers: { 'x-request-id': 'req_private_note_title' } }), /rate or quota limit.*HTTP 429.*insufficient_quota.*client ID/],
    [async () => { throw 'Request failed, status 504'; }, /HTTP 504 reported by Obsidian/],
    [async () => { throw { code: 'ERR_NAME_NOT_RESOLVED', message: 'private transport detail' }; }, /could not resolve the OpenAI host/],
    [async () => { throw new Error('Unable to resolve host "proxy.example.org": private transport detail'); }, /could not resolve the OpenAI host/],
    [async () => { throw { status: 502, code: 'ENOTFOUND', hostname: 'api.openai.com' }; }, /HTTP 502 reported by Obsidian/],
    [async () => ({ status: 200, text: '{"status":"failed","error":{"code":"server_error","message":"private provider error"}}' }), /failed response \(server_error\).*HTTP 200/],
    [async () => ({ status: 200, text: 'private malformed response body' }), /unreadable response.*HTTP 200/],
  ];
  for (const [response, expected] of scenarios) {
    let calls = 0;
    const task = new AgentTask({ current: () => true, key: async () => 'sk-synthetic-agent-key', gate: { busy: false },
      executor: { execute: async () => assert.fail('No tool may run') }, transport: async () => { calls++; return response(); } });
    await task.run('Read', { model: 'gpt-6-luna' }, 'ask', 2);
    assert.equal(calls, 1);
    assert.equal(task.state, 'failed');
    assert.match(task.message, expected);
    assert.doesNotMatch(task.message, /private|content\[456\]/);
  }
});

test('a steer held by an OpenAI host lookup failure is included once when the user continues', async () => {
  const inputs = [], statuses = [];
  const steer = { id: 'additional', text: 'Keep this extra instruction.', at: Date.now() };
  const task = new AgentTask({
    current: () => true,
    key: async () => 'sk-synthetic-agent-key',
    gate: { busy: false },
    executor: { execute: async () => assert.fail('No tool may run') },
    steerStatus: (_note, status) => statuses.push(status),
    transport: async request => {
      const number = inputs.push(JSON.parse(request.body).input);
      if (number === 1) { assert(task.addSteer(steer)); return reply([text('Initial answer.')]); }
      if (number === 2) throw { code: 'EAI_AGAIN', hostname: 'api.openai.com' };
      return reply([text('Continued.')]);
    },
  });

  await task.run('Read', { model: 'gpt-6-luna' }, 'ask', 'none');
  assert.equal(task.canResume, true);
  assert.equal(task.pausedForConnection, true);
  assert.equal(inputs.length, 2);
  assert.deepEqual(statuses, ['sending', 'steer-pending']);
  await task.resume('none');
  assert.equal(task.state, 'completed');
  assert.equal(inputs[2].filter(item => item.role === 'user' && item.content === steer.text).length, 1);
  assert.deepEqual(statuses, ['sending', 'steer-pending', 'sending', 'applied']);
});

test('a steer acknowledged by a policy-rejected reply is preserved without being offered for dispatch again', async () => {
  for (const desktop of [false, true]) {
    let firstRequest, finishFirst, requests = 0;
    const sent = [];
    const first = new Promise(resolve => { firstRequest = resolve; });
    const responses = async body => {
      if (++requests === 1) {
        firstRequest();
        await new Promise(resolve => { finishFirst = resolve; });
        return reply([text('First answer')]);
      }
      assert(body.input.some(item => item.role === 'user' && item.content === 'Focus on my note'));
      return reply([{ type: 'web_search_call' }, text('Unusable web result')]);
    };
    const task = new AgentTask({ current: () => true, gate: { busy: false }, key: async () => 'sk-synthetic-agent-key',
      executor: { execute: async () => assert.fail('No local tool') }, steerStatus: (_note, status) => sent.push(status),
      transport: async request => { assert.equal(desktop, false); return responses(JSON.parse(request.body)); },
      ...(desktop ? { liveResponse: async () => ({
        request: async body => ({ response: (await responses(JSON.parse(body))).text }),
        close() {},
      }) } : {}),
    });
    const running = task.run('Read', { model: 'gpt-6-luna' }, 'ask', 3);
    await first;
    assert.equal(task.addSteer({ id: 'steer', text: 'Focus on my note' }), true);
    finishFirst();
    await running;
    assert.equal(requests, 2);
    assert.equal(task.state, 'failed');
    assert.deepEqual(sent, ['sending', 'received']);
    assert.deepEqual(task.steerNotes.map(note => note.text), ['Focus on my note']);
    assert.equal(task.text, 'First answer');
    assert.match(task.message, /rejected in Provided materials only mode/);
  }
});
test('stopping an in-flight tool-only answer retains the unapplied document proposal',async()=>{
 let finish,tools=0;const task=new AgentTask({current:()=>true,key:async()=> 'sk-synthetic-agent-key',gate:{busy:false},executor:{execute:async()=>{tools++;}},transport:async()=>await new Promise(r=>{finish=r;})});
 const pending=task.run('Create a note',{model:'gpt-6-luna'},'edit',2);while(!finish)await new Promise(r=>setTimeout(r,1));task.stop();finish(reply([{type:'function_call',call_id:'new',name:'create_note',arguments:JSON.stringify({path:'Draft.md',markdown:'# Retained proposal'})}]));await pending;
 assert.equal(tools,0);assert.match(task.text,/Retained proposal/);assert.match(task.text,/not executed/);
});

test('a safe-step steer supersedes unstarted local actions and elapsed time excludes a pause', async t => {
  let clock = 10000, release, calls = 0, tools = 0;
  t.mock.method(Date, 'now', () => clock);
  const statuses = [];
  const task = new AgentTask({
    current: () => true, key: async () => 'sk-synthetic-agent-key', gate: { busy: false },
    steerStatus: (_note, status) => statuses.push(status),
    executor: { execute: async () => { tools++; return {}; } },
    transport: async req => {
      const body = JSON.parse(req.body);
      if (++calls === 1) return await new Promise(resolve => { release = resolve; });
      assert(body.input.some(item => item.role === 'user' && item.content === 'Keep the note untouched'));
      const output = body.input.find(item => item.type === 'function_call_output');
      assert.equal(JSON.parse(output.output).status, 'superseded');
      clock += 1250;
      return reply([{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'Checked the allowed scope' }] }, text('Left the note untouched')]);
    },
  });
  const pending = task.run('Edit note', { model: 'gpt-6-luna' }, 'edit', 1);
  await new Promise(resolve => setImmediate(resolve));
  clock += 2300;
  assert.equal(task.durationMs, 2300);
  assert(task.addSteer({ id: 'later', text: 'Keep the note untouched' }));
  release(reply([{ ...call('stale-edit'), name: 'apply_changes', arguments: '{"changes":[]}' }]));
  await pending;
  assert.equal(task.state, 'paused');
  assert.equal(tools, 0);
  assert.deepEqual(statuses, []);
  clock += 10000;
  assert.equal(task.durationMs, 2300);
  await task.resume(2);
  assert.equal(task.durationMs, 3550);
  assert.equal(task.text, 'Left the note untouched');
  assert.equal(calls, 2);
  assert.deepEqual(statuses, ['sending', 'applied']);
  assert.equal(task.steerNotes[0].text, 'Keep the note untouched');
  assert(task.events.some(event => event.kind === 'summary' && event.text === 'Checked the allowed scope'));
});

test('automatic compaction prunes the next request at the encrypted item and retains pending local tool output', async () => {
  const inputs = [];
  const compact = { type: 'compaction', id: 'cmp_test', encrypted_content: 'encrypted-state-123' };
  const task = new AgentTask({
    current: () => true, key: async () => 'sk-synthetic-agent-key', gate: { busy: false },
    executor: { execute: async () => ({ notes: [] }) },
    transport: async req => {
      inputs.push(JSON.parse(req.body));
      return inputs.length === 1 ? reply([call('pending'), compact]) : reply([text('Continued after compaction')]);
    },
  });
  await task.run('Current request', { model: 'gpt-6-luna' }, 'ask', 2, undefined, null, {
    autoCompact: true, items: [{ role: 'user', content: 'Prior conversation context' }],
  });
  assert.equal(inputs.length, 2);
  assert.deepEqual(inputs[0].context_management, [{ type: 'compaction', compact_threshold: 32000 }]);
  assert.equal(inputs[0].store, false);
  assert.equal(inputs[0].input[0].content, 'Prior conversation context');
  assert.deepEqual(inputs[1].input[0], compact);
  assert(!JSON.stringify(inputs[1].input).includes('Prior conversation context'));
  assert(inputs[1].input.some(item => item.type === 'function_call' && item.call_id === 'pending'));
  assert(inputs[1].input.some(item => item.type === 'function_call_output' && item.call_id === 'pending'));
  assert(task.events.some(event => event.text === 'Conversation context compacted.'));
  assert(!JSON.stringify(task.events).includes(compact.encrypted_content));
});
