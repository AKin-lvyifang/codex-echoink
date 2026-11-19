import assert from 'node:assert/strict';
import {connect,delay} from './cdp.mjs';
import {ownedSettings} from './owned-settings.mjs';
const c=await connect(),results=[];let child,initialDark;
async function pressSnapshot(client,selector,name){
 const rect=await client.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();window.__reviewButton=e;return{x:r.x+r.width/2,y:r.y+r.height/2,top:e.offsetTop,height:e.offsetHeight};})()`);
 await client.screenshot(name+'-normal');
 await client.evaluate('window.__reviewBlock=e=>{if(e.isTrusted){e.preventDefault();e.stopImmediatePropagation()}};document.addEventListener("click",__reviewBlock,true)');
 try {
  await client.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,x:rect.x,y:rect.y});
  await client.evaluate('new Promise(requestAnimationFrame)');await client.screenshot(name+'-pressed');
  const pressed=await client.evaluate('({top:__reviewButton.offsetTop,height:__reviewButton.offsetHeight,filter:getComputedStyle(__reviewButton).filter,transform:getComputedStyle(__reviewButton).transform,marker:__reviewButton.dataset.echoinkPressed,boxShadow:getComputedStyle(__reviewButton).boxShadow})');
  assert.equal(pressed.top,rect.top);assert.equal(pressed.height,rect.height);results.push({name,rect,pressed});
 } finally {
  const outside=await client.evaluate('({x:2,y:innerHeight-2})');await client.send('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,...outside});await client.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...outside});
  await client.evaluate('document.removeEventListener("click",__reviewBlock,true)');
 }
}
try {
 await c.evaluate('(async()=>{app.setting.close();await p.activateHomeView({keepRightSidebar:true});await p.activateView();await v.openTaskDetail(p.settings.sessions.find(s=>s.id.startsWith("conversation-")).id)})()');
 initialDark=await c.evaluate('document.body.classList.contains("theme-dark")');
 for(let pass=0;pass<2;pass++){
  if(pass)await c.evaluate('app.commands.executeCommandById("theme:toggle-light-dark")');await delay(300);
  const theme=await c.evaluate('document.body.classList.contains("theme-dark")?"dark":"light"');
  await c.screenshot('review-chat-'+theme);await pressSnapshot(c,'.codex-composer-icon-button[aria-label="添加资源"]','review-composer-'+theme);
  await c.evaluate('(async()=>{app.setting.open();app.setting.openTabById("codex-echoink");await p.settingsTabInstance.activateSettingsTab("account",true)})()');child=await ownedSettings(c);await delay(150);
  await pressSnapshot(child,'.account-login-action','review-settings-'+theme);child.close();child=undefined;await c.evaluate('app.setting.close()');
 }
 await c.write('ui-review.json',results);console.log(results);
} finally {
 child?.close();await c.evaluate('app.setting.close()');if(initialDark!==undefined&&initialDark!==await c.evaluate('document.body.classList.contains("theme-dark")'))await c.evaluate('app.commands.executeCommandById("theme:toggle-light-dark")');c.close();
}
