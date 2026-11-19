import assert from 'node:assert/strict';
import {connect,delay} from './cdp.mjs';
const c=await connect(),scene=process.argv[2]??'sessions',samples=[];
try {
  await c.evaluate('(async()=>{app.setting.close();window.p=app.plugins.plugins["codex-echoink"];await p.activateHomeView({keepRightSidebar:true});await p.activateView();window.v=p.getCodexView()})()');
  const timed=async(label,body)=>{
    const result=await c.evaluate(`(async()=>{const t=performance.now();${body};await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return {label:${JSON.stringify(label)},ms:performance.now()-t,animations:document.getAnimations().filter(a=>a.effect?.target===v.taskDetailEl).length,session:p.settings.activeSessionId};})()`);
    samples.push(result);await delay(420);
  };
  if(scene==='sessions') {
    const ids=await c.evaluate('p.settings.sessions.filter(s=>s.id.startsWith("conversation-")).slice(-3).map(s=>s.id)');assert.ok(ids.length>=2);
    for(const id of [...ids,...ids.slice().reverse()])await timed('session',`await v.openTaskDetail(${JSON.stringify(id)})`);
    samples.push(await c.evaluate(`(async()=>{const ids=${JSON.stringify(ids)};const first=v.openTaskDetail(ids[0]);while(!v.taskDetailLoaded||p.settings.activeSessionId!==ids[0])await new Promise(requestAnimationFrame);await new Promise(r=>setTimeout(r,60));const previous=v.taskDetailEl.getAnimations()[0];const previousTime=previous?.currentTime;const second=v.openTaskDetail(ids[1]);while(!v.taskDetailLoaded||p.settings.activeSessionId!==ids[1])await new Promise(requestAnimationFrame);const state={label:'interrupt-entry',previousTime,previousState:previous?.playState,animations:v.taskDetailEl.getAnimations().length};await Promise.all([first,second]);return state;})()`));
    if(!process.argv.includes("--baseline")){assert.ok(samples.at(-1).animations<=1);assert.equal(samples.at(-1).previousState,"idle","the earlier entry is cancelled by the next navigation");}await delay(300);
  } else if(scene==='tabs') {
    for(let i=0;i<3;i++) {await timed('journal','await p.activateJournalView()');await timed('workbench','await p.activateHomeView({keepRightSidebar:true})');}
  } else if(scene==='disclosures') {
    await c.evaluate(`(async()=>{await p.activateView();await v.openTaskDetail(p.settings.sessions.find(s=>s.id.startsWith("conversation-")).id);const toggle=v.virtualListEl.querySelector('.codex-assistant-turn-process-toggle');if(toggle?.getAttribute('aria-expanded')==='false')toggle.click();})()`);
    const find=()=>c.evaluate(`(()=>{const e=v.virtualListEl.querySelector('.codex-assistant-turn-reasoning-node summary');e?.scrollIntoView({block:'center'});const r=e?.getBoundingClientRect();return r?.width?{x:r.x+r.width/2,y:r.y+r.height/2}:null})()`);
    for(let i=0;i<6;i++){const xy=await find();assert.ok(xy);await c.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...xy});await delay(50);await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...xy});await delay(350);samples.push(await c.evaluate(`({label:'reasoning',open:v.virtualListEl.querySelector('.codex-assistant-turn-reasoning-node').open})`));}
    assert.ok(samples.every((s,i)=>i===0||s.open!==samples[i-1].open));
  } else throw Error('Unknown scene');
  await c.screenshot('transition-'+scene);await c.write('transition-'+scene+'.json',samples);console.log(samples);
} finally {c.close()}
