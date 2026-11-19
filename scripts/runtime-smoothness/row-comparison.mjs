import {connect} from './cdp.mjs';
const c=await connect();
try{
  if(process.argv.includes('--start')){
    await c.evaluate(`window.__rowStringifyOriginal=JSON.stringify;window.__rowStringifyStats={count:0,totalMs:0,maxMs:0,maxChars:0};
    JSON.stringify=function(value,...args){if(!value||typeof value!=='object'||!['assistantTurn','message'].includes(value.kind))return __rowStringifyOriginal(value,...args);
      const start=performance.now(),result=__rowStringifyOriginal(value,...args),ms=performance.now()-start,s=__rowStringifyStats;s.count++;s.totalMs+=ms;s.maxMs=Math.max(s.maxMs,ms);s.maxChars=Math.max(s.maxChars,result.length);return result;};`);
  }else{
    const result=await c.evaluate(`(()=>{if(window.__rowStringifyOriginal)JSON.stringify=__rowStringifyOriginal;const row=structuredClone(v.messageListRenderer.currentRows.find(r=>r.kind==='assistantTurn'));const text='长思考的固定合成文字。'.repeat(10000);for(const r of row.turn.providerReasoningSegments)r.text=text;
      const samples=[];for(let i=0;i<100;i++){const t=performance.now();JSON.stringify(row);samples.push(performance.now()-t);}samples.sort((a,b)=>a-b);return {formal:window.__rowStringifyStats,stress:{reasoningChars:text.length,iterations:100,medianMs:samples[50],maxMs:samples.at(-1)}};})()`);
    await c.write('row-comparison.json',result);console.log(result);
  }
}finally{c.close();}
