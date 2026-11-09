import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const {build}=createRequire(new URL('../../package.json',import.meta.url))('esbuild');
const bundle=await build({absWorkingDir:fileURLToPath(new URL('../',import.meta.url)),entryPoints:['src/note-vault.ts'],write:false,bundle:true,format:'cjs',platform:'browser',external:['obsidian'],target:'es2022'});
class MarkdownView {file=null;editor=null;getMode(){return 'source';}}
class TFolder {}
const context={module:{exports:{}},require:()=>({App:class{},MarkdownView,TFolder}),crypto,TextEncoder,TextDecoder,Date,Intl,Error,URL};
vm.runInNewContext(bundle.outputFiles[0].text,context);const {createNoteWorkspace}=context.module.exports;
test('related-note host reads unsaved buffers and refuses renamed, changed or concurrently opened targets',async()=>{
 const file={path:'Study reference.md',basename:'Study reference',stat:{size:30}},all=[file],contents=new Map([[file.path,'Study original on disk']]),folders=new Map();
 let value='Study unsaved buffer',leaves=[],current=true,processCalls=0;
 const view=new MarkdownView();view.file=file;view.editor={getValue:()=>value,transaction(tx){value=tx.changes[0].text;},offsetToPos:offset=>({line:0,ch:offset})};leaves=[{view}];
 const vault={getMarkdownFiles:()=>all,getAbstractFileByPath:path=>path===file.path?file:folders.get(path)??null,cachedRead:async file=>contents.get(file.path),
  process:async(file,fn)=>{processCalls++;const next=fn(contents.get(file.path));contents.set(file.path,next);return next;},createFolder:async path=>{folders.set(path,new TFolder());},create:async(path,text)=>{assert(!contents.has(path));contents.set(path,text);}};
 const app={vault,workspace:{getLeavesOfType:()=>leaves},metadataCache:{resolvedLinks:{}}};
 const host=createNoteWorkspace(app,vault,()=>current,'Source.md');const result=await host.search('Study progress');const doc=result.documents[0];
 assert.equal(doc.text,'Study unsaved buffer');assert.equal(processCalls,0);
 value='New unsaved work';await assert.rejects(doc.replace(doc.text,'Replacement'));assert.equal(value,'New unsaved work');
 value=doc.text;await doc.replace(doc.text,'Updated buffer');assert.equal(value,'Updated buffer');assert.equal(contents.get(file.path),'Study original on disk');
 leaves=[];await assert.rejects(doc.replace(doc.text,'Replacement'));assert.equal(processCalls,1);assert.equal(contents.get(file.path),'Study original on disk');
 file.path='Renamed.md';assert.equal(await doc.read(),null);await assert.rejects(doc.replace('Study original on disk','Replacement'));
 current=false;await assert.rejects(host.backup('Study.md','Original'));assert.equal(folders.size,0);
});
