import {configureNative} from "./environment.mjs";
import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
await configureNative();
const{connect,delay}=await import('../runtime-smoothness/cdp.mjs');let c=await connect();const results=[];
try{
 await c.evaluate(`(async()=>{window.p=app.plugins.plugins['codex-echoink'];p?.hideEchoInkOnboardingWorkspaceCard?.();await app.plugins.unloadPlugin('codex-echoink');return true;})()`);
 for(const[n,s]of[['main.js','dist/main.js'],['manifest.json','manifest.json'],['styles.css','styles.css']])await fs.copyFile(s,path.join(process.env.ECHOINK_PERF_VAULT,'.obsidian/plugins/codex-echoink',n));
 await fs.writeFile(path.join(process.env.ECHOINK_PERF_VAULT,'.obsidian/community-plugins.json'),'[]');
 await c.evaluate(`(()=>{setTimeout(()=>app.emulateMobile(true),20);return true;})()`);await delay(1000);c.close();c=await connect();
 for(const device of ['iphone','ipad']){
  const size=device==='iphone'?{width:390,height:844}:{width:1180,height:820},prefix=device==='iphone'?'ip':'pd';
  await c.send('Emulation.setDeviceMetricsOverride',{...size,screenWidth:size.width,screenHeight:size.height,deviceScaleFactor:1,mobile:true});await c.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});await delay(500);
  await c.evaluate(`(async()=>{for(let i=0;i<100&&!app.workspace.layoutReady;i++)await new Promise(r=>setTimeout(r,50));await app.plugins.unloadPlugin('codex-echoink');const own=Object.hasOwn, originals=new Map();
    // Obsidian 1.15.1 loads compiled factories outside window.eval. Adapt only this disposable plugin's import map.
    Object.hasOwn=function(object,key){const present=own(object,key);if(present&&key==='obsidian'&&!originals.has(object)){originals.set(object,object[key]);object[key]={...object[key],Platform:{...object[key].Platform,isMobileApp:true,isDesktopApp:false,isDesktop:false,isMobile:true,isPhone:${device==='iphone'},isTablet:${device==='ipad'},isIosApp:true,isAndroidApp:false}};}return present;};
    document.body.classList.add('emulate-mobile');document.body.classList.toggle('is-phone',${device==='iphone'});document.body.classList.toggle('is-tablet',${device==='ipad'});
    try{await app.plugins.setEnable(true);await app.plugins.loadPlugin('codex-echoink');}finally{Object.hasOwn=own;for(const[registry,value]of originals)registry.obsidian=value;}
    window.p=app.plugins.plugins['codex-echoink'];if(!p.workbench||!p.runtime)throw Error('Production mobile bundle required');p.settings.workbenchDismissals={version:1,entries:{}};p.settings.settingsLanguage='zh-CN';await p.saveSettings();${device==='iphone'?"await p.openIPhoneRoute({kind:'home'});":"await p.ipadNavigation.openHome();"}return true;})()`);await delay(300);
  const route=device==='iphone'?"await p.openIPhoneRoute({kind:'home'});":"await p.ipadNavigation.openHome();";
  const refresh=async()=>{await c.evaluate(`(async()=>{p.workbench.refreshTasks();${route}return true;})()`);await delay(200);};
  const tap=async label=>{const xy=await c.evaluate(`(()=>{const b=[...document.querySelectorAll('.echoink-${device} button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}&&b.getBoundingClientRect().height);if(!b)throw Error('Missing '+${JSON.stringify(label)});b.scrollIntoView({block:'nearest'});const r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,height:r.height};})()`);assert.ok(xy.height>=44);await c.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:xy.x,y:xy.y,id:1}]});await c.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await refresh();return xy.height;};
  assert.equal(await c.evaluate('(async()=>(await p.workbench.load()).signals.filter(s=>s.id===7).length)()'),1);await c.screenshot(device+'-zh-suggestions');const hitHeight=await tap('忽略');assert.equal(await c.evaluate('(async()=>(await p.workbench.load()).signals.filter(s=>s.id===7).length)()'),0);await c.screenshot(device+'-zh-restore');await tap('恢复已忽略建议');
  await c.evaluate(`(async()=>{p.settings.settingsLanguage='en';await p.saveSettings();${route}return true;})()`);await refresh();await c.screenshot(device+'-en-suggestions');await tap('Dismiss');await c.screenshot(device+'-en-restore');await tap('Restore dismissed suggestions');
  const geometry=await c.evaluate(`(()=>{const r=document.querySelector('.echoink-${device}');return{viewport:[innerWidth,innerHeight],touch:navigator.maxTouchPoints,overflow:r.scrollWidth>r.clientWidth,buttons:[...r.querySelectorAll('.${prefix}-signal-actions button')].map(b=>({label:b.textContent.trim(),height:b.getBoundingClientRect().height,width:b.getBoundingClientRect().width}))};})()`);assert.ok(!geometry.overflow);results.push({device,hitHeight,...geometry,ignoredAndRestored:true});await c.write('native-mobile-results.json',results);
 }
 console.log(results);
}finally{c.close();}
