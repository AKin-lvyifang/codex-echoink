import {connect,delay,device,prefix,attach,route,size} from './mobile-common.mjs';
import {visualKeyboardProxy} from './mobile-keyboard-proxy.mjs';
let proxy;
const c=await connect(),result={device,realModelCalls:0,method:process.argv.includes('--layout')?'layout shrink/restore diagnostic; changes host device classification':'visualViewport height proxy only; fixed layout/device identity; no IME or nonzero safe area',samples:[],events:[]};
try{
 result.environment=await attach(c);await route(c,{kind:'task',taskId:'mobile-perf-0'});await delay(300);
 await c.evaluate(`(()=>{const m=window.__keyboardProbe={on:true,samples:[],events:[]};m.event=e=>m.events.push({type:e.type,t:performance.now(),inner:innerHeight,visual:visualViewport.height});for(const target of [window,visualViewport])for(const type of ['resize','scroll'])target.addEventListener(type,m.event);
 const tick=()=>{if(!m.on)return;const e=[...mv.contentEl.querySelectorAll('.${prefix}-composer-input')].find(e=>!e.closest('[hidden]'));if(e){const r=e.getBoundingClientRect();let parent=e;const roots=[];while(parent&&mv.contentEl.contains(parent)){if(parent.matches('.echoink-ipad,.echoink-iphone')){const b=parent.getBoundingClientRect(),s=getComputedStyle(parent);roots.push({cls:parent.className,top:b.top,bottom:b.bottom,padding:s.paddingBottom,inset:s.getPropertyValue('--em-bottom-compensation'),occlusion:s.getPropertyValue('--em-viewport-occlusion'),spacing:s.getPropertyValue('--view-bottom-spacing')});}parent=parent.parentElement;}
 const host=[];let a=mv.contentEl;while(a&&a!==document.body){const b=a.getBoundingClientRect(),s=getComputedStyle(a);host.push({cls:a.className,style:a.getAttribute('style'),top:b.top,bottom:b.bottom,height:b.height,position:s.position,cssTop:s.top,cssBottom:s.bottom,paddingTop:s.paddingTop,paddingBottom:s.paddingBottom});a=a.parentElement;}m.samples.push({t:performance.now(),y:r.y,height:r.height,inner:innerHeight,visual:visualViewport.height,body:document.body.className,host,roots});}requestAnimationFrame(tick);};requestAnimationFrame(tick);})()`);
 await delay(120);
 if(process.argv.includes('--layout')){for(const height of [size.height-300,size.height]){await c.send('Emulation.setDeviceMetricsOverride',{...size,height,deviceScaleFactor:2,mobile:true});await delay(550);}}
 else {proxy=await visualKeyboardProxy(c);for(const height of [size.height-300,size.height]){await proxy.resize(height);await delay(550);}}
 const data=await c.evaluate(`({samples:__keyboardProbe.samples,events:__keyboardProbe.events})`);Object.assign(result,data);
 result.transitions=result.samples.filter((s,i)=>i&&Math.abs(s.y-result.samples[i-1].y)>.5).map(s=>({...s,from:result.samples[result.samples.indexOf(s)-1].y}));
 await c.write(device+'-keyboard.json',result);await c.screenshot(device+'-keyboard');console.log({device,transitions:result.transitions.map(t=>({inner:t.inner,from:t.from,to:t.y,roots:t.roots}))});
}finally{await proxy?.restore();await c.evaluate(`if(window.__keyboardProbe){const m=__keyboardProbe;m.on=false;for(const target of [window,visualViewport])for(const type of ['resize','scroll'])target.removeEventListener(type,m.event);}`);c.close();}
