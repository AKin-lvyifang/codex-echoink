import {connect,delay,device,attach} from './mobile-common.mjs';
const c=await connect();
try{
 const environment=await attach(c);
 if(await c.evaluate('!!window.__scrollMeasure?.on||!!window.__smooth'))throw Error('Reload before bare CPU sampling');
 await c.evaluate(device==='iphone'?`p.openIPhoneRoute({kind:'home'})`:`p.ipadNavigation.openHome().then(()=>void 0)`);
 await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:100,y:190});await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:101,y:191});
 await delay(1200);
 const snapshot=`({cpu:process.cpuUsage(),t:performance.now(),focus:document.hasFocus(),visibility:document.visibilityState,animations:document.getAnimations().length,dolls:document.querySelectorAll('.wb-weather-stage').length,viewport:[innerWidth,innerHeight]})`;
 const before=await c.evaluate(snapshot);
 for(let n=0;n<60;n++)await delay(1000);
 const after=await c.evaluate(snapshot),seconds=(after.t-before.t)/1000;
 const cpuOneCorePct=((after.cpu.user-before.cpu.user)+(after.cpu.system-before.cpu.system))/1e6/seconds*100;
 const result={device,environment,seconds,cpuOneCorePct,before,after,scope:'whole renderer, no trace/probe/recording; visible home, iPad includes right chat; 1.2s after trusted activity; no idle-stage preload',realModelCalls:0};
 await c.write(device+'-idle.json',result);console.log({device,seconds,cpuOneCorePct});
}finally{c.close();}
