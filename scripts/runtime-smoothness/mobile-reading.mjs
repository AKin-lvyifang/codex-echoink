import {connect,delay,device,prefix,attach,route,fake,frames,tap} from './mobile-common.mjs';
import {summarizeMobileScroll} from './mobile-scroll-summary.mjs';
const c=await connect(),outerOnly=process.argv.includes('--outer-only'),result={device,diagnostic:true,outerOnly,realModelCalls:0};
async function until(expression){for(let n=0;n<300;n++){if(await c.evaluate(expression))return;await delay(80);}throw Error('Reading scenario timeout: '+expression);}
async function gesture(selector){
 const xy=await c.evaluate(`(()=>{const e=[...document.querySelectorAll('${selector}')].find(e=>!e.closest('[hidden]'));const r=(e.classList.contains('${prefix}-task-detail')?e.closest('.eis-scroll,.echoink-ipad-content'):e).getBoundingClientRect();const top=Math.max(r.top,1),bottom=Math.min(r.bottom,innerHeight-195);if(bottom<=top)throw Error('Gesture target outside viewport');return {x:Math.min(innerWidth-1,Math.max(1,r.x+r.width/2)),y:top+Math.min((bottom-top)/3,80)};})()`);
 await c.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...xy,id:1}]});
 if(selector.includes('task-detail')){await c.evaluate(`__scrollMeasure.stage='outer-held'`);await delay(200);await c.evaluate(`__scrollMeasure.stage='outer-gesture'`);}
 for(let n=1;n<=8;n++){await c.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:xy.x,y:xy.y+n*190/8,id:1}]});await delay(22);}
 await c.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
}
try{
 result.environment=await attach(c);await fetch(fake+'/speed/55');
 await c.evaluate(`(()=>{const d=Object.getOwnPropertyDescriptor(Element.prototype,'scrollTop'),ids=new WeakMap();let seq=0;const m=window.__scrollMeasure={frame:0,writes:[],touches:[],stage:'initial',on:true};
 const loop=()=>{if(m.on){m.frame++;requestAnimationFrame(loop);}};requestAnimationFrame(loop);
 Object.defineProperty(Element.prototype,'scrollTop',{...d,set(value){const before=d.get.call(this);d.set.call(this,value);const after=d.get.call(this);if(this.closest?.('.echoink-iphone,.echoink-ipad')){if(!ids.has(this))ids.set(this,++seq);m.writes.push({frame:m.frame,t:performance.now(),id:ids.get(this),cls:String(this.className),before,after,requested:value,stage:m.stage});}}});m.restore=()=>{m.on=false;Object.defineProperty(Element.prototype,'scrollTop',d);};
 m.touch=e=>{m.touches.push({type:e.type,t:performance.now(),stage:m.stage,paused:p.runtime.composerScrollTarget?.(window.__readingId)?.paused??null});};for(const name of ['touchstart','touchmove','touchend','touchcancel'])document.addEventListener(name,m.touch,{passive:true});})();`);
 await route(c,{kind:'agent',agentId:'sol'});
 await c.evaluate(`(async()=>{window.__readingOther=p.store.state.sessions.find(s=>s.messages.length>=2).id;const input=[...document.querySelectorAll('.${prefix}-composer-input')].find(e=>!e.closest('[hidden]'));input.value='固定回放：请给出长回答，包含列表、代码和表格。只回答，不调用工具。';input.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(r=>setTimeout(r,250));})()`);
 await tap(c,`.${prefix}-composer-send:not([hidden])`);
 await until(`ui.shell.activePageId?.startsWith('task:')&&p.runtime.isBusy(ui.shell.activePageId.slice(5))`);
 await c.evaluate(`window.__readingId=ui.shell.activePageId.slice(5)`);
 const id=await c.evaluate('__readingId');await route(c,{kind:'task',taskId:id});
 if(!outerOnly){
 await until(`(p.runtime.stateFor(__readingId).live?.reasoning?.length??0)>700`);
 await c.evaluate(`__scrollMeasure.stage='reasoning-gesture'`);
 result.reasoningBefore=await c.evaluate(`(()=>{const e=[...document.querySelectorAll('.${prefix}-task-reasoning-body')].find(e=>!e.closest('[hidden]'));window.__oldReasoning=e;return {top:e.scrollTop,max:e.scrollHeight-e.clientHeight};})()`);
 await gesture(`.${prefix}-task-reasoning-body`);
 result.reasoningAfterGesture=await c.evaluate(`(()=>{const e=[...document.querySelectorAll('.${prefix}-task-reasoning-body')].find(e=>!e.closest('[hidden]'));return {top:e.scrollTop,max:e.scrollHeight-e.clientHeight,same:e===__oldReasoning};})()`);
 await c.evaluate(`__scrollMeasure.stage='reasoning-after'`);await delay(700);
 result.reasoningAfter700=await c.evaluate(`(()=>{const e=[...document.querySelectorAll('.${prefix}-task-reasoning-body')].find(e=>!e.closest('[hidden]'));return {top:e.scrollTop,max:e.scrollHeight-e.clientHeight,same:e===__oldReasoning};})()`);
 }
 await until(`(p.runtime.stateFor(__readingId).live?.text?.length??0)>650`);
 await c.evaluate(`__scrollMeasure.stage='outer-gesture';window.__outer=[...document.querySelectorAll('.${prefix}-task-detail')].find(e=>!e.closest('[hidden]')).closest('.eis-scroll,.echoink-ipad-content');void 0`);
 result.outerBefore=await c.evaluate(`({top:__outer.scrollTop,paused:p.runtime.composerScrollTarget(__readingId)?.paused})`);
 await gesture(`.${prefix}-task-detail`);
 result.outerAfterGesture=await c.evaluate(`({top:__outer.scrollTop,paused:p.runtime.composerScrollTarget(__readingId)?.paused})`);
 await c.evaluate(`__scrollMeasure.stage='inertia-window'`);await delay(900);
 result.outerAfter900=await c.evaluate(`({top:__outer.scrollTop,paused:p.runtime.composerScrollTarget(__readingId)?.paused})`);
 await c.evaluate(`__scrollMeasure.stage='task-return'`);
 await route(c,{kind:'task',taskId:await c.evaluate('__readingOther')});
 result.returnWhileRunning=await c.evaluate(`(async()=>{const t=performance.now();let done=null;p.${device==='iphone'?'openIPhoneRoute':'openIPadAgent'}({kind:'task',taskId:__readingId}).then(()=>done=performance.now()-t);while(ui.shell.activePageId!=='task:'+__readingId)await new Promise(requestAnimationFrame);await (${frames})();return {effectiveMs:performance.now()-t,promiseEndedMs:done,busy:p.runtime.stateFor(__readingId).busy};})()`);
 await until('!p.runtime.isBusy(__readingId)');
 result.diagnostic=await c.evaluate(`(()=>{const m=__scrollMeasure;return {writes:m.writes,touches:m.touches};})()`);
 result.summary=summarizeMobileScroll(result.diagnostic);
 result.hostCommandPalette=await c.evaluate(`!!document.querySelector('.prompt input[placeholder="选择命令..."]')`);
 const name=device+(outerOnly?'-follow':'-reading');await c.write(name+'.json',result);await c.screenshot(name);console.log({device,...result.summary,outerBefore:result.outerBefore,reasoning:result.reasoningAfter700,return:result.returnWhileRunning});
}finally{await fetch(fake+'/speed/40');await c.evaluate(`if(window.__scrollMeasure){const m=__scrollMeasure;for(const name of ['touchstart','touchmove','touchend','touchcancel'])document.removeEventListener(name,m.touch);m.restore();}`);if(await c.evaluate(`!!document.querySelector('.prompt input[placeholder="选择命令..."]')`)){await c.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});await c.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape'});}c.close();}
