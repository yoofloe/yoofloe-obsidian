import test from 'node:test';
import assert from 'node:assert/strict';
import { generatedStore, binaryDigest, readGeneratedFiles, generatedPath } from '../dist/generated-files.js';
import { VaultAgent, validateJournal } from '../dist/vault-agent.js';
const png=new Uint8Array([137,80,78,71,13,10,26,10,1,2,3,4]).buffer;
const base64=Buffer.from(png).toString('base64');
test('generated images are cached locally with verified bytes and stable references, without downloading URLs',async()=>{
 const cache=new Map();let downloads=0;const store=generatedStore({configDir:'.obsidian',exists:async()=>true,mkdir:async()=>{},write:async(p,b)=>cache.set(p,b),read:async p=>cache.get(p),download:async()=>{downloads++;return png;}});
 const [file]=await store.stage([{origin:'image:1',name:'chart.png',base64}], 'not-logged',()=>true);
 assert.equal(file.sha256,await binaryDigest(png));assert.equal(readGeneratedFiles([file]).length,1);assert.equal(downloads,0);
 assert.deepEqual(await store.stage([{origin:'image:1',name:'chart.png',base64}],'not-logged',()=>true),[file]);assert.equal(cache.size,1);
 await assert.rejects(store.stage([{origin:'bad',name:'chart.png',container:'http://bad',file:'cfile_a'}],'not-logged',()=>true),/Invalid/);assert.equal(downloads,0);
 assert.throws(()=>generatedPath('.obsidian/secrets.png'));assert.throws(()=>generatedPath('Other/../secret.png'));assert.throws(()=>generatedPath('Chart.svg'));
});
test('the remaining step budget reaches the size check before a generated download',async()=>{
 let budget;const cache=new Map(),store=generatedStore({configDir:'.obsidian',exists:async()=>true,mkdir:async()=>{},write:async(p,b)=>cache.set(p,b),read:async p=>cache.get(p),download:async(_c,_f,_k,_current,remaining)=>{budget=remaining;return png;}});
 await assert.rejects(store.stage([{origin:'container:large',name:'chart.png',container:'cntr_a',file:'cfile_a'}],'not-logged',()=>true,2),/memory budget/);assert.equal(budget,2);assert.equal(cache.size,0);
});
test('only registered generated files can be saved within scope, embedded, and undone while preserving newer data',async()=>{
 const docs=new Map(),assets=new Map(),journals=[];const hash=await binaryDigest(png),file={id:crypto.randomUUID(),name:'chart.png',extension:'png',bytes:png.byteLength,sha256:hash};
 const host={files:()=>[...docs.values()],create:async(path,text)=>{const f={identity:{},path,title:path,size:text.length,text};docs.set(path,f);return f;},read:async f=>f.text,persist:async j=>journals.push(structuredClone(j)),createAsset:async(_f,path)=>assets.set(path,hash),assetHash:async path=>assets.get(path)??null,trashAsset:async(path,expected)=>{assert.equal(assets.get(path),expected);assets.delete(path);},trash:async f=>docs.delete(f.path)};
 const p={mode:'edit',readScope:'current',writeScope:'current',sourcePath:null,folder:'Work',configDir:'.obsidian',excluded:['Work/Private']};const a=new VaultAgent(host,p,()=>true);a.research([{url:'https://example.org/source',title:'Data'}],[file]);
 await assert.rejects(a.execute('save_generated_file',{reference:file.id,path:'Outside/chart.png'}),/permitted/);
 await assert.rejects(a.execute('save_generated_file',{reference:file.id,path:'Work/Private/chart.png'}),/permitted/);
 await assert.rejects(a.execute('save_generated_file',{reference:'unknown',path:'Work/chart.png'}),/reference/);
 await a.execute('save_generated_file',{reference:file.id,path:'Work/chart.png'});await a.execute('create_note',{path:'Work/Report.md',markdown:'# Chart\n![[Work/chart.png]]\n![[.obsidian/private.png]]'});
 assert(docs.get('Work/Report.md').text.includes('\n![[Work/chart.png]]'));assert(docs.get('Work/Report.md').text.includes('\\![[.obsidian/private.png]]'));assert(docs.get('Work/Report.md').text.includes('https://example.org/source'));
 validateJournal(a.journal);await a.undo();assert.equal(assets.size,0);assert.equal(docs.size,0);
 const b=new VaultAgent(host,p,()=>true);b.research([],[file]);await b.execute('save_generated_file',{reference:file.id,path:'Work/chart.png'});assets.set('Work/chart.png','human edit');const result=await b.undo();assert.equal(result.kept,1);assert.equal(assets.get('Work/chart.png'),'human edit');
});
