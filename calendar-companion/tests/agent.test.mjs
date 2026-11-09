import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedPath, vaultPath, safeOutbound } from '../dist/agent-policy.js';
import { AgentTask } from '../dist/agent-task.js';
import { agentTools, parseAgentReply } from '../dist/agent-protocol.js';
const policy={sourcePath:'Work/A.md',folder:'Work',readScope:'vault',writeScope:'current',mode:'edit',configDir:'.obsidian',excluded:['Private']};
const reply=output=>({status:200,text:JSON.stringify({status:'completed',output,usage:{input_tokens:10,output_tokens:5,output_tokens_details:{reasoning_tokens:2}}})});
const call=(id='c1')=>({type:'function_call',call_id:id,name:'read_notes',arguments:'{"notes":[]}'});
const text=message=>({type:'message',role:'assistant',content:[{type:'output_text',text:message}]});
test('data scope and write scope are independent, paths/secrets/configuration never bypass local guards',()=>{
 assert(allowedPath(policy,'Other/B.md','read'));assert(!allowedPath(policy,'Other/B.md','edit'));assert(allowedPath(policy,'Work/New.md','create'));
 for(const path of ['../A.md','/A.md','C:/A.md','Work/../A.md','.obsidian/settings.md','Private/A.md','Yoofloe AI/Backups/a.md'])assert(!allowedPath(policy,path,'read'));
 assert.throws(()=>vaultPath('Work\\A.md'));assert.throws(()=>safeOutbound('sk-proj-'+ 'a'.repeat(40)));
 assert(!agentTools('ask').some(t=>t.name==='apply_changes'));assert(!agentTools('edit').some(t=>t.name==='rename_note'));
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
test('stopping an in-flight tool-only answer retains the unapplied document proposal',async()=>{
 let finish,tools=0;const task=new AgentTask({current:()=>true,key:async()=> 'sk-synthetic-agent-key',gate:{busy:false},executor:{execute:async()=>{tools++;}},transport:async()=>await new Promise(r=>{finish=r;})});
 const pending=task.run('Create a note',{model:'gpt-6-luna'},'edit',2);while(!finish)await new Promise(r=>setTimeout(r,1));task.stop();finish(reply([{type:'function_call',call_id:'new',name:'create_note',arguments:JSON.stringify({path:'Draft.md',markdown:'# Retained proposal'})}]));await pending;
 assert.equal(tools,0);assert.match(task.text,/Retained proposal/);assert.match(task.text,/not executed/);
});
