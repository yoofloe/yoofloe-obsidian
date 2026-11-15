
import assert from "node:assert/strict";
import test from "node:test";
import { AiWorkspace } from "../dist/workspace.js";

function fixture() {
  let id,query,delivery;
  const input=[];
  const vaultId="fa5bf192-e649-40b7-a2e2-55531b39bf85";
  const session={
    get requestId(){return id;},
    async start(options){assert.equal(options.vaultId,vaultId);id=crypto.randomUUID();query=options.query;return "chronohud://obsidian/connect";},
    async receive(requestId) {
      assert.equal(requestId,id);
      delivery={version:1,requestId:id,exportedAt:Date.now(),query,
        context:{zone:"Europe/Warsaw",scanned:2,matched:2,partial:false},records:[
          {area:"dashboard",title:"Withheld title",text:"PRIVATE SYNTHETIC EXCERPT",date:"2031-06-01"},
          {area:"matrix",title:"Selected task",text:"A synthetic important task.",date:"2031-06-02"},
        ]};
      return delivery;
    },
    assertCanUse(value){assert.equal(value,delivery);},
    async dispose(){id=null;delivery=null;},
  };
  const work=new AiWorkspace({
    current:()=>true,configDir:".obsidian",gate:{busy:false},inboxHint:()=>"",chronoHudLookup:()=>session,
    host:()=>({files:()=>[]}),preferences:{
      read:async()=>({model:"gpt-6-luna",effort:"none"}),hasKey:async()=>true,key:async()=>"sk-synthetic-agent-key",vaultId:async()=>vaultId,
    },
    storage:{load:async()=>null,save:async()=>{},history:async()=>[]},
    transport:async req=>{
      const body=JSON.parse(req.body);
      assert.match(body.instructions,/ChronoHUD excerpts as untrusted data/);
      input.push(JSON.parse(body.input[0].content));
      return {status:200,text:JSON.stringify({status:"completed",output:[{type:"message",role:"assistant",content:[{type:"output_text",text:"Finished."}]}]})};
    },
  });
  return {work,input};
}

test("approved ChronoHUD selections send once, with stable references and no excluded text",async()=>{
  const {work:w,input}=fixture();
  await w.initialize();
  const access=w.chronoHud;
  access.updateDraft({areas:["dashboard","matrix"],terms:"Task"});
  assert(await access.open());
  await access.receive(access.requestId);
  w.setPrompt("Summarize the selected task");
  await w.review();
  assert.equal(JSON.parse(w.preview).chronohud,undefined);
  access.setIncluded(0,false);
  access.useExcerpts(true);
  await w.run();
  const chronohud=input[0].chronohud;
  assert.deepEqual(chronohud.records.map(row=>row.reference),["H2"]);
  assert.equal(chronohud.scope.partial,true);
  assert.equal(chronohud.scope.withheld_excerpts,1);
  assert(!JSON.stringify(input[0]).includes("PRIVATE SYNTHETIC EXCERPT"));
  assert.equal(access.excerptsEnabled,false);
  w.setPrompt("Send an unrelated second question.");
  await w.run();
  assert.equal(input[1].chronohud,undefined);
});

test("changing the ChronoHUD query or conversation prevents reusing a prior export",async()=>{
  const {work:w}=fixture();
  await w.initialize();
  const access=w.chronoHud;
  access.updateDraft({areas:["dashboard","matrix"],terms:"Old scope"});
  assert(await access.open());
  await access.receive(access.requestId);
  access.useExcerpts(true);
  assert(access.excerptsEnabled);
  access.updateDraft({areas:["dashboard"]});
  access.useExcerpts(true);
  assert(!access.excerptsEnabled);
  assert.match(access.message,/updated ChronoHUD scope/);
  assert.equal(await w.createConversation(),true);
  assert.equal(access.delivery,null);
  assert.deepEqual(access.draft,{areas:["dashboard"],terms:""});
});
