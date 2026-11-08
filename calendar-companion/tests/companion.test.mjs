import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequest, launchUrl, encode, decode, aad, openReply, WINDOW_MS, INBOX } from '../dist/protocol.js';
import { CalendarSession } from '../dist/session.js';
import { saveDelivery, renderRecord } from '../dist/notes.js';
const now = 1794132000000;
const dataset = 'cbe6155c-5df4-41da-9463-23baa343557c';
const record = { id: '556217a6-8374-3c85-a6f8-e8c2a01ad990', kind: 'task', revision: 1,
  title: 'Read chapter', text: 'Status: completed\nDue: 2026-11-08', date: '2026-11-08' };
const data = request => ({ version: 1, requestId: request.requestId, datasetId: dataset, exportedAt: now, records: [{ ...record }] });

async function reply(request, value = data(request)) {
  const key = await crypto.subtle.importKey('raw', decode(request.key, 32), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name:'AES-GCM',iv,additionalData:aad(request) },key,new TextEncoder().encode(JSON.stringify(value)));
  return JSON.stringify({format:'yoofloe.calendar.reply',version:1,requestId:request.requestId,iv:encode(iv),ciphertext:encode(new Uint8Array(ciphertext))});
}
function store() {
  const files = new Map(), directories = new Set();
  return { files, directories, exists:async path=>files.has(path)||directories.has(path), mkdir:async path=>{directories.add(path);},
    write:async(path,text)=>{files.set(path,text);}, read:async path=>{if(!files.has(path))throw Error('missing');return files.get(path);},
    size:async path=>files.has(path)?new TextEncoder().encode(files.get(path)).length:null,remove:async path=>{files.delete(path);},
    create:async(path,text)=>{if(files.has(path))throw Error('exists');files.set(path,text);} };
}
test('browser-only encryption round trip preserves Unicode, civil dates, and non-v4 record IDs',async()=>{
  const request=createRequest('공부 vault',now), value=data(request);value.records[0].text+='\nZażółć gęślą jaźń';
  assert.deepEqual(await openReply(await reply(request,value),request,now),value);
  const url=launchUrl(request);assert(!url.includes(request.key));assert(!url.includes(record.text));
  assert.equal(new URL(url).searchParams.size,3);
});
test('wrong request, tampering, expiry, malformed dates and duplicate records fail before writes',async()=>{
  const request=createRequest('Test',now), valid=await reply(request);
  await assert.rejects(openReply(valid,request,now+WINDOW_MS+1),/expired/);
  await assert.rejects(openReply(valid,createRequest('Other',now),now),/different request/);
  const tampered=JSON.parse(valid);tampered.ciphertext=tampered.ciphertext.slice(0,-2)+'AA';
  await assert.rejects(openReply(JSON.stringify(tampered),request,now));
  const invalid=data(request);invalid.records[0].date='2026-02-30';await assert.rejects(openReply(await reply(request,invalid),request,now),/date/);
  const duplicate=data(request);duplicate.records.push({...record});await assert.rejects(openReply(await reply(request,duplicate),request,now),/duplicate/);
  const unknown=data(request);unknown.records[0].overwrite=true;await assert.rejects(openReply(await reply(request,unknown),request,now),/format/);
});
test('unsupported platforms perform no storage I/O',async()=>{
  const forbidden=new Proxy({}, {get(){throw Error('unexpected storage access');}});
  const session=new CalendarSession({store:forbidden,vaultName:()=> 'Test',allowed:()=>false,now:()=>now});
  await assert.rejects(session.start(),/session changed/);await assert.rejects(session.receive(crypto.randomUUID()));
});
test('session accepts only an authenticated pending response and invalidates after vault change',async()=>{
  const disk=store();let vault='Test';const session=new CalendarSession({store:disk,vaultName:()=>vault,allowed:()=>true,now:()=>now});
  await session.start();const id=session.requestId, request=JSON.parse(disk.files.get(`${INBOX}/${id}.request.json`));
  await assert.rejects(session.receive(crypto.randomUUID()),/matching/);
  disk.files.set(`${INBOX}/${id}.reply.json`,await reply(request));const delivery=await session.receive(id);
  assert.equal(delivery.records.length,1);await assert.rejects(session.receive(id),/matching/);
  session.assertCanSave(delivery);vault='Other';assert.throws(()=>session.assertCanSave(delivery),/session changed/);
  await session.dispose();assert.equal(disk.files.size,2,'do not clean another active vault');
});
test('cancelled request cannot accept a late callback and does not delete a modified marker',async()=>{
  const disk=store(), session=new CalendarSession({store:disk,vaultName:()=> 'Test',allowed:()=>true,now:()=>now});
  await session.start();const id=session.requestId;disk.files.set(`${INBOX}/${id}.request.json`,'independently edited');
  await session.cancel();await assert.rejects(session.receive(id));assert.equal(disk.files.get(`${INBOX}/${id}.request.json`),'independently edited');
});
test('save is create-only, deduplicates retries and refuses user-edited collisions before creating other notes',async()=>{
  const disk=store(), request=createRequest('Test',now), delivery=data(request);
  assert.deepEqual(await saveDelivery(delivery,disk,()=>{}),{created:1,skipped:0});
  assert.deepEqual(await saveDelivery(delivery,disk,()=>{}),{created:0,skipped:1});
  const path=[...disk.files.keys()][0];disk.files.set(path,'My private edits');
  delivery.records.push({...record,id:crypto.randomUUID()});
  await assert.rejects(saveDelivery(delivery,disk,()=>{}),/edited/);assert.equal(disk.files.size,1);assert.equal(disk.files.get(path),'My private edits');
});
test('rendered plain text does not activate HTML, remote images, or Obsidian embeds',async()=>{
  const md=await renderRecord(dataset,{...record,title:'<img src=x onerror=bad>',text:'![[Private]]\n![remote](https://example.test/a.png)\n<iframe src=x></iframe>'});
  assert(!md.includes('<img'));assert(!md.includes('<iframe'));assert(!md.includes('\n![remote]'));assert(!md.includes('\n![[Private]]'));
  assert(md.includes('source_id:'));assert(md.includes('2026-11-08'));
});
test('actual Kotlin-generated AES-GCM output opens in the production browser reader', {skip:!process.env.CALENDAR_INTEROP_VECTOR}, async()=>{
  const fixture=JSON.parse(await readFile(process.env.CALENDAR_INTEROP_VECTOR,'utf8'));
  assert.deepEqual(await openReply(fixture.reply,fixture.request,fixture.request.createdAt),fixture.plaintext);
});
