import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {connect,delay,out} from './cdp.mjs';

const c=await connect(),results=process.argv.includes('--resume')?JSON.parse(await fs.readFile(path.join(out,'reference-cases.json'),'utf8')):[],folder='性能回放专用',sourcePath=folder+'/乌桕.md';
const text='# 乌桕观察\n\n乌桕的叶片在秋日变为黄色。\n该内容仅用于自动验收的来源快照。\n';
const revision='sha256:'+createHash('sha256').update(text).digest('hex');
const scenario=body=>fetch('http://127.0.0.1:19464/scenario',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
try{
  const zeroName=process.env.ECHOINK_PERF_ZERO_NAME??'stream-batch2-cold-verified';
  const zeroId=JSON.parse(await fs.readFile(path.join(out,zeroName+'.json'),'utf8')).sessionId;
  await c.evaluate(`v.openTaskDetail(${JSON.stringify(zeroId)})`);await delay(200);
  const zero=await c.evaluate(`({refs:v.ensureSession().messages.flatMap(m=>m.knowledgeReferences??[]).length,chars:v.ensureSession().messages.filter(m=>m.itemType==='assistant').at(-1)?.text.length})`);
  assert.equal(zero.refs,0);assert.equal(zero.chars,1883);await c.screenshot('references-zero');if(!results.some(x=>x.scenario==='zero'))results.push({scenario:'zero',...zero});
  await c.evaluate(`(async()=>{
    window.__refOriginalBindings=structuredClone(p.settings.knowledgeBase.folderBindings);
    window.__refAgent=p.settings.agentRegistry.agents.find(a=>a.id==='sol');window.__refOriginalDisabled=[...(__refAgent.disabledCapabilityIds??[])];
    if(!app.vault.getAbstractFileByPath(${JSON.stringify(folder)}))await app.vault.createFolder(${JSON.stringify(folder)});
    const path=${JSON.stringify(sourcePath)},existing=app.vault.getAbstractFileByPath(path);
    if(existing){if(!(await app.vault.read(existing)).startsWith(${JSON.stringify(text)}))throw Error('Unexpected reference fixture');await app.vault.modify(existing,${JSON.stringify(text)});}else await app.vault.create(path,${JSON.stringify(text)});
    const b=p.settings.knowledgeBase.folderBindings;b.configured=true;b.revision++;
    b.organization={enabled:false,scope:'all',paths:[]};b.roles.wiki={...b.roles.wiki,enabled:true,searchEnabled:true,readPaths:[${JSON.stringify(folder)}],writePath:${JSON.stringify(folder)}};
    await p.saveSettings(true);

  })()`);
  for(const mode of ['changed','revoked','tool-added']){
    if(results.some(x=>x.scenario===mode))continue;
    const latePath=folder+'/后读.md';
    if(mode==='tool-added')await c.evaluate(`(async()=>{const file=app.vault.getAbstractFileByPath(${JSON.stringify(latePath)});if(file){if(!(await app.vault.read(file)).startsWith(${JSON.stringify(text)}))throw Error('Unexpected late fixture');await app.vault.delete(file);}})()`);
    const beforeRequests=(await(await fetch('http://127.0.0.1:19464/stats')).json()).requests.length;
    await scenario({mode:mode==='tool-added'?'tool-added':'normal',path:mode==='tool-added'?latePath:sourcePath,revision,content:text});
    await c.evaluate(`(async()=>{p.settings.agentRegistry.agents.find(a=>a.id==='sol').disabledCapabilityIds=__refOriginalDisabled.filter(id=>id!=='knowledge');p.settings.knowledgeBase.folderBindings.roles.wiki.enabled=true;p.settings.knowledgeBase.folderBindings.revision++;await app.vault.modify(app.vault.getAbstractFileByPath(${JSON.stringify(sourcePath)}),${JSON.stringify(text)});window.__refInitial=null;window.__refVerification=null;window.__refBody=null;window.__refPrevious=p.settings.activeSessionId;await v.openAgentTaskList('sol');v.inputEl.value=${JSON.stringify(mode==='tool-added'?'纯聊天：请直接按固定事件输出长回复。':'/ask 乌桕观察')};v.inputEl.dispatchEvent(new Event('input',{bubbles:true}));void v.sendMessage();})()`);
    let began=false,mutated=false;const started=Date.now();
    while(Date.now()-started<45000){
      const state=await c.evaluate(`(()=>{const a=v.ensureSession().messages.filter(m=>m.itemType==='assistant').at(-1),body=v.virtualListEl.querySelector('.codex-assistant-turn-final .codex-message-content'),workflow=p.piRuntimeBundle.runtime.active.get(p.settings.activeSessionId)?.currentRun?.knowledgeWorkflow;if(!window.__refInitial&&a?.text.length>0&&p.settings.activeSessionId!==__refPrevious&&workflow&&(workflow.kind==='ask'||workflow.kind==='chat'))window.__refInitial={references:workflow.references.map(x=>({id:x.referenceId,revision:x.contentRevision,path:x.vaultRelativePath}))};if(p.settings.activeSessionId!==__refPrevious&&a?.text.length>0&&body?.getBoundingClientRect().width&&!body.querySelector('.codex-smooth-ai-loader')&&!window.__refBody)window.__refBody=body.firstElementChild;return {running:v.running,id:p.settings.activeSessionId,chars:a?.text.length??0,initial:__refInitial};})()`);
      if(state.running)began=true;
      if(began&&!mutated&&state.id!==await c.evaluate('__refPrevious')&&state.chars>24){
        if(mode==='changed')await c.evaluate(`app.vault.modify(app.vault.getAbstractFileByPath(${JSON.stringify(sourcePath)}),${JSON.stringify(text+'结束校验前追加的一行。\n')})`);
        if(mode==='revoked')await c.evaluate(`p.settings.knowledgeBase.folderBindings.roles.wiki.enabled=false;p.settings.knowledgeBase.folderBindings.revision++`);
        mutated=true;
      }
      if(began&&!state.running)break;await delay(100);
    }
    assert.ok(began&&mutated,'the answer must stream before the case changes');await delay(400);
    const result=await c.evaluate(`(()=>{const a=v.ensureSession().messages.filter(m=>m.itemType==='assistant').at(-1),body=v.virtualListEl.querySelector('.codex-assistant-turn-final .codex-message-content');return {running:v.running,initial:__refInitial,verification:__refVerification,chars:a?.text.length,skipped:a?.knowledgeVerificationSkipped,refs:a?.knowledgeReferences?.map(x=>({id:x.referenceId,revision:x.contentRevision,status:x.verificationStatus,path:x.vaultRelativePath})),sameBody:body?.firstElementChild===__refBody,sourceChanged:!!v.virtualListEl.querySelector('.codex-source-freshness'),permissionWarning:!!v.virtualListEl.querySelector('.codex-knowledge-verification-note')};})()`);
    assert.equal(result.running,false);assert.equal(result.chars,1883);assert.ok(result.sameBody,'source settlement retains the streamed answer slot');
    if(mode==='changed'){assert.ok(result.sourceChanged);assert.ok(result.refs.some(x=>x.status==='source_link_changed'&&x.revision===revision));}
    if(mode==='revoked'){assert.equal(result.skipped,'knowledge_permission_revoked');assert.ok(result.permissionWarning);}
    if(mode==='tool-added'){const added=result.refs.find(x=>x.path===latePath);assert.ok(added,'the real tool must add the late file');const requests=(await(await fetch('http://127.0.0.1:19464/stats')).json()).requests.slice(beforeRequests).filter(x=>x.tools>0);assert.ok(!requests[0].deliveredReferenceIds.includes(added.id));assert.ok(!result.initial.references.some(x=>x.id===added.id));assert.ok(requests.length>=2,'the tool result must be followed by an actual Provider continuation');const proof=await c.evaluate(`(()=>{const t=p.piRuntimeBundle.runtime.active.get(p.settings.activeSessionId).sessionManager.getBranch().findLast(e=>e.type==='message'&&e.message?.role==='toolResult'&&e.message.toolName==='knowledge_read'),text=JSON.stringify(t?.message.content??[]);return {success:!!t&&!t.message.isError,excerpt:text.includes('乌桕的叶片在秋日变为黄色'),path:text.includes(${JSON.stringify(latePath)}),revision:text.includes(${JSON.stringify(revision)})};})()`);assert.ok(Object.values(proof).every(Boolean));result.toolReadProof=proof;result.toolDispatches=requests;}
    await c.evaluate(`v.virtualListEl.querySelector('.codex-answer-sources')?.scrollIntoView({block:'center'})`);await delay(100);
    await c.screenshot('references-'+mode);results.push({scenario:mode,...result});await c.write('reference-cases.json',results);console.log({mode,refs:result.refs,sameBody:result.sameBody});
  }
}catch(error){await c.write('reference-cases-failure.json',{results,error:String(error),state:await c.evaluate('({initial:window.__refInitial,verification:window.__refVerification,running:v.running})')});throw error;}
finally{
  await c.evaluate(`(async()=>{if(v.running)await p.piRuntimeBundle.runtime.abort(p.settings.activeSessionId);if(window.__refOriginalBindings)p.settings.knowledgeBase.folderBindings=__refOriginalBindings;if(window.__refAgent)p.settings.agentRegistry.agents.find(a=>a.id==='sol').disabledCapabilityIds=__refOriginalDisabled;await p.saveSettings(true);})()`);
  await scenario({mode:'normal'});c.close();
}
