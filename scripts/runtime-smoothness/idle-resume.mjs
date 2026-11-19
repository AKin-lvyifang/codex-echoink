import assert from 'node:assert/strict';
import {connect,delay} from './cdp.mjs';

const c=await connect(),result={};
try{
  await c.evaluate(`(async()=>{await p.activateHomeView({keepRightSidebar:true});window.__idleStage=app.workspace.getLeavesOfType('codex-echoink-home')[0].view.weatherStage;__idleStage.noteActivity();window.__idleControls=[...__idleStage.controls];window.__idleWrites=0;window.__idleObserver=new MutationObserver(r=>__idleWrites+=r.length);__idleObserver.observe(__idleStage.svg,{attributes:true,subtree:true});})()`);
  const read=()=>c.evaluate(`(()=>{const value={active:__idleStage.active,idlePaused:__idleStage.idlePaused,paused:__idleStage.motionPaused,times:__idleControls.map(c=>c.time),same:__idleControls.every(c=>__idleStage.controls.has(c)),mutations:__idleWrites+__idleObserver.takeRecords().length};__idleWrites=0;return value;})()`);
  result.start=await read();assert.ok(result.start.times.length);
  await delay(10_500);result.idle=await read();assert.ok(result.idle.idlePaused);assert.ok(result.idle.same);
  await delay(1000);result.still=await read();assert.equal(result.still.mutations,0);assert.deepEqual(result.still.times,result.idle.times);
  await c.screenshot('idle-paused');
  await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:300,y:200});await delay(400);
  result.resumed=await read();assert.equal(result.resumed.idlePaused,false);assert.ok(result.resumed.same);assert.ok(result.resumed.mutations>0);
  assert.ok(result.resumed.times[0]>result.still.times[0]);assert.ok(result.resumed.times[0]-result.still.times[0]<.8);
  await c.screenshot('idle-resumed');
  await c.write('idle-resume.json',result);console.log(result);
}finally{await c.evaluate('window.__idleObserver?.disconnect()');c.close();}
