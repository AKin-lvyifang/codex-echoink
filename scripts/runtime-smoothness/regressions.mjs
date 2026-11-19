import assert from 'node:assert/strict';
import {connect,delay} from './cdp.mjs';

const c=await connect(),result={};
try{
  await c.evaluate(`(async()=>{
    window.p=app.plugins.plugins['codex-echoink'];await p.activateHomeAndSidebar();window.v=p.getCodexView();
    if(p.settings.apiProviders.some(a=>a.baseUrl!=='http://127.0.0.1:19464/v1'))throw Error('fake Provider required');
    window.__regLong=p.settings.sessions.find(s=>s.id.startsWith('perf-long-'))?.id;
    if(!__regLong)throw Error('Run interactions.mjs first');await v.openTaskDetail(__regLong);
    window.__regPrevious=p.settings.activeSessionId;await v.openAgentTaskList('sol');
    v.inputEl.value='回归测量：生成中切换任务，固定长回答。';v.inputEl.dispatchEvent(new Event('input',{bubbles:true}));void v.sendMessage();
  })()`);
  let ready=false;
  for(let i=0;i<180;i++){
    ready=await c.evaluate(`v.running&&p.settings.activeSessionId!==__regPrevious&&(v.virtualListEl.querySelector('.codex-ai-elements-reasoning-content')?.textContent.length??0)>300`);
    if(ready)break;await delay(100);
  }
  assert.ok(ready,'a visible running task appears');
  await c.evaluate(`window.__regRunning=p.settings.activeSessionId;window.__regFrames=[];void new Promise(resolve=>{
    const start=performance.now(),sample=()=>{
      const input=v.inputEl.getBoundingClientRect(),jump=v.jumpToLatestEl?.getBoundingClientRect();
      __regFrames.push({t:performance.now()-start,inputY:input.y,inputH:input.height,jumpY:jump?.height?jump.y:null});
      if(performance.now()-start<2000)requestAnimationFrame(sample);else resolve();
    };requestAnimationFrame(sample);
  });`);
  await delay(2200);
  result.geometry=await c.evaluate(`({frames:__regFrames,inputY:[...new Set(__regFrames.map(f=>f.inputY))],inputH:[...new Set(__regFrames.map(f=>f.inputH))],jumpY:[...new Set(__regFrames.map(f=>f.jumpY).filter(y=>y!==null))]})`);
  assert.equal(result.geometry.inputY.length,1,'no repeated 4px input displacement');
  assert.ok(result.geometry.jumpY.length<=1,'no repeated 4px jump-button displacement');
  result.beforeSwitch=await c.evaluate(`({id:p.settings.activeSessionId,chars:v.virtualListEl.querySelector('.codex-ai-elements-reasoning-content')?.textContent.length})`);
  await c.evaluate('v.openTaskDetail(__regLong)');await delay(350);
  result.otherTask=await c.evaluate('({id:p.settings.activeSessionId,messages:v.ensureSession().messages.length})');
  await c.evaluate('v.openTaskDetail(__regRunning)');await delay(300);
  result.returned=await c.evaluate(`({id:p.settings.activeSessionId,running:v.running,chars:v.virtualListEl.querySelector('.codex-ai-elements-reasoning-content')?.textContent.length})`);
  assert.equal(result.otherTask.messages,200);assert.equal(result.returned.id,result.beforeSwitch.id);
  assert.ok(result.returned.chars>=result.beforeSwitch.chars,'background generation continues through task switching');
  while(await c.evaluate('v.running'))await delay(200);
  result.completed=await c.evaluate(`({status:v.ensureSession().messages.filter(m=>m.itemType==='assistant').at(-1)?.status,answerChars:v.ensureSession().messages.filter(m=>m.itemType==='assistant').at(-1)?.text.length})`);
  assert.equal(result.completed.answerChars,1883);
  await c.evaluate('v.openTaskDetail(__regLong)');await delay(200);result.virtualWindows=[];
  for(const position of ['top','middle','bottom']){
    await c.evaluate(`v.messagesEl.scrollTop=${position==='top'?'0':position==='middle'?'v.messagesEl.scrollHeight/2':'v.messagesEl.scrollHeight'}`);await delay(180);
    const window=await c.evaluate(`(()=>{const renderer=v.messageListRenderer,rows=[...v.virtualListEl.children].filter(e=>e.dataset.rowId).map(e=>({id:e.dataset.rowId,measured:renderer.virtualRowHeights.get(e.dataset.rowId),height:e.getBoundingClientRect().height,top:e.getBoundingClientRect().top}));return {rows,total:v.ensureSession().messages.length,height:v.messagesEl.scrollHeight,needsRender:renderer.needsVirtualRowsRender()};})()`);
    assert.equal(window.needsRender,false,'the virtual window matches the viewport after measuring');
    assert.ok(window.rows.length>0&&window.rows.length<20);
    for(const row of window.rows)assert.ok(Math.abs(row.measured-row.height)<1,'cached row height matches its actual layout');
    for(let i=1;i<window.rows.length;i++)assert.ok(window.rows[i].top>=window.rows[i-1].top+window.rows[i-1].height-1,'virtual rows do not overlap');
    result.virtualWindows.push({position,...window});
  }
  result.environment=await c.evaluate(`({viewport:[innerWidth,innerHeight],dpr:devicePixelRatio,version:app.version,ua:navigator.userAgent,themeMethod:typeof app.changeTheme})`);
  await c.write('regressions.json',result);console.log({geometry:{inputY:result.geometry.inputY,jumpY:result.geometry.jumpY},returned:result.returned,completed:result.completed,windows:result.virtualWindows.map(w=>({position:w.position,rows:w.rows.length}))});
}catch(error){await c.write('regressions-failure.json',{...result,error:String(error)});throw error;}finally{c.close();}
