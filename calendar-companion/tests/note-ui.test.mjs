import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { NoteWork } from '../dist/note-work.js';
import { AiSession } from '../dist/ai-session.js';
import { OPENAI_ADAPTER } from '../dist/openai.js';
const {build}=createRequire(new URL('../../package.json',import.meta.url))('esbuild');
const bundle=await build({absWorkingDir:fileURLToPath(new URL('../',import.meta.url)),entryPoints:['src/note-modal.ts'],write:false,bundle:true,format:'cjs',platform:'browser',external:['obsidian'],target:'es2022'});
const documentFixture={defaultView:{visualViewport:{height:800,addEventListener(){},removeEventListener(){}},navigator:{clipboard:{writeText:async()=>{}}}}};
class Element {
  children=[];settings=[];style={setProperty(){}};classList={add(){},remove(){},toggle(){}};ownerDocument=documentFixture;
  empty(){this.children=[];this.settings=[];}setAttribute(){}addEventListener(type,cb){this[type]=cb;}
  removeEventListener(){}
  getBoundingClientRect(){return {width:360,height:750};}
  createEl(tag,options={}){const e=new Element();e.tag=tag;e.text=options.text;e.cls=options.cls;this.children.push(e);return e;}
  createDiv(options){return this.createEl('div',options);}all(){return [this,...this.children.flatMap(e=>e.all())];}
  querySelectorAll(selector){return this.all().filter(e=>selector==='input[type="checkbox"]'?e.tag==='input'&&e.type==='checkbox':e.tag===selector);}
  controls(){return this.all().flatMap(e=>e.settings.flatMap(s=>s.controls));}
}
class Control {
 inputEl=new Element();selectEl=new Element();disabled=false;setButtonText(t){this.text=t;return this;}setDisabled(v){this.disabled=v;return this;}setCta(){return this;}
 setValue(v){this.value=v;return this;}setPlaceholder(){return this;}addOption(){return this;}onClick(cb){this.click=cb;return this;}onChange(cb){this.change=cb;return this;}
 fire(value){assert(!this.disabled,`${this.text} disabled`);if(this.click)return this.click();return this.change(value);}
}
class Setting {
 controls=[];settingEl=new Element();constructor(el){el.settings.push(this);}setName(v){this.name=v;return this;}
 add(cb){const c=new Control();this.controls.push(c);cb(c);return this;}addButton(cb){return this.add(cb);}addTextArea(cb){return this.add(cb);}addDropdown(cb){return this.add(cb);}addText(cb){return this.add(cb);}
}
class Modal {constructor(app){this.app=app;this.contentEl=new Element();this.modalEl=new Element();this.modalEl.parentElement=new Element();}open(){this.onOpen();}close(){this.onClose();}}
const context={module:{exports:{}},require:()=>({App:class{},Modal,Setting,Notice:class{},Component:class{load(){}unload(){}},MarkdownRenderer:{render:async(_app,md,el)=>{el.createEl('div',{text:md});if(md.includes('- [ ]')){const box=el.createEl('input');box.type='checkbox';box.disabled=false;}}}}),crypto,TextEncoder,TextDecoder,Date,Intl,Error,URL,btoa,atob};
vm.runInNewContext(bundle.outputFiles[0].text,context);const {NoteModal}=context.module.exports;
const until=async f=>{for(let i=0;i<50&&!f();i++)await new Promise(r=>setTimeout(r,2));assert(f());};
const button=(m,text)=>{const c=m.contentEl.controls().find(c=>c.text===text);assert(c,`Expected ${text}`);return c;};
test('phone sheet actions prepare locally; one Generate survives hide, returns with insert and copy actions',async()=>{
 let calls=0,resolve,text='Unsaved note',writes=0;
 const session=new AiSession({current:()=>true,key:async()=> 'sk-synthetic-note-ui-key',adapters:[OPENAI_ADAPTER],transport:async()=>{calls++;return await new Promise(r=>{resolve=r;});}});
 const work=new NoteWork({identity:{},path:'a.md',title:'a',read:()=>text,change(from,to,value){writes++;text=text.slice(0,from)+value+text.slice(to);}}, {from:0,to:0},
  {current:()=>true,ai:session,preferences:{read:async()=>({model:'offline-test-model'}),hasKey:async()=>true},calendar(){throw Error('Calendar must be optional');},save:async()=>{},inboxHint:()=>''});
 await work.initialize();let modal=new NoteModal({},work,{closed(){},settings(){},startNew(){},nextTitle:()=>null});modal.open();
 assert(button(modal,'Generate once').disabled);const chip=modal.contentEl.all().find(e=>e.text==='Summarize');chip.click();
 assert.equal(calls,0);assert.equal(writes,0);assert(!button(modal,'Generate once').disabled);
 button(modal,'Generate once').fire();await until(()=>calls===1);modal.close();
 resolve({status:200,text:JSON.stringify({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'## Summary\n- [ ] Review'}]}]})});await until(()=>!work.busy);
 modal=new NoteModal({},work,{closed(){},settings(){},startNew(){},nextTitle:()=>null});modal.open();
 assert(modal.contentEl.all().some(e=>e.text==='Your draft'));assert(!modal.contentEl.controls().some(c=>c.text==='Generate once'));
 await until(()=>modal.contentEl.all().some(e=>e.type==='checkbox'&&e.disabled));
 button(modal,'Append to note').fire();await until(()=>work.applied);assert.equal(writes,1);assert(text.includes('- [ ] Review'));
 assert(button(modal,'Append to note').disabled);assert.equal(calls,1);modal.close();work.dispose();
});
