import assert from 'node:assert/strict';
import {connect,delay,device,prefix,attach,route,fake,tap} from './mobile-common.mjs';
const c=await connect(),result={device,realModelCalls:0,checks:[]};
async function until(expression) {for(let n=0;n<500;n++){if(await c.evaluate(expression))return;await delay(80);}throw Error('Functional timeout: '+expression);}
async function scenario(body) {await fetch(fake+'/scenario',{method:'POST',body:JSON.stringify(body)});}
async function send(text) {
 await route(c,{kind:'agent',agentId:'sol'});
 await c.evaluate(`(async()=>{const input=mv.contentEl.querySelector('.${prefix}-composer-input');input.value=${JSON.stringify(text)};input.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(r=>setTimeout(r,250));})()`);
 await c.evaluate(`window.__functionalPageBefore=ui.shell.activePageId`);
 await tap(c,`[data-mobile-functional] .${prefix}-composer-send:not([hidden])`);
 await until(`ui.shell.activePageId?.startsWith('task:')&&ui.shell.activePageId!==__functionalPageBefore`);
 const id=await c.evaluate(`ui.shell.activePageId.slice(5)`);await c.evaluate(`window.__functionalId=${JSON.stringify(id)}`);return id;
}
async function complete(id) {
 await until(`!p.runtime.isBusy(${JSON.stringify(id)})`);
 const state=await c.evaluate(`(()=>{const s=p.store.getSession(${JSON.stringify(id)});return {status:s.taskStatus,error:p.runtime.stateFor(s.id).error,chars:s.messages.filter(m=>m.role==='assistant').flatMap(m=>m.content).filter(b=>b.type==='text').reduce((n,b)=>n+b.text.length,0)};})()`);
 assert.equal(state.status,'completed',JSON.stringify(state));assert.ok(state.chars>=1883);return state;
}
try {
 result.environment=await attach(c);await c.evaluate(`mv.contentEl.dataset.mobileFunctional='true'`);
 await scenario({mode:'normal'});await fetch(fake+'/speed/15');
 const stopped=await send('功能主流程：发送后停止，再继续。');
 await until(`(p.runtime.stateFor(__functionalId).live?.text?.length??0)>120`);
 await tap(c,`[data-mobile-functional] .${prefix}-composer-stop:not([hidden])`);
 await until('!p.runtime.isBusy(__functionalId)');
 const interrupted=await c.evaluate(`({status:p.store.getSession(__functionalId).taskStatus,reason:p.runtime.stateFor(__functionalId).interruption?.reason})`);
 assert.equal(interrupted.status,'interrupted');assert.equal(interrupted.reason,'user_stopped');result.checks.push({name:'send-stop',...interrupted});
 await tap(c,`[data-mobile-functional] [data-task-id="${stopped}"] [data-action="resume-task"]`);
 await until('p.runtime.isBusy(__functionalId)');result.checks.push({name:'resume-after-stop',...await complete(stopped)});
 const markdown=await c.evaluate(`(()=>{const root=mv.contentEl.querySelector('.${prefix}-task-detail[data-task-id="'+__functionalId+'"]');return {headings:root.querySelectorAll('.markdown-rendered h1,.markdown-rendered h2').length,code:root.querySelector('pre code')?.textContent,table:!!root.querySelector('table'),liveHidden:root.querySelector('.${prefix}-task-streaming').hidden};})()`);
 assert.equal(markdown.headings,13);assert.ok(markdown.table&&markdown.liveHidden);assert.ok(markdown.code.includes('function measure'));
 result.checks.push({name:'completed-markdown',...markdown});
 // Intercept only this fixture's copy invocation, restoring the OS clipboard API.
 await c.evaluate(`window.__copyOriginal=Object.getOwnPropertyDescriptor(navigator.clipboard,'writeText');window.__copiedFixture=null;Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:async text=>{window.__copiedFixture=text;}})`);
 try {await tap(c,`[data-mobile-functional] [data-task-id="${stopped}"] .copy-code-button`);await until('!!__copiedFixture');assert.equal(await c.evaluate('__copiedFixture'),markdown.code.trimEnd());result.checks.push({name:'copy-code',exact:true,hostTrimsTrailingNewline:true});}
 finally {await c.evaluate(`if(__copyOriginal)Object.defineProperty(navigator.clipboard,'writeText',__copyOriginal);else delete navigator.clipboard.writeText`);}
 await scenario({mode:'fail-once'});
 const failed=await send('功能主流程：固定失败后点继续重试。');
 await until('!p.runtime.isBusy(__functionalId)');
 const failure=await c.evaluate(`({status:p.store.getSession(__functionalId).taskStatus,error:p.runtime.stateFor(__functionalId).error})`);
 assert.equal(failure.status,'interrupted',JSON.stringify(failure));
 await tap(c,`[data-mobile-functional] [data-task-id="${failed}"] [data-action="resume-task"]`);
 await until('p.runtime.isBusy(__functionalId)');result.checks.push({name:'retry-after-provider-failure',failure,...await complete(failed)});
 await route(c,{kind:'task',taskId:stopped});assert.equal(await c.evaluate('ui.shell.activePageId'),'task:'+stopped);
 await route(c,{kind:'task',taskId:failed});assert.equal(await c.evaluate('ui.shell.activePageId'),'task:'+failed);
 result.checks.push({name:'switch-task',returnedAnswerVisible:await c.evaluate(`!!mv.contentEl.querySelector('[data-task-id="${failed}"] .markdown-rendered h1')`)});
 const path=`性能审批验收/${device}-${Date.now().toString(36)}.md`;
 await scenario({mode:'approval',path});
 await c.evaluate(`(async()=>{window.__approvalFixtureSettings={registry:structuredClone(p.settings.agentRegistry),bindings:structuredClone(p.settings.knowledgeBase.folderBindings),modules:structuredClone(p.settings.mobileUi.moduleEnabled)};const a=p.settings.agentRegistry.agents.find(a=>a.id==='generalist');a.capabilityIds=[...new Set([...(a.capabilityIds??[]),'knowledge'])];a.disabledCapabilityIds=a.disabledCapabilityIds?.filter(x=>x!=='knowledge');p.settings.mobileUi.moduleEnabled={...p.settings.mobileUi.moduleEnabled,'knowledge-base':true};const role=p.settings.knowledgeBase.folderBindings.roles.raw;Object.assign(role,{enabled:true,writePath:'性能审批验收',readPaths:['性能审批验收']});if(!app.vault.getAbstractFileByPath('性能审批验收'))await app.vault.createFolder('性能审批验收');})()`);
 const worker=await c.evaluate(`(async()=>{const s=await p.store.createSession('generalist');await p.store.updateSession(s.id,t=>{t.companyRole='worker';});window.__functionalId=s.id;return s.id;})()`);
 await route(c,{kind:'task',taskId:worker});
 await c.evaluate(`(async()=>{const submission=await p.runtime.submitCompanyTurn(__functionalId,'请新建 ${path}，正文为固定审批测试。','workspace-write');submission.completion.catch(e=>{window.__functionalApprovalError=String(e);});})()`);
 await until(`p.runtime.stateFor(__functionalId).interaction?.status==='pending'||!p.runtime.isBusy(__functionalId)`);
 const pending=await c.evaluate(`({busy:p.runtime.isBusy(__functionalId),interaction:p.runtime.stateFor(__functionalId).interaction?.status,exists:!!app.vault.getAbstractFileByPath(${JSON.stringify(path)}),error:p.runtime.stateFor(__functionalId).error})`);
 assert.equal(pending.interaction,'pending',JSON.stringify(pending));assert.equal(pending.exists,false);
 await c.screenshot(device+'-approval-pending');
 await tap(c,`[data-mobile-functional] [data-task-id="${worker}"] [data-option-id="approve"]`);
 const approved=await complete(worker);
 const written=await c.evaluate(`(async()=>{const f=app.vault.getAbstractFileByPath(${JSON.stringify(path)}),s=p.store.getSession(__functionalId);return {exists:!!f,text:f?await app.vault.read(f):null,completedWrites:s.operations?.filter(o=>o.target===${JSON.stringify(path)}&&o.status==='completed').length};})()`);
 assert.equal(written.text,'# 固定审批\n\n只在本轮副本。');assert.equal(written.completedWrites,1);
 result.checks.push({name:'approval',pending,...approved,...written,path});result.pass=true;
 await c.screenshot(device+'-functional-complete');
 console.log({device,pass:true,checks:result.checks.map(x=>x.name)});
} catch(error) {result.pass=false;result.error=String(error);await c.screenshot(device+'-functional-failure');throw error;}
finally {await c.write(device+'-functional.json',result);await scenario({mode:'normal'});await fetch(fake+'/speed/40');await c.evaluate(`if(window.__approvalFixtureSettings){p.settings.agentRegistry=__approvalFixtureSettings.registry;p.settings.knowledgeBase.folderBindings=__approvalFixtureSettings.bindings;p.settings.mobileUi.moduleEnabled=__approvalFixtureSettings.modules;delete window.__approvalFixtureSettings;}delete mv.contentEl.dataset.mobileFunctional`);c.close();}
