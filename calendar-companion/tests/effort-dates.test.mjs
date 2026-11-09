import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEffort, supportedEfforts } from '../dist/effort.js';
import { AiSession } from '../dist/ai-session.js';
import { OPENAI_ADAPTER } from '../dist/openai.js';
import { AiPreferences } from '../dist/ai-preferences.js';
import { planQuestion, resolvePeriod } from '../dist/question-query.js';
test('thinking depth is model-aware, retains economical defaults and never probes a provider',async()=>{
 assert.equal(resolveEffort('gpt-6-luna'),'none');assert.equal(resolveEffort('gpt-6-astra'),'low');assert.equal(resolveEffort('custom-model'),undefined);
 assert.equal(supportedEfforts('gpt-6-luna').at(-1),'max');assert(!supportedEfforts('gpt-6.1-sol').includes('none'));
 assert.throws(()=>resolveEffort('gpt-6-astra','none'));assert.throws(()=>resolveEffort('custom-model','high'));
 let keyReads=0,calls=0;
 const s=new AiSession({current:()=>true,key:async()=>{keyReads++;return 'sk-synthetic-effort-test';},adapters:[OPENAI_ADAPTER],transport:async()=>{calls++;throw Error('not called');}});s.enableForSession(true);
 const record={kind:'note',title:'a',text:'Text',date:null};
 const review=s.prepare([record],'Rewrite',{model:'gpt-6-luna',effort:'high'});const body=JSON.parse(OPENAI_ADAPTER.request(review,'synthetic').body);
 assert.equal(body.reasoning.effort,'high');assert(!('max_output_tokens'in body));assert.equal(keyReads,0);assert.equal(calls,0);
 assert.throws(()=>s.prepare([record],'Rewrite',{model:'gpt-6-astra',effort:'none'}));
 const defaults=s.prepare([record],'Rewrite',{model:'gpt-6-luna',effort:'default'});assert(!('reasoning'in JSON.parse(OPENAI_ADAPTER.request(defaults,'synthetic').body)));
 let data={keep:{original:true},gemini:{model:'dormant'}};const prefs=new AiPreferences({current:()=>true,binding:()=> 'fixture',load:async()=>data,save:async value=>{data=value;},secrets:()=>null});
 await prefs.save({model:'gpt-6-luna',effort:'max'});assert.deepEqual(await prefs.read(),{model:'gpt-6-luna',effort:'max'});assert.deepEqual(data.keep,{original:true});assert.equal(data.gemini.model,'dormant');
});
test('future durations and next calendar week use future civil dates without a new Native protocol',()=>{
 const now=Date.UTC(2026,10,11,12),zone='Europe/Warsaw';
 for(const q of ['Show my calendar for the next 7 days','앞으로 7일 캘린더']) {const plan=planQuestion(q,{zone},now).query;assert.equal(plan.period,'next_7_days');assert.deepEqual(resolvePeriod(plan,now),{from:'2026-11-11',through:'2026-11-17'});}
 for(const q of ['Show my calendar for next week','다음 주 일정']) {const plan=planQuestion(q,{zone},now).query;assert.equal(plan.period,'custom');assert.deepEqual(resolvePeriod(plan,now),{from:'2026-11-16',through:'2026-11-22'});}
 const dst=planQuestion('calendar next week',{zone},Date.UTC(2026,9,24,22)).query;assert.deepEqual(resolvePeriod(dst,now),{from:'2026-10-26',through:'2026-11-01'});
 const past=planQuestion('calendar last 7 days',{zone},now).query;assert.equal(past.period,'last_7_days');
});
import { localSecretBinding } from '../dist/ai-preferences.js';
test('desktop cache timestamps never change the key binding; the existing Android resource stays identical', () => {
  const path='C:\\Vaults\\Mine', first=localSecretBinding('app://local/C:/Vaults/Mine?100',path), second=localSecretBinding('app://different/C:/Vaults/Mine?200',path);
  assert.equal(first,second);assert.notEqual(first,localSecretBinding('ignored','C:\\Vaults\\Other'));
  const android='http://localhost/_capacitor_file_/storage/emulated/0/Documents/MyVault';assert.equal(localSecretBinding(android),android);
});
