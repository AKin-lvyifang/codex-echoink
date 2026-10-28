import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire, isBuiltin } from "node:module";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";
import vm from "node:vm";
import esbuild from "esbuild";
import { piDesktopProviderTransportPlugin } from "./pi-desktop-provider-transport.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const build = await esbuild.build({
  stdin: { contents: `export {createDesktopProviderFetch,desktopProviderFailureCode} from "./src/plugin/desktop-provider-fetch";
    export {PiProviderProtocolDispatcher,PiProviderProtocolTransport,classifyPiProviderConnectionFailure} from "./src/harness/pi/pi-provider-protocol-adapter";
    export {sanitizeProviderFailureDetail,providerFailureDetailText} from "./src/harness/pi/provider-failure";`, resolveDir: root, loader: "ts" },
  bundle: true, write: false, platform: "node", target: "node20", format: "cjs",
  external: ["electron", "obsidian"], plugins: [piDesktopProviderTransportPlugin, {
    name: "network-fixture-without-session-cli",
    setup(build) {
      build.onResolve({filter: /\/pi-context-budget$/}, () => ({path: "budget", namespace: "network-fixture"}));
      build.onLoad({filter: /.*/, namespace: "network-fixture"}, () => ({
        contents: `export {calculatePiEffectiveInputBudget} from "${root}src/harness/pi-native/pi-effective-input-budget";
          export function estimatePiContextTokens(){throw Error("Document fallback is outside this network fixture");}`,
        loader: "ts", resolveDir: root
      }));
    }
  }], logLevel: "silent"
});
const requireLocal = createRequire(import.meta.url);
let requests = [], browserFetchCalls = 0;
const session = { name: "host-window-session" };
class NativeRequest extends EventEmitter {
  headers = new Map(); writes = []; aborts = 0;
  constructor(options) { super(); this.options = options; }
  setHeader(name, value) { this.headers.set(name.toLowerCase(), value); }
  write(value) { this.writes.push(Buffer.from(value)); }
  end() { this.emit("finish"); this.emit("close"); }
  abort() { this.aborts++; this.emit("abort"); this.emit("close"); }
  respond(status = 200, headers = { "content-type": "text/event-stream" }) {
    const response = Object.assign(new EventEmitter(), { statusCode: status, headers });
    this.emit("response", response); return response;
  }
  get body() { return JSON.parse(Buffer.concat(this.writes).toString()); }
}
const requireHost = name => {
  if (name === "electron") return { remote: { net: { request: options => { const r = new NativeRequest(options); requests.push(r); return r; } }, getCurrentWebContents: () => ({ session }) } };
  if (name === "obsidian") return { Platform: { isDesktop: true, isDesktopApp: true } };
  assert.ok(isBuiltin(name), `unexpected external ${name}`); return requireLocal(name);
};
const module = { exports: {} };
const context = vm.createContext({ module, exports: module.exports, require: requireHost,
  window: { require: requireHost, setTimeout, clearTimeout }, process, Buffer, Headers, Response, Request, ReadableStream,
  AbortController, AbortSignal, DOMException, Error, TypeError, RangeError, ReferenceError, URL, URLSearchParams, FormData, Blob, File, TextEncoder, TextDecoder,
  atob, btoa, crypto: webcrypto, performance, fetch: () => { browserFetchCalls++; throw Error("Browser fetch forbidden"); },
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, console, structuredClone });
vm.runInContext(build.outputFiles[0].text, context);
const { PiProviderProtocolTransport, PiProviderProtocolDispatcher, createDesktopProviderFetch,
  desktopProviderFailureCode, sanitizeProviderFailureDetail, providerFailureDetailText,
  classifyPiProviderConnectionFailure } = module.exports;
