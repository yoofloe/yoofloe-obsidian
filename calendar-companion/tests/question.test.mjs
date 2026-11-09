import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createQuestionRequest, launchUrl, openReply, validateDelivery, aad, INBOX } from '../dist/protocol.js';
import { planQuestion, validateQuestionQuery, resolvePeriod } from '../dist/question-query.js';
import { buildQuestionInput, inputDigest } from '../dist/question-input.js';
import { AiPreferences } from '../dist/ai-preferences.js';
import { AiSession } from '../dist/ai-session.js';
import { OPENAI_ADAPTER } from '../dist/openai.js';
import { CalendarSession } from '../dist/session.js';
import { saveDelivery } from '../dist/notes.js';
const now = Date.parse('2026-11-09T10:00:00Z'), vaultId = '11860a48-22be-4156-99b3-a9458331b6df';
const query = () => validateQuestionQuery({ areas: ['study','garden'], period:'last_week', from:null, through:null, zone:'Europe/Warsaw', terms:[], profile:'summary', includeLinkedNotes:true, maxRecords:20, maxTextBytes:32768 });
const request = () => createQuestionRequest('Test vault',vaultId,query(),now);
const record = () => ({id:crypto.randomUUID(),kind:'study_session',sourceId:'private-native-id',revision:1,title:'Polish study',text:'Recorded: 40 minutes. Planned: 90 minutes.',date:'2026-11-08'});
const delivery = r => ({version:3,requestId:r.requestId,datasetId:crypto.randomUUID(),exportedAt:now,records:[record()],context:{scope:r.query,...resolvePeriod(r.query,r.createdAt),zone:r.query.zone,scanned:8,matched:1,partial:false,metrics:[{key:'study_recorded_seconds',value:2400},{key:'garden_measured_seconds',value:6}]}});

test('browser request marker fixes every query field order regardless of caller insertion order',()=>{
  const reversed=Object.fromEntries(Object.entries(query()).reverse());
  const r=createQuestionRequest('Test vault',vaultId,reversed,now);
  assert.deepEqual(Object.keys(r),['format','version','requestId','vault','vaultId','nonce','key','createdAt','expiresAt','query']);
  assert.deepEqual(Object.keys(r.query),['areas','period','from','through','zone','terms','profile','includeLinkedNotes','maxRecords','maxTextBytes']);
  assert.equal(JSON.stringify(r.query),JSON.stringify(query()));assert(Object.isFrozen(r.query));
});

