import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
const { build }=createRequire(new URL('../../package.json',import.meta.url))('esbuild');
const result=await build({absWorkingDir:fileURLToPath(new URL('../',import.meta.url)),entryPoints:['src/main.ts'],write:false,bundle:true,format:'cjs',platform:'browser',external:['obsidian'],target:'es2022'});
for(const platform of ['desktop','ios','android-tablet'])test(`${platform}: plugin startup and requirement UI never read transfers or initialize crypto`,()=>{
  const messages=[], commands=[], tabs=[];let io=0;
  const forbidden=()=>{io++;throw Error('Unexpected I/O before a user-started transfer');};
  class Element {
    classList={add(){}}; empty(){};createEl(_tag,options){if(options?.text)messages.push(options.text);return new Element();}createDiv(){return new Element();}
  }
  class Plugin {
    constructor(app){this.app=app;}addSettingTab(tab){tabs.push(tab);}addCommand(command){commands.push(command);}addRibbonIcon(){}
    registerObsidianProtocolHandler(_action,callback){this.handler=callback;}
  }
  class Modal {constructor(app){this.app=app;this.contentEl=new Element();}open(){this.onOpen();}close(){this.onClose();}}
  class PluginSettingTab {constructor(app,plugin){this.app=app;this.plugin=plugin;this.containerEl=new Element();}}
  class Setting {
    setName(text){messages.push(text);return this;}setDesc(text){messages.push(text);return this;}
    addButton(callback){const button={setButtonText(){return button;},setCta(){return button;},setDisabled(){return button;},onClick(){return button;}};callback(button);return this;}
  }
  const sdk={Plugin,Modal,PluginSettingTab,Setting,App:class{},TFolder:class{},Notice:class{constructor(text){messages.push(text);}},Platform:{isAndroidApp:platform==='android-tablet',isPhone:false,isIosApp:platform==='ios'}};
  const adapter=new Proxy({}, {get(){return forbidden;}});
  const app={vault:{adapter,getName:()=> 'Empty fixture vault',getAbstractFileByPath:forbidden,createFolder:forbidden,create:forbidden}};
  const context={module:{exports:{}},exports:{},require:name=>{assert.equal(name,'obsidian');return sdk;},TextEncoder,TextDecoder,URL,Date,
    crypto:new Proxy({}, {get(){return forbidden;}}),window:{open:forbidden},btoa,atob};
  vm.runInNewContext(result.outputFiles[0].text,context);
  const Constructor=context.module.exports.default, plugin=new Constructor(app);plugin.onload();tabs[0].display();commands[0].callback();
  if(platform!=='android-tablet')plugin.handler({requestId:'external-untrusted-value'});
  assert.equal(io,0);assert(messages.some(text=>text.includes('Android phones and tablets only')));
  if(platform!=='android-tablet')assert(messages.some(text=>text.includes('not supported')||text.includes('ordinary Markdown')));
  plugin.onunload();assert.equal(io,0);
});
