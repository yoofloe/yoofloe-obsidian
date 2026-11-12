import test from 'node:test';
import assert from 'node:assert/strict';
import { attachmentStore, readAttachments } from '../dist/attachments.js';
import { AgentTask } from '../dist/agent-task.js';
import { providerFiles, boundedOpenAiDownload } from '../dist/provider-files.js';

function fixture(){const bytes=new Map(),text=new Map();let uploads=0,transcriptions=0,removals=0;
 const store=attachmentStore({configDir:'.obsidian',exists:async()=>true,mkdir:async()=>{},write:async(p,b)=>bytes.set(p,b),read:async p=>bytes.get(p),transcript:async p=>text.get(p)??null,saveTranscript:async(p,t)=>text.set(p,t),upload:async()=>{uploads++;return 'file-test';},transcribe:async()=>{transcriptions++;return 'The meeting is on Monday.';},removeUpload:async()=>{removals++;}});
 return {store,bytes,text,counts:()=>({uploads,transcriptions,removals})};}
const response=text=>({status:200,text:JSON.stringify({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text}]}]})});

test('choosing attachments is local; text is read without a provider upload and binary files use one-time IDs',async()=>{
 const f=fixture(),txt=await f.store.add(new File(['Local only'],'notes.txt'),()=>true),pdf=await f.store.add(new File(['%PDF-1.7 fixture'],'notes.pdf'),()=>true);
 assert.deepEqual(f.counts(),{uploads:0,transcriptions:0,removals:0});const run=f.store.forTask([txt,pdf]);
 const a=await run.prepare('not-logged',()=>true,()=>{throw Error('No audio');});assert(a.parts[0].text.includes('Local only'));assert.equal(a.parts[1].file_id,'file-test');
 await run.prepare('not-logged',()=>true,()=>{});assert.equal(f.counts().uploads,1);await run.cleanup('not-logged');assert.equal(f.counts().removals,1);
});

test('audio consumes a bounded request and a paused task reuses its transcript without duplicate billing',async()=>{
 const f=fixture(),audio=await f.store.add(new File(['synthetic audio'],'meeting.wav'),()=>true);let calls=0;
 const t=new AgentTask({current:()=>true,key:async()=> 'sk-synthetic-agent-key',gate:{busy:false},executor:{execute:async()=>{}},attachments:f.store.forTask([audio]),transport:async req=>{calls++;const b=JSON.parse(req.body);assert(b.input[0].content.some(p=>p.text?.includes('The meeting is on Monday.')));return response('Monday meeting.');}});
 await t.run('{"request":"Summarize attached recording"}',{model:'gpt-6-luna'},'ask',1,{mode:'provided',maximum:'none'});assert.equal(t.state,'paused');assert.equal(calls,0);assert.equal(t.requests,1);
 await t.resume(2);assert.equal(t.state,'completed');assert.equal(t.requests,2);assert.equal(f.counts().transcriptions,1);
 const next=f.store.forTask([audio]);await next.prepare('not-logged',()=>true,()=>{throw Error('Cached transcription should not bill');});assert.equal(f.counts().transcriptions,1);
});

test('stop after an upload returns performs cleanup but never starts an inference',async()=>{
 const f=fixture(),pdf=await f.store.add(new File(['%PDF-fixture'],'file.pdf'),()=>true);let active=true,calls=0;
 const taskRun=f.store.forTask([pdf]),prepare=taskRun.prepare.bind(taskRun);taskRun.prepare=async(...args)=>{const result=await prepare(...args);active=false;return result;};
 const t=new AgentTask({current:()=>active,key:async()=> 'sk-synthetic-agent-key',gate:{busy:false},executor:{execute:async()=>{}},attachments:taskRun,transport:async()=>{calls++;return response('No');}});
 await t.run('{"request":"Read"}',{model:'gpt-6-luna'},'ask',4);assert.equal(calls,0);assert.equal(f.counts().removals,1);
});

