import {connect,delay,device,prefix,attach,route,size,frames} from './mobile-common.mjs';
import {visualKeyboardProxy} from './mobile-keyboard-proxy.mjs';
import {analyze} from './analyze.mjs';
let keyboardProxy;
const c=await connect(),rate=Number(process.argv[4]??1),entrancesOnly=process.argv.includes('--entrances-only'),name=`${device}-${entrancesOnly?'entrances':'interactions'}-${rate}x`,result={device,rate,entrances:[],scroll:[],keyboard:[]};
async function paint(label,action,predicate){
  const r=await c.evaluate(`(async()=>{const start=performance.now();let ended=null,error=null;Promise.resolve((${action})).then(()=>ended=performance.now()-start,e=>error=String(e));
    for(let n=0;n<300;n++){if(error)throw Error(error);if(${predicate}){await (${frames})();return {label:${JSON.stringify(label)},effectiveMs:performance.now()-start,promiseEndedMs:ended};}await new Promise(requestAnimationFrame);}throw Error('Effective first screen timeout: ${label}');})()`);
  result.entrances.push(r);await delay(80);return r;
}
try{
  result.environment=await attach(c);await route(c,{kind:'agent',agentId:'sol'});
  await c.evaluate(`(async()=>{window.__mobileOriginalState=p.store.state;
    const assistant={role:'assistant',api:'openai-completions',provider:'deepseek',model:'deepseek-chat',stopReason:'stop',timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
    const reply='本段用于固定的长会话滚动测量，记录渲染、滚动与主线程开销。'.repeat(8).slice(0,220);
    window.__mobileFixtureIds=Array.from({length:200},(_,i)=>'mobile-perf-'+i);
    await p.store.update(state=>{state.sessions=__mobileFixtureIds.map((id,i)=>({id,agentId:'sol',title:i===0?'长会话 · 200 条消息':'列表测量 '+i,updatedAt:Date.now()-i*60000,messages:i===0?Array.from({length:200},(_,n)=>n%2?{...assistant,content:[{type:'text',text:'第 '+n+' 条：'+reply}]}:{role:'user',content:[{type:'text',text:'固定问题 '+n}],timestamp:Date.now()-n}):[],draft:'',notePath:'',tools:{},taskStatus:'completed'}));state.activeSessionId=__mobileFixtureIds[0];state.page={kind:'list',agentId:'sol'};});
    p.workbench.invalidate();await p.workbench.refreshTasks?.();})()`);
  await route(c,{kind:'agent',agentId:'sol'});await delay(300);
  await c.send('Emulation.setCPUThrottlingRate',{rate});
  for(let n=0;n<3;n++){
    await paint('open-long-'+n,`p.${device==='iphone'?'openIPhoneRoute':'openIPadAgent'}({kind:'task',taskId:'mobile-perf-0'})`,`ui.shell.activePageId==='task:mobile-perf-0'&&[...document.querySelectorAll('.${prefix}-task-answer')].some(e=>!e.closest('[hidden]')&&e.textContent.length>100)`);
    await paint('task-back-'+n,`ui.shell.back()`,`!ui.shell.activePageId.startsWith('task:')&&[...document.querySelectorAll('.${prefix}-list-task')].some(e=>!e.closest('[hidden]'))`);
    await paint('switch-task-'+n,`p.${device==='iphone'?'openIPhoneRoute':'openIPadAgent'}({kind:'task',taskId:'mobile-perf-1'})`,`ui.shell.activePageId==='task:mobile-perf-1'&&[...document.querySelectorAll('[data-task-id="mobile-perf-1"]')].some(e=>!e.closest('[hidden]'))`);
    await route(c,{kind:'agent',agentId:'sol'});
  }
  for(const scene of (entrancesOnly?[]:['list','long'])){
    if(scene==='long')await route(c,{kind:'task',taskId:'mobile-perf-0'});else await route(c,{kind:'agent',agentId:'sol'});
    await delay(200);
    const selector=scene==='long'?`.${prefix}-task-detail`:`.${prefix}-list-task`;
    const xy=await c.evaluate(`(()=>{const target=[...document.querySelectorAll('${selector}')].find(e=>!e.closest('[hidden]'));let s=target.parentElement;while(s&&!(/auto|scroll/.test(getComputedStyle(s).overflowY)&&s.scrollHeight>s.clientHeight))s=s.parentElement;if(!s)throw Error('Scrollable ancestor missing');s.scrollTop=0;window.__scrollTest=s;const r=s.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height*.65,scrollHeight:s.scrollHeight,clientHeight:s.clientHeight,scrollerClass:s.className,nodes:s.querySelectorAll('*').length,rows:s.querySelectorAll('.${prefix}-list-task,.${prefix}-task-answer,.${prefix}-task-user').length};})()`);
    await c.traceStart();
    await c.evaluate(`performance.clearMarks('perf-send');performance.clearMarks('perf-stream-end');performance.mark('perf-send');window.__frameTimes=[];window.__framesActive=true;window.__frameLoop=t=>{if(!__framesActive)return;__frameTimes.push(t);requestAnimationFrame(__frameLoop);};requestAnimationFrame(__frameLoop);`);
    if(device==='iphone'){
      // Explicit finger movement avoids the host emulator interpreting CDP's
      // synthetic gesture as its global pull-down command-palette gesture.
      for(let repeat=0;repeat<8;repeat++){
        await c.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:xy.x,y:xy.y,id:1}]});
        for(let n=1;n<=7;n++){await c.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:xy.x,y:xy.y-n*25,id:1}]});await delay(20);}
        await c.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await delay(60);
      }
    }else await c.send('Input.synthesizeScrollGesture',{x:xy.x,y:xy.y,yDistance:-2000,speed:750,gestureSourceType:'touch',repeatCount:1,repeatDelayMs:100});
    await delay(300);
    await c.evaluate('window.__framesActive=false;performance.mark("perf-stream-end")');const tr=await c.traceEnd(`${name}-${scene}`);
    const measured=await c.evaluate(`({times:__frameTimes,top:__scrollTest.scrollTop})`);
    const intervals=measured.times.slice(1).map((t,i)=>t-measured.times[i]).sort((a,b)=>a-b);
    result.scroll.push({scene,geometry:xy,finalTop:measured.top,frames:intervals.length,frameP50:intervals[Math.floor(intervals.length*.5)],frameP95:intervals[Math.floor(intervals.length*.95)],frameMax:Math.max(...intervals),over50:intervals.filter(n=>n>50).length,trace:analyze(tr)});
    await c.screenshot(`${name}-${scene}`);
    if(measured.top<100)throw Error('Touch scroll did not move the target; no valid frame baseline');
    if(await c.evaluate(`!!document.querySelector('.modal-container,.menu,.prompt')`))throw Error('Host overlay appeared during scroll; invalid sample');
  }
  await c.send('Emulation.setCPUThrottlingRate',{rate:1});
  if(rate===1){
    await route(c,{kind:'agent',agentId:'sol'});
    if(device==='ipad')await c.evaluate(`for(const leaf of app.workspace.getLeavesOfType('echoink-ipad-settings-shell'))leaf.detach();void 0`);
    for(let n=0;n<3;n++){
      await paint('settings-open-'+n,device==='iphone'?'ui.settingsPages.open()':'p.openIPadSettings()',device==='iphone'?`ui.shell.activePageId==='iphone-settings-root'`:`document.querySelector('.pd-settings')?.textContent.includes('模型')`);
      if(device==='iphone'){
        await paint('settings-general-'+n,`ui.settingsPages.open('general')`,`ui.shell.activePageId==='iphone-settings-general'`);
        await paint('settings-back-'+n,`ui.shell.back()`,`ui.shell.activePageId==='iphone-settings-root'`);await c.evaluate('ui.shell.back()');
      }else{
        await c.evaluate(`window.sv=app.workspace.getLeavesOfType('echoink-ipad-settings-shell')[0].view;void 0`);
        await paint('settings-model-'+n,`sv.ui.open('model')`,`sv.contentEl.textContent.includes('本机固定回放')`);
        await paint('settings-general-'+n,`sv.ui.open('general')`,`sv.contentEl.textContent.includes('配色')`);
        await paint('settings-back-'+n,`sv.ui.shell.back()`,`sv.contentEl.textContent.length>20`);
      }
    }
    await c.evaluate(`(async()=>{const path='手机丝滑度测量.md';if(!app.vault.getAbstractFileByPath(path))await app.vault.create(path,${JSON.stringify('# 固定测量\n\n仅测试副本。')});const leaf=app.workspace.getLeaf('tab');await leaf.openFile(app.vault.getAbstractFileByPath(path));window.__noteLeaf=leaf;window.__echoLeaf=app.workspace.getLeavesOfType('${device==='iphone'?'echoink-iphone-shell':'echoink-ipad-workbench-shell'}')[0];return true;})()`);
    for(let n=0;n<3;n++){
      await paint('tab-to-echo-'+n,'app.workspace.setActiveLeaf(__echoLeaf,{focus:true})',`__echoLeaf.containerEl.getBoundingClientRect().width>0&&!__echoLeaf.containerEl.closest('[hidden]')`);
      await paint('tab-to-note-'+n,'app.workspace.setActiveLeaf(__noteLeaf,{focus:true})',`__noteLeaf.containerEl.getBoundingClientRect().width>0&&!__noteLeaf.containerEl.closest('[hidden]')`);
    }
    if(!entrancesOnly){
    await route(c,{kind:'task',taskId:'mobile-perf-0'});await delay(200);
    // Keep layout/device identity fixed while simulating visual keyboard occlusion.
    await c.evaluate(`window.__keyboardSamples=[];window.__keyboardOn=true;window.__keyboardTick=()=>{if(!__keyboardOn)return;const e=[...document.querySelectorAll('.${prefix}-composer-input')].find(e=>!e.closest('[hidden]'));if(e){const r=e.getBoundingClientRect();__keyboardSamples.push({t:performance.now(),y:r.y,height:r.height,vh:visualViewport.height,inner:innerHeight});}requestAnimationFrame(__keyboardTick);};requestAnimationFrame(__keyboardTick);`);
    await delay(120);
    keyboardProxy=await visualKeyboardProxy(c);for(const height of [size.height-300,size.height]){await keyboardProxy.resize(height);await delay(550);}
    const samples=await c.evaluate('window.__keyboardOn=false;__keyboardSamples');
    const transitions=samples.filter((s,i)=>i&&Math.abs(s.y-samples[i-1].y)>.5);
    result.keyboard={method:'visualViewport height proxy; layout/device identity fixed; no real IME, keyboard events, animation or nonzero safe area',samples,transitions};
    await c.screenshot(device+'-keyboard-restored');
    }
  }
  result.fixture={tasks:200,messages:200,answerCharacters:220,realModelCalls:0};
  await c.write(name+'.json',result);console.log({name,entrances:result.entrances,scroll:result.scroll.map(s=>({scene:s.scene,p95:s.frameP95,max:s.frameMax,long:s.trace.longTasks.length})),keyboard:result.keyboard.transitions?.length});
}finally{await keyboardProxy?.restore();await c.write(name+'.json',result);await c.send('Emulation.setCPUThrottlingRate',{rate:1});c.close();}
