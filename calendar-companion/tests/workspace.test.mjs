import test from 'node:test';
import assert from 'node:assert/strict';
import { AiWorkspace } from '../dist/workspace.js';
import { inputDigest } from '../dist/question-input.js';
import { chatPreview } from '../dist/chat-history.js';
const response = output => ({ status: 200, text: JSON.stringify({ status: 'completed', output }) });
function fixture() {
  let saved, calls = 0, keyReads = 0;
  const files = new Map(), journals = [], backups = new Map();
  const host = { files: () => [...files.values()], read: async f => f.text,
    create: async (path, text) => { const f = { identity: {}, path, title: path, size: text.length, text }; files.set(path, f); return f; },
    replace: async (f, expected, text) => { assert.equal(f.text,expected); f.text=text; },
    trash: async f => { files.delete(f.path); },
    persist: async j => journals.push(structuredClone(j)),
    backup: async (_path,text) => { const path=`Yoofloe AI/Backups/${crypto.randomUUID()}.md`;backups.set(path,text);return path; },readBackup: async path => backups.get(path) };
  const model = { model: 'gpt-6-luna', effort: 'low' };
  const options = { current: () => true, preferences: { read: async () => model, hasKey: async () => true, key: async () => { keyReads++; return 'sk-synthetic-agent-key'; }, save: async v => Object.assign(model, v), vaultId: async () => crypto.randomUUID() },
    configDir: '.obsidian', gate: { busy: false }, host: () => host, inboxHint: () => 'content://hint',
    storage: { load: async () => null, save: async v => { saved = structuredClone(v); }, history: async () => [] },
    transport: async request => { calls++; const body = JSON.parse(request.body); assert.equal(body.reasoning.effort, 'low');
      if (calls === 1) return response([{ type: 'function_call', call_id: 'new', name: 'create_note', arguments: JSON.stringify({ path: 'Welcome.md', markdown: '# Welcome\n```mermaid\ngraph TD; A-->B\n```' }) }]);
      assert(body.input.some(item => item.type === 'function_call_output'));
      return response([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Created [[Welcome]].' }] }]); },
  };
  return { work: new AiWorkspace(options), options, host, files, journals, saved: () => saved, calls: () => calls, keyReads: () => keyReads };
}
test('saving a generated attachment updates the full archive and also works for older search-only turns',async()=>{
 const f=fixture(),assets=new Map();f.host.assetHash=async path=>assets.get(path)??null;f.host.createAsset=async(file,path)=>assets.set(path,file.sha256);
 const generated=Array.from({length:40},(_,i)=>({id:crypto.randomUUID(),name:`file${i}.png`,extension:'png',bytes:10,sha256:'a'.repeat(64)}));
 const full={id:'long-chat',request:'r'.repeat(5000),answer:'a'.repeat(22000)+' END',startedAt:1,model:'gpt-6-luna',status:'completed',requests:1,inputTokens:1,outputTokens:1,actions:[],generated};let stored=structuredClone(full);
 f.options.storage.loadChat=async id=>{assert.equal(id,'long-chat');return structuredClone(stored);};f.options.storage.saveChat=async turn=>{stored=structuredClone(turn);};
 await f.work.initialize();f.work.chat=[chatPreview(full)];assert(f.work.chat[0].generatedTruncated);assert.equal(f.work.chat[0].answer.length,16000);
 await f.work.saveGeneratedFile('long-chat',generated[0].id);assert.equal(stored.request,full.request);assert.equal(stored.answer,full.answer);assert.equal(stored.generated.length,40);assert.equal(assets.size,1);assert.equal(f.work.writeScope,'current','a manual attachment save must not widen AI permissions');
 f.work.chat=[];await f.work.saveGeneratedFile('long-chat',generated[39].id);assert.equal(assets.size,2);assert.equal(stored.answer,full.answer);assert.equal(stored.generated.length,40);assert.equal(f.calls(),0);assert.equal(f.keyReads(),0);
});
test('completed attachments leave the composer and can be explicitly attached again without network work',async()=>{
 const f=fixture();await f.work.initialize();const file={id:crypto.randomUUID(),name:'sample.txt',extension:'txt',kind:'document',mime:'text/plain',bytes:6,sha256:'a'.repeat(64)};
 f.options.attachments={forTask:()=>({prepare:async()=>({parts:[{type:'input_text',text:'Sample'}],fileIds:[]}),cleanup:async()=>true})};f.work.attachments=[file];
 f.work.setPrompt('Create a note from the sample');await f.work.run();assert.equal(f.work.attachments.length,0);assert.equal(f.work.chat.at(-1).attachments.length,1);const calls=f.calls();
 f.work.useAttachments(f.work.chat.at(-1).attachments);assert.equal(f.work.attachments.length,1);assert.equal(f.calls(),calls);
});
test('a no-search instruction in Expanded also removes earlier web-derived context before dispatch',async()=>{
 const f=fixture();f.options.storage.load=async()=>({previous:[{request:'Research',answer:'PRIOR_WEB_CONTEXT',sourceMode:'expanded'}]});await f.work.initialize();f.work.sourceMode='expanded';f.work.setPrompt('Translate supplied news; do not search the web.');await f.work.review();
 assert.equal(JSON.parse(f.work.preview).source_mode,'provided');assert(!f.work.preview.includes('PRIOR_WEB_CONTEXT'));assert.equal(f.calls(),0);
});
test('standalone use without a note or Calendar creates a Markdown document only after explicit start and keeps result after view unsubscribe', async () => {
  const f = fixture(); await f.work.initialize(); assert.equal(f.calls(), 0); assert.equal(f.keyReads(), 0); assert.equal(f.work.source, null);
  f.work.writeScope='new';
  f.work.setPrompt('Create a welcome document with a Mermaid diagram');
  await f.work.review(); assert.match(f.work.preview, /No existing note/); assert.equal(f.calls(), 0);
  const unsubscribe = f.work.subscribe(() => {}); unsubscribe();
  await f.work.run(); assert.equal(f.calls(), 2); assert.equal(f.keyReads(), 1); assert.match(f.files.get('Welcome.md').text, /```mermaid/);
  assert.equal(f.work.result, 'Created [[Welcome]].'); assert.equal(f.saved().result, f.work.result); assert.equal(f.work.prompt, '');
  assert.equal(f.journals[0].operations[0].status, 'pending'); assert.equal(f.work.history.length, 1);
});
test('Stop during initial draft persistence prevents the first key read, request and file action',async()=>{
 const f=fixture();await f.work.initialize();f.work.setPrompt('Do not start after Stop');let release,entered=false,saves=0;
 f.options.storage.save=async()=>{if(saves++===0){entered=true;await new Promise(r=>{release=r;});}};
 const running=f.work.run();while(!entered)await new Promise(r=>setTimeout(r,1));assert.equal(f.work.canStop,true);f.work.stop();release();await running;
 assert.equal(f.calls(),0);assert.equal(f.keyReads(),0);assert.equal(f.files.size,0);assert.equal(f.work.busy,false);assert.equal(f.work.prompt,'Do not start after Stop');assert.match(f.work.message,/Stopped/);
});
test('a selection edit updates its private scope for a follow-up without including the rest of the document',async()=>{
 const f=fixture();await f.host.create('A.md','# Title\nOriginal\nPrivate tail');await f.work.initialize();const file=f.files.get('A.md');
 await f.work.newTask({path:'A.md',selection:{from:8,to:16},selectionVersion:await inputDigest(file.text)});let calls=0;
 f.options.transport=async req=>{calls++;const body=JSON.parse(req.body);if(calls===1){const n=JSON.parse(body.input[0].content).current_note;assert.equal(n.text,'Original');return response([{type:'function_call',call_id:'edit',name:'apply_changes',arguments:JSON.stringify({changes:[{reference:'N1',version:n.version,action:'replace_selection',markdown:'Longer revised text'}]})}]);}return response([{type:'message',role:'assistant',content:[{type:'output_text',text:'Selection updated.'}]}]);};
 f.work.setPrompt('Refine the selection');await f.work.run();assert.equal(f.work.source.selection.to,8+'Longer revised text'.length);assert.equal(f.work.source.selectionVersion,await inputDigest(file.text));
 await f.work.newTask();f.work.setPrompt('Continue');await f.work.review();assert.equal(JSON.parse(f.work.preview).current_note.text,'Longer revised text');assert(!f.work.preview.includes('Private tail'));assert.equal(calls,2);
 file.text+='\nHuman change';await f.work.review();assert.match(f.work.message,/selected note changed/);
});
test('a Trash-only task exposes immediate Undo after the separate user confirmation',async()=>{
 const f=fixture();await f.host.create('Task A.md','Original A');await f.work.initialize();await f.work.newTask({path:'Task A.md'});f.work.mode='organize';let calls=0;
 f.options.transport=async()=>response(++calls===1?[{type:'function_call',call_id:'trash',name:'propose_trash',arguments:'{"references":["N1"]}'}]:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Awaiting your choice.'}]}]);
 f.work.setPrompt('Propose this note for Trash');await f.work.run();assert.equal(f.work.history.length,0);assert(f.files.has('Task A.md'));await f.work.confirmTrash();assert(!f.files.has('Task A.md'));assert.equal(f.work.history.length,1);assert(f.work.chat.at(-1).actions.some(op=>op.kind==='trash'&&op.path==='Task A.md'));assert(f.saved().chat.at(-1).actions.some(op=>op.kind==='trash'));
 await f.work.undo(f.work.history[0]);assert.equal(f.files.get('Task A.md').text,'Original A');assert.equal(calls,2);
});
test('partially confirmed Trash retains immediate recovery and removes only completed proposals from the pending list',async()=>{
 const f=fixture();await f.host.create('Task A.md','Original A');await f.host.create('Task B.md','Original B');await f.work.initialize();await f.work.newTask({path:'Task A.md'});f.work.mode='organize';f.work.readScope='vault';f.work.writeScope='vault';let calls=0;
 f.options.transport=async()=>response(++calls===1?[{type:'function_call',call_id:'search',name:'search_notes',arguments:'{"query":"Task","limit":4,"offset":0}'}]:calls===2?[{type:'function_call',call_id:'trash',name:'propose_trash',arguments:'{"references":["N1","N2"]}'}]:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Awaiting your choice.'}]}]);
 f.work.setPrompt('Propose both sample notes for Trash');await f.work.run();f.files.get('Task B.md').text+=' Human edit';await f.work.confirmTrash();
 assert(!f.files.has('Task A.md'));assert.equal(f.work.agent.pendingTrash.length,1);assert.equal(f.work.history.length,1);assert.equal(f.work.history[0].status,'interrupted');assert.equal(f.work.chat.at(-1).actions.filter(op=>op.kind==='trash').length,1);
 await f.work.undo(f.work.history[0]);assert.equal(f.files.get('Task A.md').text,'Original A');assert.match(f.files.get('Task B.md').text,/Human edit/);assert.equal(calls,3);
});
test('a secret in a prompt is blocked locally before reading the key or calling OpenAI; draft remains', async () => {
  const f = fixture(); await f.work.initialize(); f.work.setPrompt('sk-proj-' + 'Z'.repeat(40));
  await f.work.run(); assert.equal(f.calls(), 0); assert.equal(f.keyReads(), 0); assert.match(f.work.message, /possible API key/); assert.match(f.work.prompt, /sk-proj/);
});
test('draft/result restoration is local, retains existing keys and does not silently retarget work to another note', async () => {
  const f = fixture(); await f.host.create('A.md', 'A'); await f.host.create('B.md', 'B');
  f.options.storage.load = async () => ({ prompt: 'Keep my draft', source: 'A.md', result: 'Existing answer', mode: 'ask' });
  await f.work.initialize(); f.work.bind({ path: 'B.md' }); assert.equal(f.work.source.path, 'A.md'); assert.equal(f.work.nextSource.path, 'B.md');
  assert.equal(f.work.result, 'Existing answer'); assert.equal(f.work.prompt, 'Keep my draft'); assert.equal(f.calls(), 0); assert.equal(f.keyReads(), 0);
  await f.work.newTask(f.work.nextSource); assert.equal(f.work.source.path, 'B.md'); assert.equal(f.work.previous[0].answer, 'Existing answer');
});
test('Stop changes to Stopping once, preserves a paid response and blocks its file proposal without retry', async () => {
 const f=fixture();await f.work.initialize();let finish,calls=0;
 f.options.transport=async()=>{calls++;return await new Promise(resolve=>{finish=resolve;});};
 f.work.setPrompt('Create a sample note');const pending=f.work.run();while(!finish)await new Promise(r=>setTimeout(r,1));
 assert.equal(f.work.canStop,true);f.work.stop();assert.equal(f.work.stopping,true);assert.equal(f.work.canStop,false);f.work.stop();
 finish(response([{type:'message',role:'assistant',content:[{type:'output_text',text:'Returned answer retained.'}]},{type:'function_call',call_id:'late',name:'create_note',arguments:'{"path":"Late.md","markdown":"# Do not execute"}'}]));await pending;
 assert.equal(calls,1);assert.equal(f.files.size,0);assert.equal(f.work.result,'Returned answer retained.');assert.equal(f.saved().result,f.work.result);assert.equal(f.work.busy,false);assert.equal(f.work.stopping,false);
 f.options.transport=async()=>{calls++;return response([{type:'message',role:'assistant',content:[{type:'output_text',text:'Next task completed.'}]}]);};
 f.work.setPrompt('A fresh request');await f.work.run();assert.equal(calls,2);assert.equal(f.work.result,'Next task completed.');
});
test('All actions restores without changing the separately saved read/write scope or reading a key',async()=>{
 const f=fixture();f.options.storage.load=async()=>({mode:'all',readScope:'folder',writeScope:'current',outputFolder:'Study',maximum:2});await f.work.initialize();
 assert.equal(f.work.mode,'all');assert.equal(f.work.readScope,'folder');assert.equal(f.work.writeScope,'current');assert.equal(f.work.outputFolder,'Study');assert.equal(f.work.maximum,2);assert.equal(f.keyReads(),0);assert.equal(f.calls(),0);
});
test('finite task pause continues without duplicate writes, keeps the original scope and updates one chat turn',async()=>{
 const f=fixture();await f.work.initialize();f.work.writeScope='new';f.work.maximum=1;f.work.setPrompt('Create the sample document');await f.work.run();
 assert.equal(f.work.canContinue,true);assert.equal(f.work.settingsLocked,true);assert.equal(f.files.size,1);assert.equal(f.work.chat.length,1);assert.equal(f.work.chat[0].status,'paused');
 const oldModel=f.work.model.model;await f.work.setModel({model:'another-model'});assert.equal(f.work.model.model,oldModel);
 const requests=f.calls();await f.work.continueTask();assert.equal(f.calls(),requests);
 f.work.maximum='none';await f.work.continueTask();assert.equal(f.calls(),2);assert.equal(f.files.size,1);assert.equal(f.work.canContinue,false);assert.equal(f.work.chat.length,1);assert.equal(f.work.chat[0].status,'completed');assert.equal(f.work.chat[0].requests,2);assert.equal(f.work.chat[0].actions.length,1);
 assert.equal(f.work.chat[0].request,'Create the sample document');assert.match(f.work.chat[0].answer,/Created/);
});
test('invalid custom draft sends nothing and retains question and prior key',async()=>{
 const f=fixture();await f.work.initialize();f.work.customMaximum='0';f.work.setPrompt('Keep this question');await f.work.run();assert.equal(f.calls(),0);assert.equal(f.keyReads(),0);assert.equal(f.files.size,0);assert.equal(f.work.prompt,'Keep this question');assert.match(f.work.limitProblem,/positive whole/);
});
test('Stop during continuation checkpoint saving prevents any additional provider request',async()=>{
 const f=fixture();await f.work.initialize();f.work.writeScope='new';f.work.maximum=1;f.work.setPrompt('Create one sample');await f.work.run();assert(f.work.canContinue);
 let release,entered=false;const gate=new Promise(resolve=>{release=resolve;}),save=f.options.storage.save;f.options.storage.save=async value=>{entered=true;await gate;await save(value);};f.work.maximum='none';const continuing=f.work.continueTask();while(!entered)await new Promise(r=>setTimeout(r,1));f.work.stop();release();await continuing;
 assert.equal(f.calls(),1);assert.equal(f.work.canContinue,false);assert.equal(f.work.busy,false);assert.match(f.work.message,/Stopped/);
});
test('no-count and custom settings restore locally; full chat archive is separate from bounded previews',async()=>{
 const f=fixture(),archives=new Map();f.options.storage.load=async()=>({maximum:'none',prompt:'Saved draft',result:'Existing answer',lastRequest:'Earlier question'});
 f.options.storage.saveChat=async turn=>archives.set(turn.id,structuredClone(turn));f.options.storage.loadChat=async id=>structuredClone(archives.get(id));
 await f.work.initialize();assert.equal(f.work.maximum,'none');assert.equal(f.keyReads(),0);assert.equal(f.work.chat.length,1);
 const turn=f.work.chat[0];turn.answer='x'.repeat(50000);await f.options.storage.saveChat(turn);await f.work.persist();assert.equal(f.saved().chat[0].answer.length,16000);assert.equal(f.saved().chat[0].answerTruncated,true);assert.equal(archives.get(turn.id).answer.length,50000);
 turn.answer='preview';turn.answerTruncated=true;await f.work.loadFullChat(turn.id);assert.equal(f.work.chat[0].answer.length,50000);assert.equal(f.calls(),0);
});
test('saved token/model usage survives reload and resaving without granting continuation authority',async()=>{
 const f=fixture();f.options.storage.load=async()=>({result:'Saved answer',lastRequest:'Question',maximum:'none',taskUsage:{requests:12,state:'paused',model:'gpt-6-luna',usage:{input:100,output:40,reasoning:12}}});await f.work.initialize();
 assert.equal(f.work.task.requests,12);assert.equal(f.work.task.modelId,'gpt-6-luna');assert.deepEqual(f.work.task.usage,{input:100,output:40,reasoning:12});assert.equal(f.work.canContinue,false);assert.equal(f.calls(),0);assert.equal(f.keyReads(),0);await f.work.persist();assert.equal(f.saved().taskUsage.usage.output,40);assert.equal(f.saved().taskUsage.model,'gpt-6-luna');
});


test('Current note migration stays strict and hides creation tools even when a provider asks to create',async()=>{
 const f=fixture();f.options.storage.load=async()=>({mode:'all',readScope:'current',writeScope:'current',outputFolder:'',prompt:'Keep my draft',previous:[{request:'Earlier',answer:'Kept'}]});await f.work.initialize();
 assert.equal(f.work.writeScope,'current');assert.equal(f.work.title,'No note attached');assert.equal(f.work.prompt,'Keep my draft');assert.equal(f.keyReads(),0);
 const original=f.options.transport;f.options.transport=async request=>{const body=JSON.parse(request.body);for(const name of ['create_note','create_folder','save_generated_file'])assert(!body.tools.some(tool=>tool.name===name));return original(request);};
 await f.work.run();assert.equal(f.files.size,0);assert.equal(f.work.chat.at(-1).actions.length,0);assert(f.work.task.events.some(event=>event.kind==='blocked'));assert.equal(f.work.previous[0].answer,'Kept');
});

test('New documents is explicit, persists locally and advertises creation without granting existing-note edits',async()=>{
 const f=fixture();f.options.storage.load=async()=>({writeScope:'new',readScope:'current',outputFolder:'Output'});await f.work.initialize();assert.equal(f.work.writeScope,'new');assert.equal(f.work.title,'New documents');assert.equal(f.calls(),0);assert.equal(f.keyReads(),0);
 await f.work.review();assert.equal(JSON.parse(f.work.preview).permissions.changes,'new');assert.equal(JSON.parse(f.work.preview).permissions.output_folder,'Output');
 let seen=false;f.options.transport=async request=>{const body=JSON.parse(request.body);assert(body.tools.some(tool=>tool.name==='create_note'));seen=true;return response([{type:'message',role:'assistant',content:[{type:'output_text',text:'No file change needed.'}]}]);};
 f.work.setPrompt('Answer only');await f.work.run();assert(seen);assert.equal(f.saved().writeScope,'new');assert.equal(f.files.size,0);
});


test('a generated file does not suppress a permitted current-note summary edit',async()=>{
 const f=fixture();await f.host.create('Current.md','Original');await f.work.initialize();await f.work.newTask({path:'Current.md'});
 f.options.generated={stage:async()=>[{id:crypto.randomUUID(),name:'chart.png',extension:'png',bytes:1,sha256:'a'.repeat(64)}]};let calls=0,version;
 f.options.transport=async request=>{const body=JSON.parse(request.body);assert(!body.tools.some(tool=>tool.name==='save_generated_file'));calls++;
  if(calls===1){version=JSON.parse(body.input[0].content).current_note.version;return response([{type:'image_generation_call',id:'chart',result:'AA==',status:'completed'},{type:'message',role:'assistant',content:[{type:'output_text',text:'Chart prepared.'}]}]);}
  if(calls===2)return response([{type:'function_call',call_id:'append',name:'apply_changes',arguments:JSON.stringify({changes:[{reference:'N1',version,action:'append',markdown:'Requested text summary.'}]})}]);
  return response([{type:'message',role:'assistant',content:[{type:'output_text',text:'Appended the summary.'}]}]);};
 f.work.maximum=3;f.work.setPrompt('Generate a chart and append a text summary to the attached note');await f.work.run();assert.equal(calls,3);assert.equal(f.work.task.state,'completed');assert(f.files.get('Current.md').text.includes('Requested text summary.'));assert.equal(f.files.size,1);assert.equal(f.work.chat.at(-1).actions.length,1);
});

test('a partial file-only reply preserves the editable draft and attachment selection',async()=>{
 for(const status of ['incomplete','completed']){
  const f=fixture();await f.work.initialize();const file={id:crypto.randomUUID(),name:'source.txt',extension:'txt',kind:'document',mime:'text/plain',bytes:6,sha256:'a'.repeat(64)};
  f.options.attachments={forTask:()=>({prepare:async()=>({parts:[{type:'input_text',text:'Sample'}],fileIds:[]}),cleanup:async()=>true})};f.work.attachments=[file];
  f.options.generated={stage:async()=>[{id:crypto.randomUUID(),name:'chart.png',extension:'png',bytes:1,sha256:'b'.repeat(64)}]};let calls=0;
  f.options.transport=async()=>{calls++;return{status:200,text:JSON.stringify({status,output:[{type:'image_generation_call',id:'chart',result:'AA==',status:'completed'}]})};};
  f.work.maximum=1;f.work.setPrompt('Generate and save a chart file');await f.work.run();assert.equal(calls,1);assert.equal(f.work.task.text,'');assert.equal(f.work.task.generated.length,1);
  assert.equal(f.work.prompt,status==='incomplete'?'Generate and save a chart file':'');assert.equal(f.work.attachments.length,status==='incomplete'?1:0);assert.equal(f.work.task.state,status==='incomplete'?'failed':'completed');
 }
});


test('pure file requests and text-only replies never inspect a writable target or add a paid follow-up',async()=>{
 for(const fileReply of [false,true]){
  const f=fixture();await f.host.create('Current.md','Original');await f.work.initialize();await f.work.newTask({path:'Current.md'});let enumerations=0,lookups=0,calls=0;const files=f.host.files;
  f.host.files=()=>{enumerations++;return files();};f.host.isCurrentNote=()=>{lookups++;return true;};
  f.options.generated={stage:async()=>[{id:crypto.randomUUID(),name:'chart.png',extension:'png',bytes:1,sha256:'a'.repeat(64)}]};
  f.options.transport=async()=>{calls++;return response(fileReply?[{type:'image_generation_call',id:'chart',result:'AA==',status:'completed'}]:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Plain answer.'}]}]);};
  f.work.maximum=1;f.work.setPrompt(fileReply?'Generate and save a chart file':'Answer this question only');await f.work.run();
  assert.equal(f.work.task.state,'completed');assert.equal(calls,1);assert.equal(lookups,0);assert.equal(enumerations,1);assert.equal(f.files.get('Current.md').text,'Original');
 }
});

test('a current-note edit already completed before generation is not requested again',async()=>{
 const f=fixture();await f.host.create('Current.md','Original');await f.work.initialize();await f.work.newTask({path:'Current.md'});let calls=0;
 f.options.generated={stage:async()=>[{id:crypto.randomUUID(),name:'chart.png',extension:'png',bytes:1,sha256:'a'.repeat(64)}]};
 f.options.transport=async request=>{calls++;if(calls===1){const version=JSON.parse(JSON.parse(request.body).input[0].content).current_note.version;return response([{type:'function_call',call_id:'edit-first',name:'apply_changes',arguments:JSON.stringify({changes:[{reference:'N1',version,action:'append',markdown:'Summary once.'}]})}]);}return response([{type:'image_generation_call',id:'chart',result:'AA==',status:'completed'}]);};
 f.work.maximum=2;f.work.setPrompt('Append a summary to the current note and generate a chart');await f.work.run();assert.equal(calls,2);assert.equal(f.work.task.state,'completed');assert.equal(f.files.get('Current.md').text.split('Summary once.').length-1,1);
});

test('file-only results retain their output folder and original request across rebind and a new task',async()=>{
 const f=fixture();await f.host.create('Notes/Current.md','Original');await f.work.initialize();await f.work.newTask({path:'Notes/Current.md'});f.work.outputFolder='Chosen output';
 f.options.generated={stage:async()=>[{id:crypto.randomUUID(),name:'chart.png',extension:'png',bytes:1,sha256:'a'.repeat(64)}]};f.options.transport=async()=>response([{type:'image_generation_call',id:'chart',result:'AA==',status:'completed'}]);
 f.work.setPrompt('Generate a chart file');await f.work.run();assert.equal(f.work.result,'');assert.equal(f.work.hasResult,true);assert.equal(f.work.prompt,'');
 f.work.bind({path:'Notes/Current.md'});assert.equal(f.work.outputFolder,'Chosen output');f.work.bind({path:'Other.md'});assert.equal(f.work.source.path,'Notes/Current.md');assert.equal(f.work.outputFolder,'Chosen output');
 await f.work.newTask({path:'Notes/Current.md'});assert.equal(f.work.previous.at(-1).request,'Generate a chart file');assert.equal(f.work.previous.at(-1).answer,'');assert.equal(f.work.outputFolder,'Chosen output');
});

test('partially delivered generated files keep the request and selected inputs even with a completed response',async()=>{
 for(const text of ['', 'Some results are ready.']){
  const f=fixture();await f.work.initialize();f.work.writeScope='new';const file={id:crypto.randomUUID(),name:'source.txt',extension:'txt',kind:'document',mime:'text/plain',bytes:6,sha256:'a'.repeat(64)};f.work.attachments=[file];
  f.options.attachments={forTask:()=>({prepare:async()=>({parts:[{type:'input_text',text:'Sample'}],fileIds:[]}),cleanup:async()=>true})};let staged=0;
  f.options.generated={stage:async()=>{if(staged++===1)throw Error('Synthetic second-file delivery failure');return[{id:crypto.randomUUID(),name:'first.png',extension:'png',bytes:1,sha256:'b'.repeat(64)}];}};
  f.options.transport=async()=>response([{type:'image_generation_call',id:'first',result:'AA==',status:'completed'},{type:'image_generation_call',id:'second',result:'AA==',status:'completed'},...(text?[{type:'message',role:'assistant',content:[{type:'output_text',text}]}]:[])]);
  f.work.maximum=1;f.work.setPrompt('Generate two chart images');await f.work.run();assert.equal(f.work.task.state,'completed');assert.equal(f.work.task.generated.length,1);assert.equal(f.work.task.fileWarnings.length,1);assert.equal(f.work.prompt,'Generate two chart images');assert.equal(f.work.attachments.length,1);
 }
});


test('non-string saved scope values cannot masquerade as selected permissions',async()=>{
 const f=fixture();f.options.storage.load=async()=>({mode:['all'],readScope:['vault'],writeScope:['new']});await f.work.initialize();assert.equal(f.work.mode,'edit');assert.equal(f.work.readScope,'current');assert.equal(f.work.writeScope,'current');assert.equal(f.calls(),0);assert.equal(f.keyReads(),0);
});


test('generated-file follow-ups fulfill explicit put and Korean note-placement requests',async()=>{
 for(const request of ['Generate a chart and put its summary in the current note','차트를 만들고 현재 노트에 요약을 넣어 줘','차트를 만들고 현재 노트에 요약을 저장해']){
  const f=fixture();await f.host.create('Current.md','Original');await f.work.initialize();await f.work.newTask({path:'Current.md'});let calls=0,version;
  f.options.generated={stage:async()=>[{id:crypto.randomUUID(),name:'chart.png',extension:'png',bytes:1,sha256:'a'.repeat(64)}]};
  f.options.transport=async req=>{calls++;if(calls===1){version=JSON.parse(JSON.parse(req.body).input[0].content).current_note.version;return response([{type:'image_generation_call',id:'chart',result:'AA==',status:'completed'}]);}if(calls===2)return response([{type:'function_call',call_id:'write-summary',name:'apply_changes',arguments:JSON.stringify({changes:[{reference:'N1',version,action:'append',markdown:'Requested summary.'}]})}]);return response([{type:'message',role:'assistant',content:[{type:'output_text',text:'Summary added.'}]}]);};
  f.work.maximum=3;f.work.setPrompt(request);await f.work.run();assert.equal(calls,3,request);assert.equal(f.work.task.state,'completed');assert(f.files.get('Current.md').text.includes('Requested summary.'));
 }
});


test('opening the first note connects it despite earlier no-note answers and an unsent draft',async()=>{
 const f=fixture();await f.host.create('Economic news.md','DOCUMENT_MARKER');f.options.storage.load=async()=>({source:null,prompt:'Opened it',lastRequest:'Add a chart',result:'No note attached',mode:'all',readScope:'current',writeScope:'current',outputFolder:'Chosen output'});await f.work.initialize();
 f.work.bind({path:'Economic news.md'});assert.equal(f.work.source.path,'Economic news.md');assert.equal(f.work.nextSource,null);assert.equal(f.work.prompt,'Opened it');assert.equal(f.work.result,'No note attached');assert.equal(f.work.outputFolder,'Chosen output');
 await f.work.review();assert.equal(JSON.parse(f.work.preview).current_note.text,'DOCUMENT_MARKER');assert.equal(f.calls(),0);assert.equal(f.keyReads(),0);
});

test('explicit note connection preserves work and scopes; browsing alone does not retarget an attached note',async()=>{
 const f=fixture();await f.host.create('A.md','A');await f.host.create('B.md','B');await f.work.initialize();await f.work.newTask({path:'A.md'});f.work.outputFolder='Chosen output';f.work.setPrompt('Keep this draft');
 f.work.bind({path:'B.md'});assert.equal(f.work.source.path,'A.md');assert.equal(f.work.nextSource.path,'B.md');
 assert.equal(f.work.attachNote(f.work.nextSource),true);assert.equal(f.work.source.path,'B.md');assert.equal(f.work.outputFolder,'Chosen output');assert.equal(f.work.prompt,'Keep this draft');assert.equal(f.work.writeScope,'current');assert.equal(f.work.readScope,'current');assert.equal(f.calls(),0);
});

test('running and paused tasks keep their note; queued first-note connection remains explicit after completion',async()=>{
 const f=fixture();await f.host.create('A.md','A');await f.work.initialize();let finish;
 f.options.transport=async()=>await new Promise(resolve=>{finish=resolve;});f.work.setPrompt('Answer a question');const running=f.work.run();while(!finish)await new Promise(resolve=>setTimeout(resolve,1));
 f.work.bind({path:'A.md'});assert.equal(f.work.source,null);assert.equal(f.work.attachNote({path:'A.md'}),false);
 finish(response([{type:'message',role:'assistant',content:[{type:'output_text',text:'Answer.'}]}]));await running;assert.equal(f.work.source,null);assert.equal(f.work.nextSource.path,'A.md');assert.equal(f.work.result,'Answer.');await f.work.initialize();f.work.bind(f.work.nextSource);assert.equal(f.work.source,null);assert.equal(f.work.attachNote(f.work.nextSource),true);
 const g=fixture();await g.host.create('A.md','A');await g.work.initialize();g.work.maximum=1;g.work.setPrompt('Read');g.options.transport=async()=>response([{type:'function_call',call_id:'read',name:'search_notes',arguments:JSON.stringify({query:'A',limit:1,offset:0})}]);await g.work.run();assert(g.work.canContinue);g.work.bind({path:'A.md'});assert.equal(g.work.source,null);await g.work.finishHere();assert.equal(g.work.source,null);assert.equal(g.work.attachNote(g.work.nextSource),true);
});

test('explicit chat-without-note choice is retained and source selection obeys read exclusions',async()=>{
 const f=fixture();await f.host.create('A.md','A');await f.host.create('Private/B.md','B');await f.work.initialize();f.work.excluded='Private';assert.equal(f.work.attachNote(null),true);
 f.work.bind({path:'A.md'});assert.equal(f.work.source,null);assert.equal(f.work.nextSource.path,'A.md');assert.equal(f.work.autoAttachNote,false);assert.equal(f.work.attachNote({path:'Private/B.md'}),false);
 assert(f.work.availableNotes().some(note=>note.path==='A.md'));assert(!f.work.availableNotes().some(note=>note.path==='Private/B.md'));
 assert.equal(f.work.attachNote({path:'A.md'}),true);assert.equal(f.work.autoAttachNote,true);await f.work.persist();assert.equal(f.saved().autoAttachNote,true);
});

test('a removed attached note fails locally before key access or a provider request',async()=>{
 const f=fixture();await f.host.create('Gone.md','Original');await f.work.initialize();await f.work.newTask({path:'Gone.md'});f.files.delete('Gone.md');f.work.setPrompt('Read my note');await f.work.run();assert.equal(f.calls(),0);assert.equal(f.keyReads(),0);assert.match(f.work.message,/attached note is unavailable/);assert.equal(f.work.prompt,'Read my note');
});


test('failed restoration keeps the original record and blocks automatic saves and sends',async()=>{
 const f=fixture();await f.host.create('A.md','A');f.options.storage.load=async()=>{throw Error('Unreadable original');};let saves=0;f.options.storage.save=async()=>{saves++;};await f.work.initialize();f.work.bind({path:'A.md'});await f.work.newTask({path:'A.md'});f.work.setPrompt('Read');await f.work.run();await assert.rejects(f.work.persist(),/original work record/);assert.equal(saves,0);assert.equal(f.calls(),0);assert.equal(f.work.source,null);assert(f.work.settingsLocked);
});

test('a missing saved note remains identifiable and cannot silently bind another note',async()=>{
 const f=fixture();await f.host.create('Other.md','OTHER');f.options.storage.load=async()=>({source:'Missing.md',prompt:'Revise original'});await f.work.initialize();f.work.bind({path:'Other.md'});assert.equal(f.work.source.path,'Missing.md');await f.work.run();assert.equal(f.calls(),0);assert.equal(f.keyReads(),0);assert.match(f.work.message,/attached note is unavailable/);assert.equal(f.work.prompt,'Revise original');
});

test('changing scope after a blocked connection does not silently attach that note on Send',async()=>{
 const f=fixture();await f.host.create('Outside.md','NOT_PREVIEWED');await f.work.initialize();f.work.outputFolder='Allowed';f.work.readScope='folder';f.work.bind({path:'Outside.md'});assert.equal(f.work.source,null);f.work.readScope='current';f.work.setPrompt('Answer');await f.work.review();assert(!JSON.parse(f.work.preview).current_note.reference);let input;f.options.transport=async req=>{input=JSON.parse(JSON.parse(req.body).input[0].content);return response([{type:'message',role:'assistant',content:[{type:'output_text',text:'Answer'}]}]);};await f.work.run();assert(!input.current_note.reference);assert(!JSON.stringify(input).includes('NOT_PREVIEWED'));assert.equal(f.work.source,null);
});

test('a late preview for note A cannot replace the current preview after connecting note B',async()=>{
 const f=fixture();await f.host.create('A.md','A');await f.host.create('B.md','B');await f.work.initialize();f.work.attachNote({path:'A.md'});let release;const read=f.host.read;f.host.read=async file=>file.path==='A.md'?await new Promise(r=>{release=()=>r('A');}):read(file);const first=f.work.review();while(!release)await new Promise(r=>setTimeout(r,1));f.work.attachNote({path:'B.md'});await f.work.review();release();await first;assert.equal(JSON.parse(f.work.preview).current_note.text,'B');assert.equal(f.calls(),0);
});

test('New task retains its selected folder and keeps an out-of-scope browsed note pending',async()=>{
 const f=fixture();await f.host.create('Allowed/A.md','A');await f.host.create('Outside.md','B');await f.work.initialize();await f.work.newTask({path:'Allowed/A.md'});f.work.readScope='folder';f.work.writeScope='folder';f.work.outputFolder='Allowed';f.work.bind({path:'Outside.md'});await f.work.newTask();assert.equal(f.work.source.path,'Allowed/A.md');assert.equal(f.work.outputFolder,'Allowed');assert.equal(f.work.nextSource.path,'Outside.md');await f.work.newTask({path:'Outside.md'});assert.equal(f.work.source.path,'Allowed/A.md');assert.equal(f.work.outputFolder,'Allowed');
});

test('pending Trash proposals survive first-note browsing until an explicit new task',async()=>{
 const f=fixture();await f.host.create('A.md','A');await f.work.initialize();f.work.agent={pendingTrash:[{reference:'N1',title:'Pending review',version:'v'}]};const agent=f.work.agent;f.work.bind({path:'A.md'});await f.work.initialize();assert.equal(f.work.source,null);assert.equal(f.work.agent,agent);assert.equal(f.work.attachNote({path:'A.md'}),false);await f.work.newTask();assert.equal(f.work.agent,null);assert.equal(f.work.source,null);assert.equal(f.work.nextSource.path,'A.md');
});


test('an unfinished selection cannot become a request source',async()=>{
 const f=fixture();await f.host.create('A.md','PRIVATE REMAINDER');await f.work.initialize();const source={path:'A.md',selection:{from:0,to:5}};assert.equal(f.work.attachNote(source),false);await f.work.newTask(source);assert.equal(f.work.source,null);assert.equal(f.calls(),0);assert.match(f.work.message,/selection is not ready/);
});


test('the first note defaults to its parent folder without replacing an explicit root choice',async()=>{
 const f=fixture();await f.host.create('Notes/A.md','A');await f.host.create('Private/B.md','B');await f.work.initialize();f.work.bind({path:'Notes/A.md'});assert.equal(f.work.outputFolder,'Notes');f.work.readScope='folder';assert.deepEqual(f.work.availableNotes().map(n=>n.path),['Notes/A.md']);
 const g=fixture();await g.host.create('Notes/A.md','A');await g.work.initialize();g.work.setOutputFolder('');g.work.bind({path:'Notes/A.md'});assert.equal(g.work.outputFolder,'');await g.work.persist();assert.equal(g.saved().outputFolderChosen,true);
 const h=fixture();await h.host.create('Notes/A.md','A');h.options.storage.load=async()=>({source:null,outputFolder:''});await h.work.initialize();h.work.bind({path:'Notes/A.md'});assert.equal(h.work.outputFolder,'','legacy saved folders remain unchanged');
});

test('separate archive or recovery listing errors do not lock a valid restored draft',async()=>{
 for(const area of ['archive','history']){
  const f=fixture();f.options.storage.load=async()=>({source:null,prompt:'Saved draft',result:'Paid answer'});if(area==='archive')f.options.storage.saveChat=async()=>{throw Error('Archive unavailable');};else f.options.storage.history=async()=>{throw Error('Recovery listing unavailable');};await f.work.initialize();assert.equal(f.work.prompt,'Saved draft');assert.equal(f.work.result,'Paid answer');assert.equal(f.work.settingsLocked,false);await f.work.persist();assert.equal(f.saved().prompt,'Saved draft');assert.equal(f.calls(),0);
 }
});
