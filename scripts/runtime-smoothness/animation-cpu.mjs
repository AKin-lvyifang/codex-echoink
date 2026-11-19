import {execFileSync} from 'node:child_process';
import {transform} from 'esbuild';
import {connect,delay} from './cdp.mjs';

// Supplemental attribution only: restore the old SVG and dataset writers,
// while retaining the current build and all other workbench behavior.
const base=process.env.ECHOINK_PERF_BASE??'1abed51a';
const old=execFileSync('git',['show',base+':src/home/workbench-weather.ts'],{encoding:'utf8'});
const body=old.match(/private applyPose\(pose: DollPose\): void \{([\s\S]*?)\n  \}\n  private pull/)[1];
const math=(await transform(execFileSync('git',['show',base+':src/home/workbench-doll-motion.ts'],{encoding:'utf8'}),{loader:'ts',format:'cjs',target:'es2022'})).code;
const c=await connect(),results=[];
try{
  const inventory=await c.evaluate(`(async()=>{
    await app.plugins.plugins['codex-echoink'].activateHomeView({keepRightSidebar:true});
    const stage=app.workspace.getLeavesOfType('codex-echoink-home')[0].view.weatherStage;
    const math=(()=>{const module={exports:{}},exports=module.exports;${math};return module.exports;})();
    const old=new Function('dollStringEndpoint',${JSON.stringify('return function(pose){'+body+'}')})(math.dollStringEndpoint);
    window.__pairStage=stage;window.__pairCurrent=stage.applyPose;
    const oldContext={layer:name=>stage.svg.querySelector('[data-layer="'+name+'"]')};
    if(stage.agent!=='unfinished'||stage.weather!=='still')throw Error('Match the original unfinished/still idle baseline first');
    window.__pairOld=pose=>{old.call(oldContext,pose);stage.svg.dataset.workAction=stage.agent;};
    return {agent:stage.agent,weather:stage.weather,controls:stage.controls.size,viewport:[innerWidth,innerHeight],base:${JSON.stringify(base)}};
  })()`);
  for(const writer of ['current','old-svg-and-state-writer','current']){
    await c.evaluate(`__pairStage.applyPose=${writer==='current'?'__pairCurrent':'__pairOld'}`);
    await delay(800);
    const before=await c.evaluate('({cpu:process.cpuUsage(),t:performance.now()})');
    for(let i=0;i<20;i++)await delay(1000);
    const after=await c.evaluate('({cpu:process.cpuUsage(),t:performance.now()})');
    const cpuOneCorePct=((after.cpu.user-before.cpu.user)+(after.cpu.system-before.cpu.system))/1000/(after.t-before.t)*100;
    results.push({writer,seconds:(after.t-before.t)/1000,cpuOneCorePct,before,after});
    await c.write('animation-cpu.json',{inventory,results});console.log({writer,cpuOneCorePct});
  }
}finally{await c.evaluate('if(window.__pairStage&&window.__pairCurrent)__pairStage.applyPose=__pairCurrent');c.close();}
