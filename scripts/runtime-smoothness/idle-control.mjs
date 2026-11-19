import fs from 'node:fs/promises';
import path from 'node:path';
import {out} from './cdp.mjs';
import {connect,delay} from './cdp.mjs';
const c=await connect();
try{
  const closedOnly=process.argv.includes('--closed-only');const results=closedOnly?JSON.parse(await fs.readFile(path.join(out,'idle-control.json'),'utf8')):[];
  for(const visible of (closedOnly?[false]:process.argv.includes('--visible-only')?[true]:[true,false])){
    if(visible){
      await c.evaluate(`app.setting?.close();app.plugins.plugins['codex-echoink'].activateHomeView({keepRightSidebar:true})`);
      await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:100,y:150});
      await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:101,y:151});
    }
    else await c.evaluate(`(()=>{const leaves=[];app.workspace.iterateAllLeaves(l=>{if(l.view.getViewType().includes('echoink'))leaves.push(l);});for(const l of leaves)l.detach();})()`);
    await delay(1200);
    const before=await c.evaluate(`({cpu:process.cpuUsage(),t:performance.now(),stage:(()=>{const s=app.workspace.getLeavesOfType('codex-echoink-home')[0]?.view.weatherStage;return s?{active:s.active,idlePaused:s.idlePaused,agent:s.agent,weather:s.weather,controls:s.controls.size}:null})()})`);
    for(let i=0;i<60;i++)await delay(1000);
    const after=await c.evaluate(`({cpu:process.cpuUsage(),t:performance.now(),animations:document.getAnimations().length,stage:(()=>{const s=app.workspace.getLeavesOfType('codex-echoink-home')[0]?.view.weatherStage;return s?{active:s.active,idlePaused:s.idlePaused,agent:s.agent,weather:s.weather,controls:s.controls.size}:null})()})`);
    const cpuOneCorePct=((after.cpu.user-before.cpu.user)+(after.cpu.system-before.cpu.system))/1000/(after.t-before.t)*100;
    results.push({visible,seconds:(after.t-before.t)/1000,cpuOneCorePct,before,after});
    await c.write('idle-control.json',results);console.log({visible,cpuOneCorePct});
  }
}finally{c.close();}
