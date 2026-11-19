import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {gunzipSync} from 'node:zlib';
import {analyze} from './analyze.mjs';
const root=path.resolve(process.env.ECHOINK_PERF_OUT??'docs/internal/test-evidence/2026-11-15-手机端运行丝滑度/baseline');
const report='docs/更新/2026-11-15-手机端运行丝滑度.md';
const read=async name=>JSON.parse(await fs.readFile(path.join(root,name+'.json'),'utf8'));
const prepared=await read('prepared-environment');assert.match(prepared.sourceCommit,/^[a-f0-9]{40}$/);
const summary={sourceCommit:prepared.sourceCommit,realModelCalls:0,devices:{}};
const n=x=>Number(x.toFixed(1)),range=arr=>`${n(Math.min(...arr))}–${n(Math.max(...arr))}`;
for(const device of ['iphone','ipad']){
 const d=summary.devices[device]={streams:[]};
 for(const rate of [1,4])for(const label of ['cold','warm']){
  const name=`${device}-stream-${rate}x-${label}`,r=await read(name);
  assert.deepEqual(r.environment.viewport,device==='iphone'?[390,844]:[1180,820]);
  assert.equal(r.samples.at(-1).answerChars,1883);assert.ok(r.samples.some(s=>s.busy&&s.visibleAt&&s.liveChars>0&&s.liveChars<1883));
  const trace=analyze(JSON.parse(gunzipSync(await fs.readFile(path.join(root,name+'.trace.json.gz')))));
  assert.deepEqual(trace.longTasks,r.trace.longTasks);assert.deepEqual(trace.forcedLayout,r.trace.forcedLayout);
  d.streams.push({rate,label,sendMs:n(r.metrics.sendToVisibleMs),deltaMs:r.metrics.firstProviderBodyToVisibleMs,longTasks:trace.longTasks.length,maxTaskMs:n(Math.max(0,...trace.longTasks.map(t=>t.durationMs))),forcedCount:trace.forcedLayout.count,forcedMs:n(trace.forcedLayout.totalMs),bodyReplacements:r.metrics.bodyReplacements,reasoningReplacements:r.metrics.reasoningReplacements,completedStreamClears:r.metrics.completedStreamClears,evidence:name+'.json'});
 }
 d.entrances={};d.scroll={};
 for(const rate of [1,4]){
  const e=await read(`${device}-entrances-${rate}x`),s=await read(`${device}-interactions-${rate}x`);
  assert.deepEqual(s.environment.viewport,device==='iphone'?[390,844]:[1180,820]);
  d.entrances[rate]=Object.fromEntries(['open-long','task-back','switch-task','settings-open','settings-model','settings-general','settings-back','tab-to-'].map(label=>[label,e.entrances.filter(r=>r.label.startsWith(label)).map(r=>r.effectiveMs)]));
  d.scroll[rate]=s.scroll.map(r=>{assert.ok(r.finalTop>100,'Actual target scrolling required');return {scene:r.scene,p95:n(r.frameP95),max:n(r.frameMax),longTasks:r.trace.longTasks.length,finalTop:r.finalTop,rows:r.geometry.rows,nodes:r.geometry.nodes};});
  if(rate===1)d.keyboard={transitions:s.keyboard.transitions.map(r=>({y:r.y,vh:r.vh})),count:s.keyboard.transitions.length};
 }
 const controls=await read(device+'-controls');assert.equal(controls.summary.measured,controls.rows.filter(r=>r.pressed).length);assert.equal(controls.summary.pass,controls.rows.filter(r=>r.pass).length);d.controls=controls.summary;
 const follow=await read(device+'-follow');assert.equal(follow.outerBefore.paused,false);assert.equal(follow.summary.firstMovePaused,true);d.follow={...follow.summary,before:follow.outerBefore,after:follow.outerAfterGesture,after900:follow.outerAfter900,returnMs:n(follow.returnWhileRunning.effectiveMs)};
 const reading=await read(device+'-reading');d.reasoning={before:reading.reasoningBefore,after:reading.reasoningAfterGesture,later:reading.reasoningAfter700};
 const idle=await read(device+'-idle');assert.ok(idle.seconds>=60);d.idle={seconds:n(idle.seconds),cpu:Number(idle.cpuOneCorePct.toFixed(2)),dolls:idle.before.dolls};
}
const a=summary.devices.iphone,b=summary.devices.ipad;
const pair=(d,rate,key)=>d.streams.filter(s=>s.rate===rate).map(s=>s[key]).join(' / ');
const ranges=(d,key,rate=1)=>range(d.entrances[rate][key]);
const scroll=(d,rate,scene)=>{const s=d.scroll[rate].find(s=>s.scene===scene);return `${s.p95} / ${s.max}ms；长任务 ${s.longTasks}`;};
const row=(...cells)=>'| '+cells.join(' | ')+' |';
const rows=[
 row('项','iPhone 1×','iPad 1×','4×（iPhone；iPad）','是否达标','证据（baseline/ 下）'),
 '| --- | --- | --- | --- | --- | --- |',
 row('发送→正文可见，冷 / 热',pair(a,1,'sendMs')+'ms',pair(b,1,'sendMs')+'ms',pair(a,4,'sendMs')+'；'+pair(b,4,'sendMs')+'ms','总等待含固定思考，无独立硬阈值；均生成中可见','*-stream-*.json'),
 row('假服务首正文→双 rAF 可见，冷 / 热',pair(a,1,'deltaMs')+'ms',pair(b,1,'deltaMs')+'ms',pair(a,4,'deltaMs')+'；'+pair(b,4,'deltaMs')+'ms','流式出现；不能用总等待判断 UI 卡顿','*-stream-*.json'),
 row('>50ms 任务数，冷 / 热',pair(a,1,'longTasks'),pair(b,1,'longTasks'),pair(a,4,'longTasks')+'；'+pair(b,4,'longTasks'),'冷态、4× 未达标；1× 热态通过','*-stream-*.json / .trace.json.gz'),
 row('最长超限任务，冷 / 热（0=无超限）',pair(a,1,'maxTaskMs')+'ms',pair(b,1,'maxTaskMs')+'ms',pair(a,4,'maxTaskMs')+'；'+pair(b,4,'maxTaskMs')+'ms','未达标；准备与完成阶段下文拆开','*-stream-*.json: trace.longTaskFunctions'),
 row('同步 Layout 次数；总 ms，冷 / 热',pair(a,1,'forcedCount')+'；'+pair(a,1,'forcedMs'),pair(b,1,'forcedCount')+'；'+pair(b,1,'forcedMs'),pair(a,4,'forcedCount')+'；'+pair(b,4,'forcedCount')+' 次','无单独次数阈值；含 JS 栈的 Layout','*-stream-*.json: trace.forcedLayout'),
 row('生成中整段正文换节点，冷 / 热',pair(a,1,'bodyReplacements'),pair(b,1,'bodyReplacements'),pair(a,4,'bodyReplacements')+'；'+pair(b,4,'bodyReplacements'),'未达标（应为 0）；手机当前为纯文本','*-stream-*.json: metrics.bodyReplacements'),
 row('稳定目标每帧实际滚动变化最大值',a.follow.maxActualPerTargetFrame,b.follow.maxActualPerTargetFrame,'未加 4×（按任务范围）','所采稳定阶段 ≤1；不等于不强制排版','*-follow.json: diagnostic.writes'),
 row('外层首个 touchmove 暂停；甩动后 900ms 程序写入',`是；${a.follow.outerWritesInInertiaWindow} 次`,`是；${b.follow.outerWritesInInertiaWindow} 次`,'—','暂停通过；仍写 scrollTop，有惯性风险','*-follow.json'),
 row('思考阅读节点 / 700ms 后位置',`${a.reasoning.later.same?'保留':'已替换'}；top=${a.reasoning.later.top}`,`${b.reasoning.later.same?'保留':'已替换'}；top=${b.reasoning.later.top}`,'—','未达标：重新贴底，阅读锚点不保留','*-reading.json；film/*-walkthrough.mp4'),
 row('200 消息首屏，3 次范围',ranges(a,'open-long')+'ms',ranges(b,'open-long')+'ms',ranges(a,'open-long',4)+'；'+ranges(b,'open-long',4)+'ms','iPhone 1× 通过；iPad 1× 及两端 4× 有超项','*-entrances-*.json'),
 row('切短会话，3 次范围',ranges(a,'switch-task')+'ms',ranges(b,'switch-task')+'ms',ranges(a,'switch-task',4)+'；'+ranges(b,'switch-task',4)+'ms','iPad 1× 未达标；其余所采组 ≤100ms','*-entrances-*.json'),
 row('长任务返回列表，3 次范围',ranges(a,'task-back')+'ms',ranges(b,'task-back')+'ms',ranges(a,'task-back',4)+'；'+ranges(b,'task-back',4)+'ms','iPad 1× 及两端 4× 超标','*-entrances-*.json'),
 row('生成中切走再返回',a.follow.returnMs+'ms',b.follow.returnMs+'ms','—','iPad 本样本 >100ms；运行仍继续','*-follow.json: returnWhileRunning'),
 row('切原生 Tab，6 次范围',ranges(a,'tab-to-')+'ms',ranges(b,'tab-to-')+'ms','—','≤100ms','*-entrances-1x.json'),
 row('设置打开；分类/返回范围',ranges(a,'settings-open')+'；'+ranges(a,'settings-general')+' / '+ranges(a,'settings-back')+'ms',ranges(b,'settings-open')+'；'+ranges(b,'settings-general')+' / '+ranges(b,'settings-back')+'ms','—','≤100ms；iPad 先卸下旧设置页再测','*-entrances-1x.json'),
 row('200 任务列表滚动：P95 / 最大帧间隔',scroll(a,1,'list'),scroll(b,1,'list'),scroll(a,4,'list')+'；'+scroll(b,4,'list'),'所采滚动无 >50ms 长任务；实际滚动已断言','*-interactions-*.json / *-list.trace.json.gz'),
 row('200 消息滚动：P95 / 最大帧间隔',scroll(a,1,'long'),scroll(b,1,'long'),scroll(a,4,'long')+'；'+scroll(b,4,'long'),'iPhone 4× 出现 1 个超限任务；其余组无超限','*-interactions-*.json / *-long.trace.json.gz'),
 row('键盘代理：缩高 / 恢复位移次数',a.keyboard.count+' 次（合计）',b.keyboard.count+' 次（合计）','—','iPhone 一次到位；iPad 两段移动，未达一次到位','*-interactions-1x.json: keyboard'),
 row('触摸首帧反馈：通过 / 可测 / 现身',`${a.controls.pass} / ${a.controls.measured} / ${a.controls.total}`,`${b.controls.pass} / ${b.controls.measured} / ${b.controls.total}`,'—','模拟未通过；宿主 :active 差异须与 CSS 缺漏分开','*-controls.json；*-press-calibration.json'),
 row('可见无操作单核 CPU',a.idle.cpu+'% / '+a.idle.seconds+'s',b.idle.cpu+'% / '+b.idle.seconds+'s','—','按桌面 ≤8% 比较通过；本轮未挂载娃娃','*-idle.json')
];
const table=rows.join('\n');
const markdown=await fs.readFile(report,'utf8');const start='<!-- mobile-baseline:start -->',end='<!-- mobile-baseline:end -->';
assert.ok(markdown.includes(start)&&markdown.includes(end));
if(process.argv.includes('--check')){
 assert.equal(markdown.split(start)[1].split(end)[0].trim(),table);
 assert.deepEqual(await read('baseline-summary'),summary);
 console.log('Verified: 8 raw stream traces, visible unfinished responses, device sizes, actual scrolling, press counts, >=60s CPU, summary and report table agree.');
}else{
 await fs.writeFile(path.join(root,'baseline-summary.json'),JSON.stringify(summary,null,2));
 await fs.writeFile(report,markdown.split(start)[0]+start+'\n'+table+'\n'+end+markdown.split(end)[1]);
 console.log(JSON.stringify(summary,null,2));
}
