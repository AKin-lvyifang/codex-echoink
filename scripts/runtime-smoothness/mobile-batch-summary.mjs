import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import {analyze} from './analyze.mjs';
import {summarizeMobileScroll} from './mobile-scroll-summary.mjs';
const root=path.resolve('docs/internal/test-evidence/2026-11-15-手机端运行丝滑度'),check=process.argv.includes('--check');
const load=async relative=>JSON.parse(await fs.readFile(path.join(root,relative),'utf8'));
const afterDirectory=process.argv.includes('--final')?'final-after-lint':'after';
const summary={afterDirectory,sourceBefore:'10fc258c',realModelCalls:0,devices:{},limitations:['Chromium mobile emulation, not WKWebView/device acceptance','4x CPU is a pressure sample','Cold completion Markdown/Prism and batch4 navigation/keyboard gaps remain']};
for(const device of ['iphone','ipad']) {
 const streams=[];
 for(const rate of [1,4])for(const label of ['cold','warm']) {
  const file=`batch3/${afterDirectory}/${device}-stream-${rate}x-${label}.json`,d=await load(file);
  assert.equal(d.realModelCalls,0);assert.equal(d.metrics.stableBodyReplacements,0);assert.equal(d.metrics.completionBodyReplacements,1);
  assert.equal(d.samples.at(-1).answerChars,1883);assert.deepEqual(d.environment.viewport,device==='iphone'?[390,844]:[1180,820]);
  if(check){const trace=JSON.parse(gunzipSync(await fs.readFile(path.join(root,file.replace('.json','.trace.json.gz')))));const measured=analyze(trace);assert.deepEqual(measured.longTasks,d.trace.longTasks);assert.deepEqual(measured.forcedLayout,d.trace.forcedLayout);}
  const beforeFile=rate===1&&label==='cold'?`batch3/before/${device}-stream-1x-cold.json`:`batch2/after/${device}-stream-${rate}x-${label}.json`,b=await load(beforeFile);
  streams.push({rate,label,before:{evidence:beforeFile,bodyReplacements:b.metrics.bodyReplacements,stableBodyReplacements:b.metrics.stableBodyReplacements??b.metrics.bodyReplacements-1,bodyVisibleMs:b.metrics.firstProviderBodyToVisibleMs,forcedLayout:b.trace.forcedLayout.count},after:{evidence:file,sendToVisibleMs:d.metrics.sendToVisibleMs,bodyVisibleMs:d.metrics.firstProviderBodyToVisibleMs,stableRebuilds:d.metrics.stableBodyReplacements,completionReplacements:d.metrics.completionBodyReplacements,reasoningReplacements:d.metrics.reasoningReplacements,forcedLayout:d.trace.forcedLayout.count,preparationLongTasks:d.preparation.longTasks.map(x=>x.durationMs),allLongTasks:d.trace.longTaskFunctions.map(x=>({durationMs:x.durationMs,functions:x.functions.slice(0,10)}))}});
 }
 const reading={};
 for(const phase of ['before','after'])for(const mode of ['reading','follow']) {
  const evidence=`batch3/${phase==='after'?afterDirectory:phase}/${device}-${mode}.json`,d=await load(evidence),counts=summarizeMobileScroll(d.diagnostic);
  const reasoningWrites=d.diagnostic.writes.filter(w=>w.cls.includes('reasoning-body')&&['reasoning-gesture','reasoning-after'].includes(w.stage)).length;
  if(phase==='after'){assert.equal(counts.nativeTouchWindow.complete,true);assert.equal(counts.outerRawWritesWhileHeld+counts.outerRawWritesDuringGesture+counts.outerRawWritesInInertiaWindow,0);assert.ok(counts.maxActualPerTargetFrame<=1);assert.equal(counts.firstMovePaused,true);if(mode==='reading'){assert.equal(d.reasoningAfter700.same,true);assert.equal(reasoningWrites,0);}assert.equal(d.hostCommandPalette,false);}
  reading[phase+'-'+mode]={evidence,counts,reasoningRawWritesAfterReading:reasoningWrites,reasoningBefore:d.reasoningBefore,reasoningAfterGesture:d.reasoningAfterGesture,reasoningAfter700:d.reasoningAfter700,hostCommandPalette:d.hostCommandPalette??null,returnWhileRunning:d.returnWhileRunning};
 }
 const scale=[];for(const rate of [1,4]){const evidence=`batch3/scale/${device}-interactions-${rate}x.json`,d=await load(evidence);for(const s of d.scroll){assert.ok(s.finalTop>=100);scale.push({rate,scene:s.scene,frameP95:s.frameP95,frameMax:s.frameMax,longTasks:s.trace.longTasks.map(t=>t.durationMs),finalTop:s.finalTop,evidence});}if(rate===1)summary.devices[device]={entrances:d.entrances,keyboardTransitions:d.keyboard.transitions.length};}
 const functionalFile=`batch3/functional/${device}-functional.json`,functional=await load(functionalFile);assert.equal(functional.pass,true);assert.equal(functional.checks.length,7);
 summary.devices[device]={...summary.devices[device],environment:(await load(`batch3/${afterDirectory}/${device}-environment.json`)),streams,reading,scale,functional:{evidence:functionalFile,pass:functional.pass,checks:functional.checks}};
}
await fs.writeFile(path.join(root,afterDirectory==='after'?'batch3/batch3-summary.json':'batch3/batch3-summary-final.json'),JSON.stringify(summary,null,2)+'\n');
console.log({devices:Object.keys(summary.devices),traceReparsed:check,pass:true});
