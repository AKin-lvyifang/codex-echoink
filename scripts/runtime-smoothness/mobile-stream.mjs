import assert from 'node:assert/strict';
import {connect,delay,device,prefix,attach,route,fake,tap} from './mobile-common.mjs';
import {analyze} from './analyze.mjs';
const rate=Number(process.argv[4]??1),label=process.argv[5]??'cold';
const name=`${device}-stream-${rate}x-${label}`,c=await connect();let tracing=false;
try{
  const environment=await attach(c);await route(c,{kind:'agent',agentId:'sol'});await delay(300);
  await c.send('Emulation.setCPUThrottlingRate',{rate});
  await c.evaluate(`(async()=>{const input=[...document.querySelectorAll('.${prefix}-composer-input')].find(e=>e.getBoundingClientRect().height);if(!input)throw Error('Composer missing');input.value='固定回放：请给出长回答，包含列表、代码和表格。只回答，不调用工具。';input.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(r=>setTimeout(r,250));})()`);
  const before=await(await fetch(fake+'/stats')).json();
  await c.evaluate(`(()=>{
    const m=window.__mobileMeasure={start:0,firstVisible:null,firstVisibleAt:null,firstDomAt:null,liveClears:0,bodyReplacements:0,stableBodyReplacements:0,completionBodyReplacements:0,reasoningReplacements:0,completedStreamClears:0,liveSamples:[],phase:'preparing'};
    const original=Element.prototype.replaceChildren;
    Element.prototype.replaceChildren=function(...args){if(m.start){if(this.classList.contains('${prefix}-task-streaming')){m.liveClears++;if(this.querySelector('.${prefix}-task-answer-live')){m.bodyReplacements++;const run=p.runtime.runs.get(this.parentElement?.dataset.taskId);if(run?.live?.content.some(c=>c.type==='text'&&c.text))m.stableBodyReplacements++;else m.completionBodyReplacements++;}if(this.querySelector('details'))m.reasoningReplacements++;}if(this.classList.contains('${prefix}-task-stream'))m.completedStreamClears++;}return original.apply(this,args);};
    m.restore=()=>{Element.prototype.replaceChildren=original;};
    document.addEventListener('click',function start(e){if(e.target.closest('.${prefix}-composer-send')){m.start=performance.now();m.startedAt=Date.now();performance.mark('perf-send');document.removeEventListener('click',start,true);}},true);
    m.observer=new MutationObserver(()=>{const e=[...document.querySelectorAll('.${prefix}-task-answer-live')].find(e=>!e.closest('[hidden]'));if(!m.start||m.firstVisible||m.checking||!e?.textContent.trim())return;
      m.firstDomAt??=Date.now();m.checking=true;
      requestAnimationFrame(()=>{const r=e.getBoundingClientRect(),s=e.closest('.eis-scroll,.echoink-ipad-content')?.getBoundingClientRect();
        if(e.isConnected&&s&&r.width&&r.bottom>s.top&&r.top<s.bottom){requestAnimationFrame(()=>{if(e.isConnected){m.firstVisible=performance.now()-m.start;m.firstVisibleAt=Date.now();}m.checking=false;});}else m.checking=false;});});
    m.observer.observe(mv.contentEl,{childList:true,subtree:true,characterData:true});
  })()`);
  await c.traceStart();tracing=true;
  await tap(c,`.${prefix}-composer-send:not([hidden])`);
  const started=Date.now(),samples=[];let seen=false;
  while(Date.now()-started<65000){
    const state=await c.evaluate(`(()=>{const id=ui.shell.activePageId?.startsWith('task:')?ui.shell.activePageId.slice(5):null;const s=id?p.runtime.stateFor(id):null;return {id,busy:s?.busy,liveChars:s?.live?.text?.length??0,reasoning:s?.live?.reasoning?.length??0,visibleAt:__mobileMeasure.firstVisibleAt,error:s?.error,answerChars:id?p.store.getSession(id)?.messages.filter(m=>m.role==='assistant').reduce((n,m)=>n+m.content.filter(c=>c.type==='text').reduce((a,b)=>a+b.text.length,0),0):0};})()`);
    samples.push({t:Date.now()-started,...state});if(state.busy)seen=true;
    if(seen&&!state.busy)break;
    if(state.error)break;await delay(150);
  }
  await delay(200);await c.evaluate('performance.mark("perf-stream-end")');
  const trace=await c.traceEnd(name);tracing=false;
  const metrics=await c.evaluate(`(()=>{const m=__mobileMeasure;m.observer.disconnect();m.restore();return {start:m.start,startedAt:m.startedAt,sendToVisibleMs:m.firstVisible,firstVisibleAt:m.firstVisibleAt,firstDomAt:m.firstDomAt,liveClears:m.liveClears,bodyReplacements:m.bodyReplacements,stableBodyReplacements:m.stableBodyReplacements,completionBodyReplacements:m.completionBodyReplacements,reasoningReplacements:m.reasoningReplacements,completedStreamClears:m.completedStreamClears};})()`);
  const after=await(await fetch(fake+'/stats')).json(),requests=after.requests.slice(before.requests.length);
  const summary=analyze(trace),result={device,rate,label,environment,metrics,requests,samples,trace:summary,realModelCalls:0};
  const sendMark=trace.traceEvents.find(e=>e.name==='perf-send'),requestStart=requests.find(r=>!r.auxiliary)?.start;
  if(sendMark&&requestStart){const end=Date.parse(requestStart)-metrics.startedAt;result.preparation={endMs:end,longTasks:summary.longTasks.filter(t=>(t.ts-sendMark.ts)/1000<end).map(t=>({...t,relativeMs:(t.ts-sendMark.ts)/1000}))};}
  result.metrics.firstProviderBodyToVisibleMs=requests.find(r=>r.firstContentAt&&!r.auxiliary)?.firstContentAt?metrics.firstVisibleAt-requests.find(r=>r.firstContentAt&&!r.auxiliary).firstContentAt:null;
  await c.write(name+'.json',result);await c.screenshot(name);
  assert.ok(seen,'A real mobile run must start');assert.ok(metrics.sendToVisibleMs,'Streaming body must reach viewport');
  assert.ok(samples.some(s=>s.busy&&s.visibleAt&&s.liveChars>0&&s.liveChars<1883),'Current unfinished body must be visible');
  assert.equal(samples.at(-1).answerChars,1883);
  console.log({name,sendToVisibleMs:metrics.sendToVisibleMs,bodyToVisibleMs:result.metrics.firstProviderBodyToVisibleMs,longTasks:summary.longTasks.map(t=>t.durationMs),forcedLayout:summary.forcedLayout.count,replacements:metrics.bodyReplacements});
}finally{if(tracing)await c.traceEnd(name+'-failed');await c.evaluate('window.__mobileMeasure?.observer?.disconnect();window.__mobileMeasure?.restore?.()');await c.send('Emulation.setCPUThrottlingRate',{rate:1});c.close();}
