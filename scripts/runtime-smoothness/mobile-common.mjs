import path from 'node:path';
import os from 'node:os';
process.env.ECHOINK_PERF_VAULT ??= path.join(os.homedir(),'EchoInk-TestVaults/测试仓库-手机端丝滑度验收');
process.env.ECHOINK_PERF_PORT ??= '19571';
process.env.ECHOINK_PERF_OUT ??= path.resolve('docs/internal/test-evidence/2026-11-15-手机端运行丝滑度/baseline');
const cdp=await import('./cdp.mjs');
export const {delay,out,vault}=cdp;
if(path.dirname(path.resolve(vault))!==path.join(os.homedir(),'EchoInk-TestVaults')||!path.basename(vault).startsWith('测试仓库-'))throw Error('Named disposable Vault required');
export const fake=`http://127.0.0.1:${process.env.ECHOINK_FAKE_PORT??19572}`;
export const device=process.argv[3]??'iphone';
if(!['iphone','ipad'].includes(device))throw Error('iphone or ipad required');
export const prefix=device==='iphone'?'ip':'pd';
export const size=device==='iphone'?{width:390,height:844}:{width:1180,height:820};
// Emulation overrides belong to the CDP connection, not the browser profile.
// Every measurement connection must set them and assert the readback itself.
export async function connect(){
  const c=await cdp.connect();
  await c.send('Emulation.setDeviceMetricsOverride',{...size,screenWidth:size.width,screenHeight:size.height,deviceScaleFactor:2,mobile:true});
  await c.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
  // The desktop host debounces its phone/tablet classification after a CDP resize.
  // Settle outside measured windows so a previous connection's desktop size cannot leak in.
  for(let n=0;n<100;n++){
    const identity=await c.evaluate(`({mobile:document.body?.classList.contains('emulate-mobile'),phone:document.body?.classList.contains('is-phone'),tablet:document.body?.classList.contains('is-tablet')})`);
    if(!identity.mobile)break;
    if(device==='iphone'?identity.phone&&!identity.tablet:identity.tablet&&!identity.phone){await delay(50);break;}
    if(n===99)throw Error('Host mobile identity did not settle');await delay(16);
  }
  return c;
}
export const frames=`()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`;
export async function attach(c){
  return c.evaluate(`(()=>{window.p=app.plugins.plugins['codex-echoink'];if(!p?.runtime||!p?.store)throw Error('Production mobile plugin required');if(innerWidth!==${size.width}||innerHeight!==${size.height}||navigator.maxTouchPoints!==5)throw Error('Device emulation readback mismatch');if(p.settings.apiProviders.length!==1||p.settings.apiProviders[0].baseUrl!==${JSON.stringify(fake+'/v1')})throw Error('Local fake provider required');window.mv=app.workspace.getLeavesOfType('${device==='iphone'?'echoink-iphone-shell':'echoink-ipad-agent-shell'}')[0]?.view;window.ui=mv?.ui;if(!ui)throw Error('Expected device shell not mounted');return {vault:app.vault.adapter.getBasePath(),version:p.manifest.version,classes:document.body.className,viewport:[innerWidth,innerHeight],shell:ui.constructor.name,tablet:!!p.ipadNavigation,phone:!!p.iphoneNavigation,tasks:p.store.state.sessions.length};})()`);
}
export async function route(c,r){await c.evaluate(`p.${device==='iphone'?'openIPhoneRoute':'openIPadAgent'}(${JSON.stringify(r)})`);}
export async function tap(c,selector){
  const xy=await c.evaluate(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>!e.closest('[hidden],[inert]')&&e.getBoundingClientRect().height);if(!e)throw Error('Missing touch target');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!e.contains(document.elementFromPoint(x,y)))throw Error('Covered touch target');return {x,y};})()`);
  await c.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...xy,id:1}]});
  await c.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
}
