import assert from "node:assert/strict";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import esbuild from "esbuild";
import { mobileBuildOptions } from "./mobile-build.mjs";
const build = await esbuild.build({ ...mobileBuildOptions("tests/mobile-usage/entry.ts"), metafile: true });
assert.ok(!Object.keys(build.metafile.inputs).some(p => /node:fs|usage-store\.ts$/u.test(p) && !p.includes("mobile/")));
const module = {exports:{}};
const notices=[];
vm.runInNewContext(build.outputFiles[0].text, {module,exports:module.exports,crypto:webcrypto,structuredClone,TextEncoder,TextDecoder,Uint8Array,AbortController,URL,URLSearchParams,atob,btoa,setTimeout,clearTimeout,console,require:id=>{assert.equal(id,"obsidian");return new Proxy({Notice:class{constructor(message){notices.push(message);}},TFile:class{},TFolder:class{}},{get:(target,name)=>name in target?target[name]:class{}});}});
const {MobileUsageStore,USAGE_TOKEN_STANDARD,MobileStore,MobileRuntime,loadMobileSettings,mobileProvider,mobileModel,mobileGenerateText,prepareMobileTaskContext,MobileMemoryService,AccountService,MobileServices,MobileModelConfiguration,mobileStream,piModel,countTextTokens,estimateUsageInputTokens,estimateUsageOutputTokens}=module.exports;
const files=new Map(),dirs=new Set();let fail=false;
const adapter={exists:async p=>files.has(p)||dirs.has(p),read:async p=>{assert.ok(files.has(p));return files.get(p);},write:async(p,v)=>{files.set(p,v);},remove:async p=>{files.delete(p);},mkdir:async p=>{dirs.add(p);},rename:async(a,b)=>{if(fail&&a.endsWith('.tmp')){fail=false;throw Error('fixture disk failure');}assert.ok(files.has(a)&&!files.has(b));files.set(b,files.get(a));files.delete(a);},
list:async p=>({files:[...files.keys()].filter(k=>k.startsWith(`${p}/`)&&!k.slice(p.length+1).includes('/')),folders:[...dirs].filter(k=>k.startsWith(`${p}/`)&&!k.slice(p.length+1).includes('/'))}),
rmdir:async p=>{for(const k of [...files.keys()])if(k===p||k.startsWith(`${p}/`))files.delete(k);for(const k of [...dirs])if(k===p||k.startsWith(`${p}/`))dirs.delete(k);}};
let now=new Date(2026,9,19,12).getTime();const usage=new MobileUsageStore(adapter,'plugin/mobile','usage-instance',()=>now);
assert.equal(usage.readStatistics().totalTokens,null);await usage.initialize();assert.equal(usage.readStatistics().totalTokens,0);
const request={requestId:'r1',recordedAt:now-86400000,provider:'fixture',model:'model',source:'conversation',inputTokens:17,outputTokens:9,status:'completed',standard:USAGE_TOKEN_STANDARD,secretPrompt:'must-not-persist'};
await Promise.all([usage.recordUsage(request),usage.recordUsage(request)]);await usage.recordCompletedTurn('turn1',now-86400000);await usage.recordCompletedTurn('turn1',now-86400000);await usage.recordCompletedTurn('turn2',now);
assert.equal(usage.readStatistics().totalTokens,26);assert.equal(usage.readStatistics().totalTurns,2);assert.equal(usage.readStatistics().currentStreak,2);assert.equal(usage.readStatistics().bestStreak,2);assert.ok(!files.get(usage.path).includes('must-not-persist'));
const before=files.get(usage.path);fail=true;await assert.rejects(usage.recordUsage({...request,requestId:'failed-save'}));assert.equal(files.get(usage.path),before);assert.equal(usage.readStatistics().totalTokens,26);
const cold=new MobileUsageStore(adapter,'plugin/mobile','usage-instance',()=>now);await cold.initialize();assert.equal(cold.readStatistics().totalTokens,26);assert.equal(cold.readStatistics(now+2*86400000).currentStreak,0);
const other=new MobileUsageStore(adapter,'plugin/mobile','other-instance',()=>now);await other.initialize();assert.equal(other.readStatistics().totalTurns,0);assert.equal(files.get(usage.path),before);
files.set('plugin/mobile/devices/bad-instance/usage.json','{bad');await assert.rejects(new MobileUsageStore(adapter,'plugin/mobile','bad-instance').initialize());assert.equal(files.get('plugin/mobile/devices/bad-instance/usage.json'),'{bad');
await cold.recordUsage({...request,requestId:'new-cold'});await assert.rejects(usage.recordUsage({...request,requestId:'stale'}));assert.equal(cold.readStatistics().totalTokens,52);
console.log('PASS mobile usage numeric schema, dedup, streak, cold read, partition, invalid data, stale writer and save rollback');
// Exercise the production runtime; no UI may fabricate usage counters.
const store=new MobileStore(adapter,'runtime/mobile','runtime-instance');await store.load();
const settings=loadMobileSettings({});const provider=mobileProvider('custom');provider.apiKey='fixture';provider.baseUrl='https://provider.invalid/v1';provider.models=[mobileModel('fixture-model')];provider.defaultModelId='fixture-model';settings.apiProviders=[provider];settings.activeApiProviderId=provider.id;settings.defaultModel='fixture-model';
const tracked=new MobileUsageStore(adapter,'runtime/mobile','runtime-instance');await tracked.initialize();let calls=0;
const app={vault:{adapter,getMarkdownFiles:()=>[],getAbstractFileByPath:()=>null},workspace:{getActiveFile:()=>null}};
const runtime=new MobileRuntime(app,store,()=>settings,async()=>{calls++;return {status:200,json:{choices:[{message:{role:'assistant',content:'fixture completed'},finish_reason:'stop'}]}};});
runtime.setUsage(tracked);await runtime.initialize();await runtime.send('test numeric usage');assert.equal(calls,1);assert.equal(tracked.readStatistics().totalTurns,1);assert.ok(tracked.readStatistics().totalTokens>0);
const tokens=tracked.readStatistics().totalTokens,taskId=store.session.id;await store.archiveAndCreateSession(taskId);await store.restoreSession(taskId);assert.equal(tracked.readStatistics().totalTokens,tokens);assert.equal(tracked.readStatistics().totalTurns,1);
console.log('PASS real mobile runtime request and completed turn accounting, archive does not recount');
await runtime.shutdown();
const restartedStore=new MobileStore(adapter,'runtime/mobile','runtime-instance');await restartedStore.load();const restartedUsage=new MobileUsageStore(adapter,'runtime/mobile','runtime-instance');await restartedUsage.initialize();const restartedRuntime=new MobileRuntime(app,restartedStore,()=>settings,async()=>{throw Error('cold load must not infer');});restartedRuntime.setUsage(restartedUsage);await restartedRuntime.initialize();assert.equal(restartedUsage.readStatistics().totalTurns,1);assert.equal(restartedUsage.readStatistics().totalTokens,tokens);await restartedRuntime.shutdown();
console.log('PASS cold runtime load and archive/restore never recount prior turns');

