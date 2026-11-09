import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNoteAnswer, noteAnswerFormat, noteDiff, noteTerms } from '../dist/note-workspace.js';
import { NoteWork } from '../dist/note-work.js';
import { AiSession } from '../dist/ai-session.js';
import { OPENAI_ADAPTER } from '../dist/openai.js';
test('structured proposals bind only reviewed references, never filesystem paths or duplicate targets',()=>{
 const valid={reply:'Review these changes',changes:[{target:'N1',action:'replace',title:'Study',markdown:'# Revised'},{target:'new',action:'create',title:'Chart',markdown:'```mermaid\npie\n"Done" : 2\n"Remaining" : 2\n```'}]};
 assert.equal(parseNoteAnswer(JSON.stringify(valid),['N1']).changes.length,2);
 assert.deepEqual(noteAnswerFormat(['N1']).schema.properties.changes.items.properties.target.enum,['N1','new']);
 for(const change of [{...valid.changes[0],target:'../../private.md'},{...valid.changes[0],target:'N2'},{...valid.changes[0],action:'delete'},{...valid.changes[1],action:'replace'}])assert.throws(()=>parseNoteAnswer(JSON.stringify({...valid,changes:[change]}),['N1']));
 assert.throws(()=>parseNoteAnswer(JSON.stringify({...valid,changes:[valid.changes[0],valid.changes[0]]}),['N1']));
 assert(!noteTerms('Create a diagram of Study progress').includes('diagram'));
 assert(noteDiff('Same\nOld\nEnd','Same\nNew\nEnd').includes('- Old\n+ New'));
});
test('one reviewed answer updates an existing full note, a related note and a create-only new Markdown file; undo and follow-up preserve originals',async()=>{
 let main='# Study\nOriginal',related='# Reference\nOriginal',calls=0;const backups=[],files=new Map();
 const graph='```mermaid\nflowchart TD\nA[Study] --> B[Review]\n```';
 const answer={reply:'Three proposed changes.',changes:[{target:'N1',action:'replace',title:'Study',markdown:'# Study revised\n'+graph},{target:'N2',action:'append',title:'Reference',markdown:'- [ ] Review'},{target:'new',action:'create',title:'Study report',markdown:'# Report\n| Check | Done |\n| --- | --- |\n| Mobile | Yes |'}]};
 const target={identity:{},path:'Study.md',title:'Study',read:()=>main,change(from,to,text){main=main.slice(0,from)+text+main.slice(to);}};
 const doc={reference:'N2',title:'Reference',path:'private/ref.md',text:related,read:async()=>related,replace:async(expected,value)=>{assert.equal(related,expected);related=value;}};
 const ai=new AiSession({current:()=>true,key:async()=> 'sk-synthetic-workspace-key',adapters:[OPENAI_ADAPTER],transport:async request=>{
  calls++;const body=JSON.parse(request.body),input=JSON.parse(body.input);assert.equal(body.text.format.strict,true);assert.equal(input.related_notes[0].reference,'N2');assert(!request.body.includes('private/ref.md'));
  return {status:200,text:JSON.stringify({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(answer)}]}]})};
 }});
 const work=new NoteWork(target,{from:0,to:0},{current:()=>true,ai,preferences:{read:async()=>({model:'offline-test-model'}),hasKey:async()=>true},inboxHint:()=>'',calendar(){throw Error('Not needed');},
  save:async(path,text)=>{assert(!files.has(path),'create only');files.set(path,text);},workspace:{search:async()=>({documents:[doc],scanned:2,total:50}),backup:async(path,text)=>{backups.push({path,text});return 'backup.md';}}});
 await work.initialize();work.setPrompt('Rewrite the study note, update the reference, and create a report with a diagram');await work.findRelated();assert.equal(calls,0);
 await work.generate();assert.equal(calls,1);assert.equal(work.proposals.length,3);assert.equal(main,'# Study\nOriginal');
 await work.applyProposal();assert(main.includes('```mermaid'));assert.equal(backups[0].text,'# Study\nOriginal');
 await work.undo();assert.equal(main,'# Study\nOriginal');assert(work.draft);
 work.selectProposal(1);await work.applyProposal();assert(related.includes('- [ ] Review'));assert.equal(backups[1].text,'# Reference\nOriginal');
 await work.undo();assert.equal(related,'# Reference\nOriginal');
 work.selectProposal(2);await work.saveNew();await work.saveNew();assert.equal(files.size,1);assert(files.has('Study report.md'));
 await work.followUp();assert.equal(work.used,false);assert.equal(work.previousTurns.length,1);assert(work.input==='');assert(work.previousTurns[0].answer.includes('```mermaid'));
 work.setPrompt('Now explain the diagram');assert(JSON.parse(work.input).previous_turns[0].answer.includes('flowchart'));assert.equal(calls,1);
});
test('changed full note is never replaced; backup failure also prevents the edit',async()=>{
 for(const failure of ['changed','backup']) {
  let text='Original';const target={identity:{},path:'a.md',title:'a',read:()=>text,change(){throw Error('Must not write');}};
  const work=new NoteWork(target,{from:0,to:0},{current:()=>true,ai:{},preferences:{read:async()=>({model:'x'}),hasKey:async()=>true},workspace:{backup:async()=>{throw Error('Backup unavailable');}},save:async()=>{},inboxHint:()=>'',calendar(){}});
  await work.initialize();work.used=true;work.draft={text:'Replacement'};work.proposals=[{target:'N1',action:'replace',title:'a',markdown:'Replacement'}];
  if(failure==='changed')text='New owner edits';await work.applyProposal();assert.equal(text,failure==='changed'?'New owner edits':'Original');assert.equal(work.applied,false);
 }
});
