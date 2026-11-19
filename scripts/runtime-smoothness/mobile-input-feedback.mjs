import {connect,device,prefix,attach,route,frames,delay} from './mobile-common.mjs';
const c=await connect(),result={device};
try {
 result.environment=await attach(c);await route(c,{kind:'agent',agentId:'sol'});
 const xy=await c.evaluate(`(()=>{const e=[...mv.contentEl.querySelectorAll('.${prefix}-composer-input')].find(e=>!e.closest('[hidden]'));e.scrollIntoView({block:'nearest'});window.__inputFeedback=e;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);await delay(50);
 await c.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...xy,id:1}]});
 result.pressed=await c.evaluate(`(async()=>{await (${frames})();return {opacity:getComputedStyle(__inputFeedback).opacity,marked:__inputFeedback.dataset.mobilePressed??null,tapHighlight:getComputedStyle(__inputFeedback).webkitTapHighlightColor};})()`);
 await c.screenshot(device+'-input-pressed');await c.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 result.released=await c.evaluate(`(async()=>{await (${frames})();return {opacity:getComputedStyle(__inputFeedback).opacity,focused:document.activeElement===__inputFeedback,marked:__inputFeedback.dataset.mobilePressed??null};})()`);
 await c.write(device+'-input-feedback.json',result);console.log(result);
}finally{await c.evaluate(`window.__inputFeedback?.blur();delete window.__inputFeedback`);c.close();}
