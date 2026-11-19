import assert from 'node:assert/strict';
import {connect,delay} from './cdp.mjs';
const c=await connect(),result=[];
try {
 await c.evaluate('(async()=>{await p.activateView();v.closeComposerMenus();await v.openTaskDetail(p.settings.sessions.find(s=>s.id.startsWith("conversation-")).id)})()');
 const click=async selector=>{const xy=await c.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e?.getBoundingClientRect();if(!r?.width)throw Error('hidden menu target');return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);for(const type of ['mousePressed','mouseReleased'])await c.send('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...xy});await delay(120);};
 await click('.codex-model-summary-button');
 for(const sub of [false,true]) {
  if(sub)await click('.codex-composer-parameter-menu button:not(:disabled)');
  const selector=sub?'.codex-composer-parameter-submenu':'.codex-composer-parameter-menu';
  // Never select a model or change parameters: block activation after measuring press.
  await c.evaluate(`window.__menuBlock=e=>{e.preventDefault();e.stopImmediatePropagation()};document.addEventListener('click',__menuBlock,true);window.__menuTargets=[...document.querySelectorAll(${JSON.stringify(selector+' button:not(:disabled)')})];`);
  const count=await c.evaluate('__menuTargets.length');
  for(let i=0;i<count;i++){
   const xy=await c.evaluate(`(()=>{const e=__menuTargets[${i}];e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();window.__menuBefore=getComputedStyle(e).filter;return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
   await c.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...xy});
   const row=await c.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>{const e=__menuTargets[${i}];resolve({scene:${JSON.stringify(sub?'parameter-submenu':'parameter-menu')},label:e.textContent,changed:getComputedStyle(e).filter!==__menuBefore,marker:e.dataset.echoinkPressed})}))`);
   await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...xy});result.push(row);
  }
  await c.evaluate('document.removeEventListener("click",__menuBlock,true)');await c.screenshot(sub?'parameter-submenu':'parameter-menu');
 }
 await c.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});await c.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape'});await delay(100);
 await c.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});await c.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape'});await delay(100);
 const closed=await c.evaluate('!document.querySelector(".codex-composer-parameter-menu")');assert.ok(closed);assert.ok(result.length);assert.ok(result.every(r=>r.changed));await c.write('menus-audit.json',{result,escapeCloses:closed});console.log(result);
} finally {await c.evaluate('if(window.__menuBlock)document.removeEventListener("click",__menuBlock,true)');c.close()}
