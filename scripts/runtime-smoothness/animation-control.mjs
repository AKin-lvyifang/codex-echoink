import {connect,delay} from './cdp.mjs';
const c=await connect();
try{
  await c.evaluate(`(async()=>{window.p=app.plugins.plugins['codex-echoink'];await p.activateHomeView({keepRightSidebar:true});window.__perfWeather=app.workspace.getLeavesOfType('codex-echoink-home')[0].view.weatherStage;})()`);await delay(1000);
  const inventory=await c.evaluate(`({agent:__perfWeather.agent,weather:__perfWeather.weather,controls:__perfWeather.controls.size,waapi:document.getAnimations().length,controlKeys:[...__perfWeather.controls].map(c=>({keys:Object.keys(c),repeat:c.options?.repeat===Infinity?'Infinity':c.options?.repeat}))})`);
  const results=[];
  for(const stopped of [false,true]){
    if(stopped)await c.evaluate('__perfWeather.stop()');
    await delay(500);const before=await c.evaluate('({cpu:process.cpuUsage(),t:performance.now()})');
    for(let i=0;i<20;i++)await delay(1000);
    const after=await c.evaluate('({cpu:process.cpuUsage(),t:performance.now(),controls:__perfWeather.controls.size})');
    results.push({stopped,seconds:(after.t-before.t)/1000,cpuOneCorePct:((after.cpu.user-before.cpu.user)+(after.cpu.system-before.cpu.system))/1000/(after.t-before.t)*100,before,after});
  }
  await c.write('animation-control.json',{inventory,results});console.log({inventory,results:results.map(x=>({stopped:x.stopped,cpu:x.cpuOneCorePct}))});
}finally{await c.evaluate('window.__perfWeather?.restart()');c.close();}
