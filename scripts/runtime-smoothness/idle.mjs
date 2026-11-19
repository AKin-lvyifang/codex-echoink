import {connect,delay} from './cdp.mjs';
const c=await connect();
try{
  await c.evaluate(`app.setting.close();window.p=app.plugins.plugins['codex-echoink'];window.v=p.getCodexView();__smooth.attach();`);
  await delay(1500);await c.send('Performance.enable');
  const metrics=async()=>Object.fromEntries((await c.send('Performance.getMetrics')).metrics.map(x=>[x.name,x.value]));
  const capture=async(name,seconds)=>{
    await c.evaluate('__smooth.reset();performance.mark("idle-start")');await c.traceStart();
    const before=await c.evaluate('({cpu:process.cpuUsage(),now:performance.now(),timers:__smooth.snapshot().timers})'),m0=await metrics();
    for(let i=0;i<seconds;i++)await delay(1000);
    const after=await c.evaluate('({cpu:process.cpuUsage(),now:performance.now(),...__smooth.snapshot()})'),m1=await metrics();
    await c.traceEnd(name);
    const wallMs=after.now-before.now;
    const result={seconds,wallMs,rendererCpuOneCorePct:((after.cpu.user-before.cpu.user)+(after.cpu.system-before.cpu.system))/1000/wallMs*100,mainThreadTaskPct:(m1.TaskDuration-m0.TaskDuration)/(wallMs/1000)*100,metricDeltas:Object.fromEntries(Object.keys(m1).map(k=>[k,m1[k]-m0[k]])),before,after};
    await c.write(name+'.json',result);console.log({name,cpu:result.rendererCpuOneCorePct,task:result.mainThreadTaskPct,timers:after.timers.map(t=>({kind:t.kind,ms:t.ms,fires:t.fires,totalMs:t.totalMs})),animations:after.animations});
  };
  await capture('idle-visible',60);
  await c.evaluate(`const leaves=[];app.workspace.iterateAllLeaves(l=>{if(l.view===v||l.view.getViewType().startsWith('codex-echoink')||l.view.getViewType().startsWith('echoink-'))leaves.push(l);});window.__perfClosed=leaves.map(l=>l.view.getViewType());for(const l of leaves)l.detach();`);
  await delay(1500);
  await capture('idle-closed',60);
  await c.write('closed-views.json',await c.evaluate('__perfClosed'));
}finally{c.close();}