test('invalid paths, executable uploads and oversized selections cannot enter the attachment queue',async()=>{
 const f=fixture();await assert.rejects(f.store.add(new File(['x'],'run.exe'),()=>true));
 const valid=await f.store.add(new File(['ok'],'ok.txt'),()=>true);assert.deepEqual(readAttachments([{...valid,id:'../key'}]),[]);assert.deepEqual(readAttachments([{...valid,name:'../../key.txt'}]),[]);
 await assert.rejects(f.store.forTask([{...valid,sha256:'0'.repeat(64)}]).prepare('not-logged',()=>true,()=>{}),/changed/);assert.equal(f.counts().uploads,0);
});

test('provider upload expires after one hour and downloads never send authorization to arbitrary hosts',async()=>{
 const calls=[];const api=providerFiles(async r=>{calls.push(r);if(r.url.endsWith('/files')&&r.method==='POST'){const text=new TextDecoder().decode(r.body);assert(text.includes('expires_after[seconds]'));assert(text.includes('3600'));assert(text.includes('user_data'));return {status:200,text:'{"id":"file-test"}',arrayBuffer:new ArrayBuffer(0)};}return {status:200,text:'{"id":"cfile_a","container_id":"cntr_a","object":"container.file","bytes":999999999}',arrayBuffer:new ArrayBuffer(0)};});
 await api.upload({name:'x.pdf',mime:'application/pdf'},new Uint8Array([1]).buffer,'secret',()=>true);assert.equal(calls.length,1);
 await assert.rejects(api.download('cntr_a','cfile_a','secret',()=>true),/size budget/);assert.equal(calls.length,2);
 await assert.rejects(api.download('https://evil.test','cfile_a','secret',()=>true),/Invalid/);assert.equal(calls.length,2);assert(calls.every(c=>new URL(c.url).origin==='https://api.openai.com'));
});
test('image uploads use vision purpose while documents retain user_data and both expire',async()=>{
 const bodies=[];const api=providerFiles(async r=>{bodies.push(new TextDecoder().decode(r.body));return {status:200,text:'{"id":"file-test"}',arrayBuffer:new ArrayBuffer(0)};});
 await api.upload({kind:'image',name:'chart.png',mime:'image/png'},new Uint8Array([1]).buffer,'synthetic',()=>true);
 await api.upload({kind:'document',name:'brief.pdf',mime:'application/pdf'},new Uint8Array([2]).buffer,'synthetic',()=>true);
 assert.match(bodies[0],/name="purpose"\r\n\r\nvision\r\n/);assert.match(bodies[1],/name="purpose"\r\n\r\nuser_data\r\n/);
 for(const body of bodies){assert(body.includes('expires_after[seconds]'));assert(body.includes('3600'));}
});
test('unknown provider file sizes use bounded streaming without redirects or an unbounded native request',async()=>{
 const runtime=fetch=>({fetch,setTimeout,clearTimeout,setInterval,clearInterval});const route='https://api.openai.com/v1/containers/cntr_a/files/cfile_a/content';let streamed=0,requests=0;
 const api=providerFiles(async()=>{requests++;return{status:200,text:'{"id":"cfile_a","container_id":"cntr_a","object":"container.file","bytes":null}',arrayBuffer:new ArrayBuffer(0)};},async(url,key,max,current)=>{streamed++;return boundedOpenAiDownload(url,key,max,current,runtime(async(_url,options)=>{assert.equal(options.redirect,'error');return new Response(new Uint8Array([1,2,3]));}));});
 assert.equal((await api.download('cntr_a','cfile_a','test',()=>true,5)).byteLength,3);assert.equal(requests,1);assert.equal(streamed,1);
 await assert.rejects(boundedOpenAiDownload('https://evil.example/content','test',5,()=>true,runtime(async()=>{throw Error('must not fetch');})),/Invalid/);
 await assert.rejects(boundedOpenAiDownload(route,'test',2,()=>true,runtime(async()=>new Response(new Uint8Array([1,2,3])))),/size budget/);
 await assert.rejects(boundedOpenAiDownload(route,'test',5,()=>false,runtime(async()=>{throw Error('must not fetch');})),/Stopped/);
});
test('recognized credentials are blocked in both small and uploaded-size plaintext before any upload',async()=>{
 for(const length of [20,40000]){const f=fixture(),file=await f.store.add(new File(['x'.repeat(length)+'\n'+'sk-proj-'+'A'.repeat(40)],'export.txt'),()=>true);await assert.rejects(f.store.forTask([file]).prepare('not-logged',()=>true,()=>{}),/possible API key/);assert.equal(f.counts().uploads,0);}
 const f=fixture();await assert.rejects(f.store.add(new File(['GIF89a'],'animated.gif'),()=>true),/Choose an image/);assert.equal(f.counts().uploads,0);
});

