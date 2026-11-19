import fs from 'node:fs/promises';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import {out} from './cdp.mjs';

export function analyze(data) {
  const events=data.traceEvents, main=events.find(e=>e.name==='thread_name'&&e.args.name==='CrRendererMain');
  const mainThread=e=>e.pid===main?.pid&&e.tid===main?.tid;
  const sendMark=events.find(e=>e.name==='perf-send'&&mainThread(e));
  const endMark=events.find(e=>e.name==='perf-stream-end'&&mainThread(e));
  const startTs=sendMark?.ts??-Infinity,endTs=endMark?.ts??Infinity;
  const thread=e=>mainThread(e)&&e.ts>=startTs&&e.ts<=endTs;
  const totals={};
  for(const e of events.filter(thread))if(e.ph==='X'&&e.dur){const r=totals[e.name]??={count:0,totalMs:0,maxMs:0};r.count++;r.totalMs+=e.dur/1000;r.maxMs=Math.max(r.maxMs,e.dur/1000);}
  const layouts=events.filter(e=>thread(e)&&e.name==='Layout'&&e.ph==='X');
  const forced=layouts.filter(e=>e.args?.beginData?.stackTrace?.length);
  const profiles=new Map();
  const profileIds=new Set(events.filter(e=>mainThread(e)&&e.name==='Profile').map(e=>`${e.pid}:${e.id}`));
  for(const e of events){
    if(e.name!=='ProfileChunk'||!profileIds.has(`${e.pid}:${e.id}`))continue;
    const key=e.id,p=profiles.get(key)??{nodes:new Map(),samples:[],start:events.find(x=>x.name==='Profile'&&x.id===key&&x.pid===e.pid)?.args.data.startTime};profiles.set(key,p);
    const d=e.args.data;
    for(const n of d.cpuProfile?.nodes??[])p.nodes.set(n.id,n);
    for(let i=0;i<(d.cpuProfile?.samples?.length??0);i++)p.samples.push([d.cpuProfile.samples[i],d.timeDeltas?.[i]??0]);
  }
  const self=new Map(),inclusive=new Map();
  for(const p of profiles.values()){let sampleTime=p.start;for(const [id,delta] of p.samples){
    sampleTime+=delta;if(sampleTime<startTs||sampleTime>endTs)continue;
    let node=p.nodes.get(id),first=true,seen=new Set();
    while(node){
      const f=node.callFrame,k=`${f.functionName||'(anonymous)'} @ ${f.url||''}:${(f.lineNumber??-1)+1}:${(f.columnNumber??-1)+1}`;
      if(first)self.set(k,(self.get(k)??0)+delta/1000);
      if(!seen.has(k))inclusive.set(k,(inclusive.get(k)??0)+delta/1000);
      seen.add(k);first=false;node=p.nodes.get(node.parent);
    }
  }
  }
  const sort=m=>[...m].sort((a,b)=>b[1]-a[1]).slice(0,30).map(([fn,ms])=>({fn,ms}));
  const long=events.filter(e=>thread(e)&&e.name==='RunTask'&&e.ph==='X'&&e.dur>50000).map(e=>({ts:e.ts,durationMs:e.dur/1000}));
  const stacks={};for(const e of forced){const key=JSON.stringify(e.args.beginData.stackTrace.map(f=>f.functionName));const r=stacks[key]??={count:0,totalMs:0};r.count++;r.totalMs+=e.dur/1000;}
  const longTaskFunctions=long.map(task=>{const counts=new Map();for(const p of profiles.values()){let time=p.start;for(const [id,delta] of p.samples){time+=delta;if(time<task.ts||time>task.ts+task.durationMs*1000)continue;let n=p.nodes.get(id);const seen=new Set();while(n){const f=n.callFrame,k=f.functionName||'(anonymous)';if(!seen.has(k))counts.set(k,(counts.get(k)??0)+delta/1000);seen.add(k);n=p.nodes.get(n.parent);}}}return {...task,functions:sort(counts)};});
  const marks=new Map(events.filter(e=>e.cat?.includes('user_timing')).map(e=>[e.name,e.ts]));
  const windows={};for(const [name,start] of marks){if(!name.endsWith('-start'))continue;const key=name.slice(0,-6),end=marks.get(key+'-paint')??marks.get(key+'-end');if(!end)continue;const tasks=long.filter(e=>e.ts<end&&e.ts+e.durationMs*1000>start);windows[key]={durationMs:(end-start)/1000,longTasks:tasks,layoutCount:layouts.filter(e=>e.ts<end&&e.ts+e.dur>start).length};}
  const excludedLongTasks=events.filter(e=>mainThread(e)&&e.name==='RunTask'&&e.ph==='X'&&e.dur>50000&&!thread(e)).map(e=>({ts:e.ts,durationMs:e.dur/1000,relativeToSendMs:sendMark?(e.ts-sendMark.ts)/1000:undefined}));
  return {main,measurementWindow:sendMark?{startMark:'perf-send',endMark:endMark?'perf-stream-end':'trace-end'}:null,excludedLongTasks,totals,windows,longTaskFunctions,longTasks:long,longTaskTotalMs:long.reduce((n,e)=>n+e.durationMs,0),forcedLayout:{count:forced.length,totalMs:forced.reduce((n,e)=>n+e.dur/1000,0),stacks},topSelf:sort(self),topInclusive:sort(inclusive)};
}
if(process.argv[1]===new URL(import.meta.url).pathname){
  const names=process.argv.slice(2);
  const summary={};
  for(const name of names){const data=JSON.parse(gunzipSync(await fs.readFile(path.join(out,name+'.trace.json.gz'))));summary[name]=analyze(data);}
  await fs.writeFile(path.join(out,'trace-summary.json'),JSON.stringify(summary,null,2));
  console.log(JSON.stringify(Object.fromEntries(Object.entries(summary).map(([n,s])=>[n,{longTasks:s.longTasks,forcedLayout:s.forcedLayout,layout:s.totals.Layout,style:s.totals.UpdateLayoutTree,topSelf:s.topSelf.slice(0,8),topInclusive:s.topInclusive.filter(r=>!/\((root|idle)\)/.test(r.fn)).slice(0,8)}])),null,2));
}
