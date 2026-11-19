import assert from 'node:assert/strict';
import {connect,delay} from './cdp.mjs';
const c=await connect(),toggle=process.argv.includes('--toggle'),name=process.env.ECHOINK_PERF_NAME??(toggle?'stream-toggle':'stream');
try{
  await c.evaluate(`(async()=>{app.setting?.close();window.p=app.plugins.plugins['codex-echoink'];await p.activateView();window.v=p.getCodexView();if(p.settings.apiProviders.some(a=>a.baseUrl!=='http://127.0.0.1:19464/v1'))throw Error('local fake provider only');await v.openAgentTaskList('sol');await p.ensurePiProductionRuntime();await new Promise(r=>setTimeout(r,600));if(document.querySelector('.modal-container'))throw Error('Blocking modal before stream measurement');__smooth.attach();const r=p.piRuntimeBundle.runtime;for(const key of ['handleAgentSessionEvent','emitRuntimeEvent','rebuildProjection','projectionFromActive','appendProviderReasoningDelta'])__smooth.wrap(r,key,'runtime.'+key);for(const key of ['projectRuntimeEvent','projectSessionBranch'])__smooth.wrap(r.projector,key,'projector.'+key);__smooth.reset();})()`);
  const before=await (await fetch('http://127.0.0.1:19464/stats')).json();
  await c.traceStart(toggle);
  await c.evaluate(`window.__perfOldSession=p.settings.activeSessionId;window.__perfVisibleAnswerAt=null;window.__perfBodyObserver=new MutationObserver(()=>{
    const body=v.virtualListEl.querySelector('.codex-assistant-turn-final .codex-message-content');
    if(p.settings.activeSessionId===__perfOldSession||!body||body.querySelector('.codex-smooth-ai-loader')||!body.textContent.trim())return;
    if(!v.ensureSession().messages.some(m=>m.itemType==='assistant'&&m.text?.length))return;
    const rect=body.getBoundingClientRect(),viewport=v.messagesEl.getBoundingClientRect();
    if(!rect.width||rect.bottom<=viewport.top||rect.top>=viewport.bottom||document.querySelector('.modal-container'))return;
    window.__perfVisibleAnswerAt=Date.now();__perfBodyObserver.disconnect();
  });__perfBodyObserver.observe(v.virtualListEl,{childList:true,subtree:true,characterData:true});`);
  await c.evaluate(`(()=>{v.inputEl.value='固定回放：请给出长回答，包含列表、代码和表格。只回答，不调用工具。';v.inputEl.dispatchEvent(new Event('input',{bubbles:true}));performance.mark('perf-send');void v.sendMessage();})()`);
  const oldId=await c.evaluate('p.settings.activeSessionId');
  const start=Date.now(),samples=[];let clicked=false,seen=false;
  while(Date.now()-start<60000){
    const state=await c.evaluate(`({running:[...p.getConversationRunService().runs.values()].some(s=>s.running||s.flight),id:p.settings.activeSessionId,visible:(v.virtualListEl.getBoundingClientRect().height>0),reasoning:v.virtualListEl.querySelector('.codex-assistant-turn-reasoning-node .codex-ai-elements-reasoning-content')?.textContent.length??0,open:v.virtualListEl.querySelector('.codex-assistant-turn-reasoning-node')?.open,answer:p.settings.sessions.find(s=>s.id===p.settings.activeSessionId)?.messages.filter(m=>m.itemType==='assistant').map(m=>({chars:m.text?.length,status:m.status})),answerDom:v.virtualListEl.querySelector('.codex-assistant-turn-final')?.textContent.length})`);
    samples.push({t:Date.now()-start,...state});
    if(state.running)seen=true;
    if(toggle&&!clicked&&state.id!==oldId&&state.visible&&state.reasoning>300){
      clicked=true;
      await c.evaluate(`void __smooth.watchFrames(2500)`);
      const click=async label=>{
        await c.evaluate(`performance.mark('${label}')`);
        const xy=await c.evaluate(`(()=>{const e=v.virtualListEl.querySelector('.codex-assistant-turn-reasoning-node summary'),r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
        await c.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...xy});
        await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...xy});
      };
      await click(state.open?'running-collapse':'running-expand');await delay(450);await click(state.open?'running-expand':'running-collapse');
    }
    if(seen&&!state.running)break;
    await delay(200);
  }
  await delay(1100);
  await c.evaluate('performance.mark("perf-stream-end")');
  await c.traceEnd(name);
  const after=await(await fetch('http://127.0.0.1:19464/stats')).json();
  const data=await c.evaluate(`({...__smooth.snapshot(),firstVisibleAnswerAt:__perfVisibleAnswerAt,sessionId:p.settings.activeSessionId,messageCount:v.ensureSession().messages.length,rows:v.virtualListEl.children.length,answerChars:v.ensureSession().messages.filter(m=>m.itemType==='assistant').reduce((n,m)=>n+(m.text?.length??0),0),open:document.querySelector('.codex-assistant-turn-reasoning-node')?.open})`);
  await c.write(name+'.json',{scenario:'new-task-from-list',wallMs:Date.now()-start,captureStartedAt:start,requests:after.requests.slice(before.requests.length),samples,...data});
  assert.equal(typeof data.firstVisibleAnswerAt,'number','the current response must reach an uncovered viewport');
  assert.ok(samples.some(s=>s.id===data.sessionId&&s.running&&s.visible&&(s.answerDom??0)>30&&s.answer?.some(a=>a.chars>0&&a.chars<1883)), 'the current streaming answer must actually be visible before completion');
  await c.screenshot(name);
  console.log({name,wallMs:Date.now()-start,tasks:data.tasks.length,fullRenders:data.calls['list.render'],markdown:data.calls['markdown.render'],saveData:data.calls['plugin.saveData'],sessionId:data.sessionId});
}finally{await c.evaluate('window.__perfBodyObserver?.disconnect()');c.close();}
