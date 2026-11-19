import assert from 'node:assert/strict';
import vm from 'node:vm';
import {Worker as Thread} from 'node:worker_threads';
import {webcrypto} from 'node:crypto';
import {build} from 'esbuild';
import {mobileBuildOptions} from '../../scripts/mobile-build.mjs';

export async function mobileTokenWorkerScenarios() {
 const built=await build({...mobileBuildOptions('tests/mobile-token-worker/entry.ts'),minify:true});
 const code=built.outputFiles[0].text;
 function host(mode){
  const blobs=new Map(),stats={created:0,terminated:0,counts:0};let sequence=0;
  class MemoryBlob { constructor(parts){this.text=parts.join('');} }
  class MemoryURL extends URL { static createObjectURL(blob){const id='blob:fixture-'+(++sequence);blobs.set(id,blob.text);return id;} static revokeObjectURL(id){blobs.delete(id);} }
  class BrowserWorker {
   constructor(url){
    if(mode==='constructor-failure')throw Error('fixture worker unavailable');
    stats.created++;this.thread=new Thread(`const {parentPort}=require('node:worker_threads');globalThis.self={postMessage:value=>parentPort.postMessage(value)};parentPort.on('message',data=>self.onmessage({data}));\n${blobs.get(url)}`,{eval:true});
    this.thread.on('message',data=>this.onmessage?.({data}));this.thread.on('error',error=>this.onerror?.(error));
   }
   postMessage(value){
    if(value.id)stats.counts++;
    if(mode==='message-failure'&&value.id){queueMicrotask(()=>this.onerror?.(Error('fixture worker failed')));return;}
    if(mode==='delayed'&&value.id)setTimeout(()=>this.thread.postMessage(value),40);else this.thread.postMessage(value);
   }
   terminate(){stats.terminated++;void this.thread.terminate();}
  }
  const module={exports:{}};
  const context={module,exports:module.exports,crypto:webcrypto,structuredClone,TextEncoder,TextDecoder,AbortController,URL:MemoryURL,Blob:MemoryBlob,atob,btoa,setTimeout,clearTimeout,console,
   require:id=>{assert.equal(id,'obsidian');return {};},...(mode==='none'?{}:{Worker:BrowserWorker})};
  context.window=context;vm.runInNewContext(code,context);return {api:module.exports,stats};
 }
 const reference=host('none'),worker=host('worker');let checked=0;
 const values=['hello world','中文与 English 🧑🏽‍💻','<|endoftext|> <|im_start|> literal','中文1234 abc\n'.repeat(700),
  {name:'工具',description:'真实回执',parameters:{type:'object',properties:{值:{type:'number'}}}},
  {role:'user',content:[{type:'text',text:'一张图'},{type:'image',data:'fixture',mimeType:'image/png'}]},
  {role:'assistant',content:[{type:'thinking',thinking:'推理'},{type:'text',text:'答案'},{type:'toolCall',id:'call',name:'sum',arguments:{值:12}}],usage:{ignored:999},signature:'not inference'}];
 try{
  for(const value of values){assert.equal(await worker.api.estimateTokenValueAsync(value),reference.api.estimateTokenValue(value));checked++;}
  assert.ok(worker.stats.created>0&&worker.stats.counts>0,'real worker thread, not cached synchronous equality');
  for(const mode of ['constructor-failure','message-failure']){
   const fixture=host(mode);
   try{for(const value of values.slice(0,4)){assert.equal(await fixture.api.estimateTokenValueAsync(value),reference.api.estimateTokenValue(value));checked++;}}
   finally{fixture.api.disposeUsageTokenWorker();}
  }
  const provider={id:'fixture',name:'fixture',providerId:'custom',runtimeProviderId:'fixture',authMode:'api-key',apiProtocol:'openai-completions',baseUrl:'http://127.0.0.1:19572/v1',apiKey:'fake',models:[]};
  const model={id:'fixture',displayName:'fixture',input:['text'],contextWindow:64000,maxOutputTokens:16,reasoning:false,toolCalling:true};
  const history=[{role:'user',content:[{type:'text',text:'完整最近一轮，保留预算边界。'}],timestamp:1},{role:'assistant',api:'openai-completions',provider:'fixture',model:'fixture',content:[{type:'text',text:'历史回答'}],timestamp:2,stopReason:'stop'}];
  const budgetInput={messages:history,text:'新输入',systemPrompt:'固定系统规则',tools:[]};
  const exact=reference.api.estimateTokenValue(budgetInput.systemPrompt)+reference.api.estimateTokenValue(budgetInput.tools)+reference.api.estimateTokenValue(budgetInput.text)+reference.api.estimateTokenValue(history)+32;
  let requests=0;
  const input={...budgetInput,store:{getSession:()=>({messages:history}),updateSession:()=>{throw Error('No summary may be committed');}},taskId:'fixture',provider,request:async()=>{requests++;throw Error('No inference');},signal:new AbortController().signal,assertAllowed(){}};
  const admitted=await worker.api.prepareMobileTaskContext({...input,model:{...model,contextWindow:exact+model.maxOutputTokens+256}});
  assert.equal(admitted.messages,history);assert.equal(admitted.systemPrompt,budgetInput.systemPrompt);checked++;
  await assert.rejects(worker.api.prepareMobileTaskContext({...input,model:{...model,contextWindow:exact+model.maxOutputTokens+255}}),/无法容纳最近一轮/);checked++;
  assert.equal(requests,0);
  for(const responses of [false,true]){
   const events=[],p={...provider,apiProtocol:responses?'openai-responses':'openai-completions'};
   const context={systemPrompt:'系统',messages:[{role:'user',content:'输入',timestamp:1},{...history[1],mobileReasoning:responses?undefined:'历史推理',mobileResponseItems:responses?[{type:'reasoning',summary:[{type:'summary_text',text:'历史推理'}]}]:undefined}]};
   const parts=['回答','推理','拒绝'];const tool={name:'sum',arguments:{value:1}};
   const data=responses?{output:[{type:'reasoning',summary:[{type:'summary_text',text:parts[1]}]},{type:'message',content:[{type:'output_text',text:parts[0]},{type:'refusal',refusal:parts[2],text:parts[2]}]},{type:'function_call',call_id:'call',name:tool.name,arguments:JSON.stringify(tool.arguments)}]}:
    {choices:[{finish_reason:'stop',message:{content:parts[0],reasoning_content:parts[1],refusal:parts[2],tool_calls:[{id:'call',function:{name:tool.name,arguments:JSON.stringify(tool.arguments)}}]}}]};
   const stream=worker.api.mobileStream(p,async()=>({status:200,json:data}),{recordUsage:event=>events.push(event)})(worker.api.piModel(p,model),context,{signal:new AbortController().signal});
   await stream.result();assert.equal(events.length,1);
   assert.equal(events[0].inputTokens,reference.api.estimateUsageInputTokens(context)+reference.api.countTextTokens('历史推理'));
   assert.equal(events[0].outputTokens,parts.reduce((n,text)=>n+reference.api.countTextTokens(text),0)+reference.api.estimateTokenValue(tool));checked+=2;
  }
  const snapshot={user:'画像。'.repeat(80),manifest:{vaultId:'fixture'},records:[
   {id:'pin',title:'固定偏好',content:'固定内容',status:'current',pinned:true},
   {id:'ordinary',title:'普通记忆',content:'不计入固定开销',status:'current',pinned:false},
   {id:'old',title:'旧记忆',content:'不计入固定开销',status:'superseded',pinned:true}]};
  const fixed=reference.api.estimateTokenValue({user:snapshot.user,core:[{id:'pin',title:'固定偏好',summary:'固定内容'}]});
  function memoryService(api) {
   const service=new api.MobileMemoryService({adapter:{},store:{instanceId:'worker-memory-fixture',memoryEnabled:true},settings:()=>({mobileMemory:{dreamEnabled:false,dreamRunsPerDay:1,autoArchive:false}})});
   service.initialize=async()=>{};service.snapshot=async()=>snapshot;return service;
  }
  const originalPrepare=worker.api.PersonalMemoryRecallHarness.prototype.prepareTurnContext;
  worker.api.PersonalMemoryRecallHarness.prototype.prepareTurnContext=async input=>input;
  try {
   const service=memoryService(worker.api),beforeCounts=worker.stats.counts;
   for(const available of [fixed+255,fixed+256,fixed+300,fixed+2000]){
    const prepared=await service.prepareTurnMemory({taskId:'fixture',runId:'run',text:'问题',history:[],availableInputTokens:available,provider,model,signal:new AbortController().signal});
    assert.equal(prepared.skipDirectory,available<=fixed+256);assert.equal(prepared.tokenBudget,Math.max(1,Math.min(1200,Math.floor(available-fixed-256))));assert.equal(prepared.availableInputTokens,available);checked+=3;
   }
   assert.ok(worker.stats.counts>beforeCounts,'memory fixed budget must enter the actual worker');
  }finally{worker.api.PersonalMemoryRecallHarness.prototype.prepareTurnContext=originalPrepare;}
  const canceled=host('delayed');
  try{
   let preparedCalls=0;canceled.api.PersonalMemoryRecallHarness.prototype.prepareTurnContext=async()=>{preparedCalls++;};
   const service=memoryService(canceled.api),controller=new AbortController();
   const pending=service.prepareTurnMemory({taskId:'fixture',runId:'run',text:'问题',history:[],availableInputTokens:4000,provider,model,signal:controller.signal});
   await new Promise(r=>setTimeout(r,5));controller.abort();await assert.rejects(pending,/已停止/);assert.equal(preparedCalls,0);checked++;
  }finally{await new Promise(r=>setTimeout(r,80));canceled.api.disposeUsageTokenWorker();}
  const delayed=host('delayed');
  try{
   const controller=new AbortController();const pending=delayed.api.prepareMobileTaskContext({...input,model,signal:controller.signal});controller.abort();await assert.rejects(pending,/已停止/);assert.equal(requests,0);checked++;
  }finally{await new Promise(r=>setTimeout(r,80));delayed.api.disposeUsageTokenWorker();}
  console.log(`OK mobile tokenizer: ${checked} exact field/budget/usage/fallback/cancellation comparisons; actual worker threads; real Provider calls 0`);
 }finally{worker.api.disposeUsageTokenWorker();reference.api.disposeUsageTokenWorker();}
}
