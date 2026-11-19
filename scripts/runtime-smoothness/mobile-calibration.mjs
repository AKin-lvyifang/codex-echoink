import {connect,delay,device,prefix,attach,route} from './mobile-common.mjs';
const c=await connect();
try{
 const environment=await attach(c);await route(c,{kind:'agent',agentId:'sol'});
 const xy=await c.evaluate(`(()=>{window.__cal=[...document.querySelectorAll('.${prefix}-composer-model')].find(e=>!e.closest('[hidden]'));const e=__cal;e.scrollIntoView({block:'nearest'});window.__calEvents=[];window.__calHandler=event=>{queueMicrotask(()=>{__calEvents.push({type:event.type,defaultPrevented:event.defaultPrevented,pointerType:event.pointerType,active:e.matches(':active'),className:e.className});});};for(const name of ['pointerdown','touchstart'])document.addEventListener(name,__calHandler,true);window.__calBlock=event=>{event.preventDefault();event.stopImmediatePropagation();};document.addEventListener('click',__calBlock,true);const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
 const snapshot=`({active:__cal.matches(':active'),opacity:getComputedStyle(__cal).opacity,background:getComputedStyle(__cal).backgroundColor,className:__cal.className})`;
 const before=await c.evaluate(snapshot);await c.screenshot(device+'-press-before');
 await c.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...xy,id:1}]});
 const firstFrame=await c.evaluate(`new Promise(r=>requestAnimationFrame(()=>r(${snapshot})))`);
 await delay(120);const held=await c.evaluate(snapshot);await c.screenshot(device+'-press-held');
 await c.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 await c.send('DOM.enable');await c.send('CSS.enable');await c.send('DOM.getDocument');
 const object=await c.send('Runtime.evaluate',{expression:'__cal'});const {nodeId}=await c.send('DOM.requestNode',{objectId:object.result.objectId});
 await c.send('CSS.forcePseudoState',{nodeId,forcedPseudoClasses:['active']});
 const forcedActive=await c.evaluate(snapshot);
 await c.send('CSS.forcePseudoState',{nodeId,forcedPseudoClasses:[]});
 const events=await c.evaluate('__calEvents');
 await c.write(device+'-press-calibration.json',{environment,before,firstFrame,held,forcedActive,events,interpretation:'Forced :active checks CSS coverage only; it is not a real press. Actual emulated-host touch is reported separately.'});
 console.log({device,before,firstFrame,held,forcedActive,events});
}finally{await c.evaluate(`document.removeEventListener('click',window.__calBlock,true);for(const name of ['pointerdown','touchstart'])document.removeEventListener(name,window.__calHandler,true)`);c.close();}
