import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
const { build }=createRequire(new URL('../../package.json',import.meta.url))('esbuild');
const result=await build({absWorkingDir:fileURLToPath(new URL('../',import.meta.url)),entryPoints:['src/main.ts'],write:false,bundle:true,format:'cjs',platform:'browser',external:['obsidian'],target:'es2022'});
for(const platform of ['desktop','ios','android-tablet'])for(const declarative of [false,true])test(`${declarative?'1.13+ searchable':'legacy'}: ${platform}: startup registers one standalone workspace without reading notes, transfers, keys or network`,()=>{
  const messages=[], commands=[], tabs=[], views=[], ribbons=[];let io=0;
  const forbidden=()=>{io++;throw Error('Unexpected I/O before a user-started transfer');};
  class Element {
    classList={add(){}}; appendText(text){messages.push(text);} empty(){};setAttribute(){};createEl(_tag,options){if(options?.text)messages.push(options.text);return new Element();}createDiv(){return new Element();}
  }
  class Plugin {
    constructor(app){this.app=app;}addSettingTab(tab){tabs.push(tab);}addCommand(command){commands.push(command);}addRibbonIcon(icon,title){ribbons.push(title);}registerView(type){views.push(type);}
    registerObsidianProtocolHandler(_action,callback){this.handler=callback;}
  }
  class Modal {constructor(app){this.app=app;this.contentEl=new Element();}open(){this.onOpen();}close(){this.onClose();}}
  class PluginSettingTab {constructor(app,plugin){this.app=app;this.plugin=plugin;this.containerEl=new Element();}}
  class Setting {
    descEl=new Element();
    setHeading(){return this;}setName(text){messages.push(text);return this;}setDesc(text){messages.push(text);return this;}
    addButton(callback){const button={setButtonText(){return button;},setCta(){return button;},setDisabled(){return button;},onClick(){return button;}};callback(button);return this;}
    addField(callback){const field={inputEl:new Element(),addOption(){return field;},setValue(){return field;},setPlaceholder(){return field;},setDisabled(){return field;},onChange(){return field;}};callback(field);return this;}
    addTextArea(callback){return this.addField(callback);}addDropdown(callback){return this.addField(callback);}addText(callback){return this.addField(callback);}
  }
  const sdk={Plugin,Modal,PluginSettingTab,Setting,ItemView:class{},App:class{},TFolder:class{},Notice:class{constructor(text){messages.push(text);}},Platform:{isAndroidApp:platform==='android-tablet',isPhone:false,isIosApp:platform==='ios'}};
  const adapter=new Proxy({}, {get(){return forbidden;}});
  const app={vault:{adapter,getName:()=> 'Empty fixture vault',getAbstractFileByPath:forbidden,createFolder:forbidden,create:forbidden}};
  const context={module:{exports:{}},exports:{},require:name=>{assert.equal(name,'obsidian');return sdk;},TextEncoder,TextDecoder,URL,Date,
    crypto:new Proxy({}, {get(){return forbidden;}}),window:{open:forbidden},btoa,atob};
  vm.runInNewContext(result.outputFiles[0].text,context);
  const Constructor=context.module.exports.default, plugin=new Constructor(app);plugin.onload();
  const definitions=tabs[0].getSettingDefinitions();assert.equal(io,0);
  assert(definitions.some(d=>d.name.includes('thinking depth')&&d.aliases.includes('effort')));
  assert(definitions.some(d=>d.name==='Data and recovery'));
  assert.equal(definitions.some(d=>d.name.includes('Manual Calendar import')),platform==='android-tablet');
  if(declarative)for(const definition of definitions)definition.render(new Setting());else tabs[0].display();
  if(platform!=='android-tablet')plugin.handler({requestId:'external-untrusted-value'});
  assert.equal(io,0);assert.equal(commands.length,1);assert.equal(commands[0].id,'note-ai');assert.equal(commands[0].mobileOnly,undefined);
  assert.deepEqual(ribbons,['Yoofloe AI']);assert(views.includes('yoofloe-ai'));assert(views.includes('yoofloe-ai-writer'));assert(views.includes('yoofloe-capture'));
  assert(messages.some(text=>text.includes('Yoofloe Calendar is optional')));
  plugin.onunload();assert.equal(io,0);
});
