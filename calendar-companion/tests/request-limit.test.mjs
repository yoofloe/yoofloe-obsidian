import test from 'node:test';
import assert from 'node:assert/strict';
import { requestLimit, customRequestLimit } from '../dist/request-limit.js';
import { AgentTask } from '../dist/agent-task.js';
const reply=output=>({status:200,text:JSON.stringify({status:'completed',output,usage:{input_tokens:10,output_tokens:5}})});
const call=(id,n=0)=>({type:'function_call',call_id:id,name:'read_notes',arguments:JSON.stringify({notes:[{reference:'N1',from_line:0,through_line:n}]})});
const text=value=>({type:'message',role:'assistant',content:[{type:'output_text',text:value}]});
test('custom counts have no arbitrary ten-request ceiling; none is explicit and JSON-safe',()=>{
 for(const n of [1,4,11,20,1000,Number.MAX_SAFE_INTEGER])assert.equal(requestLimit(n),n);
 assert.equal(requestLimit('none'),'none');assert.equal(JSON.parse(JSON.stringify({maximum:'none'})).maximum,'none');
 for(const n of [0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,null,'4'])assert.throws(()=>requestLimit(n));
 assert.equal(customRequestLimit(' 20 '),20);for(const v of ['','0','-1','1.5','1e3','abc','99999999999999999999'])assert.equal(customRequestLimit(v),null);
});
for(const maximum of ['none',20])test(`${maximum}: task finishes after more than ten requests without truncation or retries`,async()=>{
 let calls=0,tools=0;const task=new AgentTask({current:()=>true,key:async()=> 'sk-synthetic-agent-key',gate:{busy:false},executor:{execute:async()=>({step:++tools})},transport:async()=>reply(++calls<=12?[call('c'+calls,calls)]:[text('All steps completed.')])});
 await task.run('Read relevant excerpts',{model:'gpt-6-luna'},'ask',maximum);assert.equal(calls,13);assert.equal(tools,12);assert.equal(task.requests,13);assert.equal(task.state,'completed');assert.equal(task.text,'All steps completed.');
});
test('finite pause resumes the same tool context, IDs and cumulative count with a higher total budget',async()=>{
 let calls=0,tools=0,keyReads=0;const model={model:'gpt-6-luna'};
 const task=new AgentTask({current:()=>true,key:async()=>{keyReads++;return 'sk-synthetic-agent-key';},gate:{busy:false},executor:{execute:async()=>({step:++tools})},transport:async request=>{
  const body=JSON.parse(request.body);calls++;assert.equal(body.model,'gpt-6-luna');
  if(calls===1)return reply([call('once')]);assert(body.input.some(i=>i.type==='function_call_output'&&i.call_id==='once'));return reply([text('Continued without replay.')]);
 }});
 await task.run('A multi-step task',model,'ask',1);assert.equal(task.state,'paused');assert.equal(tools,1);await assert.rejects(task.resume(1));assert.equal(keyReads,1);
 model.model='other-model';await task.resume('none');assert.equal(task.state,'completed');assert.equal(task.requests,2);assert.equal(calls,2);assert.equal(tools,1);assert.equal(keyReads,2);
});
test('unlimited mode stops exact no-progress loops without automatic retry',async()=>{
 let calls=0,tools=0;const task=new AgentTask({current:()=>true,key:async()=> 'sk-synthetic-agent-key',gate:{busy:false},executor:{execute:async()=>{tools++;return {same:true};}},transport:async()=>{calls++;return reply([call('same')]);}});
 await task.run('Find a note',{model:'gpt-6-luna'},'ask','none');assert.equal(calls,3);assert.equal(tools,1);assert.equal(task.state,'failed');assert.match(task.message,/repeated loop/);
});
test('three blocked steps stop even when the model varies failed arguments',async()=>{
 let calls=0;const task=new AgentTask({current:()=>true,key:async()=> 'sk-synthetic-agent-key',gate:{busy:false},executor:{execute:async()=>{throw Error('Outside approved scope');}},transport:async()=>reply([call('c'+(++calls),calls)])});
 await task.run('A blocked task',{model:'gpt-6-luna'},'ask','none');assert.equal(calls,3);assert.equal(task.state,'failed');assert.match(task.message,/Three consecutive/);
});
