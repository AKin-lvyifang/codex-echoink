import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import vm from 'node:vm';import {webcrypto} from 'node:crypto';import esbuild from 'esbuild';import {mobileBuildOptions} from './mobile-build.mjs';import {createHost} from '../tests/mobile/host.mjs';
if(process.env.ECHOINK_MOBILE_MEMORY_REAL!=='1')throw new Error('Real-model smoke requires explicit ECHOINK_MOBILE_MEMORY_REAL=1');
const vault=path.join(os.homedir(),'EchoInk-TestVaults/测试仓库-手机端记忆补齐验收'),out=path.resolve('docs/internal/test-evidence/2026-11-15-手机端记忆补齐');await fs.mkdir(out,{recursive:true});
const ledgerPath=path.join(out,'real-usage.json');let ledger;try{ledger=JSON.parse(await fs.readFile(ledgerPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;ledger={limit:20,stopAt:18,requests:[],scenarios:[]};}
const save=()=>fs.writeFile(ledgerPath,JSON.stringify(ledger,null,2)+'\n');
const pluginRoot=path.join(vault,'.obsidian/plugins');let raw;
for(const name of await fs.readdir(pluginRoot)){try{const dir=path.join(pluginRoot,name),manifest=JSON.parse(await fs.readFile(path.join(dir,'manifest.json'),'utf8'));if(manifest.id==='codex-echoink')raw=JSON.parse(await fs.readFile(path.join(dir,'data.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}}
if(!raw)throw new Error('Disposable plugin settings missing');
const built=await esbuild.build(mobileBuildOptions('tests/mobile-memory-settings/entry.ts')),mod={exports:{}};
const browser=vm.createContext({module:mod,exports:mod.exports,crypto:webcrypto,TextEncoder,TextDecoder,Uint8Array,URL,URLSearchParams,structuredClone,AbortController,setTimeout,clearTimeout,console,require:name=>{if(name!=='obsidian')throw new Error('Unexpected browser dependency');return {TFile:class{},TFolder:class{},Platform:{isMobile:true},Notice:class{hide(){}}};}});browser.window=browser;browser.self=browser;vm.runInContext(built.outputFiles[0].text,browser);
const {MobileStore,MobileMemoryService,MobileRuntime,loadMobileSettings,serializeCanonicalMemoryRecord,sha256Hex}=mod.exports;
const settings=loadMobileSettings(raw);for(const p of settings.apiProviders)for(const m of p.models??[])m.maxOutputTokens=Math.min(m.maxOutputTokens,4096);
settings.mobileMemory.dreamRunsPerDay=6;
const request=async input=>{
 if(ledger.requests.length>=ledger.stopAt)throw new Error('Real-model counter stopped before hard limit');
 const id=ledger.requests.length+1,record={id,status:'started',inputTokens:null,outputTokens:null,tokenSource:'unknown'};ledger.requests.push(record);await save();
 try{const response=await fetch(input.url,{method:input.method??'POST',headers:{'Content-Type':input.contentType??'application/json',...input.headers},body:input.body,signal:AbortSignal.timeout(120000)}),json=await response.json();record.status=response.ok?'completed':'failed';record.httpStatus=response.status;
  const usage=json.usage;if(usage){record.inputTokens=usage.prompt_tokens??usage.input_tokens??null;record.outputTokens=usage.completion_tokens??usage.output_tokens??null;record.tokenSource='server';}
  await save();return {status:response.status,json};
 }catch(error){record.status='failed';record.reason=error.name==='TimeoutError'?'timeout':'network_or_parse';await save();throw new Error(record.reason);}
};
const base=path.join(vault,'mobile-memory-smoke');await fs.mkdir(base,{recursive:true});
const resolve=file=>{const target=path.resolve(base,file);if(target!==base&&!target.startsWith(base+path.sep))throw new Error('Path outside disposable root');return target;};
const adapter={exists:async file=>{try{await fs.access(resolve(file));return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}},read:file=>fs.readFile(resolve(file),'utf8'),write:async(file,text)=>{await fs.mkdir(path.dirname(resolve(file)),{recursive:true});await fs.writeFile(resolve(file),text);},mkdir:file=>fs.mkdir(resolve(file),{recursive:true}),remove:file=>fs.rm(resolve(file)),rename:(a,b)=>fs.rename(resolve(a),resolve(b)),rmdir:(file)=>fs.rm(resolve(file),{recursive:true,force:true}),list:async file=>{const entries=await fs.readdir(resolve(file),{withFileTypes:true});return {files:entries.filter(e=>e.isFile()).map(e=>`${file}/${e.name}`),folders:entries.filter(e=>e.isDirectory()).map(e=>`${file}/${e.name}`)};}};
const host=createHost({});host.app.vault.adapter=adapter;const store=new MobileStore(adapter,'plugin/mobile','smoke-device');await store.load();
const memory=new MobileMemoryService({adapter,store,storageRoot:'product',settings:()=>settings,saveSettings:async()=>{},request,changed(){},isBusy:()=>false});await memory.initialize();store.bindCanonicalMemory(()=>memory.recordsForRuntime());
const provider=settings.apiProviders.find(p=>p.id===settings.activeApiProviderId),model=provider?.models.find(m=>m.id===settings.defaultModel);if(!provider||!model)throw new Error('Configured disposable model missing');
const now=Date.now(),taskId=store.session.id,runId='smoke-source',user={role:'user',content:[{type:'text',text:'产品发布价格定为29.9元。知识库基础功能保持免费。'}],timestamp:now};
await store.updateSession(taskId,task=>{task.messages=[user];task.runs=[{id:runId,startedAt:now,userMessageIndex:0,userMessageDigest:sha256Hex(JSON.stringify(user))}];});
if(!(await memory.list()).records.length){const record=await memory.commitToolMemory(await memory.prepareToolMemory({kind:'decision',title:'产品发布价格',content:'产品发布价格定为19.9元。',recallWhen:'问到发布价格时',basis:'explicit'},taskId,runId,'seed'),()=>{});
 await memory.repository.mutate((await memory.list()).revision,'smoke-free',(draft,files)=>{const extra=memory.repository.newRecord({kind:'decision',title:'知识库免费范围',content:'知识库基础功能保持免费。',recallWhen:'问到知识库收费范围时',basis:'explicit',contentOrigin:'user_statement',source:record.source,revision:draft.manifest.revision+1});draft.records.push(extra);files.set(extra.file,serializeCanonicalMemoryRecord(extra));});}
const beforeRecall=ledger.requests.length;const prepared=await memory.prepareTurnMemory({taskId,runId:'smoke-recall',text:'产品发布价格和知识库的收费范围分别是什么？',history:[],availableInputTokens:16000,provider,model,signal:new AbortController().signal});
ledger.scenarios.push({name:'mobile-directory-recall',passed:prepared.selectionReceipt?.route==='directory'&&prepared.recall.candidates.length>=1,calls:ledger.requests.length-beforeRecall,injected:prepared.selectionReceipt.injectedIds.length});await save();
const beforeDream=ledger.requests.length;const dream=await memory.runDream();const corrections=await memory.corrections();
ledger.scenarios.push({name:'mobile-Dream-original-correction',passed:dream.phase==='completed'&&corrections.some(event=>event.action==='correct'&&event.after?.content.includes('29.9')),calls:ledger.requests.length-beforeDream,phase:dream.phase,events:corrections.length});await save();
if(dream.phase!=='completed')throw new Error('Dream smoke failed; inspect private sanitized run state');
const beforeRepeat=ledger.requests.length;const repeat=await memory.runDream();ledger.scenarios.push({name:'repeat-zero-calls',passed:repeat.phase==='completed'&&ledger.requests.length===beforeRepeat,calls:ledger.requests.length-beforeRepeat});await save();
const runtime=new MobileRuntime(host.app,store,()=>settings,request);runtime.setMemory(()=>memory);await runtime.initialize();
const beforeChat=ledger.requests.length;await runtime.send('知识库基础功能是否免费？请只用一句话回答。');
const run=store.session.runs.at(-1);ledger.scenarios.push({name:'formal-mobile-runtime',passed:run.status==='completed'&&!!run.memoryRecallReceipt&&!!run.memorySources?.length,calls:ledger.requests.length-beforeChat,sources:run.memorySources?.length??0,receipt:!!run.memoryRecallReceipt});await runtime.dispose();await save();
ledger.totalCalls=ledger.requests.length;ledger.tokens={input:ledger.requests.reduce((n,r)=>n+(r.inputTokens??0),0),output:ledger.requests.reduce((n,r)=>n+(r.outputTokens??0),0),unknownRequests:ledger.requests.filter(r=>r.inputTokens===null||r.outputTokens===null).length};await save();
if(ledger.scenarios.some(s=>!s.passed))throw new Error('One or more smoke scenarios failed');
console.log(JSON.stringify({calls:ledger.totalCalls,tokens:ledger.tokens,scenarios:ledger.scenarios}));
