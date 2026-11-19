import {connect,delay} from './cdp.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {out} from './cdp.mjs';

// Pointer presses are real; click activation is intercepted so this audit
// blocks click-activated actions. Custom drag/pointer actions and native
// range/select controls are excluded rather than assumed safe.
const settingsOnly=process.argv.includes('--settings-only'),sceneOnly=process.argv.find(x=>x.startsWith('--scene='))?.slice(8);
let child;
const c=await connect(),results=settingsOnly||sceneOnly?JSON.parse(await fs.readFile(path.join(out,'controls-audit.json'),'utf8')).filter(row=>sceneOnly?row.scene!==sceneOnly:!row.scene.startsWith('settings-')):[];
try{
  const install=`window.__auditBlockClick=e=>{if(e.isTrusted){e.preventDefault();e.stopImmediatePropagation();}};document.addEventListener('click',__auditBlockClick,true);
    window.__auditStyle=e=>[e,e.closest('.wb-task,.echoink-task-card')].filter(Boolean).map(n=>{const s=getComputedStyle(n);return [s.backgroundColor,s.color,s.opacity,s.transform,s.filter,s.boxShadow,s.outlineStyle];});`;
  await c.evaluate(install);
  const scenes=[
    ['conversation',`await p.activateView();window.v=p.getCodexView();await v.openTaskDetail(p.settings.sessions.find(s=>s.id.startsWith('conversation-')).id);`,`.codex-container`],
    ['task-list',`await v.openAgentTaskList('sol');`,`.codex-container`],
    ['workbench',`await p.activateHomeView({keepRightSidebar:true});`,`.echoink-workbench`],
    ...['general','models','agent','memory','modules','capabilities','account','modules-expanded'].map(category=>['settings-'+category,`app.setting.open();app.setting.openTabById('codex-echoink');await p.settingsTabInstance.activateSettingsTab('${category==='modules-expanded'?'modules':category}',true);${category==='modules-expanded'?`for(const button of p.settingsTabInstance.containerEl.querySelectorAll('button[aria-expanded=false][aria-controls]')){const target=button.ownerDocument.getElementById(button.getAttribute('aria-controls'));if(target?.classList.contains('echoink-module-drawer-content'))button.click();}`:''}`,null])
  ];
  for(const [scene,setup,selector] of scenes){
    if(sceneOnly&&scene!==sceneOnly||settingsOnly&&!scene.startsWith('settings-'))continue;
    await c.evaluate(`(async()=>{${setup}})()`);await delay(250);
    let input=c;
    if(scene.startsWith('settings-')){
      const tag=scene+'-'+Date.now();
      await c.evaluate(`(()=>{const w=p.settingsTabInstance.containerEl.ownerDocument.defaultView;w.__smoothApp=app;w.p=p;w.v=v;w.__smoothAuditTag=${JSON.stringify(tag)};})()`);
      const targets=await(await fetch('http://127.0.0.1:'+Number(process.env.ECHOINK_PERF_PORT??19463)+'/json/list')).json();
      for(const target of targets.filter(t=>t.type==='page'&&t.url==='about:blank')){
        let candidate;
        try{candidate=await connect({targetId:target.id});if(await candidate.evaluate('__smoothAuditTag')===tag){child=candidate;input=child;break;}}catch{};
        candidate?.close();
      }
      if(input===c)throw Error('Owned settings window not found');
      await input.evaluate(install);
    }
    const count=await input.evaluate(`(()=>{const root=${selector?`document.querySelector(${JSON.stringify(selector)})`:'p.settingsTabInstance.containerEl'};
      window.__auditTargets=[...root.querySelectorAll('button,summary,input,select,textarea,a[href],[role="button"]')].filter(e=>{const r=e.getBoundingClientRect();return r.width&&r.height&&!e.disabled&&!e.closest('[hidden],[aria-hidden="true"]');});return __auditTargets.length;})()`);
    for(let index=0;index<count;index++){
      const target=await input.evaluate(`(()=>{const e=__auditTargets[${index}];if(!e?.isConnected)return null;e.scrollIntoView({block:'center',inline:'nearest'});const r=e.getBoundingClientRect();return {tag:e.tagName,type:e.type,label:(e.getAttribute('aria-label')||e.getAttribute('data-tooltip-position')&&e.getAttribute('aria-label')||e.textContent||e.placeholder||e.title||'').trim().slice(0,100),cls:String(e.className),x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      if(!target)continue;
      if(target.cls.includes("wb-weather-stage")||target.tag==="SELECT"||target.type==="range"){results.push({scene,...target,covered:false,reason:"manual drag/native chooser; no automated press"});continue;}
      await input.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:target.x,y:target.y});await delay(180);
      const ready=await input.evaluate(`(()=>{const e=__auditTargets[${index}],r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!e.isConnected||!e.contains(document.elementFromPoint(x,y)))return null;
        window.__auditBefore=JSON.stringify(__auditStyle(e));window.__auditMenus=document.querySelectorAll('.menu,[data-radix-popper-content-wrapper]').length;
        window.__auditPressed=new Promise(resolve=>document.addEventListener('pointerdown',()=>{const t=performance.now();requestAnimationFrame(()=>resolve({ms:performance.now()-t,changed:__auditBefore!==JSON.stringify(__auditStyle(e)),focused:document.activeElement===e,active:e.matches(':active'),marker:e.dataset.echoinkPressed,scoped:!!e.closest('[data-echoink-press-scope]'),connected:e.isConnected,popupOpened:document.querySelectorAll('.menu,[data-radix-popper-content-wrapper]').length>__auditMenus}));},{once:true,capture:true}));return {x,y};})()`);
      if(!ready){results.push({scene,...target,covered:false,reason:'covered or moved'});continue;}
      await input.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...ready});
      const pressed=await input.evaluate('__auditPressed');
      const outside=await input.evaluate('({x:2,y:innerHeight-2})');
      await input.send('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,...outside});
      await input.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...outside});
      if(await input.evaluate(`document.querySelectorAll('.menu,[data-radix-popper-content-wrapper]').length>__auditMenus`)){
        await input.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});await input.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape'});
      }
      results.push({scene,...target,covered:true,pressed});
    }
    await c.write('controls-audit.json',results);
    if(child){await child.evaluate('document.removeEventListener("click",__auditBlockClick,true)');child.close();child=undefined;}
    if(scene.startsWith('settings-'))await c.evaluate('app.setting.close()');
  }
  console.log({controls:results.length,measured:results.filter(r=>r.covered).length,noStyleFeedback:results.filter(r=>r.covered&&!r.pressed.changed).map(r=>({scene:r.scene,label:r.label,tag:r.tag}))});
}finally{if(child){try{await child.evaluate('document.removeEventListener("click",__auditBlockClick,true)');}catch{}child.close();}await c.evaluate('document.removeEventListener("click",__auditBlockClick,true);app.setting.close()');c.close();}
