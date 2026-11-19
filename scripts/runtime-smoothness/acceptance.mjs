import assert from 'node:assert/strict';
import {connect,delay} from './cdp.mjs';
const c=await connect(),result={};
const point=()=>c.evaluate(`(()=>{const e=v.virtualListEl.querySelector('.codex-assistant-turn-reasoning-node > summary');const r=e.getBoundingClientRect();if(!r.width||!r.height)throw Error('hidden pointer target');const at=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);if(!at||!e.contains(at))throw Error('pointer target covered before press');return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
try{
  await fetch('http://127.0.0.1:19464/speed/80');
  await c.evaluate(`(async()=>{window.p=app.plugins.plugins['codex-echoink'];await p.activateView();window.v=p.getCodexView();if(p.settings.apiProviders.some(a=>a.baseUrl!=='http://127.0.0.1:19464/v1'))throw Error('fake Provider required');window.__acceptPrevious=p.settings.activeSessionId;await v.openAgentTaskList('sol');if(document.querySelector('.modal-container'))throw Error('Blocking modal before click acceptance');v.inputEl.value='回归测量：保留思考阅读，固定回放长回答。';v.inputEl.dispatchEvent(new Event('input',{bubbles:true}));void v.sendMessage();})()`);
  let ready=false;
  for(let i=0;i<160;i++){ready=await c.evaluate(`(()=>{const d=v.virtualListEl.querySelector('.codex-assistant-turn-reasoning-node');return v.running&&p.settings.activeSessionId!==__acceptPrevious&&d?.dataset.nodeStatus==='running'&&d.querySelector('summary').getBoundingClientRect().width>0&&d.querySelector('.codex-ai-elements-reasoning-content').textContent.length>300;})()`);if(ready)break;await delay(100);}
  assert.ok(ready,'running reasoning must appear');
  await c.evaluate(`window.__acceptRoot=v.virtualListEl.querySelector('.codex-assistant-turn-reasoning-node');window.__acceptClicks=[];window.__acceptInput=e=>{const target=e.target.closest?.('.codex-ai-elements-reasoning-trigger');if(target&&target.closest('.codex-virtual-list')===v.virtualListEl)__acceptClicks.push({type:e.type,sameRoot:target.parentElement===__acceptRoot,trusted:e.isTrusted});};for(const name of ['pointerdown','pointerup','click'])document.addEventListener(name,__acceptInput,true);`);
  result.clicks=[];
  for(let i=0;i<20;i++){
    const before=await c.evaluate('__acceptRoot.open'),xy=await point();
    await c.evaluate(`window.__acceptSummary=__acceptRoot.querySelector('summary');window.__acceptDownTarget=document.elementFromPoint(${xy.x},${xy.y});`);
    await c.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...xy});await delay(35);
    await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...xy});await delay(45);
    const after=await c.evaluate(`({open:__acceptRoot.open,same:v.virtualListEl.querySelector('.codex-assistant-turn-reasoning-node')===__acceptRoot,sameSummary:__acceptRoot.querySelector('summary')===__acceptSummary,downConnected:__acceptDownTarget?.isConnected,downClass:__acceptDownTarget?.className,upClass:document.elementFromPoint(${xy.x},${xy.y})?.className,rect:__acceptSummary.getBoundingClientRect().toJSON(),renders:__smooth.calls['list.render']?.count})`);
    result.clicks.push(after);assert.equal(after.open,!before,'every press/release toggles once');assert.ok(after.same,'the pointer target survives increments');
  }
  assert.equal(await c.evaluate(`__acceptClicks.filter(e=>e.type==='click').length`),20);
  const bodyPoint=await c.evaluate(`(()=>{const b=__acceptRoot.querySelector('.codex-ai-elements-reasoning-content');b.scrollTop=b.scrollHeight;const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await c.send('Input.dispatchMouseEvent',{type:'mouseWheel',deltaX:0,deltaY:-10000,...bodyPoint});await delay(200);
  const top=await c.evaluate(`__acceptRoot.querySelector('.codex-ai-elements-reasoning-content').scrollTop`);assert.equal(top,0);
  await c.evaluate(`(()=>{const b=__acceptRoot.querySelector('.codex-ai-elements-reasoning-content'),walker=document.createTreeWalker(b,NodeFilter.SHOW_TEXT);let n;while(n=walker.nextNode())if(n.textContent.trim().length>=12)break;const r=document.createRange();r.setStart(n,0);r.setEnd(n,12);getSelection().removeAllRanges();getSelection().addRange(r);window.__acceptSelected=getSelection().toString();})()`);
  await delay(1200);
  result.reading=await c.evaluate(`({top:__acceptRoot.querySelector('.codex-ai-elements-reasoning-content').scrollTop,open:__acceptRoot.open,paused:v.messagesBottomFollowPaused,selected:getSelection().toString(),expected:__acceptSelected,same:v.virtualListEl.querySelector('.codex-assistant-turn-reasoning-node')===__acceptRoot})`);
  assert.equal(result.reading.top,0);assert.equal(result.reading.selected,result.reading.expected);assert.ok(result.reading.paused);assert.ok(result.reading.same);
  await c.screenshot('acceptance-reading');
  while(await c.evaluate('v.running'))await delay(200);
  result.completion=await c.evaluate(`({open:__acceptRoot.open,same:v.virtualListEl.querySelector('.codex-assistant-turn-reasoning-node')===__acceptRoot,processHidden:__acceptRoot.closest('.codex-ai-elements-chain-of-thought').hidden,top:__acceptRoot.querySelector('.codex-ai-elements-reasoning-content').scrollTop,selected:getSelection().toString(),sessionId:p.settings.activeSessionId})`);
  assert.ok(result.completion.same,'the actual completed disclosure remains connected');
  assert.equal(result.completion.open,true);assert.equal(result.completion.processHidden,false);assert.equal(result.completion.top,0);
  if(process.argv.includes('--preserve-selection'))assert.equal(result.completion.selected,result.reading.expected,'completion preserves the reasoning selection');
  // Exercise the production copy action without replacing the user's OS clipboard.
  result.copy=await c.evaluate(`(async()=>{const original=navigator.clipboard.writeText;let copied='';try{navigator.clipboard.writeText=async text=>{copied=text;};const button=v.virtualListEl.querySelector('.codex-answer-copy');if(!button)throw Error('copy action missing');button.click();await new Promise(r=>setTimeout(r,100));return {matches:copied===v.ensureSession().messages.find(m=>m.itemType==='assistant').text,chars:copied.length};}finally{navigator.clipboard.writeText=original;}})()`);assert.ok(result.copy.matches);
  await c.write('acceptance.json',result);console.log(result);
}catch(error){await c.write('acceptance-failure.json',{...result,error:String(error),events:await c.evaluate('window.__acceptClicks??[]')});throw error;}finally{
  await c.evaluate(`if(window.__acceptInput)for(const name of ['pointerdown','pointerup','click'])document.removeEventListener(name,__acceptInput,true);`);
  await fetch('http://127.0.0.1:19464/speed/40');c.close();
}
