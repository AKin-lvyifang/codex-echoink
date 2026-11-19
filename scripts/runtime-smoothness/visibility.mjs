import assert from 'node:assert/strict';
import {connect,delay} from './cdp.mjs';
const c=await connect(),result={};
try{
  await c.evaluate(`(async()=>{window.p=app.plugins.plugins['codex-echoink'];await p.activateHomeView({keepRightSidebar:true});window.__visibilityStage=app.workspace.getLeavesOfType('codex-echoink-home')[0].view.weatherStage;})()`);
  await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:130,y:160});await delay(300);
  await c.evaluate(`window.__visibilityControls=[...__visibilityStage.controls];window.__visibilityMutations=0;window.__visibilityObserver=new MutationObserver(records=>__visibilityMutations+=records.length);__visibilityObserver.observe(__visibilityStage.svg,{attributes:true,subtree:true});`);
  const read=()=>c.evaluate(`(()=>{const value={active:__visibilityStage.active,paused:__visibilityStage.motionPaused,visibility:document.visibilityState,times:__visibilityControls.map(c=>c.time),same:__visibilityControls.every(c=>__visibilityStage.controls.has(c)),mutations:__visibilityMutations+__visibilityObserver.takeRecords().length};__visibilityMutations=0;return value;})()`);
  result.before=await read();
  assert.ok(result.before.times.length,'capture an active timeline before testing its suspension');
  await c.evaluate('p.activateJournalView()');await delay(250);result.tabStart=await read();await delay(800);result.tabHidden=await read();
  assert.equal(result.tabHidden.active,false);assert.equal(result.tabHidden.mutations,0);assert.deepEqual(result.tabHidden.times,result.tabStart.times);assert.ok(result.tabHidden.same);
  await c.evaluate('p.activateHomeView({keepRightSidebar:true})');await delay(250);result.tabResumed=await read();assert.ok(result.tabResumed.active);assert.ok(result.tabResumed.same);
  await c.evaluate(`window.__visibilityWindow=require('@electron/remote').getCurrentWindow();void 0`);
  await c.send('Emulation.setFocusEmulationEnabled',{enabled:false});await c.evaluate('__visibilityWindow.hide()');await delay(250);result.windowStart=await read();await delay(800);result.windowHidden=await read();
  assert.equal(result.windowHidden.visibility,'hidden');assert.equal(result.windowHidden.mutations,0);assert.deepEqual(result.windowHidden.times,result.windowStart.times);assert.ok(result.windowHidden.same);
  await c.evaluate('__visibilityWindow.show()');await c.send('Emulation.setFocusEmulationEnabled',{enabled:true});await c.evaluate('p.activateHomeView({keepRightSidebar:true})');await delay(250);result.windowResumed=await read();assert.ok(result.windowResumed.same);
  assert.ok(result.windowResumed.times[0]>result.windowHidden.times[0],'the retained body timeline continues');
  assert.ok(result.windowResumed.times[0]-result.windowHidden.times[0]<.8,'hidden time is excluded, without resetting to zero');
  await c.write('visibility.json',result);console.log(result);
}catch(error){await c.write('visibility-failure.json',{...result,error:String(error)});throw error;}finally{
  await c.evaluate(`window.__visibilityWindow?.show();window.__visibilityObserver?.disconnect()`);await c.send('Emulation.setFocusEmulationEnabled',{enabled:true});c.close();
}
