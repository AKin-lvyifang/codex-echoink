import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {gunzipSync} from 'node:zlib';
import {analyze} from './analyze.mjs';
import {summarizeMobileScroll} from './mobile-scroll-summary.mjs';
const root=path.resolve('docs/internal/test-evidence/2026-11-15-手机端运行丝滑度/batch4'),check=process.argv.includes('--check');
const read=async file=>JSON.parse(await fs.readFile(path.join(root,file),'utf8'));
async function traceInfo(file,summary) {
 if(!check)return {};
 const raw=JSON.parse(gunzipSync(await fs.readFile(path.join(root,file.replace('.json','.trace.json.gz'))))),actual=analyze(raw);
 assert.deepEqual(actual.longTasks,summary.longTasks);assert.deepEqual(actual.forcedLayout,summary.forcedLayout);
 const main=actual.main,marks=raw.traceEvents.filter(e=>e.name==='perf-send'||e.name==='perf-stream-end'),start=marks.find(e=>e.name==='perf-send')?.ts??-Infinity,end=marks.find(e=>e.name==='perf-stream-end')?.ts??Infinity;
 const gc=raw.traceEvents.filter(e=>e.pid===main.pid&&e.tid===main.tid&&e.ts>=start&&e.ts<=end&&/GC/.test(e.name)&&e.ph==='X'&&e.dur);
 return {gcEventNames:[...new Set(gc.map(e=>e.name))],gcMaxMs:Math.max(0,...gc.map(e=>e.dur/1000)),gcOver50:gc.filter(e=>e.dur>50000).length};
}
const summary={mergedMain:'5b8b36f1',mergeCommit:'a2e20bcf',realModelCalls:0,devices:{},keyboardCalibration:'Old layout shrink changes host tablet/phone identity; corrected visualViewport-only proxy leaves the product inset rule unchanged.'};
for(const device of ['iphone','ipad']) {
 const navigation={};
 for(const [phase,folder] of [['before','paired-before'],['after','final']]) {
  const file=`${folder}/${device}-navigation-1x.json`,d=await read(file),groups={};
  for(const key of ['open-long','switch-short','return-list','running-return']){const rows=d.entrances.filter(e=>e.label.startsWith(key));assert.equal(rows.length,3);assert.ok(rows.every(r=>r.readableInViewport));groups[key]={valuesMs:rows.map(r=>r.effectiveMs),pass:rows.every(r=>r.effectiveMs<=100)};if(phase==='after')assert.equal(groups[key].pass,true);}
  navigation[phase]={file,groups,...await traceInfo(file,d.trace)};
 }
 const pressure={};for(const [phase,folder] of [['before','before'],['after','after']]){const file=`${folder}/${device}-navigation-4x.json`,d=await read(file);pressure[phase]={file,values:d.entrances.map(e=>({label:e.label,ms:e.effectiveMs})),...await traceInfo(file,d.trace)};}
 const keyboard={};for(const [phase,folder] of [['before','paired-before'],['after','final']]){const file=`${folder}/${device}-keyboard.json`,d=await read(file);assert.equal(d.transitions.length,2);assert.ok(d.samples.every(s=>s.inner===(device==='iphone'?844:820)));keyboard[phase]={file,transitions:d.transitions.map(t=>({from:t.from,to:t.y,inner:t.inner})),sameDeviceIdentity:true};}
 const input={};for(const [phase,folder] of [['before','paired-before'],['after','final']]){const file=`${folder}/${device}-input-feedback.json`,d=await read(file);assert.equal(d.pressed.opacity,phase==='before'?'0.65':'1');assert.equal(d.released.focused,true);input[phase]={file,pressed:d.pressed,released:d.released};}
 const streams=[];for(const rate of [1,4])for(const label of ['cold','warm']){const file=`final/${device}-stream-${rate}x-${label}.json`,d=await read(file);assert.equal(d.metrics.stableBodyReplacements,0);assert.equal(d.metrics.completionBodyReplacements,1);if(rate===1)assert.equal(d.preparation.longTasks.length,0);streams.push({file,rate,label,metrics:d.metrics,preparation:d.preparation,allLongTasks:d.trace.longTaskFunctions.map(t=>({ms:t.durationMs,functions:t.functions.slice(0,8)})),...await traceInfo(file,d.trace)});}
 const reading={};for(const mode of ['reading','follow']){const file=`regression/${device}-${mode}.json`,d=await read(file),counts=summarizeMobileScroll(d.diagnostic);assert.equal(counts.outerRawWritesWhileHeld+counts.outerRawWritesDuringGesture+counts.outerRawWritesInInertiaWindow,0);assert.ok(counts.maxActualPerTargetFrame<=1);if(mode==='reading')assert.equal(d.reasoningAfter700.same,true);reading[mode]={file,counts,reasoningAfterGesture:d.reasoningAfterGesture,reasoningAfter700:d.reasoningAfter700};}
 const functionalFile=`regression/${device}-functional.json`,functional=await read(functionalFile);assert.equal(functional.pass,true);
 const scale=[];for(const rate of [1,4]){const file=`scale-after/${device}-interactions-${rate}x.json`,d=await read(file);for(const s of d.scroll){assert.ok(s.finalTop>=100);const rawFile=file.replace('.json',`-${s.scene}.json`);scale.push({file,rate,scene:s.scene,p95:s.frameP95,max:s.frameMax,longTasks:s.trace.longTasks,...await traceInfo(rawFile,s.trace)});}}
 const beforeScroll=await read(`scale-before/${device}-interactions-4x.json`);const scaleBefore=[];for(const s of beforeScroll.scroll)scaleBefore.push({scene:s.scene,p95:s.frameP95,max:s.frameMax,longTasks:s.trace.longTasks,...await traceInfo(`scale-before/${device}-interactions-4x-${s.scene}.json`,s.trace)});
 const idle=await read(`idle/${device}-idle.json`);assert.ok(idle.seconds>=60);assert.ok(idle.cpuOneCorePct<=8);
 summary.devices[device]={navigation,pressure,keyboard,input,streams,reading,functional:{file:functionalFile,checks:functional.checks,pass:true},scale,scaleBefore,idle:{file:`idle/${device}-idle.json`,seconds:idle.seconds,cpuOneCorePct:idle.cpuOneCorePct,focus:idle.after.focus,visibility:idle.after.visibility}};
}
await fs.writeFile(path.join(root,'batch4-summary.json'),JSON.stringify(summary,null,2)+'\n');console.log({devices:Object.keys(summary.devices),tracesReparsed:check,pass:true});
