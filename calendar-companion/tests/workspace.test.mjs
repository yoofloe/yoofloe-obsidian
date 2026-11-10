import test from 'node:test';
import assert from 'node:assert/strict';
import { AiWorkspace } from '../dist/workspace.js';
import { inputDigest } from '../dist/question-input.js';
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
test('standalone use without a note or Calendar creates a Markdown document only after explicit start and keeps result after view unsubscribe', async () => {
  const f = fixture(); await f.work.initialize(); assert.equal(f.calls(), 0); assert.equal(f.keyReads(), 0); assert.equal(f.work.source, null);
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
 f.work.setPrompt('Propose this note for Trash');await f.work.run();assert.equal(f.work.history.length,0);assert(f.files.has('Task A.md'));await f.work.confirmTrash();assert(!f.files.has('Task A.md'));assert.equal(f.work.history.length,1);
 await f.work.undo(f.work.history[0]);assert.equal(f.files.get('Task A.md').text,'Original A');assert.equal(calls,2);
});
test('partially confirmed Trash retains immediate recovery and removes only completed proposals from the pending list',async()=>{
 const f=fixture();await f.host.create('Task A.md','Original A');await f.host.create('Task B.md','Original B');await f.work.initialize();await f.work.newTask({path:'Task A.md'});f.work.mode='organize';f.work.readScope='vault';f.work.writeScope='vault';let calls=0;
 f.options.transport=async()=>response(++calls===1?[{type:'function_call',call_id:'search',name:'search_notes',arguments:'{"query":"Task","limit":4,"offset":0}'}]:calls===2?[{type:'function_call',call_id:'trash',name:'propose_trash',arguments:'{"references":["N1","N2"]}'}]:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Awaiting your choice.'}]}]);
 f.work.setPrompt('Propose both sample notes for Trash');await f.work.run();f.files.get('Task B.md').text+=' Human edit';await f.work.confirmTrash();
 assert(!f.files.has('Task A.md'));assert.equal(f.work.agent.pendingTrash.length,1);assert.equal(f.work.history.length,1);assert.equal(f.work.history[0].status,'interrupted');
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
