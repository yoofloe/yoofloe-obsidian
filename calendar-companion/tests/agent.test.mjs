import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedPath, vaultPath, safeOutbound } from '../dist/agent-policy.js';
import { AgentTask, AGENT_INSTRUCTION } from '../dist/agent-task.js';
import { agentTools, parseAgentReply } from '../dist/agent-protocol.js';
test('rename instructions permit user-requested filenames instead of conflicting preservation guidance',()=>{assert(AGENT_INSTRUCTION.includes('unless the user requests a rename or move'));assert(!AGENT_INSTRUCTION.includes('Existing filenames and user edits must be preserved.'));});
const policy={sourcePath:'Work/A.md',folder:'Work',readScope:'vault',writeScope:'current',mode:'edit',configDir:'.obsidian',excluded:['Private']};
const reply=output=>({status:200,text:JSON.stringify({status:'completed',output,usage:{input_tokens:10,output_tokens:5,output_tokens_details:{reasoning_tokens:2}}})});
const call=(id='c1')=>({type:'function_call',call_id:id,name:'read_notes',arguments:'{"notes":[]}'});
const text=message=>({type:'message',role:'assistant',content:[{type:'output_text',text:message}]});
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
