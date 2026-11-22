import test from 'node:test';
import assert from 'node:assert/strict';
import { createAndroidModelStream } from '../dist/android-model-stream.js';
import { AgentTask } from '../dist/agent-task.js';
import { diagnosticFixture, exportedReport } from './fixtures/diagnostics.mjs';

const endpoint = 'https://api.openai.com/v1/responses';
const encoder = new TextEncoder();
const frame = (type, detail) => 'event: ' + type + '\r\ndata: ' + JSON.stringify({type, ...detail}) + '\r\n\r\n';
const answer = {id:'msg_ok', type:'message', role:'assistant', content:[{type:'output_text', text:'기록 · Łódź'}]};
const completed = frame('response.completed', {response:{status:'completed', output:[answer]}});
const outbound = () => ({url:endpoint, method:'POST', contentType:'application/json', throw:false,
  headers:{Authorization:'Bearer sk-synthetic-agent-key', 'X-Client-Request-Id':crypto.randomUUID()},
  body:JSON.stringify({model:'gpt-6.2-sol', store:false, stream:true, input:'fixture'})});
const responseHeaders = {'content-type':'text/event-stream','x-request-id':'req_0123456789abcdef0123456789abcdef','private-header':'private fixture'};

test('Android consumes the complete terminal event before HTTP EOF and preserves split UTF-8, CRLF and compaction', {timeout:5000}, async () => {
  const compact = {id:'cmp_ok', type:'compaction', encrypted_content:'opaque-fixture'};
  const partialTool = {type:'function_call',call_id:'never-run',name:'create_note',arguments:'{}'};
  const frames = '\ufeff: heartbeat\r\n\r\n' +
    frame('response.output_item.done', {output_index:0,item:compact}) +
    frame('response.output_item.added', {output_index:1,item:answer}) +
    frame('response.output_item.done', {output_index:2,item:partialTool}) + completed;
  const bytes = encoder.encode(frames);
  let posted = 0, cancelled = 0;
  const stream = createAndroidModelStream({fetch:async (url, options) => {
    posted++;
    assert.equal(url,endpoint);
    assert.equal(options.redirect,'error'); assert.equal(options.credentials,'omit');
    assert.equal(options.referrerPolicy,'no-referrer'); assert.equal(options.mode,'cors');
    assert.equal(JSON.parse(options.body).store,false);
    return new Response(new ReadableStream({
      start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); },
      cancel() { cancelled++; },
    }),{status:200,headers:responseHeaders});
  }});
  const receipts=[];
  const result = await stream(outbound(), receipt=>receipts.push(receipt));
  assert.equal(posted,1); assert.equal(cancelled,1);
  assert.equal(receipts.length,1); assert.equal(receipts[0].status,200);
  assert.equal(receipts[0].headers['private-header'],undefined);
  assert.deepEqual(JSON.parse(result.text).output,[compact,answer]);
  assert.equal(result.terminal.compactionReported,true);
});

test('cutting Android transport before the terminal event pauses with the received HTTP status and executes no provisional call', async () => {
  const {diagnostics}=diagnosticFixture();
  const run=diagnostics.start('assistant');
  let posts=0, edits=0, nativePosts=0;
  const directStream=createAndroidModelStream({fetch:async()=>{
    if(++posts===2) return new Response(completed,{status:200,headers:responseHeaders});
    let sent=false;
    const incomplete=new ReadableStream({pull(controller){
      if(sent) return controller.error(new TypeError('private socket details'));
      sent=true;
      controller.enqueue(encoder.encode(frame('response.output_item.done',{output_index:0,
        item:{type:'function_call',call_id:'unconfirmed',name:'create_note',arguments:'{}'}})));
    }},{highWaterMark:0});
    return new Response(incomplete,{status:200,headers:responseHeaders});
  }});
  const task=new AgentTask({current:()=>true,key:async()=>'sk-synthetic-agent-key',gate:{busy:false},
    streamResponses:true,directStream,diagnostics:run,transport:async()=>{nativePosts++;throw Error('Unexpected fallback')},
    executor:{execute:async()=>{edits++;}},
  });
  await task.run('Read',{model:'gpt-6.2-sol'},'edit',2);
  assert.equal(posts,1); assert.equal(edits,0); assert.equal(nativePosts,0); assert.equal(task.canResume,true);
  const copied=await diagnostics.copyReport({id:run.id});
  const report=exportedReport(copied);
  const head=report.events.find(event=>event.stage==='stream'&&event.outcome==='received');
  assert.equal(head.httpStatus,200); assert.equal(head.transport,'android_webview_stream'); assert.equal(head.providerId,responseHeaders['x-request-id']);
  assert.equal(report.lastFailure.httpStatus,200); assert.equal(report.lastFailure.reason,'response_unconfirmed');
  assert.match(task.message,/Android WebView stream.*OpenAI ID req_/);
  assert.doesNotMatch(copied,/private socket details|sk-synthetic|never-run/);
  await task.resume(2);
  assert.equal(posts,2); assert.equal(task.state,'completed'); assert.equal(task.text,answer.content[0].text);
  assert.equal(nativePosts,0); assert.equal(edits,0);
  await diagnostics.dispose();
});

