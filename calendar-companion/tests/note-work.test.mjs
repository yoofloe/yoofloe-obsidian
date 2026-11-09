import test from 'node:test';
import assert from 'node:assert/strict';
import { NoteWork } from '../dist/note-work.js';
import { AiSession } from '../dist/ai-session.js';
import { OPENAI_ADAPTER } from '../dist/openai.js';
const flush=()=>new Promise(r=>setImmediate(r));
const until=async condition=>{for(let i=0;i<50&&!condition();i++)await new Promise(r=>setTimeout(r,2));assert(condition(),'async operation did not settle');};
function fixture({delay=false}={}) {
  let text='Unsaved draft\nThe task is to review the design.', live=true, finish, calls=0, changes=0, starts=0, saved=[];
  const session=new AiSession({current:()=>live,key:async()=> 'sk-synthetic-note-test-key',adapters:[OPENAI_ADAPTER],transport:async request=>{
    calls++;const input=JSON.parse(JSON.parse(request.body).input);assert(!JSON.stringify(input).includes('private-folder'));
    const response={status:200,text:JSON.stringify({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'## Result\n- [ ] Review the design'}]}]})};
    return delay?await new Promise(resolve=>{finish=()=>resolve(response);}):response;
  }});
  const target={identity:{},path:'private-folder/a.md',title:'a',read:()=>text,change(from,to,value){changes++;text=text.slice(0,from)+value+text.slice(to);}};
  const work=new NoteWork(target,{from:0,to:0},{current:()=>live,ai:session,preferences:{read:async()=>({model:'offline-test-model'}),hasKey:async()=>true,vaultId:async()=> '11860a48-22be-4156-99b3-a9458331b6df'},
    calendar:()=>({requestId:null,start:async function(){starts++;this.requestId='matching';return 'local-scheme://safe';},dispose:async()=>{},assertCanSave(){},receive:async()=>{throw Error('Not approved');}}),inboxHint:()=>'',save:async(path,content)=>{saved.push({path,content});}});
  return {work,session,target,get text(){return text;},get calls(){return calls;},get changes(){return changes;},get starts(){return starts;},saved,edit:value=>{text=value;},finish:()=>finish(),stop:()=>{live=false;}};
}
test('quick actions and settings are local; result survives unsubscribed sheet and no generation is retried',async()=>{
  const f=fixture({delay:true});await f.work.initialize();let renders=0;const unsubscribe=f.work.subscribe(()=>{renders++;});
  f.work.choose('tasks');assert.equal(f.calls,0);assert.equal(f.starts,0);assert(f.work.input.includes('Unsaved draft'));
  const pending=f.work.generate();await until(()=>f.calls===1);unsubscribe();const before=renders;
  f.finish();await pending;assert.equal(renders,before);assert(f.work.draft.text.includes('Result'));
  await f.work.generate();assert.equal(f.calls,1);assert.equal(f.work.used,true);
  await f.work.apply('append');assert.equal(f.changes,1);assert(f.text.includes('- [ ] Review'));
  await f.work.apply('append');assert.equal(f.changes,1);
});
test('changed source keeps paid result and permits create-only saving with no extra call',async()=>{
  const f=fixture();await f.work.initialize();f.work.choose('summary');await f.work.generate();f.edit('New private unsaved edits');
  await f.work.apply('append');assert.equal(f.changes,0);assert.equal(f.text,'New private unsaved edits');assert(f.work.draft);
  await f.work.saveNew();await f.work.saveNew();assert.equal(f.saved.length,1);assert(f.saved[0].path.startsWith('private-folder/'));assert(f.saved[0].content.includes('- [ ] Review'));assert.equal(f.calls,1);
});
test('Calendar is explicitly optional and ambiguous context does not read all workspaces',async()=>{
  const f=fixture();await f.work.initialize();f.work.choose('refine');assert(!('calendar_records'in JSON.parse(f.work.input)));
  f.work.calendarQuestion='Help me';assert.equal(await f.work.findCalendar(),null);assert.equal(f.starts,0);
  f.work.calendarQuestion='My study this week';assert.equal(await f.work.findCalendar(),'local-scheme://safe');assert.equal(f.starts,1);assert.equal(f.calls,0);
  await f.work.receive('matching');assert.equal(f.work.delivery,null);assert.equal(f.calls,0);
  await f.work.removeCalendar();assert.equal(f.work.requestId,null);assert(f.work.prompt.includes('Refine'));
});
test('vault unload prevents late response application; shared session gate blocks concurrent calls',async()=>{
  const f=fixture({delay:true});await f.work.initialize();f.work.choose('summary');const pending=f.work.generate();await until(()=>f.calls===1);
  f.work.dispose();f.stop();f.finish();await pending;assert.equal(f.work.draft,null);assert.equal(f.changes,0);
  const gate={busy:false}, a=new AiSession({current:()=>true,key:async()=> 'sk-synthetic-shared-key',adapters:[OPENAI_ADAPTER],gate,transport:async()=>await new Promise(()=>{})});
  const b=new AiSession({current:()=>true,key:async()=> 'sk-synthetic-shared-key',adapters:[OPENAI_ADAPTER],gate,transport:async()=>{throw Error('must not send');}});
  a.enableForSession(true);b.enableForSession(true);const capture=f.work.source;
  const review=await a.prepareNote(capture,'x',{model:'offline-test-model'},()=>true);void a.generate(review,true);await flush();
  assert.equal(b.inFlight,true);await assert.rejects(b.prepareNote(capture,'x',{model:'offline-test-model'},()=>true));
});
