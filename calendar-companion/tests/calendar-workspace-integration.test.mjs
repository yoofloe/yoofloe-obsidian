
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { AiWorkspace } from "../dist/workspace.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/calendar-workspace-lookup-v5.json", import.meta.url), "utf8"));
const vaultId = "815b9a69-7a8f-496d-abcb-2699e5481d75";
const datasetId = "4ac45c5b-d48b-4d1a-9a15-9b983b73a04c";
const eventId = "abd15991-4fef-4ee9-a66c-5786023a6f26";
const studyId = "d529cd03-fce1-4b28-a27b-2afff19d177a";
const seriesId = "ca832a75-d26c-4ad6-9821-6e467393c4f2";
const modelPacket = output => ({status: 200, text: JSON.stringify({status: "completed", output})});
const message = text => ({type: "message", role: "assistant", content: [{type: "output_text", text}]});
const call = operations => ({type: "function_call", call_id: "draft-workspace", name: "draft_calendar_workspace_changes",
  arguments: JSON.stringify({ operations })});

function makeFixture() {
  let request, id, approved, changeAction, changeId, activeDraft, saved, transport = [];
  const transfers = [];
  const capabilities = { readKinds:["event","study_session"], writeKinds: [
    { kind:"event", actions:["create","update"] }, { kind:"study_session", actions:["create","update"] },
  ] };
  const lookup = {
    get requestId() { return id; },
    start: async info => { assert.equal(info.vaultId, vaultId); id=crypto.randomUUID(); request=info.query; return "v5 lookup"; },
    receive: async (submitted, imported) => {
      assert.equal(submitted,id);
      if (imported) assert.equal(imported.name, id+".reply.json");
      const records = request.mode==="records" ? [
        {id:"e1",sourceId:eventId,revision:6,kind:"event",title:"Synthetic private event",text:"WITHHOLD THIS EXCERPT",state:"active",date:"2031-06-03",details:{origin:{seriesId,seriesRevision:8,originalStart:"2031-06-03",timeBasis:"DATE"}}},
        {id:"s1",sourceId:studyId,revision:9,kind:"study_session",title:"Synthetic study",text:"APPROVED EXCERPT",state:"active",date:"2031-06-03",details:{recordedSeconds:3600}},
      ] : [];
      approved={version:5,requestId:id,query:request,exportedAt:Date.now(),datasetId,records,capabilities,
        context: request.lookup ? {scope:request.lookup,from:"2031-06-01",through:"2031-06-08",zone:request.lookup.zone,partial:true,
          scanned:2,matched:2,metrics:[]} : null};
      return approved;
    },
    exportPending: () => id ? {name:id+".request.json",contents:"synthetic marker"} : null,
    assertCanUse: value => assert.equal(value,approved),
    dispose: async () => { approved=null; id=null; },
  };
  const bridge = {
    get action() { return changeAction; },
    get requestId() { return changeId; },
    start: async (draft, info) => { assert.equal(draft.datasetId,datasetId); assert.equal(info.datasetId,datasetId);
      activeDraft=draft; changeAction=info.action; changeId=crypto.randomUUID(); transfers.push(info.action); return "v5 change"; },
    exportPending: () => changeId ? {name:changeId+".change.request.json",contents:"synthetic marker"} : null,
    receive: async (submitted, imported) => {
      assert.equal(submitted,changeId);
      assert.equal(imported.name,changeId+".change.reply.json");
      const status=changeAction==="undo" ? "undone" : "applied"; changeId=null;
      return {status,datasetId,version:5,proposalId:activeDraft.proposalId,proposalDigest:activeDraft.proposalDigest,
        results:activeDraft.operations.map(op => ({opId:op.opId,kind:op.kind,id:op.target?.id,revision:10}))};
    },
    dispose: async () => { changeId=null; },
  };
  const originalNote = {path:"Original.md", title:"Original", size:16, identity:{}};
  const options = {
    current:()=>true, configDir:".obsidian", gate:{busy:false}, inboxHint:()=>"",
    workspaceLookup:()=>lookup, workspaceChange:()=>bridge,
    host:()=>({files:()=>[originalNote],read:async()=>{throw Error("Do not read vault notes in proposal mode");}}),
    preferences:{read:async()=>({model:"gpt-6-luna",effort:"none"}),hasKey:async()=>true,key:async()=>"sk-synthetic-agent-key",vaultId:async()=>vaultId},
    storage:{load:async()=>null,save:async value=>{saved=structuredClone(value);},history:async()=>[]},
    transport:async req=>{
      const body=JSON.parse(req.body), raw=JSON.stringify(body);
      transport.push(body);
      assert(!raw.includes(eventId) && !raw.includes(studyId) && !raw.includes("WITHHOLD THIS EXCERPT"));
      assert.deepEqual(body.tools.map(x=>x.name),["draft_calendar_workspace_changes"]);
      assert(raw.includes("APPROVED EXCERPT"));
      if(transport.length===1)return modelPacket([call([{kind:"study_session",action:"update",record:"C2",valuesJson:'{"title":"Edited synthetic session"}'}])]);
      return modelPacket([message("Review in Calendar.")]);
    },
  };
  return {work:new AiWorkspace(options),options,transfers,get saved(){return saved;},get requests(){return transport.length;}};
}

