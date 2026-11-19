import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {connect} from './cdp.mjs';

// Diagnostic run only: the rAF clock and setter hooks add overhead, so these
// samples are not a CPU or latency baseline.
const c=await connect();
try{
  await c.evaluate(`(()=>{const d=Object.getOwnPropertyDescriptor(Element.prototype,'scrollTop');window.__scrollProbeDescriptor=d;window.__scrollProbe={frame:0,writes:[],ids:new WeakMap(),next:0,stopped:false,renders:0};
    const tick=()=>{__scrollProbe.frame++;__scrollProbe.renders=__smooth.calls['list.render']?.count??0;if(!__scrollProbe.stopped)__scrollProbe.raf=requestAnimationFrame(tick);};tick();
    Object.defineProperty(Element.prototype,'scrollTop',{...d,set(value){const relevant=this===v.messagesEl||this.classList.contains('codex-ai-elements-reasoning-content');const before=relevant?d.get.call(this):0;d.set.call(this,value);if(!relevant)return;
      const id=this===v.messagesEl?'messages':(__scrollProbe.ids.get(this)??(()=>{const id='reasoning-'+(++__scrollProbe.next);__scrollProbe.ids.set(this,id);return id;})());
      const answer=p.settings.sessions.find(s=>s.id===p.settings.activeSessionId)?.messages.filter(m=>m.itemType==='assistant').at(-1)?.text.length??0,reasoning=v.virtualListEl.querySelector('.codex-ai-elements-reasoning-content')?.textContent.length??0;
      __scrollProbe.writes.push({frame:__scrollProbe.frame,id,changed:before!==d.get.call(this),running:v.running,paused:v.messagesBottomFollowPaused,answer,reasoning,structural:(__smooth.calls['list.render']?.count??0)!==__scrollProbe.renders,stable:v.running&&(reasoning>300||answer>0)&&answer<1883});}});
  })()`);
  const status=await new Promise((resolve,reject)=>{const p=spawn(process.execPath,['scripts/runtime-smoothness/stream.mjs'],{stdio:'inherit',env:{...process.env,ECHOINK_PERF_NAME:'frame-scroll-stream'}});p.on('error',reject);p.on('exit',resolve);});
  assert.equal(status,0);
  const writes=await c.evaluate('__scrollProbe.writes');
  const counts=new Map();for(const r of writes)if(r.stable&&!r.structural&&r.changed){const key=r.frame+':'+r.id;counts.set(key,(counts.get(key)??0)+1);}
  const maximum=Math.max(0,...counts.values()),result={maximumWritesPerTargetPerFrame:maximum,stableTargetFrames:counts.size,writes};
  await c.write('frame-scroll.json',result);assert.ok(counts.size>10,'exercise actual following, not only unchanged scroll writes');assert.ok(maximum<=1,'each reading target receives at most one actual scroll update per frame');
  console.log({maximumWritesPerTargetPerFrame:maximum,stableTargetFrames:counts.size});
}finally{await c.evaluate(`if(window.__scrollProbeDescriptor){Object.defineProperty(Element.prototype,'scrollTop',__scrollProbeDescriptor);__scrollProbe.stopped=true;cancelAnimationFrame(__scrollProbe.raf);}`);c.close();}
