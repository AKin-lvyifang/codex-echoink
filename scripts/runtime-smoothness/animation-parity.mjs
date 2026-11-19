import {execFileSync} from 'node:child_process';
import {transform} from 'esbuild';
import assert from 'node:assert/strict';
import {connect} from './cdp.mjs';
const base=process.env.ECHOINK_PERF_BASE??'1abed51a';
const old=execFileSync('git',['show',base+':src/home/workbench-weather.ts'],{encoding:'utf8'});
const body=old.match(/private applyPose\(pose: DollPose\): void \{([\s\S]*?)\n  \}\n  private pull/)[1];
const mathSource=execFileSync('git',['show',base+':src/home/workbench-doll-motion.ts'],{encoding:'utf8'});
assert.equal(execFileSync('git',['diff',base,'--','src/home/workbench-doll-motion.ts'],{encoding:'utf8'}),'','trajectory math must be byte-identical');
const math=(await transform(mathSource,{loader:'ts',format:'cjs',target:'es2022'})).code;
const c=await connect();
try{
  const result=await c.evaluate(`(async()=>{
    const p=app.plugins.plugins['codex-echoink'];await p.activateHomeView({keepRightSidebar:true});
    const stage=app.workspace.getLeavesOfType('codex-echoink-home')[0].view.weatherStage;
    const math=(()=>{const module={exports:{}},exports=module.exports;${math};return module.exports;})();
    const original=new Function('dollStringEndpoint',${JSON.stringify('return function(pose){'+body+'}')})(math.dollStringEndpoint);
    const clone=stage.svg.cloneNode(true),oldContext={layer:name=>clone.querySelector('[data-layer="'+name+'"]')};
    const names=['face-happy','face-sad','face-curious','face-laugh','body','head','skirt','bow-ribbon-left','bow-ribbon-right','string-line'];
    const snapshot=root=>names.map(name=>{const node=root.querySelector('[data-layer="'+name+'"]');return [name,...['display','transform','d'].map(a=>node.getAttribute(a))];});
    const prototype=stage.svg.ownerDocument.defaultView.SVGElement.prototype,set=prototype.setAttribute;
    let phase='',oldWrites=0,newWrites=0;const states=[];
    prototype.setAttribute=function(...args){if(phase==='old')oldWrites++;if(phase==='new'&&stage.svg.contains(this))newWrites++;return set.apply(this,args);};
    stage.stop();
    try{
      for(const state of ['working','waiting','unfinished','done','idle']){
        let mismatches=0;const frames=[];
        for(let i=0;i<=240;i++){
          const pose=math.dollPose(state,i/10);phase='old';original.call(oldContext,pose);phase='new';stage.applyPose(pose);phase='';
          if(JSON.stringify(snapshot(clone))!==JSON.stringify(snapshot(stage.svg)))mismatches++;
          if(i%60===0)frames.push({seconds:i/10,attributes:snapshot(stage.svg)});
        }states.push({state,samples:241,mismatches,frames});
      }
      return {states,totalSamples:1205,oldWrites,newWrites};
    }finally{prototype.setAttribute=set;stage.restart();}
  })()`);
  await c.write('animation-parity.json',{base,...result});
  assert.ok(result.states.every(s=>s.mismatches===0),'every sampled SVG pose must match the original source');console.log({samples:result.totalSamples,mismatches:0,oldWrites:result.oldWrites,newWrites:result.newWrites});
}finally{c.close();}
