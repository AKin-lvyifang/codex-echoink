import assert from 'node:assert/strict';
import {connect,device,prefix,attach,route,delay} from './mobile-common.mjs';
const c=await connect(),results=[];
try{
 const environment=await attach(c);await route(c,{kind:'agent',agentId:'sol'});const oldTheme=await c.evaluate('app.vault.getConfig("theme")');
 c.oldTheme=oldTheme;
 await c.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]}).catch(e=>{if(!e.message.includes('Must send a TouchStart'))throw e;});await delay(250);
 if(process.argv.includes('--light'))await c.evaluate(`app.changeTheme('moonstone')`);
 await c.evaluate(`window.__pressClicks=0;window.__pressBlock=e=>{__pressClicks++;e.preventDefault();e.stopImmediatePropagation();};document.addEventListener('click',__pressBlock,true);`);
 for(const kind of ['release','drag-out','cancel','scroll-start']){
  const xy=await c.evaluate(`(()=>{const e=[...document.querySelectorAll('.${prefix}-composer-model')].find(e=>!e.closest('[hidden],[inert]')&&e.getBoundingClientRect().height);window.__pressTarget=e;const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!e.contains(document.elementFromPoint(x,y)))throw Error('Covered press target');window.__pressClicks=0;window.__pressFrame=null;document.addEventListener('pointerdown',()=>requestAnimationFrame(()=>{__pressFrame={marked:e.dataset.mobilePressed==='true',opacity:getComputedStyle(e).opacity};}),{once:true,capture:true});return {x,y,left:r.left};})()`);
  await c.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:xy.x,y:xy.y,id:1}]});
  await delay(process.argv.includes('--film')?200:35);const first=await c.evaluate('__pressFrame');assert.ok(first?.marked);assert.equal(first.opacity,'0.65');
  if(kind==='release')await c.screenshot(device+'-press-held'+(process.argv.includes('--light')?'-light':''));
  if(kind==='cancel')await c.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});
  else if(kind!=='release'){
    await c.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:kind==='drag-out'?xy.left-12:xy.x,y:xy.y-15,id:1}]});
    assert.equal(await c.evaluate('__pressTarget.hasAttribute("data-mobile-pressed")'),false);
    await c.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});
  }else await c.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await delay(50);const after=await c.evaluate('({marked:__pressTarget.hasAttribute("data-mobile-pressed"),clicks:__pressClicks})');assert.equal(after.marked,false);if(kind!=='release')assert.equal(after.clicks,0);
  results.push({kind,first,after});
 }
 await c.write(device+'-press-gestures.json',{environment,results});await c.screenshot(device+'-press-gestures');console.log({device,results});
}finally{await c.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]}).catch(e=>{if(!e.message.includes('Must send a TouchStart'))throw e;});await c.evaluate('document.removeEventListener("click",window.__pressBlock,true)');if(process.argv.includes('--light')){await c.evaluate(`app.changeTheme(${JSON.stringify(c.oldTheme??'obsidian')})`);await delay(1000);}c.close();}
