import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { aad, encode, INBOX } from '../dist/protocol.js';
import { resolvePeriod } from '../dist/question-query.js';
import { AiSession } from '../dist/ai-session.js';
import { OPENAI_ADAPTER } from '../dist/openai.js';
const {build}=createRequire(new URL('../../package.json',import.meta.url))('esbuild');
const bundle=await build({absWorkingDir:fileURLToPath(new URL('../',import.meta.url)),entryPoints:['src/question-modal.ts'],write:false,bundle:true,format:'cjs',platform:'browser',external:['obsidian'],target:'es2022'});
let documentFixture;
class Element {
  children=[];settings=[];style={};classList={add(){}};value='';
  constructor(){this.ownerDocument=documentFixture;}
  empty(){this.children=[];this.settings=[];}setAttribute(){}addEventListener(){}removeEventListener(){}
  createEl(tag,options={}){const el=new Element();el.tag=tag;el.text=options.text;this.children.push(el);return el;}
  createDiv(){return this.createEl('div');}
  allSettings(){return [...this.settings,...this.children.flatMap(child=>child.allSettings())];}
  allText(){return [this.text??'',...this.children.map(child=>child.allText())].join('\n');}
}
class Control {
  inputEl=new Element();disabled=false;choices=new Map();
  setValue(v){this.value=v;this.inputEl.value=v;return this;}setPlaceholder(){return this;}setDisabled(v){this.disabled=v;return this;}
  setButtonText(v){this.text=v;return this;}setCta(){return this;}onClick(cb){this.click=cb;return this;}onChange(cb){this.change=cb;return this;}
  addOption(v,label){this.choices.set(v,label);return this;}
  fire(v){assert(!this.disabled,`disabled ${this.text??'input'}`);if(this.click)return this.click();this.value=v;this.inputEl.value=v;return this.change(v);}
}
class Setting {
  controls=[];constructor(el){el.settings.push(this);}setName(v){this.name=v;return this;}setDesc(v){this.desc=v;return this;}
  add(cb){const control=new Control();this.controls.push(control);cb(control);return this;}
  addButton(cb){return this.add(cb);}addTextArea(cb){return this.add(cb);}addDropdown(cb){return this.add(cb);}addText(cb){return this.add(cb);}
}
class Modal {constructor(app){this.app=app;this.contentEl=new Element();}open(){this.onOpen();}close(){this.onClose();}}
const context={module:{exports:{}},require:()=>({App:class{},Modal,Setting,Platform:{isAndroidApp:true}}),crypto,TextEncoder,TextDecoder,Date,Intl,Error,URL,btoa,atob};
vm.runInNewContext(bundle.outputFiles[0].text,context);const {QuestionModal}=context.module.exports;
const settle=async()=>{for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setTimeout(resolve,5));};
const controls=m=>m.contentEl.allSettings().flatMap(row=>row.controls);
const button=(m,text)=>{const found=controls(m).find(c=>c.text===text);assert(found,`button ${text}`);return found;};
const field=(m,name)=>{const row=m.contentEl.allSettings().find(r=>r.name===name);assert(row,`field ${name}`);return row.controls[0];};
function fixture(){
  const calls=[],files=new Map(),dirs=new Set(),launched=[];let model='offline-test-model',alive=true;
  documentFixture={defaultView:{open:url=>launched.push(url),addEventListener(){},removeEventListener(){},cancelAnimationFrame(){},clearTimeout(){}},activeElement:null};
  const preferences={vaultId:async()=> '11860a48-22be-4156-99b3-a9458331b6df',read:async()=>({model}),hasKey:async()=>true};
  const ai={current:()=>alive,preferences,session:new AiSession({current:()=>alive,adapters:[OPENAI_ADAPTER],key:async()=> 'sk-synthetic-ui-fixture-only',transport:async request=>{calls.push(request);return {status:200,text:JSON.stringify({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Study was recorded [C1].'}]}]})};}})};
  const adapter={exists:async p=>files.has(p)||dirs.has(p),mkdir:async p=>{dirs.add(p);},write:async(p,t)=>{files.set(p,t);},read:async p=>files.get(p),stat:async p=>files.has(p)?{type:'file',size:new TextEncoder().encode(files.get(p)).length}:null,remove:async p=>{files.delete(p);},getResourcePath:p=>'file:///local/Fixture/'+p};
  const app={vault:{adapter,getName:()=> 'Fixture'}};
  const modal=new QuestionModal(app,{live:()=>alive,closed(){},ai:()=>ai,openAiSettings(){ai.session.enableForSession(false);},manualImport(){},notes:{mkdir:adapter.mkdir,create:async(p,t)=>{assert(!files.has(p));files.set(p,t);}},requirements:'Android phones and tablets only.'});
  modal.open();return {modal,calls,files,launched,ai,setModel:value=>{model=value;},stop:()=>{alive=false;}};
}
async function answer(f,empty=false){
  const markerPath=[...f.files.keys()].find(p=>p.endsWith('.request.json'));const request=JSON.parse(f.files.get(markerPath));
  const records=empty?[]:[{id:crypto.randomUUID(),kind:'study_session',sourceId:'private-id-not-for-provider',revision:1,title:'Polish',text:'Recorded: 40 minutes.',date:'2026-11-09'}];
  const data={version:3,requestId:request.requestId,datasetId:crypto.randomUUID(),exportedAt:Date.now(),records,context:{scope:request.query,...resolvePeriod(request.query,request.createdAt),zone:request.query.zone,scanned:5,matched:records.length,partial:false,metrics:[]}};
  const key=await crypto.subtle.importKey('raw',Uint8Array.from(atob(request.key.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0)),'AES-GCM',false,['encrypt']);
  const iv=crypto.getRandomValues(new Uint8Array(12)),ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(request)},key,new TextEncoder().encode(JSON.stringify(data)));
  f.files.set(`${INBOX}/${request.requestId}.reply.json`,JSON.stringify({format:'yoofloe.calendar.reply',version:3,requestId:request.requestId,iv:encode(iv),ciphertext:encode(new Uint8Array(ciphertext))}));
  await f.modal.receive(request.requestId);await settle();return data;
}
test('question UI searches locally, shows exact input and sends once only after the explicit Generate action',async()=>{
  const f=fixture();assert.equal(f.files.size,0);assert.equal(f.calls.length,0);assert(button(f.modal,'Find relevant records').disabled);
  field(f.modal,'Your question').fire('Summarize my study this week');button(f.modal,'Find relevant records').fire();await settle();
  assert.equal(f.launched.length,1);assert.equal(f.calls.length,0);assert.equal(f.ai.session.enabled,false);
  assert(field(f.modal,'Your question').disabled);await answer(f);
  assert.equal(f.calls.length,0);assert(f.modal.contentEl.allText().includes('SHA-256'));assert(!f.modal.contentEl.allText().includes('private-id-not-for-provider'));
  button(f.modal,'Generate once with OpenAI').fire();await settle();assert.equal(f.calls.length,1);assert.equal(f.ai.session.enabled,false);
  assert(!controls(f.modal).some(c=>c.text==='Generate once with OpenAI'));assert(![...f.files.keys()].some(p=>p.includes('AI drafts')));
  button(f.modal,'Save draft as new note').fire();await settle();assert.equal([...f.files.keys()].filter(p=>p.includes('AI drafts')).length,1);
  assert.equal([...f.files.keys()].filter(p=>p.includes('Snapshots v2')).length,0);f.modal.close();
});
test('changed model invalidates approval; a local refresh is required before a one-use generation',async()=>{
  const f=fixture();field(f.modal,'Your question').fire('Summarize my study this week');button(f.modal,'Find relevant records').fire();await settle();await answer(f);
  f.setModel('changed-fixture-model');button(f.modal,'Generate once with OpenAI').fire();await settle();assert.equal(f.calls.length,0);assert(f.modal.contentEl.allText().includes('model changed'));
  button(f.modal,'Refresh model and key status').fire();await settle();button(f.modal,'Generate once with OpenAI').fire();await settle();assert.equal(f.calls.length,1);f.modal.close();
});
test('empty results clarify locally with no All fallback, and changing scope preserves the question',async()=>{
  const f=fixture();field(f.modal,'Your question').fire('Summarize my study this week');button(f.modal,'Find relevant records').fire();await settle();await answer(f,true);
  assert(f.modal.contentEl.allText().includes('No matching records'));assert(!controls(f.modal).some(c=>c.text==='Generate once with OpenAI'));assert.equal(f.calls.length,0);
  button(f.modal,'Change question').fire();await settle();assert.equal(field(f.modal,'Your question').value,'Summarize my study this week');assert.equal(f.files.size,0);f.modal.close();
});
test('closing a pending question invalidates its late callback without touching independent inbox files',async()=>{
  const f=fixture();f.files.set(`${INBOX}/owner-kept.md`,'Original');field(f.modal,'Your question').fire('Summarize my study this week');button(f.modal,'Find relevant records').fire();await settle();
  const id=f.modal.requestId;f.modal.close();await settle();await f.modal.receive(id);assert.equal(f.calls.length,0);assert.equal(f.files.get(`${INBOX}/owner-kept.md`),'Original');assert.equal(f.files.size,1);
});
