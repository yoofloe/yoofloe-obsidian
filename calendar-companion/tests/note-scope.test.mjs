import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedPath } from '../dist/agent-policy.js';
import { agentTools } from '../dist/agent-protocol.js';
import { VaultAgent } from '../dist/vault-agent.js';

const base = { sourcePath:'Notes/Current.md', folder:'Output', readScope:'current', writeScope:'current', mode:'all', configDir:'.obsidian', excluded:['Private'] };
function fixture(overrides={}) {
 const files=new Map(['Notes/Current.md','Output/Existing.md'].map(path=>[path,{identity:{},path,title:path,size:8,text:'Original'}])),backups=new Map();
 const host={files:()=>[...files.values()],read:async f=>files.get(f.path)?.identity===f.identity?files.get(f.path).text:null,
  create:async(path,text)=>{assert(!files.has(path));const file={identity:{},path,title:path,size:text.length,text};files.set(path,file);return file;},
  replace:async(f,before,after)=>{assert.equal(files.get(f.path).identity,f.identity);assert.equal(f.text,before);f.text=after;},
  rename:async(f,path)=>{assert(!files.has(path));files.delete(f.path);f.path=path;f.title=path;files.set(path,f);},folder:async()=>true,affected:()=>[],
  backup:async(_path,text)=>{const path=`Yoofloe AI/Backups/${crypto.randomUUID()}.md`;backups.set(path,text);return path;},readBackup:async path=>backups.get(path),
  trash:async f=>files.delete(f.path),persist:async()=>{}};
 const policy={...base,...overrides};return {files,host,policy,agent:new VaultAgent(host,policy,()=>true)};
}
const read = async (agent,reference) => (await agent.execute('read_notes',{notes:[{reference,from_line:1,through_line:0}]})).notes[0];
const append = (agent,reference,version,markdown) => agent.execute('apply_changes',{changes:[{reference,version,action:'append',markdown}]});

test('Current note never gains creation authority, including All actions and an empty output folder',()=>{
 for(const mode of ['edit','organize','all'])for(const folder of ['','Output'])for(const sourcePath of ['Notes/Current.md',null]){
  const policy={...base,mode,folder,sourcePath};
  for(const path of ['New.md','Output/New.md','Elsewhere/New.md'])assert.equal(allowedPath(policy,path,'create'),false);
  assert.equal(allowedPath(policy,'Output/chart.png','create',true),false);assert.equal(allowedPath(policy,'Output/New folder','organize',true),false);
  assert.equal(allowedPath(policy,'Notes/Current.md','edit'),sourcePath!==null);assert.equal(allowedPath(policy,'Output/Existing.md','edit'),false);
  for(const name of ['create_note','create_folder','save_generated_file'])assert(!agentTools(mode,'current').some(tool=>tool.name===name));
 }
});

test('explicit new-note destinations remain bounded even with Vault writes',()=>{
 for(const writeScope of ['new','folder','vault']){
  const policy={...base,readScope:'vault',writeScope};assert(allowedPath(policy,'Output/New.md','create'));assert(!allowedPath(policy,'Other/New.md','create'));
  assert(!allowedPath({...policy,excluded:['Output/Private']},'Output/Private/New.md','create'));
  assert(!allowedPath({...policy,folder:''},'.obsidian/private.md','create'));assert(allowedPath(policy,'Other/Context.md','read'));
 }
 assert(!allowedPath({...base,writeScope:'new'},'Notes/Current.md','edit'));
 assert(!allowedPath({...base,mode:'ask',writeScope:'new'},'Output/New.md','create'));
});

test('All actions cannot create files or move the current note outside its folder',async()=>{
 const f=fixture({readScope:'vault',folder:''}),initial=await f.agent.initialContext();
 for(const [name,args] of [['create_note',{path:'Other/New.md',markdown:'Forbidden'}],['create_folder',{path:'Other'}],['save_generated_file',{reference:'untrusted',path:'Other/chart.png'}]])await assert.rejects(f.agent.execute(name,args),/not enabled/);
 await assert.rejects(f.agent.execute('rename_note',{reference:'N1',version:initial.version,path:'Other/Moved.md'}),/change scope/);
 const hits=await f.agent.execute('search_notes',{query:'Existing',limit:4,offset:0}),other=hits.notes.find(note=>note.path==='Output/Existing.md');assert(other);
 const context=await read(f.agent,other.reference);await assert.rejects(append(f.agent,other.reference,context.version,'Forbidden'),/edit scope/);
 await assert.rejects(f.agent.execute('propose_trash',{references:[other.reference]}),/current scope/);
 await f.agent.execute('rename_note',{reference:'N1',version:initial.version,path:'Notes/Renamed.md'});
 const renamed=await read(f.agent,'N1');await append(f.agent,'N1',renamed.version,'Allowed edit');
 assert.equal(f.files.get('Output/Existing.md').text,'Original');assert(f.files.get('Notes/Renamed.md').text.includes('Allowed edit'));assert(!f.files.has('Other/New.md'));
});

test('New documents permits task-owned revisions and renames while preserving all existing notes',async()=>{
 const f=fixture({writeScope:'new'}),original=await f.agent.initialContext();await assert.rejects(append(f.agent,'N1',original.version,'Forbidden'),/edit scope/);
 await assert.rejects(f.agent.execute('create_note',{path:'Outside/New.md',markdown:'Forbidden'}),/output folder/);
 const created=await f.agent.execute('create_note',{path:'Output/New.md',markdown:'# New'}),context=await read(f.agent,created.reference);
 await append(f.agent,created.reference,context.version,'Revision');const updated=await read(f.agent,created.reference);
 await f.agent.execute('create_note',{path:'Output/Peer.md',markdown:'[[Output/New]]'});f.host.affected=()=>['Output/Peer.md'];
 await f.agent.execute('rename_note',{reference:created.reference,version:updated.version,path:'Output/Sub/Renamed.md'});
 assert.equal((await read(f.agent,created.reference)).path,'Output/Sub/Renamed.md');
 const search=await f.agent.execute('search_notes',{query:'Renamed',limit:4,offset:0});assert(search.notes.some(note=>note.path==='Output/Sub/Renamed.md'));
 assert.equal(f.files.get('Notes/Current.md').text,'Original');assert.equal(f.files.get('Output/Existing.md').text,'Original');
 const next=new VaultAgent(f.host,{...f.policy,sourcePath:'Output/Sub/Renamed.md'},()=>true),nextContext=await next.initialContext();
 await assert.rejects(append(next,'N1',nextContext.version,'Not owned by this task'),/edit scope/);
});

test('task ownership never follows an externally replaced or moved filename',async()=>{
 for(const change of ['replace','move']){
  const f=fixture({writeScope:'new'}),created=await f.agent.execute('create_note',{path:'Output/New.md',markdown:'Synthetic'}),file=f.files.get('Output/New.md');
  if(change==='replace')f.files.set(file.path,{...file,identity:{},text:'External private replacement'});else await f.host.rename(file,'Outside/Moved.md');
  await assert.rejects(read(f.agent,created.reference),/renamed|data scope/);
  await assert.rejects(append(f.agent,created.reference,created.version,'Forbidden'),/renamed|data scope/);
 }
});
