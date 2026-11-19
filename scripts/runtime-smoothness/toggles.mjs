import fs from 'node:fs/promises';
import path from 'node:path';
import {out} from './cdp.mjs';
import {installGeometry,compareGeometry} from './geometry.mjs';
import {connect,delay} from './cdp.mjs';
const c=await connect();
const running=process.argv.includes('--running'),name=process.env.ECHOINK_PERF_NAME??(running?'thinking-running':'thinking-completed');
const geometry=[];const film=[];const filmWrites=[];
const selector='.codex-assistant-turn-reasoning-node > summary';
const click=async(sel,label)=>{
  const before=await c.evaluate('__perfGeometry()');
  const point=await c.evaluate(`(()=>{const e=v.virtualListEl.querySelector(${JSON.stringify(sel)});if(!e)throw Error('target missing');const r=e.getBoundingClientRect();if(!r.width||!r.height)throw Error('hidden target');performance.mark(${JSON.stringify(label)});return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await c.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
  await delay(100);const after=await c.evaluate('__perfGeometry()');geometry.push({label,...compareGeometry(before,after)});
};
try{
  await c.evaluate(`window.p=app.plugins.plugins['codex-echoink'];window.v=p.getCodexView();__smooth.attach();`);
  if(running){
    await fetch('http://127.0.0.1:19464/speed/80');
    await c.evaluate(`(async()=>{if(p.settings.apiProviders.some(a=>a.baseUrl!=='http://127.0.0.1:19464/v1'))throw Error('local provider required');await v.openAgentTaskList('sol');v.inputEl.value='合成思考展开测量，只回答。';v.inputEl.dispatchEvent(new Event('input',{bubbles:true}));void v.sendMessage();})()`);
    let ready=false;
    for(let i=0;i<150;i++){
      ready=await c.evaluate(`(()=>{const d=v.virtualListEl.querySelector('${selector}');return v.running&&d?.getBoundingClientRect().width>0&&d.parentElement.querySelector('.codex-ai-elements-reasoning-content')?.textContent.length>400;})()`);
      if(ready)break;await delay(200);
    }if(!ready)throw Error('running thinking not ready');
  } else {
    await c.evaluate('v.messagesEl.scrollTop=0');
    await delay(200);
  }
  await c.evaluate(installGeometry);
  if(process.argv.includes('--film')){await fs.mkdir(path.join(out,name+'-frames'),{recursive:true});c.on('Page.screencastFrame',e=>{void c.send('Page.screencastFrameAck',{sessionId:e.sessionId});const file=String(film.length).padStart(5,'0')+'.jpg';film.push({file,timestamp:e.metadata.timestamp});filmWrites.push(fs.writeFile(path.join(out,name+'-frames',file),Buffer.from(e.data,'base64')));});await c.send('Page.startScreencast',{format:'jpeg',quality:85,maxWidth:1536,maxHeight:1200,everyNthFrame:1});}
  await c.traceStart(true);
  await c.evaluate(`__smooth.reset();void __smooth.watchFrames(5500);window.__smoothInput=(e)=>{const d=e.target.closest?.('summary,.codex-assistant-turn-process-toggle');if(d)__smooth.events.push({t:performance.now(),type:e.type,target:d.className,open:d.parentElement.open,trusted:e.isTrusted});};for(const name of ['pointerdown','pointerup','click','toggle'])document.addEventListener(name,__smoothInput,true);`);
  if(!running){await click('.codex-assistant-turn-process-toggle','completed-process-expand');await delay(500);}
  for(let i=0;i<3;i++){
    const open=await c.evaluate(`v.virtualListEl.querySelector('.codex-assistant-turn-reasoning-node').open`);
    await click(selector,`${running?'running':'completed'}-${open?'collapse':'expand'}-${i}`);
    await delay(i===2?600:350);
  }
  // Ensure a readable open state, then deliberately scroll back to the first line.
  for(let i=0;i<4;i++){if(await c.evaluate(`v.virtualListEl.querySelector('.codex-assistant-turn-reasoning-node').open`))break;await click(selector,'retry-expand-'+i);await delay(100);}
  await c.evaluate(`performance.mark('reader-scroll-to-top');v.virtualListEl.querySelector('.codex-ai-elements-reasoning-content').scrollTop=0`);
  await c.screenshot(name+'-reading-top');
  await delay(1600);
  await c.screenshot(name+'-reading-later');
  await delay(1400);
  const data=await c.evaluate(`({...__smooth.snapshot(),disclosureStates:[...v.messageListRenderer.reasoningDisclosureStates],open:v.virtualListEl.querySelector('.codex-assistant-turn-reasoning-node')?.open,bodyTextLength:v.virtualListEl.querySelector('.codex-ai-elements-reasoning-content')?.textContent.length})`);
  await c.write(name+'.json',{...data,geometry,filmTimeOrigin:await c.evaluate('performance.timeOrigin')});await c.traceEnd(name);if(process.argv.includes('--film')){await c.send('Page.stopScreencast');await Promise.all(filmWrites);await c.write(name+'-film.json',film);}
  await c.evaluate(`for(const name of ['pointerdown','pointerup','click','toggle'])document.removeEventListener(name,__smoothInput,true);`);
  console.log({name,frames:data.frames.length,events:data.events.filter(x=>['click','toggle'].includes(x.type)),open:data.open});
  if(running){while(await c.evaluate('v.running'))await delay(400);await fetch('http://127.0.0.1:19464/speed/40');}
}finally{c.close();}
