import {execFileSync} from 'node:child_process';
import {transform} from 'esbuild';
import {connect,delay} from './cdp.mjs';
const source=execFileSync('git',['show','16c0bd2e:src/home/workbench-weather.ts'],{encoding:'utf8'});
const body=source.match(/private applyPose\(pose: DollPose\): void \{([\s\S]*?)\n  \}\n  private pull/)[1];
const math=(await transform(execFileSync('git',['show','16c0bd2e:src/home/workbench-doll-motion.ts'],{encoding:'utf8'}),{loader:'ts',format:'cjs'})).code;
const c=await connect(),results=[];
try{
  await c.evaluate(`(()=>{window.__cssStage=app.workspace.getLeavesOfType('codex-echoink-home')[0].view.weatherStage;
    if(typeof __cssStage.rotateTag!=='function')throw Error('This experiment requires the archived CSS trial build, not the final product');
    const math=(()=>{const module={exports:{}},exports=module.exports;${math};return module.exports;})();
    window.__cssOriginal={body:__cssStage.applyPose,tag:__cssStage.rotateTag,idlePauseMs:__cssStage.idlePauseMs};
    window.__svgBody=new Function('dollStringEndpoint',${JSON.stringify('return function(pose){'+body+'}')})(math.dollStringEndpoint);
    __cssStage.idlePauseMs=3600000;__cssStage.noteActivity();__cssStage.scheduleIdlePause();})();`);
  for(const mode of ['css','svg','css']){
    await c.evaluate(`(()=>{const s=__cssStage;s.cssTransforms?.clear();
      if(${JSON.stringify(mode)}==='svg'){for(const name of ['body','tag'])s.layer(name).style.removeProperty('transform');s.applyPose=__svgBody;s.rotateTag=v=>s.layerAttribute('tag','transform','rotate('+v+' 181 8)');}
      else{s.applyPose=__cssOriginal.body;s.rotateTag=__cssOriginal.tag;}})()`);
    await delay(800);const before=await c.evaluate('({cpu:process.cpuUsage(),t:performance.now()})');
    for(let i=0;i<20;i++)await delay(1000);
    const after=await c.evaluate('({cpu:process.cpuUsage(),t:performance.now()})');
    const cpuOneCorePct=((after.cpu.user-before.cpu.user)+(after.cpu.system-before.cpu.system))/1000/(after.t-before.t)*100;
    results.push({mode,cpuOneCorePct,before,after});await c.write('css-cpu-control.json',results);console.log({mode,cpuOneCorePct});
  }
}finally{await c.evaluate(`if(window.__cssOriginal){__cssStage.applyPose=__cssOriginal.body;__cssStage.rotateTag=__cssOriginal.tag;__cssStage.idlePauseMs=__cssOriginal.idlePauseMs;__cssStage.cssTransforms?.clear();__cssStage.noteActivity();__cssStage.scheduleIdlePause();}`);c.close();}
