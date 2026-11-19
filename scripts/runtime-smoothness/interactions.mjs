import {connect,delay} from './cdp.mjs';
import {ownedSettings} from './owned-settings.mjs';
const c=await connect();let settingsWindow;
try{
  await c.evaluate(`app.setting.close();window.p=app.plugins.plugins['codex-echoink'];window.v=p.getCodexView();__smooth.attach();window.__perfPaint=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));window.__perfTimes=[];`);
  // Build a real 200-message Pi archive through the same SessionManager used by production.
  const fixture=await c.evaluate(`(async()=>{
    const runtime=p.piRuntimeBundle.runtime,id='perf-long-'+Date.now(),entry=await p.createPiConversation({conversationId:id,title:'性能合成会话·200条',agentId:'sol',cwd:p.getVaultPath(),defaultMemoryMode:'normal'});
    await runtime.activateConversation(id);const a=runtime.active.get(id);
    const usage={input:10,output:10,cacheRead:0,cacheWrite:0,totalTokens:20,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
    for(let i=0;i<100;i++){
      a.sessionManager.appendMessage({role:'user',content:[{type:'text',text:'第'+(i+1)+'个合成问题：请说明本次记录。'}],timestamp:Date.now()});
      a.sessionManager.appendMessage({role:'assistant',content:[{type:'text',text:'第'+(i+1)+'个合成回答。'+('这是用于衡量长会话打开与滚动的固定文字。'.repeat(10))+'\\n\\n- 第一项\\n- 第二项'}],api:'openai-completions',provider:'deepseek',model:'deepseek-flash',usage,stopReason:'stop',timestamp:Date.now()});
    }
    runtime.checkpointConversationLeaf(a);await runtime.releaseConversation(id);
    window.__perfLong=id;window.__perfShort=p.settings.sessions.find(s=>s.messages.length===3).id;
    return {id,messages:200,assistantChars:220,archiveBytes:require('fs').statSync(entry.sessionFile).size};
  })()`);
  await delay(1000);
  await c.traceStart();await c.evaluate('__smooth.reset()');
  const timed=async(label,body)=>{
    const paint=label.startsWith('settings')?`for(let i=0;i<120&&!p.settingsTabInstance.settingsBodyEl?.childElementCount;i++)await new Promise(requestAnimationFrame);const owner=p.settingsTabInstance.containerEl.ownerDocument.defaultView;if(!owner||owner.closed)throw Error('Settings owner closed');await new Promise(r=>owner.requestAnimationFrame(()=>owner.requestAnimationFrame(r)))`:'await __perfPaint()';
    return c.evaluate(`(async()=>{performance.mark(${JSON.stringify(label)}+'-start');const t=performance.now();${body};${paint};const ms=performance.now()-t;performance.mark(${JSON.stringify(label)}+'-paint');__perfTimes.push({label:${JSON.stringify(label)},ms});return ms;})()`);
  };
  await timed('long-open-cold','await v.openTaskDetail(__perfLong)');
  const long=await c.evaluate(`({messages:v.ensureSession().messages.length,virtualRows:v.virtualListEl.children.length,domNodes:v.virtualListEl.querySelectorAll('*').length,scrollHeight:v.messagesEl.scrollHeight,viewportHeight:v.messagesEl.clientHeight})`);
  for(let i=0;i<3;i++){await timed('session-short-'+i,'await v.openTaskDetail(__perfShort)');await timed('long-open-warm-'+i,'await v.openTaskDetail(__perfLong)');}
  await c.evaluate(`v.inputEl.focus();v.inputEl.value='';window.__perfInputs=[];v.inputEl.addEventListener('input',window.__perfInput=()=>{const t=performance.now();__perfPaint().then(()=>__perfInputs.push(performance.now()-t));});`);
  for(const ch of '这是输入延迟测试abcdefghij'){await c.send('Input.insertText',{text:ch});await delay(100);}
  await c.evaluate(`v.inputEl.removeEventListener('input',__perfInput);v.inputEl.value='';`);
  await c.evaluate(`v.messagesEl.scrollTop=0;performance.mark('long-scroll-start');`);await delay(300);
  const xy=await c.evaluate(`(()=>{const r=v.messagesEl.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  for(let i=0;i<30;i++){await c.send('Input.dispatchMouseEvent',{type:'mouseWheel',deltaY:160,deltaX:0,...xy});await delay(40);}
  await c.evaluate(`performance.mark('long-scroll-end');`);
  await c.screenshot('long-conversation');
  await timed('tab-journal-cold','await p.activateJournalView()');await delay(800);
  await timed('tab-home-warm','await p.activateHomeView({keepRightSidebar:true})');
  for(let i=0;i<3;i++){await timed('tab-journal-warm-'+i,'await p.activateJournalView()');await timed('tab-home-warm-'+i,'await p.activateHomeView({keepRightSidebar:true})');}
  if(process.argv.includes('--chat-only')) {
    await c.traceEnd('interactions');
    const data=await c.evaluate(`({...__smooth.snapshot(),times:__perfTimes,inputMs:__perfInputs})`);
    await c.write('interactions.json',{fixture,long,...data});console.log({fixture,long,times:data.times,inputs:data.inputMs});
  } else {
  await timed('settings-open',`app.setting.open();app.setting.openTabById('codex-echoink')`);
  const settings=await c.evaluate(`({text:p.settingsTabInstance.containerEl.innerText.slice(0,400),buttons:[...p.settingsTabInstance.containerEl.querySelectorAll('button')].slice(0,18).map(e=>({text:e.textContent,cls:e.className,role:e.getAttribute('role')})),nodes:p.settingsTabInstance.containerEl.querySelectorAll('*').length})`);
  for(const key of ['renderSettingsContent','renderTopTabs','scheduleDisplay'])await c.evaluate(`__smooth.wrap(p.settingsTabInstance,'${key}','settings.${key}')`);
  for(const category of ['models','agent','memory','modules','capabilities','account'])await timed('settings-'+category,`await p.settingsTabInstance.activateSettingsTab('${category}',true)`);
  settingsWindow=await ownedSettings(c);await settingsWindow.screenshot('settings');
  await c.traceEnd('interactions');
  await c.write('interactions.json',{fixture,long,settings,...await c.evaluate(`({...__smooth.snapshot(),times:__perfTimes,inputMs:__perfInputs})`)});
  await c.evaluate('app.setting.close()');
  console.log({fixture,long,settings,times:await c.evaluate('__perfTimes'),inputs:await c.evaluate('__perfInputs')});
  }
}finally{settingsWindow?.close();c.close();}