const key = "sk-fake-transport-secret-canary";
let passed = 0;
async function test(name, run) { requests = []; await run(); passed++; console.log(`OK ${name}`); }
async function until(fn) { const deadline=Date.now()+2000; while (!fn()) { if(Date.now()>deadline)throw Error("fixture condition timed out"); await new Promise(r=>setTimeout(r,1)); } }
async function bounded(p) { let t; try { return await Promise.race([p,new Promise((_,reject)=>{t=setTimeout(()=>reject(Error("fixture result timed out")),2500);})]); } finally { clearTimeout(t); } }
const sse = x => Buffer.from(`${x.type ? `event: ${x.type}\n` : ""}data: ${JSON.stringify(x)}\n\n`);
function events(api, kind="text") {
  if(api==="openai-completions") {
    const c=delta=>({id:"response-1",choices:[{index:0,delta,finish_reason:null}]});
    return kind==="tool" ? [c({role:"assistant",tool_calls:[{index:0,id:"call_fixture",type:"function",function:{name:"fixture_read",arguments:""}}]}),c({tool_calls:[{index:0,function:{arguments:'{"value":1}'}}]}),{choices:[{index:0,delta:{},finish_reason:"tool_calls"}]}] : [c({role:"assistant"}),c({content:"甲"}),c({content:"乙"}),{choices:[{index:0,delta:{},finish_reason:"stop"}]}];
  }
  if(api==="anthropic-messages") {
    const start={type:"message_start",message:{id:"response-1",role:"assistant",content:[],usage:{input_tokens:1,output_tokens:0}}};
    const block=kind==="tool"?{type:"tool_use",id:"call_fixture",name:"fixture_read",input:{}}:{type:"text",text:""};
    const deltas=kind==="tool"?[{type:"input_json_delta",partial_json:'{"value":1}'}]:[{type:"text_delta",text:"甲"},{type:"text_delta",text:"乙"}];
    return [start,{type:"content_block_start",index:0,content_block:block},...deltas.map(delta=>({type:"content_block_delta",index:0,delta})),{type:"content_block_stop",index:0},{type:"message_delta",delta:{stop_reason:kind==="tool"?"tool_use":"end_turn"},usage:{output_tokens:2}},{type:"message_stop"}];
  }
  const item=kind==="tool"?{id:"fc_fixture",call_id:"call_fixture",type:"function_call",name:"fixture_read",arguments:""}:{id:"msg_fixture",type:"message",role:"assistant",content:[]};
  const middle=kind==="tool"?[{type:"response.function_call_arguments.delta",output_index:0,delta:'{"value":1}'}]:[{type:"response.output_text.delta",output_index:0,content_index:0,delta:"甲"},{type:"response.output_text.delta",output_index:0,content_index:0,delta:"乙"}];
  const doneItem=kind==="tool"?{...item,arguments:'{"value":1}'}:{...item,content:[{type:"output_text",text:"甲乙"}]};
  return [{type:"response.created",response:{id:"response-1"}},{type:"response.output_item.added",output_index:0,item},...middle,{type:"response.output_item.done",output_index:0,item:doneItem},{type:"response.completed",response:{id:"response-1",status:"completed",output:[],usage:{input_tokens:1,output_tokens:2,total_tokens:3}}}];
}
function write(response, list) { for(const e of list) response.emit("data",sse(e)); }
function finish(response, list) { write(response,list);response.emit("end");response.emit("close"); }
const user={role:"user",content:"fixture",timestamp:1};
const tool={name:"fixture_read",description:"Read fixture",parameters:{type:"object",properties:{value:{type:"number"}}}};
async function start(api,{signal,timeoutMs=1000,messages=[user],method="streamSimple"}={}) {
  const count=requests.length;
  const model={api,provider:api==="anthropic-messages"?"anthropic":"openai",id:"fixture",name:"Fixture",baseUrl:"https://fixture.invalid/v1",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:2048};
  const ctx={messages,tools:[tool]};
  const dispatcher=new PiProviderProtocolDispatcher();
  const stream=method==="stream"?dispatcher.stream({model,context:ctx,apiKey:key,options:{signal,timeoutMs,maxRetries:0,maxTokens:64}}):await new PiProviderProtocolTransport({authorityId:"fixture",storeSetId:"fixture",resolveAuthToken:()=>key,dispatcher}).stream({runId:"r",turnId:"t",conversationId:"c",correlationId:"x",model,context:ctx,provider:{providerId:model.provider,baseUrl:model.baseUrl,apiProtocol:api,modelRef:model.id,authMode:"api-key"},options:{signal,timeoutMs,maxRetries:0,cacheRetention:"none",temperature:0}});
  const received=[]; const collecting=(async()=>{for await(const e of stream)received.push(e);})();
  await until(()=>{const error=received.find(e=>e.type==="error");if(error)throw Error(JSON.stringify(error));return requests.length>count;});
  return {stream,received,collecting,request:requests.at(-1)};
}
for(const api of ["openai-completions","openai-responses","anthropic-messages"]) {
  await test(`${api}: settings and chat use native bytes, text appears before HTTP end`,async()=>{
    for(const method of ["stream","streamSimple"]) {
      const r=await start(api,{method});assert.equal(r.request.options.session,session);
      assert.equal(r.request.options.redirect,"error");assert.equal(r.request.body.stream,true);
      const response=r.request.respond();const list=events(api);const split=list.findIndex(e=>e.delta?.text==="甲"||e.delta==="甲"||e.choices?.[0]?.delta?.content==="甲")+1;
      write(response,list.slice(0,split));await until(()=>r.received.some(e=>e.type==="text_delta"));
      assert.equal(r.received.filter(e=>e.type==="text_delta").map(e=>e.delta).join(""),"甲");
      assert.equal(r.received.some(e=>e.type==="done"),false);
      finish(response,list.slice(split));const result=await bounded(r.stream.result());await r.collecting;
      assert.equal(result.stopReason,"stop");assert.equal(result.content.find(b=>b.type==="text").text,"甲乙");
    }
  });
  await test(`${api}: tool JSON and next-round history survive the native bridge`,async()=>{
    const first=await start(api);finish(first.request.respond(),events(api,"tool"));const assistant=await bounded(first.stream.result());
    assert.equal(assistant.stopReason,"toolUse");const call=assistant.content.find(x=>x.type==="toolCall");assert.equal(call.arguments.value,1);
    const next=await start(api,{messages:[user,assistant,{role:"toolResult",toolCallId:call.id,toolName:call.name,content:[{type:"text",text:"fixture result"}],timestamp:3,isError:false}]});
    assert.match(JSON.stringify(next.request.body),/fixture result/u);finish(next.request.respond(),events(api));assert.equal((await bounded(next.stream.result())).stopReason,"stop");
  });
  for(const afterPartial of [false,true]) await test(`${api}: user cancel ${afterPartial?"after text":"before headers"} aborts the real transaction`,async()=>{
    const controller=new AbortController(),r=await start(api,{signal:controller.signal});
    if(afterPartial){write(r.request.respond(),events(api).slice(0,api==="openai-completions"?2:3));await until(()=>r.received.some(e=>e.type==="text_delta"));}
    controller.abort();const result=await bounded(r.stream.result());assert.equal(result.stopReason,"aborted");assert.equal(r.request.aborts,1);assert.equal(requests.length,1);
    if(afterPartial)assert.ok(result.content.some(b=>b.type==="text"&&b.text));
  });
  for(const phase of ["headers","empty-stream","partial-stream"]) await test(`${api}: timeout at ${phase} terminates and preserves partial output`,async()=>{
    const r=await start(api,{timeoutMs:45});
    if(phase!=="headers"){const response=r.request.respond();if(phase==="partial-stream")write(response,events(api).slice(0,api==="openai-completions"?2:3));}
    const result=await bounded(r.stream.result());assert.equal(result.stopReason,"error");assert.equal(result.errorMessage,phase==="partial-stream"?"provider_partial_interrupted_deadline":"provider_request_timeout");assert.equal(r.request.aborts,1);assert.equal(requests.length,1);
    if(phase==="partial-stream")assert.ok(result.content.some(b=>b.type==="text"&&b.text));
  });
  await test(`${api}: unexpected disconnect retains text and does not regenerate`,async()=>{
    const r=await start(api);const response=r.request.respond();write(response,events(api).slice(0,api==="openai-completions"?2:3));await until(()=>r.received.some(e=>e.type==="text_delta"));response.emit("aborted");
    const result=await bounded(r.stream.result());assert.equal(result.errorMessage,"provider_partial_interrupted_network");assert.ok(result.content.some(b=>b.type==="text"&&b.text));assert.equal(requests.length,1);
  });
  await test(`${api}: HTTP end without a protocol terminal preserves text as interrupted`,async()=>{
    const r=await start(api);const response=r.request.respond();write(response,events(api).slice(0,api==="openai-completions"?2:3));response.emit("end");
    const result=await bounded(r.stream.result());assert.equal(result.errorMessage,"provider_partial_interrupted_network");assert.ok(result.content.some(b=>b.type==="text"&&b.text));assert.equal(requests.length,1);
  });
  for(const [native,code] of [["net::ERR_CERT_AUTHORITY_INVALID","provider_certificate_failed"],["net::ERR_PROXY_CONNECTION_FAILED","provider_proxy_failed"],["unexplained failure","provider_network_error"]]) await test(`${api}: native error evidence ${code} survives SDK wrapping`,async()=>{
    const r=await start(api);r.request.emit("error",new Error(native));const result=await bounded(r.stream.result());assert.equal(result.errorMessage,code);
  });
  for(const status of [401,403]) await test(`${api}: HTTP ${status} shows bounded provider message, not a fabricated cause`,async()=>{
    const r=await start(api);const response=r.request.respond(status,{"content-type":"application/json"});
    response.emit("data",Buffer.from(JSON.stringify({type:"error",error:{type:"invalid_request_error",code:"invalid_request_error",message:`Actual provider explanation ${key}; provider_proxy_failed Request timed out <b>literal</b>`,request:{prompt:"PRIVATE_REQUEST_CANARY"}}})));response.emit("end");
    const result=await bounded(r.stream.result());assert.equal(result.errorMessage,status===401?"provider_auth_failed":"provider_request_rejected");assert.match(result.echoInkProviderFailure.message,/Actual provider explanation/u);assert.doesNotMatch(JSON.stringify(result),/sk-fake-transport-secret-canary|PRIVATE_REQUEST_CANARY/u);
  });
}
await test("message redaction precedes truncation; unstructured bodies are not displayed",async()=>{
  const value=sanitizeProviderFailureDetail(403,{error:{message:`Denied ${key} Authorization: Bearer ${key}; ${"x".repeat(800)}`,code:"denied"}},[key]);
  assert.ok(value.message.length<=512);assert.doesNotMatch(value.message,/Bearer|Authorization|secret-canary/u);assert.match(providerFailureDetailText(value),/Denied/u);
  assert.equal(sanitizeProviderFailureDetail(500,"<html>PRIVATE_BODY</html>").message,undefined);
  assert.equal(classifyPiProviderConnectionFailure(403,'403 invalid request'),"request");
  assert.equal(desktopProviderFailureCode(new Error("TLS proxy maybe")),null);
});
await test("reader cancellation after headers aborts native request",async()=>{
  let req;const fetch=createDesktopProviderFetch(options=>(req=new NativeRequest(options)),{timeoutMs:1000});
  const pending=fetch("http://127.0.0.1:12345/stream",{method:"POST",body:"{}"});const response=req.respond();const result=await pending;await result.body.cancel();assert.equal(req.aborts,1);response.emit("end");
});
assert.equal(browserFetchCalls,0,"No protocol may use the global browser fetch");
console.log(`PASS ${passed} desktop Provider transport checks; browser fetch calls: ${browserFetchCalls}`);
