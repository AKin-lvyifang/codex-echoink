import assert from 'node:assert/strict';
import {connect,delay,device,prefix,attach,route,frames,fake,tap} from './mobile-common.mjs';
import {analyze} from './analyze.mjs';
const c=await connect(),rate=Number(process.argv[4]??1),diagnostic=process.argv.includes('--diagnostic'),name=`${device}-navigation-${rate}x${diagnostic?'-diagnostic':''}`;
const result={device,rate,diagnostic,realModelCalls:0,entrances:[]};let tracing=false;
const open=route=>`p.${device==='iphone'?'openIPhoneRoute':'openIPadAgent'}(${JSON.stringify(route)})`;
async function paint(label,action,predicate){
 const r=await c.evaluate(`(async()=>{const start=performance.now();performance.mark(${JSON.stringify(label+'-start')});let ended=null,error=null;
 const pending=Promise.resolve((${action})).then(()=>ended=performance.now()-start,e=>error=String(e));
 for(let n=0;n<300;n++){if(error)throw Error(error);if(${predicate}){await (${frames})();const effectiveMs=performance.now()-start;const visible=[...mv.contentEl.querySelectorAll(ui.shell.activePageId.startsWith('task:')?'.${prefix}-task-answer-live,.${prefix}-task-answer':'.${prefix}-list-task')].some(e=>{if(e.closest('[hidden],[inert]'))return false;const r=e.getBoundingClientRect(),s=e.closest('.eis-scroll,.echoink-ipad-content')?.getBoundingClientRect();return !!(s&&r.width&&r.height&&r.bottom>Math.max(0,s.top)&&r.top<Math.min(innerHeight,s.bottom));});if(!visible)throw Error('No readable content in viewport: ${label}');performance.mark(${JSON.stringify(label+'-paint')});await pending;if(error)throw Error(error);return {label:${JSON.stringify(label)},effectiveMs,readableInViewport:visible,promiseEndedMs:ended,diagnostic:window.__navClone?{...__navClone}:undefined};}await new Promise(requestAnimationFrame);}throw Error('Effective screen timeout: ${label}');})()`);
 result.entrances.push(r);await delay(80);
}
try{
 result.environment=await attach(c);await route(c,{kind:'agent',agentId:'sol'});
 await c.evaluate(`(async()=>{const assistant={role:'assistant',api:'openai-completions',provider:'deepseek',model:'deepseek-chat',stopReason:'stop',timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
 const reply='本段用于固定的长会话滚动测量，记录渲染、滚动与主线程开销。'.repeat(8).slice(0,220);
 await p.store.update(state=>{state.sessions=Array.from({length:200},(_,i)=>({id:'mobile-perf-'+i,agentId:'sol',title:i===0?'长会话 · 200 条消息':'列表测量 '+i,updatedAt:Date.now()-i*60000,messages:i===0?Array.from({length:200},(_,n)=>n%2?{...assistant,content:[{type:'text',text:'第 '+n+' 条：'+reply}]}:{role:'user',content:[{type:'text',text:'固定问题 '+n}],timestamp:Date.now()-n}):i===1?[{role:'user',content:[{type:'text',text:'短问题'}],timestamp:Date.now()},{...assistant,content:[{type:'text',text:'短回答，核对首屏可读。'}]}]:[],draft:'',notePath:'',tools:{},taskStatus:'completed'}));state.activeSessionId='mobile-perf-0';state.page={kind:'list',agentId:'sol'};});p.workbench.invalidate();await p.workbench.refreshTasks?.();})()`);
 await route(c,{kind:'agent',agentId:'sol'});await delay(300);await c.send('Emulation.setCPUThrottlingRate',{rate});
 if(diagnostic)await c.evaluate(`window.__navClone={count:0,ms:0};window.__nativeClone=structuredClone;window.structuredClone=function(...args){const t=performance.now();try{return __nativeClone(...args);}finally{__navClone.count++;__navClone.ms+=performance.now()-t;}}`);
 await c.traceStart(false,['v8','disabled-by-default-v8.gc']);tracing=true;await c.evaluate(`performance.clearMarks();performance.mark('perf-send')`);
 for(let n=0;n<3;n++){
  await paint('open-long-'+n,open({kind:'task',taskId:'mobile-perf-0'}),`ui.shell.activePageId==='task:mobile-perf-0'&&[...mv.contentEl.querySelectorAll('.${prefix}-task-detail[data-task-id="mobile-perf-0"] .${prefix}-task-answer')].some(e=>!e.closest('[hidden]')&&e.textContent.length>100)`);
  await paint('switch-short-'+n,open({kind:'task',taskId:'mobile-perf-1'}),`ui.shell.activePageId==='task:mobile-perf-1'&&[...mv.contentEl.querySelectorAll('.${prefix}-task-detail[data-task-id="mobile-perf-1"] .${prefix}-task-answer')].some(e=>!e.closest('[hidden]')&&e.textContent.includes('短回答'))`);
  await route(c,{kind:'task',taskId:'mobile-perf-0'});
  await paint('return-list-'+n,'ui.shell.back()',`!ui.shell.activePageId.startsWith('task:')&&[...mv.contentEl.querySelectorAll('.${prefix}-list-task')].some(e=>!e.closest('[hidden]'))`);
 }
 // Native composer/real Runtime, only the loopback model is fake.
 await fetch(fake+'/speed/55');await route(c,{kind:'agent',agentId:'sol'});
 await c.evaluate(`(async()=>{const e=[...mv.contentEl.querySelectorAll('.${prefix}-composer-input')].find(e=>!e.closest('[hidden]'));e.value='固定回放：请给出长回答，不调用工具。';e.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(r=>setTimeout(r,250));})()`);
 await tap(c,`.${prefix}-composer-send:not([hidden])`);
 for(let n=0;n<400;n++){if(await c.evaluate(`ui.shell.activePageId?.startsWith('task:')&&(p.runtime.stateFor(ui.shell.activePageId.slice(5)).live?.text?.length??0)>180`))break;if(n===399)throw Error('Live return fixture never became visible');await delay(60);}
 const id=await c.evaluate('ui.shell.activePageId.slice(5)');result.runningTask=id;
 for(let n=0;n<3;n++){
  await route(c,{kind:'task',taskId:'mobile-perf-1'});
  assert.equal(await c.evaluate(`p.runtime.isBusy(${JSON.stringify(id)})`),true,'Running return must remain running');
  await paint('running-return-'+n,open({kind:'task',taskId:id}),`ui.shell.activePageId==='task:'+${JSON.stringify(id)}&&[...mv.contentEl.querySelectorAll('.${prefix}-task-answer-live')].some(e=>!e.closest('[hidden]')&&e.textContent.length>100)`);
 }
 await c.evaluate(`performance.mark('perf-stream-end')`);const trace=await c.traceEnd(name);tracing=false;result.trace=analyze(trace);
 result.gc=trace.traceEvents.filter(e=>e.pid===result.trace.main.pid&&e.tid===result.trace.main.tid&&/GC/.test(e.name)&&e.ph==='X'&&e.dur).map(e=>({name:e.name,durationMs:e.dur/1000,ts:e.ts}));
 await c.evaluate(`p.runtime.stopTask(${JSON.stringify(id)})`);await c.screenshot(name);
 result.fixture={tasks:200,messages:200,shortMessages:2,answerCharacters:220};await c.write(name+'.json',result);console.log({name,entrances:result.entrances.map(x=>({label:x.label,ms:x.effectiveMs,clone:x.diagnostic})),gcMax:Math.max(0,...result.gc.map(x=>x.durationMs))});
}finally{if(tracing)await c.traceEnd(name+'-failed');await c.write(name+'.json',result);await fetch(fake+'/speed/40');await c.evaluate(`if(window.__nativeClone){window.structuredClone=__nativeClone;delete window.__nativeClone;}`);await c.send('Emulation.setCPUThrottlingRate',{rate:1});c.close();}
