import test from 'node:test';
import assert from 'node:assert/strict';
import { captureNote, applyNote, buildNoteInput, safeNoteMarkdown } from '../dist/note-context.js';
import { AiSession } from '../dist/ai-session.js';
import { OPENAI_ADAPTER } from '../dist/openai.js';

function fixture(text='Unsaved draft\nselected text\nend') {
  let current=text, history=[], open=true;
  const target={identity:{},path:'private/folder/a.md',title:'a',read:()=>open?current:null,
    change(from,to,value){history.push(current);current=current.slice(0,from)+value+current.slice(to);}};
  return {target,get text(){return current;},edit(value){current=value;},close(){open=false;},undo(){current=history.pop();},get changes(){return history.length;}};
}
test('unsaved selection is the only outbound note content; insertion is one undoable change',async()=>{
  const f=fixture(), capture=await captureNote(f.target,{from:14,to:27});
  const input=JSON.parse(buildNoteInput(capture,'Refine this'));
  assert.equal(input.note.text,'selected text');assert.equal(input.note.scope,'selection');
  assert(!JSON.stringify(input).includes('private/folder'));assert(!JSON.stringify(input).includes('Unsaved'));
  await applyNote(capture,'## Draft\n- [ ] Task','below',()=>true);
  assert.equal(f.changes,1);assert(f.text.includes('selected text\n\n## Draft\n- [ ] Task\n'));
  f.undo();assert.equal(f.text,'Unsaved draft\nselected text\nend');
});
test('replace is explicit and never overwrites changed, closed or wrong-vault source',async()=>{
  for(const state of ['changed','closed','vault']) {
    const f=fixture(),c=await captureNote(f.target,{from:14,to:27});
    if(state==='changed')f.edit('New unsaved work');if(state==='closed')f.close();
    await assert.rejects(applyNote(c,'paid result','replace',()=>state!=='vault'));
    assert.equal(f.changes,0);
  }
  const f=fixture(),c=await captureNote(f.target,{from:14,to:27});
  await applyNote(c,'Better','replace',()=>true);assert.equal(f.text,'Unsaved draft\nBetter\nend');
});
test('long notes require an explicit complete section or selection; no silent truncation',async()=>{
  const f=fixture('# Small\nActual section\n# Large\n'+'a'.repeat(40000));
  await assert.rejects(captureNote(f.target,{from:5,to:5}),/32 KiB/);
  const c=await captureNote(f.target,{from:5,to:5},true);
  assert.equal(c.scope,'section');assert.equal(c.text,'# Small\nActual section\n');
  const all=fixture('whole note'),n=await captureNote(all.target,{from:0,to:0});
  await assert.rejects(applyNote(n,'x','replace',()=>true));
});
test('Markdown keeps headings and tasks but deactivates executable blocks, images, links and HTML',()=>{
  const safe=safeNoteMarkdown('# Heading\n- [ ] Task\n- [x] Done\n<script>x</script>\n![pic](https://x)\n![[secret]]\n[go](obsidian://open)\n\\\\![x](https://x)\n```dataviewjs\nalert(1)\n```');
  assert(safe.startsWith('# Heading\n- [ ] Task\n- [x] Done'));
  assert(!safe.includes('<script>'));assert(!safe.includes('!['));assert(!safe.includes('[[secret]]'));
  assert(safe.includes('```text'));assert(!safe.includes('```dataviewjs'));assert(safe.includes('obsidian\\:'));
});
test('one note call survives sheet closure and source edits; a review cannot be resent',async()=>{
  const f=fixture(),capture=await captureNote(f.target,{from:0,to:0});let resolve,calls=0;
  const session=new AiSession({current:()=>true,key:async()=> 'sk-test-not-a-real-key',adapters:[OPENAI_ADAPTER],
    transport:async request=>{calls++;const body=JSON.parse(request.body);assert.equal(body.store,false);assert(!('max_output_tokens'in body));
      assert(body.instructions.includes('Obsidian'));return await new Promise(r=>{resolve=r;});}});
  session.enableForSession(true);const review=await session.prepareNote(capture,'Summarize',{model:'gpt-6-luna'},()=>true);
  const pending=session.generate(review,true);await new Promise(r=>setImmediate(r));
  f.edit('User changed source while sheet is hidden');
  resolve({status:200,text:JSON.stringify({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Paid draft'}]}]})});
  assert.equal((await pending).text,'Paid draft');assert.equal(calls,1);
  await assert.rejects(session.generate(review,true));assert.equal(calls,1);
});
