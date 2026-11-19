import {createHost} from '../tests/mobile/host.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import esbuild from 'esbuild';
import {createRequire} from 'node:module';
export async function runMobileMemoryParityScenarios(api, fixtures) {
 const {test,fixture,seed,oldMemory,model,answer,dreamAnswer,turn,plain}=fixtures;
 const {PersonalMemoryRecallHarness,mobilePreparedMemory,mergeInjectedMemorySources,MobileMemoryService,MobileStore,sha256Hex,mobileUserEntryId,mobileAssistantEntryId,memoryQuoteSource}=api;
 const now=new Date('2026-10-19T12:00:00Z').getTime();

 const input=async(repo,budget=1200)=>({memoryMode:'normal',query:'价格计划',now,tokenBudget:budget,availableInputTokens:32000,vaultId:await repo.readVaultId(),conversationId:'fixture',piSessionId:'session',productRunId:'run',decisionTurnId:'turn',recentConversation:[]});
 await test('mobile/desktop repositories share frozen semantic, fallback, association, secondary and low-budget snapshots',async()=>{
  const f=await fixture();await seed(f,[{...oldMemory('mem_a'),title:'价格计划',related:['mem_b']},{...oldMemory('mem_b'),title:'发布范围'}, {...oldMemory('mem_pin'),title:'固定偏好',pinned:true}]);await f.service.initialize();
  await f.service.repository.mutate(undefined,'fixture-secondary',(draft,files)=>{const secondary=api.createSecondaryRecord({parentId:'mem_b',title:'价格计划关联',content:'可能与价格计划相关',recallWhen:'价格计划',matchTerms:['价格计划'],relation:'associated',basis:'llm_inferred',confidence:.8,supportLevel:'strong_inference',reason:'关联范围',evidence:'喜欢简洁答复',sourceMemoryRevision:draft.records.find(record=>record.id==='mem_b').revision,now,idFactory:()=> 'sec_parity'});draft.secondary.push(secondary);files.set(secondary.file,api.serializeSecondaryRecord(secondary));});
  const root=path.join(process.env.ECHOINK_TEST_ROOT??process.env.ECHOINK_MEMORY_TEST_ROOT,'parity-desktop');await fs.mkdir(root,{recursive:true});
  for(const [file,content] of f.files)if(file.startsWith('.echoink/')){await fs.mkdir(path.dirname(path.join(root,file)),{recursive:true});await fs.writeFile(path.join(root,file),content);}
  const built=await esbuild.build({stdin:{contents:'export { PersonalMemoryRepository } from "./src/harness/memory/personal-memory-repository"; export { SecondaryMemoryStore } from "./src/harness/memory/secondary-memory-store";',resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,platform:'node',format:'cjs',external:['obsidian'],loader:{'.md':'text'},logLevel:'silent'}),mod={exports:{}},require=createRequire(import.meta.url);
  new Function('require','module','exports',built.outputFiles[0].text)(id=>id==='obsidian'?{Platform:{isDesktop:true}}:require(id),mod,mod.exports);
  const secondaryStore=new mod.exports.SecondaryMemoryStore(path.join(root,'.echoink/shared-user/memory'));
  const desktop=new mod.exports.PersonalMemoryRepository({vaultPath:root,vaultId:await f.service.repository.readVaultId(),now:()=>now,secondaryRecordsProvider:()=>secondaryStore.loadAll()});
  try {await desktop.initialize();for(const mode of ['pro','directory','fallback'])for(const budget of [1200,80]){
   const run=async repo=>{const harness=new PersonalMemoryRecallHarness(repo,{decisions:mode==='directory'?undefined:{judgeMemory:async({memories})=>mode==='fallback'?null:{selected:['mem_a'],probabilities:Object.fromEntries(memories.map(m=>[m.id,.95]))}},directory:{modelInputBudget:32000,llm:{call:async()=>({text:'["mem_a","mem_b"]'})}}});return harness.prepareTurnContext(await input(repo,budget));};
   const left=await run(desktop),right=await run(f.service.repository);
   const projection=value=>plain({candidates:value.recall.candidates,core:value.core.map(({id,title,summary})=>({id,title,summary})),route:value.selectionReceipt.route,ids:value.selectionReceipt.injectedIds,n:mobilePreparedMemory(value).sources.map(source=>source.id)});
   assert.deepEqual(projection(left),projection(right),`${mode} budget=${budget}`);
   if(budget===1200&&mode==='pro')assert.equal(right.recall.candidates.find(m=>m.id==='mem_b').relatedFrom.id,'mem_a');
   if(budget===80)assert.ok(!right.recall.candidates.some(m=>m.relatedFrom),'associated items never displace an unaffordable primary');
  }}finally{await desktop.dispose();await fs.rm(root,{recursive:true,force:true});}
 });
 await test('shared receipt unions actual injection and successful tool reads once, preserving first reason across cold Store',async()=>{
  const f=await fixture();await f.service.initialize();const id=f.store.session.id;
  const sources=mergeInjectedMemorySources([{id:'mem_a',title:'价格',revision:1,reason:'related',relatedFrom:{id:'mem_seed',title:'计划'}}],[{id:'mem_a',title:'新版',revision:2,reason:'tool_read'},{id:'mem_b',title:'范围',revision:3,reason:'tool_read'}]);
  await f.store.updateSession(id,task=>{task.runs=[{id:'receipt_run',startedAt:now,memorySources:sources,memoryRecallReceipt:{schemaVersion:1,route:'directory',candidateCount:5,selectedCount:1,injectedCount:1,selectedIds:['mem_a'],injectedIds:['mem_a'],coreIds:[],elapsedMs:1,attempts:[]}}];});
  const cold=await fixture(undefined,f),run=cold.store.getSession(id).runs[0];assert.equal(run.memorySources.length,2);assert.equal(run.memorySources[0].relatedFrom.title,'计划');assert.equal(run.memorySources[0].reason,'related');assert.equal(run.memoryRecallReceipt.candidateCount,5);
 });
 await test('one mobile Dream drains >10 memories and a cold no-model rerun makes zero calls',async()=>{
  const f=await fixture(async input=>dreamAnswer(input));await seed(f,Array.from({length:13},(_,i)=>({...oldMemory(`mem_many_${i}`),title:`计划 ${i}`,content:`记录 ${i}`})));model(f);await f.service.initialize();
  const status=await f.service.runDream();assert.equal(status.phase,'completed',status.error);const state=JSON.parse(f.files.get('.echoink/shared-user/.runtime/dream-state.json'));assert.equal(state.processedMemorySources.length,13);assert.ok(state.runSummary.batches>=2);assert.equal(status.attemptsToday,1);
  const cold=await fixture(undefined,f);await cold.service.initialize();cold.settings.apiProviders=[];assert.equal((await cold.service.runDream()).phase,'completed');assert.equal(cold.calls(),0);
  const peerStore=new MobileStore(f.adapter,'plugin/mobile','synced-peer');await peerStore.load();let peerCalls=0;
  const peer=new MobileMemoryService({adapter:f.adapter,store:peerStore,settings:()=>cold.settings,saveSettings:async()=>{},request:async()=>{peerCalls++;throw new Error('No Provider expected');},changed(){},isBusy:()=>false,now:()=>now});
  await peer.initialize();assert.equal((await peer.runDream()).phase,'completed');assert.equal(peerCalls,0,'another device consumes the synchronized completed ledger without inference');
 });
 await test('phone source pointers validate native user identity and enqueue one durable public experience',async()=>{
  const f=await fixture();await f.service.initialize();const id=f.store.session.id,runId='mobile_run';
  const user={role:'user',content:[{type:'text',text:'价格改为29.9元。'}],timestamp:now},assistant={role:'assistant',content:[{type:'text',text:'已记下。'}],timestamp:now+1};
  await f.store.updateSession(id,task=>{task.messages=[user,assistant];task.runs=[{id:runId,startedAt:now,status:'completed',completedAt:now+1,userMessageIndex:0,userMessageDigest:sha256Hex(JSON.stringify(user)),assistantMessageIndex:1,assistantMessageDigest:sha256Hex(JSON.stringify(assistant))}];});
  const record=await f.service.commitToolMemory(await f.service.prepareToolMemory({kind:'decision',title:'价格',content:'价格为19.9元。',recallWhen:'价格',basis:'explicit'},id,runId,'tool_call'),()=>{});
  assert.match(record.source,/mobile/);assert.equal((await f.service.originalQuote(record.source)).quote.text,'价格改为29.9元。');
  await f.service.recordDreamExperience(id,runId);await f.service.recordDreamExperience(id,runId);const inbox=JSON.parse(f.files.get('.echoink/shared-user/.runtime/dream-experience-inbox.json'));assert.equal(inbox.entries.length,1);
  await f.store.updateSession(id,task=>{task.messages[0].content[0].text='被修改的原话';});assert.equal((await f.service.originalQuote(record.source)).reason,'mobile_message_changed');
 });
 for(const action of ['correct','obsolete'])await test(`mobile shared reconciliation ${action}, derived lifecycle, durable undo and undo invalidation`,async()=>{
  const f=await fixture(async request=>{
   const body=JSON.parse(request.body),q=JSON.parse(body.messages.at(-1).content);
   if(q.phase)return answer(JSON.stringify({results:q.memories.map(m=>({id:m.id,source:q.source,conclusion:action,...(action==='correct'?{title:'价格',content:'价格为29.9元。',recallWhen:'价格'}:{})}))}));
   if(q.userQuote&&q.directory)return answer('[]');return dreamAnswer(request);
  });await f.service.initialize();model(f);const id=f.store.session.id,runId='correction_run',user={role:'user',content:[{type:'text',text:'价格为29.9元。'}],timestamp:now};
  await f.store.updateSession(id,task=>{task.messages=[user];task.runs=[{id:runId,startedAt:now,userMessageIndex:0,userMessageDigest:sha256Hex(JSON.stringify(user))}];});
  const record=await f.service.commitToolMemory(await f.service.prepareToolMemory({kind:'decision',title:'价格',content:'价格为19.9元。',recallWhen:'价格',basis:'explicit'},id,runId,'call'),()=>{});
  await f.service.setPinned(record.id,true,(await f.service.list()).revision);
  const result=await f.service.runDream();assert.equal(result.phase,'completed',result.error);let events=await f.service.corrections();assert.equal(events.length,1);assert.equal(events[0].canUndo,true);
  const event=events[0];if(action==='correct'){assert.equal(event.after.content,'价格为29.9元。');assert.equal(event.after.pinned,true);}else assert.equal(event.before.status,'closed');
  const cold=await fixture(undefined,f);const restored=await cold.service.undoCorrection(event.id);assert.equal(restored,record.id);assert.equal((await cold.service.read(record.id)).record.status,'current');assert.equal((await cold.service.corrections())[0].canUndo,false);
  await assert.rejects(cold.service.undoCorrection(event.id));
 });
 await test('missing synchronized original remains pending then is rechecked when it arrives',async()=>{
  let ready=false,judgeCalls=0;const f=await fixture(async request=>{const q=JSON.parse(JSON.parse(request.body).messages.at(-1).content);if(q.phase){judgeCalls++;return answer(JSON.stringify({results:q.memories.map(m=>({id:m.id,source:q.source,conclusion:'confirmed'}))}));}return dreamAnswer(request);});
  await seed(f,[{...oldMemory(),source:'pi://vault/phone/mobile%3Adevice/mobile-user%3Adevice%3Arun?productRun=run'}]);model(f);await f.service.initialize();
  f.settings.mobileMemory.dreamRunsPerDay=6;
  const record=(await f.service.read('mem_old')).record;const reader={source:async source=>ready?{quote:{pointer:{vaultId:await f.service.repository.readVaultId(),conversationId:'phone',sessionId:'mobile:device',entryId:'mobile-user:device:run',productRunId:'run'},source,text:record.content,position:0,timestamp:now}}:{reason:'source_pending'},experience:async()=>({reason:'source_pending'})};
  const service=new MobileMemoryService({adapter:f.adapter,store:f.store,settings:()=>f.settings,saveSettings:async()=>{},request:async()=>{throw new Error("No HTTP expected");},changed(){},isBusy:()=>false,now:()=>now,originalQuotes:reader,dreamLlm:{call:async request=>{if(request.stepId?.includes('original'))judgeCalls++;const q=JSON.parse(request.userPrompt);return q.phase?JSON.stringify({results:q.memories.map(m=>({id:m.id,source:q.source,conclusion:'confirmed'}))}):q.sources?'no_change':JSON.stringify({secondaryFacts:[],relatedIds:[],userProfileItems:[]});}}});
  await service.runDream();let state=JSON.parse(f.files.get('.echoink/shared-user/.runtime/dream-state.json'));assert.ok(state.reconciliation.checks.some(check=>check.status==='waiting_source'));ready=true;f.setNow(now+86400000);await service.runDream();state=JSON.parse(f.files.get('.echoink/shared-user/.runtime/dream-state.json'));assert.ok(state.reconciliation.checks.some(check=>check.status==='written'));assert.ok(judgeCalls>=1);
 });
 await test('Dream pauses on suspension, resumes remaining work and does not consume another daily run',async()=>{
  let resolve;const pending=new Promise(r=>resolve=r);let count=0;const f=await fixture(async request=>{count++;return count===1?pending:dreamAnswer(request);});await seed(f);model(f);const running=f.service.runDream();for(let i=0;i<100&&!count;i++)await turn();await f.service.suspend();assert.equal((await running).phase,'interrupted');resolve(answer(JSON.stringify({secondaryFacts:[],relatedIds:[],userProfileItems:[]})));await f.service.resumeDream();
  for(let i=0;i<200&&f.service.dreamStatus().phase!=='completed';i++)await turn();assert.equal(f.service.dreamStatus().phase,'completed',f.service.dreamStatus().error);assert.equal(f.service.dreamStatus().attemptsToday,1);
 });
 await test('cold Dream repairs the response-saved/inbox-not-yet-written interruption without admitting private turns',async()=>{
  const f=await fixture();await f.service.initialize();const id=f.store.session.id,runId='missed-inbox',user={role:'user',content:[{type:'text',text:'这是公开的一轮对话'}],timestamp:now},assistant={role:'assistant',content:[{type:'text',text:'已收到'}],timestamp:now+1};
  await f.store.updateSession(id,task=>{task.messages=[user,assistant];task.runs=[{id:runId,startedAt:now,status:'completed',completedAt:now+1,dreamEligible:true,userMessageIndex:0,userMessageDigest:sha256Hex(JSON.stringify(user)),assistantMessageIndex:1,assistantMessageDigest:sha256Hex(JSON.stringify(assistant))},{id:'private-turn',startedAt:now,status:'completed',dreamEligible:false}];});
  const cold=await fixture(undefined,f);await assert.rejects(cold.service.runDream(),/模型/u);const inbox=JSON.parse(f.files.get('.echoink/shared-user/.runtime/dream-experience-inbox.json'));assert.equal(inbox.entries.length,1);assert.equal(inbox.entries[0].productRunId,runId);assert.equal(cold.store.getSession(id).runs[0].dreamExperienceRecorded,true);assert.equal(cold.calls(),0);
 });
 await test('foreground mobile chat completes while Dream waits for its model response',async()=>{
  let first=true,release,started=false;const gate=new Promise(resolve=>release=resolve);
  const request=async input=>{const body=JSON.parse(input.body),system=body.messages[0].content;if(system.includes('你是 EchoInk 的 Agent'))return answer('聊天完成');
   const q=JSON.parse(body.messages.at(-1).content);if(q.query)return answer('["mem_old"]');if(first&&q.memory){first=false;started=true;return gate;}return dreamAnswer(input);};
  const f=await fixture(request);await seed(f);model(f);const running=f.service.runDream();for(let i=0;i<100&&!started;i++)await turn();assert.equal(started,true);
  const host=createHost({});host.app.vault.adapter=f.adapter;const runtime=new api.MobileRuntime(host.app,f.store,()=>f.settings,request);runtime.setMemory(()=>f.service);await runtime.initialize();
  await runtime.send('请用一句话回复');assert.equal(f.store.session.taskStatus,'completed');assert.equal(f.service.dreamStatus().phase,'running');
  await f.service.cancelDream();release(answer(JSON.stringify({secondaryFacts:[],relatedIds:[],userProfileItems:[]})));await running;await runtime.dispose();
 });
 await test('two device adapters reject partial delayed sync and a stale batch after the peer revision arrives',async()=>{
  const f=await fixture();await seed(f);await f.service.initialize();const snapshot=await f.service.repository.snapshot(),record=snapshot.records[0];
  const peerFiles=await fixture();for(const [file,bytes] of f.files)peerFiles.files.set(file,bytes);
  const peerStore=new MobileStore(peerFiles.adapter,'plugin/mobile','sync-peer');await peerStore.load();
  const peer=new MobileMemoryService({adapter:peerFiles.adapter,store:peerStore,settings:()=>peerFiles.settings,saveSettings:async()=>{},request:async()=>{throw new Error('No Provider expected');},changed(){},isBusy:()=>false,now:()=>now});await peer.initialize();
  await peer.repository.mutate((await peer.repository.snapshot()).manifest.revision,'peer-edit',(draft,files)=>{const updated={...record,title:'同步到达的新标题',revision:draft.manifest.revision+1};draft.records=draft.records.map(item=>item.id===record.id?updated:item);files.set(updated.file,api.serializeCanonicalMemoryRecord(updated));});
  const stale={expectedMemoryRevision:snapshot.manifest.revision,mutations:[{action:'obsolete',check:{key:'stale',phase:'original',memoryId:record.id,memoryRevision:record.revision,source:record.source,at:now,status:'pending_write'}}],patch:{}};
  const file=`.echoink/${record.file}`,manifest='.echoink/shared-user/.runtime/manifest.json',beforeManifest=f.files.get(manifest);
  f.files.set(file,peerFiles.files.get(file));await assert.rejects(f.service.repository.applyDreamCorrections(stale));assert.equal(f.files.get(manifest),beforeManifest,'partial sync cannot publish a new local revision');assert.equal(f.files.get(file),peerFiles.files.get(file));
  await turn();for(const [file,bytes] of peerFiles.files)if(file.startsWith('.echoink/shared-user/'))f.files.set(file,bytes);
  await assert.rejects(f.service.repository.applyDreamCorrections(stale));
  assert.equal((await f.service.read(record.id)).record.title,'同步到达的新标题');assert.equal((await f.service.read(record.id)).record.status,'current');
 });
}