test('Android direct transport restricts the destination and retains JSON and explicit HTTP error responses', async () => {
  let calls=0;
  const direct=createAndroidModelStream({fetch:async()=>{
    if(++calls===1) return new Response(JSON.stringify({error:{code:'rate_limit_exceeded'}}),{status:429});
    return new Response('  '+JSON.stringify({status:'completed',output:[answer]}),{status:200});
  }});
  await assert.rejects(direct({...outbound(),url:'https://other.invalid/v1/responses'},()=>{}),/endpoint/);
  assert.equal(calls,0);
  const error=await direct(outbound(),()=>{});
  assert.equal(error.status,429); assert.equal(JSON.parse(error.text).error.code,'rate_limit_exceeded');
  const json=await direct(outbound(),()=>{});
  assert.equal(JSON.parse(json.text).status,'completed');
  assert.equal(createAndroidModelStream({fetch:undefined}),undefined);
});

test('a WebView failure before headers can use native HTTP only after explicit Continue', async () => {
  let directPosts=0,nativePosts=0;
  const direct=createAndroidModelStream({fetch:async()=>{directPosts++;throw TypeError('Failed to fetch')}});
  const task=new AgentTask({current:()=>true,key:async()=>'sk-synthetic-agent-key',gate:{busy:false},
    streamResponses:true,directStream:direct,transport:async()=>{nativePosts++;return {status:200,text:completed}},
    executor:{execute:async()=>assert.fail('No local tools expected')}});
  await task.run('Read',{model:'gpt-6.2-sol'},'ask',2);
  assert.equal(directPosts,1);assert.equal(nativePosts,0);assert.equal(task.canResume,true);
  assert.match(task.message,/Continue will use Obsidian HTTP/);
  await task.resume(2);
  assert.equal(directPosts,1);assert.equal(nativePosts,1);assert.equal(task.state,'completed');
});

test('disposing an Android task aborts an outstanding direct stream and never replays the generation', async () => {
  let started,posts=0;
  const ready=new Promise(resolve=>{started=resolve});
  const direct=createAndroidModelStream({fetch:async(_url,options)=>{
    posts++;started();
    return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('Stopped','AbortError')),{once:true}));
  }});
  const task=new AgentTask({current:()=>true,key:async()=>'sk-synthetic-agent-key',gate:{busy:false},
    streamResponses:true,directStream:direct,transport:async()=>assert.fail('Unexpected fallback'),
    executor:{execute:async()=>assert.fail('No output confirmed')}});
  const work=task.run('Read',{model:'gpt-6.2-sol'},'ask',2);
  await ready;task.dispose();await work;
  assert.equal(task.state,'stopped');assert.equal(task.canResume,false);assert.equal(posts,1);
});

test('Stop releases the Android task gate when a stream stays open without a terminal event', { timeout: 6000 }, async () => {
  let receiveHeaders, aborted = false;
  const ready = new Promise(resolve => { receiveHeaders = resolve; });
  const direct = createAndroidModelStream({
    fetch: async (_url, options) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(': still waiting\n\n'));
        options.signal.addEventListener('abort', () => {
          aborted = true;
          controller.error(new DOMException('Stopped', 'AbortError'));
        }, { once: true });
        receiveHeaders();
      },
    }), { status: 200 }),
  });
  const gate = { busy: false };
  const task = new AgentTask({ current: () => true, key: async () => 'sk-synthetic-agent-key', gate,
    streamResponses: true, directStream: direct, transport: async () => assert.fail('Unexpected native POST'),
    executor: { execute: async () => assert.fail('Stopped task cannot write') } });
  const sent = task.run('Test the open stream', { model: 'gpt-6.2-sol' }, 'ask', 2);
  await ready;
  task.stop();
  await sent;
  assert.equal(aborted, true); assert.equal(gate.busy, false);
  assert.equal(task.state, 'stopped'); assert.equal(task.requests, 1);
});