test('Kotlin v3 AES-GCM opens in the real reader; vault identity and version prevent crossover',async()=>{
  const vector=JSON.parse(await readFile(new URL('fixtures/query-interop.json',import.meta.url),'utf8'));
  assert.deepEqual(await openReply(vector.reply,vector.request,vector.request.createdAt),vector.plaintext);
  await assert.rejects(openReply(vector.reply,{...vector.request,vaultId:crypto.randomUUID()},vector.request.createdAt),/authenticated/);
  await assert.rejects(openReply(vector.reply,{...vector.request,version:2},vector.request.createdAt),/version/);
  assert.notDeepEqual(aad(vector.request),aad({...vector.request,vaultId:crypto.randomUUID()}));
});
test('local plans route multi-workspace questions and ask for one workspace when ambiguous',()=>{
  const q=planQuestion('Summarize my study and focus time last week').query;
  assert.deepEqual(q.areas,['study','garden']);assert.equal(q.period,'last_week');assert.deepEqual(q.terms,[]);
  const ko=planQuestion('지난 주 공부와 집중 기록을 요약해줘').query;
  assert.deepEqual(ko.areas,['study','garden']);assert.equal(ko.period,'last_week');
  assert.equal(planQuestion('What should I do?').needsArea,true);
  assert.deepEqual(planQuestion('Review my project budget this week').query.areas,['project']);
  assert.equal(planQuestion('My notes about Polish 2026-11-01').query.period,'custom');
  assert(!q.areas.includes('flow'));assert.equal(q.maxTextBytes,32768);
});
test('date periods use the request civil day in its zone, including Monday and a DST boundary',()=>{
  assert.deepEqual(resolvePeriod(query(),now),{from:'2026-11-02',through:'2026-11-08'});
  assert.deepEqual(resolvePeriod({...query(),period:'this_week'},now),{from:'2026-11-09',through:'2026-11-15'});
  assert.deepEqual(resolvePeriod({...query(),period:'today'},Date.parse('2026-10-25T23:30:00Z')),{from:'2026-10-26',through:'2026-10-26'});
  assert.deepEqual(resolvePeriod({...query(),period:'last_7_days'},now),{from:'2026-11-03',through:'2026-11-09'});
});
test('query filters are closed and bounded; dates, metrics, Flow and financial records stay within scope',()=>{
  assert.throws(()=>validateQuestionQuery({...query(),all:true}),/format/);
  assert.throws(()=>validateQuestionQuery({...query(),period:'any'}),/topic/);
  assert.throws(()=>validateQuestionQuery({...query(),terms:['Not canonical']}),/topic/);
  assert.throws(()=>validateQuestionQuery({...query(),maxRecords:21}),/budget/);
  const r=request(), d=delivery(r);assert.deepEqual(validateDelivery(d,r),d);
  d.context.from='2026-11-01';assert.throws(()=>validateDelivery(d,r),/dates/);d.context.from='2026-11-02';
  d.records[0].kind='flow_actor';assert.throws(()=>validateDelivery(d,r),/scope/);d.records[0].kind='study_session';
  d.context.metrics.push({key:'project_count',value:99});assert.throws(()=>validateDelivery(d,r),/workspace/);d.context.metrics.pop();
  d.context.matched=2;assert.throws(()=>validateDelivery(d,r),/partial/);d.context.partial=true;validateDelivery(d,r);
  d.records[0].text='x'.repeat(32769);assert.throws(()=>validateDelivery(d,r),/budget/);
  const pr=createQuestionRequest('T',vaultId,validateQuestionQuery({...query(),areas:['project']}),now), pd=delivery(pr);pd.records[0].kind='project_expense';pd.context.metrics=[];
  assert.throws(()=>validateDelivery(pd,pr),/scope/);
});
test('question excerpts never overwrite complete v2 snapshots and outbound content excludes local identities',async()=>{
  const r=request(),d=delivery(r),input=buildQuestionInput(d,'How did my study go?');
  assert(!input.includes(d.datasetId));assert(!input.includes(d.records[0].id));assert(!input.includes('private-native-id'));assert(!input.includes(vaultId));
  assert(input.includes('C1'));assert(input.includes('recorded study seconds'));assert(input.includes('garden_measured_seconds'));assert(input.includes('can overlap; do not add'));
  assert.equal((await inputDigest(input)).length,64);assert.notEqual(await inputDigest(input),await inputDigest(input+' '));
  await assert.rejects(saveDelivery(d,new Proxy({}, {get(){throw Error('unexpected write');}}),()=>{}),/full snapshots/);
  assert.throws(()=>buildQuestionInput({...d,records:[]},'Summarize'),/Find relevant/);
});
test('stable vault ID and concurrent model updates preserve opaque settings and the existing secret binding',async()=>{
  let raw={privateSetting:{kept:true},openai:{model:'existing-model',extra:'preserved'},aiProvider:'openai'};const ids=[];
  const prefs=new AiPreferences({current:()=>true,binding:()=>'/unchanged/vault',load:async()=>structuredClone(raw),save:async value=>{await Promise.resolve();raw=value;},secrets:()=>({getSecret:id=>{ids.push(id);return 'sk-fixture-only';},setSecret(){}})});
  const [id1,id2]=await Promise.all([prefs.vaultId(),prefs.vaultId(),prefs.save({model:'gpt-6-luna'})]);
  assert.equal(id1,id2);assert.equal(raw.calendarVaultId,id1);assert.deepEqual(raw.privateSetting,{kept:true});assert.equal(raw.openai.extra,'preserved');assert.equal(raw.openai.model,'gpt-6-luna');
  await prefs.hasKey();await prefs.vaultId();await prefs.hasKey();assert.equal(ids[0],ids[1]);assert(ids[0].startsWith('ycc-openai-'));
});
test('one-use compact review makes zero provider calls until explicit approval and does not retry',async()=>{
  let calls=0,reads=0,current=true;
  const session=new AiSession({current:()=>true,key:async()=>{reads++;return 'sk-synthetic-fixture-only';},adapters:[OPENAI_ADAPTER],transport:async()=>{calls++;return {status:200,text:JSON.stringify({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Fixture [C1]'}]}]})};}});
  const d=delivery(request());session.enableForSession(true);
  const review=await session.prepareQuestion(d,'Summarize my study',{model:'offline-test-model'},()=>current);
  assert.equal(reads,0);assert.equal(calls,0);assert.equal(review.digest,await inputDigest(review.input));
  await assert.rejects(session.generate(review,false),/explicitly confirm/);assert.equal(calls,0);
  assert.equal((await session.generate(review,true)).text,'Fixture [C1]');assert.equal(calls,1);
  await assert.rejects(session.generate(review,true));assert.equal(calls,1);
  const changed=await session.prepareQuestion(d,'Another question',{model:'offline-test-model'},()=>current);current=false;
  await assert.rejects(session.generate(changed,true),/changed/);assert.equal(calls,1);
});
test('v3 sessions keep exact cleanup and put no key or question into the launch URI',async()=>{
  const files=new Map(),dirs=new Set(),store={exists:async p=>files.has(p)||dirs.has(p),mkdir:async p=>{dirs.add(p);},write:async(p,t)=>{files.set(p,t);},read:async p=>files.get(p),size:async()=>null,remove:async p=>{files.delete(p);}};
  const session=new CalendarSession({store,vaultName:()=> 'Fixture',allowed:()=>true,now:()=>now});
  const url=await session.start({vaultId,query:query(),inboxHint:'file:///storage/emulated/0/Documents/Fixture/Yoofloe Calendar Inbox'});
  const marker=JSON.parse(files.get(`${INBOX}/${session.requestId}.request.json`));assert.equal(marker.version,3);assert(!url.includes(marker.key));assert(!url.includes(marker.nonce));
  assert.equal(new URL(url).searchParams.get('vaultId'),vaultId);assert.equal(new URL(url).searchParams.size,5);
  await session.cancel();assert.equal(files.size,0);
});