test("V5 workspace proposal shares selected excerpts, persists a scoped draft, and imports approved Apply and Undo replies",async()=>{
  const data=makeFixture(),w=data.work;
  await w.initialize();
  w.setWorkspaceCalendarDraft(true);
  assert.equal(w.workspaceCalendarChanges.enabled,false);
  const access=w.workspaceCalendar;
  assert.equal(await access.open("capabilities"),"v5 lookup");
  assert.match(access.exportPending().name,/\.request\.json$/);
  await access.receive(access.requestId,{name:access.requestId+".reply.json",contents:"authenticated mock"});
  assert.equal(access.datasetId,datasetId);
  access.updateSelection({areas:["calendar","study"],kinds:["event","study_session"],period:"custom",from:"2031-06-01",through:"2031-06-08"});
  assert.equal(await access.open("records"),"v5 lookup");
  await access.receive(access.requestId,{name:access.requestId+".reply.json",contents:"authenticated mock"});
  assert.equal(access.excerptsEnabled,false);
  access.setIncluded(0,false);
  access.useExcerpts(true);
  w.setWorkspaceCalendarDraft(true);
  w.setPrompt("Update my included study session title");
  await w.review();
  assert(w.preview.includes("APPROVED EXCERPT") && !w.preview.includes("WITHHOLD THIS EXCERPT"));
  assert.deepEqual(JSON.parse(w.preview).calendar_records.map(record => record.reference), ["C2"]);
  await w.run();
  assert.equal(data.requests,2);
  assert.equal(w.workspaceCalendarChanges.state.status,"draft");
  const operation=w.workspaceCalendarChanges.state.draft.operations[0];
  assert.deepEqual(operation.target,{id:studyId,revision:9});
  assert.equal(operation.kind,"study_session");
  assert.equal(data.saved.workspaceCalendarChange.draft.version,5);
  assert.deepEqual(data.transfers,[]);
  assert.equal(await w.workspaceCalendarChanges.open("review"),"v5 change");
  let id=w.workspaceCalendarChanges.requestId;
  assert.match(w.workspaceCalendarChanges.exportPending().name,/\.change\.request\.json$/);
  assert(await w.workspaceCalendarChanges.receive(id,{name:id+".change.reply.json",contents:"authenticated mock"}));
  assert.equal(w.workspaceCalendarChanges.state.status,"applied");
  assert.equal(await w.workspaceCalendarChanges.open("undo"),"v5 change");
  id=w.workspaceCalendarChanges.requestId;
  assert(await w.workspaceCalendarChanges.receive(id,{name:id+".change.reply.json",contents:"authenticated mock"}));
  assert.equal(w.workspaceCalendarChanges.state.status,"undone");
  assert.deepEqual(data.transfers,["review","undo"]);
  assert.equal(data.requests,2);
  const restored=new AiWorkspace({...data.options,storage:{...data.options.storage,load:async()=>data.saved}});
  await restored.initialize();
  assert.equal(restored.workspaceCalendarChanges.state.status,"undone");
  assert.equal(restored.workspaceCalendar.datasetId,null);
  assert.equal(restored.workspaceCalendar.excerptsEnabled,false);
});

test("Changing the selected lookup scope revokes approved excerpts and proposal authorization until a fresh lookup",async()=>{
  const {work:w}=makeFixture();
  await w.initialize();
  const access=w.workspaceCalendar;
  assert(await access.open("capabilities"));
  await access.receive(access.requestId);
  access.updateSelection({areas:["calendar","study"],kinds:["event","study_session"]});
  assert(await access.open("records"));
  await access.receive(access.requestId);
  access.useExcerpts(true);
  assert.equal(access.datasetId,datasetId);
  access.updateSelection({areas:["study"],kinds:["study_session"]});
  assert.equal(access.excerptsEnabled,false);
  assert.equal(access.datasetId,null);
  w.setWorkspaceCalendarDraft(true);
  assert.equal(w.workspaceCalendarChanges.enabled,false);
});

assert(fixture, "the deterministic wire fixture remains available to native verification");


test("Review of an approved recurring event shows only temporal origin details in the provider input", async()=>{
  const {work:w}=makeFixture();
  await w.initialize();
  const access=w.workspaceCalendar;
  assert(await access.open("capabilities"));
  await access.receive(access.requestId);
  access.updateSelection({areas:["calendar"],kinds:["event"],topic:"original event"});
  assert(await access.open("records"));
  await access.receive(access.requestId);
  access.setIncluded(1,false);
  access.useExcerpts(true);
  w.setWorkspaceCalendarDraft(true);
  w.setPrompt("Edit the approved event occurrence");
  await w.review();
  const raw=w.preview, record=JSON.parse(raw).calendar_records[0];
  assert(!raw.includes(seriesId) && !raw.includes(eventId));
  assert.deepEqual(record.details.origin,{originalStart:"2031-06-03",timeBasis:"DATE"});
  assert.equal(record.reference,"C1");
});