test('a composer paste retains all Unicode text and distinguishes it from ordinary source files', async () => {
  const f = fixture(), text = '검색하지 마. ' + '한글🙂'.repeat(1250);
  const paste = await f.store.add(new File([text], 'Pasted text.txt'), () => true);
  paste.pastedText = { providedOnly: true };
  const ordinary = await f.store.add(new File(['Ordinary reference text'], 'reference.txt'), () => true);
  assert.deepEqual(readAttachments([paste])[0].pastedText, { providedOnly: true });
  assert.equal(readAttachments([{ ...ordinary, pastedText: { providedOnly: true } }])[0].pastedText, undefined);
  assert.deepEqual(f.counts(), { uploads: 0, transcriptions: 0, removals: 0 });
  const prepared = await f.store.forTask([ordinary, paste], true).prepare('synthetic', () => true, () => {});
  const [source, message] = prepared.parts.map(part => JSON.parse(part.text));
  assert.match(source.note, /source content/);
  assert.match(message.note, /pasting it into the composer/);
  assert.equal(message.text, text);
  const context = await f.store.forTask([paste]).prepare('synthetic', () => true, () => {});
  assert.match(JSON.parse(context.parts[0].text).note, /source content/);
});

test('a pasted message longer than the inline budget uses a file with its content unchanged', async () => {
  const f = fixture(), text = '한'.repeat(36000);
  const item = await f.store.add(new File([text], 'Pasted text.txt'), () => true);
  item.pastedText = { providedOnly: false };
  assert.equal(item.bytes, new TextEncoder().encode(text).length);
  assert.equal(new TextDecoder().decode([...f.bytes.values()][0]), text);
  assert.equal(f.counts().uploads, 0);
  const run = f.store.forTask([item], true);
  const prepared = await run.prepare('synthetic', () => true, () => {});
  assert.match(prepared.parts[0].text, /message the user pasted/);
  assert.deepEqual(prepared.parts[1], { type: 'input_file', file_id: 'file-test' });
  assert.equal(f.counts().uploads, 1);
  await run.cleanup('synthetic');
  assert.equal(f.counts().removals, 1);
});

test('the widened selection budget keeps the per-file image and transcription boundaries', async () => {
  const f = fixture(), mib = 1024 * 1024;
  const doc = await f.store.add(new File([new Uint8Array(21 * mib)], 'large.pdf'), () => true);
  assert.equal(doc.bytes, 21 * mib);
  const tooLarge = (name, size) => ({ name, size, arrayBuffer: async () => { assert.fail('Oversized files must be rejected before reading their contents'); } });
  await assert.rejects(f.store.add(tooLarge('sample.png', 20 * mib + 1), () => true), /20 MiB/);
  await assert.rejects(f.store.add(tooLarge('sample.wav', 25000001), () => true), /25 MB/);
  await assert.rejects(f.store.add(tooLarge('large.pdf', 45 * mib + 1), () => true), /45 MiB/);
  const audio = { ...doc, id: crypto.randomUUID(), name: 'audio.wav', extension: 'wav', kind: 'audio', mime: 'audio/wav', bytes: 25000000 };
  const overflow = { ...doc, id: crypto.randomUUID(), bytes: 45 * mib - doc.bytes - audio.bytes + 1 };
  assert.equal(readAttachments([doc, audio, overflow]).length, 2);
  assert.equal(readAttachments([doc, { ...audio, bytes: 25000001 }]).length, 1);
  assert.deepEqual(f.counts(), { uploads: 0, transcriptions: 0, removals: 0 });
});
