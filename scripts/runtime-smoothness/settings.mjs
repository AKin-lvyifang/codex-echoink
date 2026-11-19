import {connect,delay} from './cdp.mjs';
const c=await connect();
try{
  const samples=[];await c.evaluate(`window.p=app.plugins.plugins['codex-echoink'];void 0;`);
  await c.traceStart();
  for(let i=0;i<3;i++){
    await c.evaluate('app.setting.close()');await delay(200);
    samples.push(await c.evaluate(`(async()=>{const t=performance.now();performance.mark('settings-precise-open');app.setting.open();app.setting.openTabById('codex-echoink');for(let n=0;n<120&&!p.settingsTabInstance.settingsBodyEl?.childElementCount;n++)await new Promise(requestAnimationFrame);if(!p.settingsTabInstance.settingsBodyEl?.childElementCount)throw Error('Settings content never became ready');const root=p.settingsTabInstance.containerEl,w=root.ownerDocument.defaultView;if(!w||w.closed)throw Error("Settings window closed");await new Promise(r=>w.requestAnimationFrame(()=>w.requestAnimationFrame(r)));return {ownerWindow:w===window?"workspace":"settings-popout",ms:performance.now()-t,bodyReady:!!p.settingsTabInstance.settingsBodyEl?.childElementCount,visible:p.settingsTabInstance.containerEl.getBoundingClientRect().width>0};})()`));
  }
  await c.traceEnd('settings-precise');await c.write('settings-precise.json',{samples});console.log(samples);
}finally{await c.evaluate('app.setting.close()');c.close();}
