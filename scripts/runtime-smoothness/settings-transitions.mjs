import {connect,delay} from './cdp.mjs';
import {ownedSettings} from './owned-settings.mjs';
const c=await connect();let child;
try {
 await c.evaluate('(async()=>{app.setting.open();app.setting.openTabById("codex-echoink");await p.settingsTabInstance.activateSettingsTab("general",true)})()');
 child=await ownedSettings(c);const samples=[];
 for(const category of ['general','models','agent','memory','modules','capabilities','account','general']) {
  samples.push(await child.evaluate(`(async()=>{const t=performance.now();await p.settingsTabInstance.activateSettingsTab(${JSON.stringify(category)},true);await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return {category:${JSON.stringify(category)},ms:performance.now()-t,nodes:p.settingsTabInstance.containerEl.querySelectorAll('*').length,pressed:document.querySelectorAll('[data-echoink-pressed]').length};})()`));await delay(550);
 }
 await child.screenshot('settings-general-owned');await c.write('settings-transitions.json',samples);console.log(samples);
} finally {child?.close();c.close()}
