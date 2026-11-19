import {connect,delay} from './cdp.mjs';
const c=await connect(),samples=[];
try {
 for(const id of ['editor','appearance','editor','appearance']){
  await c.evaluate('app.setting.close()');await delay(250);
  samples.push(await c.evaluate(`(async()=>{const t=performance.now();app.setting.open();app.setting.openTabById(${JSON.stringify(id)});const tab=app.setting.activeTab;if(!tab?.containerEl)throw Error('Native settings tab unavailable');const root=tab.containerEl,w=root.ownerDocument.defaultView;for(let i=0;i<120&&!root.childElementCount;i++)await new Promise(requestAnimationFrame);await new Promise(r=>w.requestAnimationFrame(()=>w.requestAnimationFrame(r)));return {id:${JSON.stringify(id)},ms:performance.now()-t,popout:w!==window,visible:root.getBoundingClientRect().width>0};})()`));
 }
 await c.write('settings-host-control.json',samples);console.log(samples);
} finally{await c.evaluate('app.setting.close()');c.close()}
