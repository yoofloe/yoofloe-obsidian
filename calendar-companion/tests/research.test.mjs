import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentTask } from '../dist/agent-task.js';
import { parseAgentReply } from '../dist/agent-protocol.js';
import { effectiveSourceMode, onlineTools, publicUrl, sourceInstructions } from '../dist/research.js';
import { AiWorkspace } from '../dist/workspace.js';
import { chatMatches, searchChatPreview } from '../dist/chat-history.js';

const message=text=>({type:'message',role:'assistant',content:[{type:'output_text',text}]});
const response=output=>({status:200,text:JSON.stringify({status:'completed',output,usage:{input_tokens:3,output_tokens:2}})});
function task(transport,extra={}){return new AgentTask({current:()=>true,key:async()=> 'sk-synthetic-agent-key',gate:{busy:false},executor:{execute:async()=>({ok:true})},transport,...extra});}

test('expanded tools include live search; supplied-material analysis has no network or web capability',()=>{
 const full=onlineTools('expanded','none'),restricted=onlineTools('provided','none');
 assert(full.some(x=>x.type==='web_search'&&x.external_web_access===true));assert(!restricted.some(x=>x.type==='web_search'));
 assert.equal(restricted.find(x=>x.type==='code_interpreter').container.network_policy.type,'disabled');
 assert.equal(restricted.find(x=>x.type==='image_generation').model,'gpt-image-2.6-flare');
 assert.deepEqual(onlineTools('expanded',0),[]);assert.match(sourceInstructions('provided'),/Do not search/);
 for(const url of ['javascript:alert(1)','file:///etc/passwd','https://key@host.example','https://example.com/\nsecret'])assert.equal(publicUrl(url),null);
});

test('image planning uses valid levels without changing the selected text-model thinking depth',async()=>{
 for(const [effort,complexity] of [['none','low'],['low','low'],['medium','medium'],['high','high'],['xhigh','high'],['max','high'],['default','low']]){
  let calls=0;const t=task(async request=>{calls++;const body=JSON.parse(request.body);assert.equal(body.reasoning?.effort,effort==='default'?undefined:effort);assert.equal(body.tools.find(tool=>tool.type==='image_generation').complexity,complexity);return response([message('A synthetic image response.')]);});
  await t.run('{"request":"Create an image"}',{model:'gpt-6-luna',effort},'ask',1,{mode:'provided',maximum:1});assert.equal(t.state,'completed');assert.equal(calls,1);
 }
});

test('web citations become clickable Markdown and hosted tool state is retained for stateless continuation',()=>{
 const raw=response([{type:'web_search_call',id:'w',status:'completed',action:{type:'search',sources:[{url:'https://example.org/statistics',title:'Statistics'}]}},{type:'message',role:'assistant',content:[{type:'output_text',text:'😀 통계 결과',annotations:[{type:'url_citation',start_index:2,end_index:4,title:'Official data',url:'https://example.org/statistics'}]}]}]);
 const r=parseAgentReply(raw.status,raw.text);assert.equal(r.online.search,1);assert.match(r.text,/😀 \[통계\]\(https:\/\/example.org\/statistics\)/);assert.equal(r.sources.length,1);assert(r.output.some(x=>x.type==='web_search_call'));
});
test('rendered provider citation text uses a readable label and does not dump all consulted URLs into the answer',()=>{
 const citation='(example.org (https://example.org/used))',raw=response([{type:'web_search_call',id:'w',status:'completed',action:{type:'search',sources:[{url:'https://example.org/unrelated?client_id=123',title:'Other'}]}},{type:'message',role:'assistant',content:[{type:'output_text',text:'Fact. '+citation,annotations:[{type:'url_citation',start_index:6,end_index:6+citation.length,title:'Official source',url:'https://example.org/used'}]}]}]);
 const reply=parseAgentReply(raw.status,raw.text);assert(reply.text.includes('[Official source](https://example.org/used)'));assert(!reply.text.includes('client_id'));assert.equal(reply.citations.length,1);assert.equal(reply.sources.length,2);
});
test('an already returned image is kept locally after Stop without granting note actions',async()=>{
 let finish,alive=true,staged=0,writes=0;
 const t=task(async()=>await new Promise(resolve=>{finish=resolve;}),{current:()=>alive,preserve:()=>true,generated:{stage:async(_files,_key,current)=>{assert(current());staged++;return[{id:crypto.randomUUID(),name:'image.png',extension:'png',bytes:1,sha256:'a'.repeat(64)}];}},executor:{execute:async()=>{writes++;}}});
 const running=t.run('{"request":"Generate an image"}',{model:'gpt-6-luna'},'edit',1,{mode:'expanded',maximum:1});while(!finish)await new Promise(r=>setTimeout(r,1));t.stop();alive=false;
 finish(response([{type:'image_generation_call',id:'image',result:'AA==',status:'completed'},message('Returned image.') ]));await running;assert.equal(t.state,'stopped');assert.equal(staged,1);assert.equal(writes,0);assert.equal(t.generated.length,1);
});