let fixtureSequence=0;
async function runtimeFixture(request){
  const directory=`runtime-${++fixtureSequence}/mobile`,store=new MobileStore(adapter,directory,'runtime-instance');await store.load();const usage=new MobileUsageStore(adapter,directory,'runtime-instance');await usage.initialize();
  const runtime=new MobileRuntime(app,store,()=>settings,request);runtime.setUsage(usage);await runtime.initialize();return {store,usage,runtime};
}
const completed=text=>({status:200,json:{usage:{prompt_tokens:999999999,completion_tokens:999999999},choices:[{message:{role:'assistant',content:text},finish_reason:'stop'}]}});
{
  let requests=0;const f=await runtimeFixture(async()=>++requests===1?{status:200,json:{choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'lookup',type:'function',function:{name:'memory_search',arguments:'{"query":"usage"}'}}]},finish_reason:'tool_calls'}]}}:completed('two requests completed'));
  await f.runtime.send('run two actual provider requests');const evidence=JSON.parse(files.get(f.usage.path));assert.equal(evidence.requests.length,2);assert.equal(evidence.completedTurns.length,1);assert.ok(evidence.requests.every(item=>item.source==='conversation'&&item.status==='completed'));assert.ok(f.usage.readStatistics().totalTokens<1000000);await f.runtime.shutdown();
}
{
  const f=await runtimeFixture(async()=>({status:500,json:{error:{message:'fixture provider failure'}}}));await assert.rejects(f.runtime.send('a failed request'));assert.equal(f.usage.readStatistics().totalTurns,0);assert.equal(f.store.session.taskStatus,'interrupted');await f.runtime.shutdown();
}
{
  let dispatched;const start=new Promise(resolve=>{dispatched=resolve;});let finish;const response=new Promise(resolve=>{finish=resolve;});const f=await runtimeFixture(async()=>{dispatched();return response;});
  const pending=f.runtime.send('a cancelled request');await start;await f.runtime.stopTask(f.store.session.id);await pending;finish(completed('late result must not count'));await new Promise(resolve=>setTimeout(resolve,0));assert.equal(f.usage.readStatistics().totalTurns,0);assert.equal(f.usage.readStatistics().totalTokens,0);await f.runtime.shutdown();
}
console.log('PASS actual multi-request/tool round counts once; Provider failure and cancellation do not complete a turn');
async function observedResponse(protocol,response,context){
  const selected={...provider,apiProtocol:protocol},events=[];let body;
  const result=await mobileStream(selected,async request=>{body=JSON.parse(request.body);return response;},{recordUsage:event=>{events.push(event);}})(piModel(selected,selected.models[0]),context,{}).result();
  return {result,events,body};
}
{
  const reasoning='visible chain reasoning before a tool',context={systemPrompt:'test reasoning accounting',messages:[{role:'user',content:'look up evidence',timestamp:1}]};
  const first=await observedResponse('openai-completions',{status:200,json:{choices:[{message:{role:'assistant',content:null,reasoning_content:reasoning,tool_calls:[{id:'lookup-reasoning',type:'function',function:{name:'memory_search',arguments:'{"query":"evidence"}'}}]},finish_reason:'tool_calls'}]}},context);
  assert.equal(first.result.mobileReasoning,reasoning);assert.equal(first.result.content.some(block=>block.type==='thinking'),false);assert.equal(first.events[0].outputTokens,estimateUsageOutputTokens(first.result)+countTextTokens(reasoning));
  const continued={...context,messages:[...context.messages,first.result,{role:'toolResult',toolCallId:'lookup-reasoning',toolName:'memory_search',content:[{type:'text',text:'actual tool evidence'}],isError:false,timestamp:2}]};
  const second=await observedResponse('openai-completions',{status:200,json:{choices:[{message:{role:'assistant',content:'final answer',reasoning_content:'visible final reasoning'},finish_reason:'stop'}]}},continued);
  assert.equal(second.body.messages.find(item=>item.role==='assistant').reasoning_content,reasoning);assert.equal(second.events[0].inputTokens,estimateUsageInputTokens(continued)+countTextTokens(reasoning));assert.equal(second.events[0].outputTokens,countTextTokens('final answer')+countTextTokens('visible final reasoning'));
  const skipped={...context,messages:[...context.messages,{...first.result,stopReason:'error'}]};const skip=await observedResponse('openai-completions',completed('new answer'),skipped);assert.equal(skip.events[0].inputTokens,estimateUsageInputTokens(skipped));assert.equal(skip.body.messages.some(item=>item.reasoning_content),false);
  const f=await runtimeFixture(async()=>completed('unused'));for(const event of [...first.events,...second.events])await f.usage.recordUsage(event);assert.equal(f.usage.readStatistics().totalTurns,0);assert.ok(!files.get(f.usage.path).includes(reasoning));await f.runtime.shutdown();
}
console.log('PASS Chat reasoning output and actual tool-continuation input are counted without changing Agent content or reasoning replay');
{
  const summary='visible Responses reasoning summary',detail='visible Responses reasoning detail',encrypted='opaque encrypted payload',context={systemPrompt:'Responses reasoning accounting',messages:[{role:'user',content:'use a tool',timestamp:1}]};
  const response=opaque=>({status:200,json:{output:[{type:'reasoning',id:`reasoning-${opaque}`,encrypted_content:opaque,signature:opaque,summary:[{type:'summary_text',text:summary,signature:opaque}],content:[{type:'reasoning_text',text:detail}]},{type:'function_call',call_id:'responses-tool',name:'memory_search',arguments:'{"query":"summary"}'}],status:'completed'}});
  const first=await observedResponse('openai-responses',response(encrypted),context),large=await observedResponse('openai-responses',response(encrypted.repeat(500)),context);
  assert.equal(first.events[0].outputTokens,estimateUsageOutputTokens(first.result)+countTextTokens(summary)+countTextTokens(detail));assert.equal(large.events[0].outputTokens,first.events[0].outputTokens);assert.equal(first.result.content.some(block=>block.type==='thinking'),false);assert.equal(first.result.mobileResponseItems[0].encrypted_content,encrypted);
  const tool={role:'toolResult',toolCallId:'responses-tool',toolName:'memory_search',content:[{type:'text',text:'actual Responses tool result'}],isError:false,timestamp:2};
  const continued={...context,messages:[...context.messages,first.result,tool]},continuedLarge={...context,messages:[...context.messages,large.result,tool]};
  const answer={status:200,json:{output:[{type:'message',content:[{type:'output_text',text:'Responses answer'}]}],status:'completed'}};
  const second=await observedResponse('openai-responses',answer,continued),secondLarge=await observedResponse('openai-responses',answer,continuedLarge);
  assert.equal(second.events[0].inputTokens,estimateUsageInputTokens(continued)+countTextTokens(summary)+countTextTokens(detail));assert.equal(secondLarge.events[0].inputTokens,second.events[0].inputTokens);assert.equal(second.body.input.find(item=>item.type==='reasoning').encrypted_content,encrypted);assert.ok(!JSON.stringify([...first.events,...large.events,...second.events]).includes(encrypted));
}
console.log('PASS Responses visible reasoning summary/detail counts while encrypted content, signatures and IDs never affect estimates or wire replay');
{
  const text='valid text before malformed tool arguments',reasoning='valid reasoning before parse failure',context={systemPrompt:'failure accounting',messages:[{role:'user',content:'test valid returned output',timestamp:1}]};
  const chat=await observedResponse('openai-completions',{status:200,json:{choices:[{message:{role:'assistant',content:text,reasoning_content:reasoning,tool_calls:[{id:'bad-json',type:'function',function:{name:'memory_search',arguments:'{'}}]},finish_reason:'tool_calls'}]}},context);
  assert.equal(chat.result.stopReason,'error');assert.equal(chat.result.content.length,0);assert.equal(chat.events[0].status,'failed');assert.equal(chat.events[0].outputTokens,countTextTokens(text)+countTextTokens(reasoning)+countTextTokens('memory_search')+countTextTokens('{'));
  const responses=await observedResponse('openai-responses',{status:200,json:{output:[{type:'function_call',call_id:'bad-response-json',name:'memory_search',arguments:'{'},{type:'reasoning',encrypted_content:'exclude-failed-ciphertext',summary:[{type:'summary_text',text:reasoning}]},{type:'message',content:[{type:'output_text',text}]}],status:'completed'}},context);
  assert.equal(responses.result.stopReason,'error');assert.equal(responses.result.content.length,0);assert.equal(responses.events[0].status,'failed');assert.equal(responses.events[0].outputTokens,chat.events[0].outputTokens);assert.ok(!JSON.stringify([...chat.events,...responses.events]).includes('exclude-failed-ciphertext'));
  const partial=await observedResponse('openai-responses',{status:200,json:{status:'failed',error:{message:'excluded error metadata '.repeat(50)},output:[{type:'reasoning',summary:[{type:'summary_text',text:reasoning}]},{type:'message',content:[{type:'output_text',text}]}]}},context);
  assert.equal(partial.result.stopReason,'error');assert.equal(partial.result.content.length,0);assert.equal(partial.events[0].status,'failed');assert.equal(partial.events[0].outputTokens,countTextTokens(text)+countTextTokens(reasoning));
}
console.log('PASS malformed tool output keeps numeric snapshots of valid returned text/reasoning while Agent failure messages remain unchanged');
{
  const f=await runtimeFixture(async()=>completed('task must remain completed'));const original=files.get(f.usage.path),rename=adapter.rename,noticeCount=notices.length;
  adapter.rename=async(from,to)=>{if(from.startsWith(`${f.usage.path}.`)&&from.endsWith('.tmp'))throw Error('stats-only write failure');await rename(from,to);};
  try{await f.runtime.send('statistics disk failure cannot fail this task');}finally{adapter.rename=rename;}
  assert.equal(f.store.session.taskStatus,'completed');assert.equal(f.store.session.messages.at(-1).content[0].text,'task must remain completed');assert.equal(files.get(f.usage.path),original);assert.equal(f.usage.readStatistics().totalTurns,0);assert.equal(notices.length,noticeCount+1);await f.runtime.shutdown();
}
{
  const f=await runtimeFixture(async()=>completed('Provider finished but task completion could not save')),update=f.store.updateSession.bind(f.store);let blocked=false;
  f.store.updateSession=(id,change)=>update(id,task=>{change(task);if(!blocked&&task.taskStatus==='completed'){blocked=true;throw Error('final task receipt write failed');}});
  await assert.rejects(f.runtime.send('no completed turn before durable task completion'));assert.equal(f.usage.readStatistics().totalTurns,0);assert.ok(f.usage.readStatistics().totalTokens>0);await f.runtime.shutdown().catch(()=>{});
}
console.log('PASS statistics persistence failures preserve task results; failed task completion is never counted');
{
  const f=await runtimeFixture(async()=>completed('unused')),observer={recordUsage:event=>f.usage.recordUsage(event)};
  await mobileGenerateText(provider,provider.models[0],async()=>completed('background result'),'synthetic system','synthetic background request',64,new AbortController().signal,observer);
  assert.equal(JSON.parse(files.get(f.usage.path)).requests[0].source,'background');assert.equal(f.usage.readStatistics().totalTurns,0);
  const messages=[{role:'user',content:'old history '.repeat(450),timestamp:1},{role:'assistant',content:[{type:'text',text:'old response '.repeat(300)}],api:'openai-completions',provider:'fixture',model:'fixture',stopReason:'stop',timestamp:2,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}},{role:'user',content:'recent question',timestamp:3}];
  await f.store.updateSession(f.store.session.id,task=>{task.messages=messages;});
  await prepareMobileTaskContext({store:f.store,taskId:f.store.session.id,messages,text:'new question',systemPrompt:'Summarize faithfully',tools:[],provider,model:{...provider.models[0],contextWindow:768,maxOutputTokens:96},request:async()=>completed('brief faithful summary'),signal:new AbortController().signal,assertAllowed(){},usage:observer});
  const evidence=JSON.parse(files.get(f.usage.path));assert.ok(evidence.requests.length>1);assert.ok(evidence.requests.every(item=>item.source==='background'));assert.equal(evidence.completedTurns.length,0);await f.runtime.shutdown();
}
{
  const f=await runtimeFixture(async()=>completed('unused'));const memory=new MobileMemoryService({adapter,store:f.store,settings:()=>settings,saveSettings:async()=>{},request:async()=>completed(JSON.stringify({userProfileItems:[{section:'preference',profileKey:'preference.tone',text:'直接'}]})),changed(){},isBusy:()=>false});
  await f.store.update(state=>{state.memories=[{schema:'echoink.memory.v1',id:'mem_usage_dream',kind:'fact',status:'current',date:'2026-10-19',source:'mobile:usage-fixture',basis:'explicit',title:'偏好',recallWhen:'表达',content:'喜欢直接表达',revision:1,file:'legacy.json'}];});
  memory.setUsage({recordUsage:event=>f.usage.recordUsage(event)});await memory.runDream();const evidence=JSON.parse(files.get(f.usage.path));assert.ok(evidence.requests.length>0);assert.ok(evidence.requests.every(item=>item.source==='background'));assert.equal(evidence.completedTurns.length,0);await f.runtime.shutdown();
}
console.log('PASS independent inference, real history-summary chain and Dream record background usage without completed conversations');
{
  const f=await runtimeFixture(async()=>completed('unused'));let rejectRequest=false;
  const services=new MobileServices({app,settings,store:f.store,runtime:f.runtime,navigation:{},saveSettings:async()=>{},registerEvent(){},showPage:async()=>{},capabilityRequest:async()=>rejectRequest?{status:503,json:{error:{message:'controlled failure'}}}:completed('controlled financial result')},'lifestyle-usage/mobile');
  services.setUsage({recordUsage:event=>f.usage.recordUsage(event)});
  await services.generateLifestyleText('synthetic finance system','synthetic finance analysis',64,new AbortController().signal);
  const before=f.usage.readStatistics().totalTokens;assert.ok(before>0);let evidence=JSON.parse(files.get(f.usage.path));assert.equal(evidence.requests.length,1);assert.equal(evidence.requests[0].source,'background');assert.equal(evidence.requests[0].status,'completed');assert.equal(evidence.completedTurns.length,0);
  rejectRequest=true;await assert.rejects(services.generateLifestyleText('synthetic finance system','failed finance request',64,new AbortController().signal));assert.equal(f.usage.readStatistics().totalTokens,before);assert.equal(f.usage.readStatistics().totalTurns,0);assert.equal(JSON.parse(files.get(f.usage.path)).requests.length,1);await f.runtime.shutdown();
}
{
  const f=await runtimeFixture(async()=>completed('unused'));const configSettings=loadMobileSettings({apiProviders:[structuredClone(provider)],activeApiProviderId:provider.id,defaultModel:provider.models[0].id});let rejectRequest=false,saves=0;
  const config=new MobileModelConfiguration(()=>configSettings,async()=>{saves++;},async()=>rejectRequest?{status:503,json:{error:{message:'controlled connection failure'}}}:completed('OK'),{recordUsage:event=>f.usage.recordUsage(event)});
  await config.save(config.createDraft(provider.id));const before=f.usage.readStatistics().totalTokens;assert.ok(before>0);let evidence=JSON.parse(files.get(f.usage.path));assert.equal(evidence.requests.length,1);assert.equal(evidence.requests[0].source,'connection-test');assert.equal(evidence.requests[0].status,'completed');assert.equal(evidence.completedTurns.length,0);assert.equal(saves,1);
  rejectRequest=true;await assert.rejects(config.save(config.createDraft(provider.id)));assert.equal(f.usage.readStatistics().totalTokens,before);assert.equal(f.usage.readStatistics().totalTurns,0);assert.equal(JSON.parse(files.get(f.usage.path)).requests.length,1);assert.equal(saves,1);await f.runtime.shutdown();
}
console.log('PASS real lifestyle and model-save requests share numeric usage; failed calls add no false evidence and neither adds completed turns');
{
  let state={};const account=new AccountService({persistent:true,read:async()=>state,write:async next=>{state=next;},identity:async()=>{throw Error('free account needs no device');}},async route=>{
    if(route==='/api/products')return {products:[]};if(route==='/api/auth/login')return {token:'synthetic-session'};if(route==='/api/account')return {id:'synthetic-user',email:'fixture@example.invalid',name:'Fixture',joinedAt:'2026-10-19',avatar:null,passwordSet:false};if(route==='/api/membership')return {state:'free',serverTime:now};if(route==='/api/auth/logout')return {};throw Error(`unexpected controlled route ${route}`);
  },'https://membership.invalid',()=>{},'https://membership.invalid',()=> 'configured');
  account.setStatisticsSource({read:()=>tracked.readStatistics(),subscribe:listener=>tracked.subscribe(listener)});await account.initialize();assert.equal(account.read().statistics.totalTurns,1);const prior=files.get(tracked.path);
  await account.actions.signIn({email:'fixture@example.invalid',method:'password',credential:'synthetic-password'});assert.equal(account.read().identity.id,'synthetic-user');assert.equal(account.read().statistics.totalTurns,1);
  await account.actions.signOut();assert.equal(account.read().identity,null);assert.equal(account.read().statistics.totalTurns,1);assert.equal(files.get(tracked.path),prior);account.dispose();
}
console.log('PASS real AccountService reads local statistics when anonymous, signed in and signed out without clearing usage');
if(process.env.ECHOINK_USAGE_TEST_ROOT){
  const registered=await fs.realpath(path.join(homedir(),'EchoInk-TestVaults/90-任务临时/移动端改版-M10-20261019')),root=await fs.realpath(process.env.ECHOINK_USAGE_TEST_ROOT);
  assert.ok(root.startsWith(`${registered}${path.sep}`),'Mobile usage fixtures must stay inside the registered M10 disposable root');
  const directory=await fs.mkdtemp(path.join(root,'mobile-usage-'));
  const resolve=relative=>{const absolute=path.resolve(directory,relative);assert.ok(absolute.startsWith(`${directory}${path.sep}`));return absolute;};
  const disk={exists:async relative=>{try{await fs.access(resolve(relative));return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}},read:relative=>fs.readFile(resolve(relative),'utf8'),write:(relative,bytes)=>fs.writeFile(resolve(relative),bytes),mkdir:relative=>fs.mkdir(resolve(relative),{recursive:true}),remove:relative=>fs.unlink(resolve(relative)),rename:async(from,to)=>{if(await disk.exists(to))throw Error('non-overwriting disk adapter');await fs.rename(resolve(from),resolve(to));}};
  try{
    const saved=new MobileUsageStore(disk,'vault-a/plugin/mobile','physical-instance',()=>now);await saved.initialize();await saved.recordUsage(request);await saved.recordCompletedTurn('physical-turn',now);const bytes=await disk.read(saved.path);
    const cold=new MobileUsageStore(disk,'vault-a/plugin/mobile','physical-instance',()=>now);await cold.initialize();assert.equal(cold.readStatistics().totalTokens,26);assert.equal(cold.readStatistics().totalTurns,1);await cold.recordCompletedTurn('physical-turn',now);assert.equal(await disk.read(saved.path),bytes);
    const otherVault=new MobileUsageStore(disk,'vault-b/plugin/mobile','physical-instance',()=>now);await otherVault.initialize();assert.equal(otherVault.readStatistics().totalTokens,0);
    const rename=disk.rename;let crashed=false;disk.rename=async(from,to)=>{if(crashed)throw Error('process no longer writing');if(from.endsWith('.tmp')&&to===saved.path){crashed=true;throw Error('interrupted usage replacement');}await rename(from,to);};
    await assert.rejects(cold.recordUsage({...request,requestId:'interrupted-physical'}));assert.equal(await disk.exists(saved.path),false);assert.equal(await disk.read(`${saved.path}.replace-backup`),bytes);disk.rename=rename;
    const recovered=new MobileUsageStore(disk,'vault-a/plugin/mobile','physical-instance',()=>now);await recovered.initialize();assert.equal(await disk.read(saved.path),bytes);assert.equal(recovered.readStatistics().totalTurns,1);
    await disk.write(saved.path,'corrupt evidence must remain');const broken=new MobileUsageStore(disk,'vault-a/plugin/mobile','physical-instance',()=>now);await assert.rejects(broken.initialize());assert.equal(broken.readStatistics().totalTokens,null);assert.equal(await disk.read(saved.path),'corrupt evidence must remain');
  }finally{await fs.rm(directory,{recursive:true});}
  console.log('PASS physical DataAdapter cold read, Vault partition, interrupted replacement recovery and corrupt evidence preservation; fixture cleaned');
}
