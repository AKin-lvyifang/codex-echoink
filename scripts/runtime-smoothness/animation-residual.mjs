import {connect,delay} from './cdp.mjs';

// Diagnostic trace only; SVG instrumentation overhead excludes this from CPU baselines.
const c=await connect();
try{
  await c.evaluate(`window.__idleStage=app.workspace.getLeavesOfType('codex-echoink-home')[0].view.weatherStage;
    window.__idleWrites={};window.__idleSet=SVGElement.prototype.setAttribute;
    SVGElement.prototype.setAttribute=function(name,value){
      if(__idleStage.svg.contains(this)){const key=this.getAttribute('data-layer')+':'+name;__idleWrites[key]=(__idleWrites[key]??0)+1;}
      return __idleSet.call(this,name,value);
    };window.__idleStarted=performance.now();`);
  await c.traceStart();await delay(10000);
  const result=await c.evaluate(`(()=>{SVGElement.prototype.setAttribute=__idleSet;return {seconds:(performance.now()-__idleStarted)/1000,agent:__idleStage.agent,weather:__idleStage.weather,controls:__idleStage.controls.size,writes:__idleWrites};})()`);
  await c.traceEnd('idle-residual');await c.write('idle-residual.json',result);console.log(result);
}finally{await c.evaluate('if(window.__idleSet)SVGElement.prototype.setAttribute=__idleSet');c.close();}
