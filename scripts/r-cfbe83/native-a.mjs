import {configureNative} from "./environment.mjs";
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
await configureNative();
const {connect,delay}=await import('../runtime-smoothness/cdp.mjs');const c=await connect();
async function home(){await c.evaluate(`(async()=>{for(let i=0;i<200&&(!app.workspace.layoutReady||!app.workspace.rightSplit);i++)await new Promise(r=>setTimeout(r,50));window.p=app.plugins.plugins['codex-echoink'];await p.activateHomeView();window.h=app.workspace.getLeavesOfType('codex-echoink-home')[0].view;await h.refresh();p.hideEchoInkOnboardingWorkspaceCard();})()`);await delay(150);}
async function click(label){const xy=await c.evaluate(`(()=>{const b=[...h.contentEl.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}&&b.getBoundingClientRect().height);if(!b)throw Error('Missing button '+${JSON.stringify(label)});b.scrollIntoView({block:'nearest'});const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);await c.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...xy});await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...xy});await delay(250);await home();}
const report=[];
try{
 await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});await home();
 await c.evaluate(`(async()=>{p.settings.workbenchDismissals={version:1,entries:{}};p.settings.settingsLanguage='zh-CN';const b=p.settings.knowledgeBase.folderBindings;b.revision++;for(const role of ['raw','wiki'])Object.assign(b.roles[role],{enabled:true,readPaths:['R-CFBE83/'+role],writePath:'R-CFBE83/'+role});await p.saveSettings(true,{flushConversationStore:false});h.refreshLanguage();})()`);await home();
 await c.evaluate(`app.plugins.enablePluginAndSave('codex-echoink')`);
 assert.equal(await c.evaluate('(async()=>(await h.port.load()).signals.filter(s=>s.id===7).length)()'),1);await c.screenshot('desktop-zh-before-dismiss');
 await click('忽略');let state=await c.evaluate('(async()=>{const s=await h.port.load();const data=JSON.parse(await app.vault.adapter.read(p.manifest.dir+"/data.json"));return {signals:s.signals.length,dismissed:s.dismissedCount,diskCount:Object.keys(data.workbenchDismissals.entries).length};})()');assert.equal(state.signals,0);assert.equal(state.diskCount,1);report.push({case:'dismiss-saved',...state});await c.screenshot('desktop-zh-dismissed');
 assert.equal(await c.evaluate('(async()=>(await h.port.load(Date.now()+86400000)).signals.filter(s=>s.id===7).length)()'),0);report.push({case:'cross-midnight',passed:true});
 await c.evaluate(`(async()=>{await app.plugins.unloadPlugin('codex-echoink');await app.plugins.loadPlugin('codex-echoink');})()`);await home();assert.equal(await c.evaluate('(async()=>(await h.port.load()).signals.filter(s=>s.id===7).length)()'),0);report.push({case:'reload-persists',passed:true});
 await c.evaluate(`app.fileManager.processFrontMatter(app.vault.getFileByPath('R-CFBE83/raw/合成资料1.md'),fm=>{fm['合成属性']='程序回写';})`);await home();assert.equal(await c.evaluate('(async()=>(await h.port.load()).signals.filter(s=>s.id===7).length)()'),0);report.push({case:'metadata-no-wake',passed:true});
 await c.evaluate(`app.vault.process(app.vault.getFileByPath('R-CFBE83/raw/合成资料1.md'),text=>text+'\\n新增合成正文。')`);await home();assert.equal(await c.evaluate('(async()=>(await h.port.load()).signals.filter(s=>s.id===7).length)()'),1);report.push({case:'body-edit-wakes',passed:true});
 await click('忽略');await click('恢复已忽略建议');assert.equal(await c.evaluate('(async()=>(await h.port.load()).signals.filter(s=>s.id===7).length)()'),1);report.push({case:'restore',passed:true});
 await c.evaluate(`window.__originalSave=p.saveSettings;p.saveSettings=async()=>{throw Error('synthetic save failure')}`);await click('忽略');assert.equal(await c.evaluate('(async()=>(await h.port.load()).signals.filter(s=>s.id===7).length)()'),1);await c.evaluate('p.saveSettings=__originalSave');report.push({case:'save-failure-retains-card',passed:true});await c.screenshot('desktop-save-failure');await delay(2700);
 await c.evaluate(`(async()=>{p.settings.settingsLanguage='en';await p.saveSettings(true,{flushConversationStore:false});h.refreshLanguage();})()`);await home();await c.send('Emulation.setDeviceMetricsOverride',{width:700,height:900,deviceScaleFactor:1,mobile:false});await delay(150);await c.screenshot('desktop-en-narrow');
 await click('Dismiss');await c.screenshot('desktop-en-restore');await click('Restore dismissed suggestions');report.push({case:'english-dismiss-and-restore',passed:true});
 if(process.argv.includes('--leave-dismissed'))await click('Dismiss');
 await c.write('native-a-results.json',report);console.log(report);
}finally{c.close();}