test('online tool budget is enforced on the actual request and separate usage is counted',async()=>{
 let calls=0;const t=task(async req=>{const body=JSON.parse(req.body);if(++calls===1){assert.equal(body.max_tool_calls,1);return response([{type:'web_search_call',id:'w',status:'completed',action:{type:'search',sources:[]}},{type:'function_call',call_id:'r',name:'read_notes',arguments:'{}'}]);}assert(!body.tools.some(x=>x.type==='web_search'));return response([message('Finished with gathered evidence.')]);});
 await t.run('{"request":"Review the public evidence"}',{model:'gpt-6-luna'},'ask',4,{mode:'expanded',maximum:1});assert.equal(t.onlineCalls,1);assert.equal(t.requests,2);
});

test('provided-only rejects an unexpected server web result before local tools run',async()=>{
 let writes=0;const t=task(async()=>response([{type:'web_search_call',id:'unexpected'},message('Outside data'),{type:'function_call',call_id:'bad',name:'create_note',arguments:'{}'}]),{executor:{execute:async()=>{writes++;}}});
 await t.run('{"request":"Use only my materials"}',{model:'gpt-6-luna'},'edit',1,{mode:'provided',maximum:'none'});assert.equal(writes,0);assert.equal(t.state,'failed');assert.match(t.message,/unexpected web result/);
});

test('saved expanded history is excluded from provided-only context while local history is kept',async()=>{
 let saved;const w=new AiWorkspace({current:()=>true,preferences:{read:async()=>({model:'gpt-6-luna'}),hasKey:async()=>true},gate:{busy:false},configDir:'.obsidian',host:()=>({files:()=>[]}),transport:async()=>{throw Error('No request allowed');},inboxHint:()=>'',storage:{load:async()=>({previous:[{request:'A',answer:'WEB SECRET',sourceMode:'expanded'},{request:'B',answer:'Provided fact',sourceMode:'provided'}]}),save:async v=>{saved=v;},history:async()=>[]}});
 await w.initialize();assert.equal(w.sourceMode,'expanded');assert.equal(w.maximum,'none');assert.equal(w.onlineMaximum,'none');w.setSourceMode('provided');w.setPrompt('Summarize my material');await w.review();assert(!w.preview.includes('WEB SECRET'));assert(w.preview.includes('Provided fact'));assert.equal(w.previous.length,2);await w.persist();assert.equal(saved.sourceMode,'provided');
});

test('local conversation search finds long answers and attachment names without discarding full records',()=>{
 const turn={id:'a',request:'Hello',answer:'x'.repeat(40000)+' SEARCH-ME '+'y'.repeat(5000),actions:[],attachments:[{name:'meeting.wav'}]};
 assert(chatMatches(turn,'search-me'));assert(chatMatches(turn,'MEETING'));const p=searchChatPreview(turn,'SEARCH-ME');assert(p.answer.includes('SEARCH-ME'));assert(p.answerTruncated);assert(turn.answer.length>40000);
});
test('explicit no-search requests narrow Expanded mode and are never forced by a news keyword',async()=>{
 for(const request of ['Translate the attached news excerpt; do not search the web.','첨부 뉴스만 번역해. 웹 검색하지 마.','Use only the provided materials.']){
  assert.equal(effectiveSourceMode('expanded',request),'provided');let calls=0;
  const t=task(async req=>{calls++;const b=JSON.parse(req.body);assert(!b.tool_choice);assert(!b.tools.some(tool=>tool.type==='web_search'));return response([message('Translated supplied content.')]);});
  await t.run(JSON.stringify({request}),{model:'gpt-6-luna'},'edit',1,{mode:'expanded',maximum:'none'});assert.equal(t.state,'completed');assert.equal(calls,1);
 }
});
test('answer-only research completes in one request and retains sources across later local-tool turns',async()=>{
 let calls=0;const t=task(async()=>{calls++;return response([{type:'web_search_call',id:'w',status:'completed',action:{type:'search',sources:[{url:'https://example.org/data',title:'Data'}]}},message('The answer is here.')]);});
 await t.run('{"request":"Search the web and answer only. Do not change notes."}',{model:'gpt-6-luna'},'edit',1,{mode:'expanded',maximum:'none'});assert.equal(calls,1);assert.equal(t.state,'completed');assert(t.text.includes('https://example.org/data'));
 let round=0;const follow=task(async()=>response(++round===1?[{type:'web_search_call',id:'web',status:'completed',action:{type:'search',sources:[{url:'https://example.org/earlier',title:'Earlier source'}]}},{type:'function_call',call_id:'r',name:'read_notes',arguments:'{}'}]:[message('Final answer after reading a note.')]));
 await follow.run('{"request":"Research a topic"}',{model:'gpt-6-luna'},'ask',4,{mode:'expanded',maximum:'none'});assert.equal(round,2);assert(follow.text.includes('https://example.org/earlier'));
});
test('Custom text models do not receive guessed hosted-tool configurations',async()=>{
 assert.deepEqual(onlineTools('expanded','none',[],'gpt-5.4-pro'),[]);let calls=0;
 const t=task(async req=>{calls++;const b=JSON.parse(req.body);assert(b.tools.every(tool=>tool.type==='function'));assert(!b.tool_choice);return response([message('A simple rewrite.')]);});
 await t.run('{"request":"Rewrite this sentence"}',{model:'gpt-5.4-pro'},'edit',1,{mode:'expanded',maximum:'none'});assert.equal(calls,1);assert.equal(t.state,'completed');
});
test('successfully generated files count as progress across several replies',async()=>{
 let round=0;const t=task(async()=>response(++round<=3?[{type:'image_generation_call',id:'image'+round,result:'AA==',status:'completed'},message('Image prepared.')]:round===4?[{type:'function_call',call_id:'save',name:'create_note',arguments:'{}'}]:[message('Document created.')]),{writeScope:'new',generated:{stage:async()=>[{id:crypto.randomUUID(),name:'image.png',extension:'png',bytes:1,sha256:'a'.repeat(64)}]}});
 await t.run('{"request":"Create a Markdown note with the generated images"}',{model:'gpt-6-luna'},'edit','none',{mode:'expanded',maximum:'none'});assert.equal(t.state,'completed');assert.equal(round,5);assert.equal(t.generated.length,3);
});


test('Current note stops after a generated result when automatic file saving is unavailable',async()=>{
 let calls=0;const t=task(async request=>{calls++;assert(!JSON.parse(request.body).tools.some(tool=>tool.name==='save_generated_file'));return response([{type:'image_generation_call',id:'image',result:'AA==',status:'completed'},message('Generated the image.')]);},{writeScope:'current',generated:{stage:async()=>[{id:crypto.randomUUID(),name:'image.png',extension:'png',bytes:1,sha256:'a'.repeat(64)}]}});
 await t.run('{"request":"Create a Markdown note and save the generated image"}',{model:'gpt-6-luna'},'all',1,{mode:'provided',maximum:1});
 assert.equal(t.state,'completed');assert.equal(t.canResume,false);assert.equal(calls,1);assert.equal(t.generated.length,1);assert(t.text.includes('Choose Save attachment'));
});
