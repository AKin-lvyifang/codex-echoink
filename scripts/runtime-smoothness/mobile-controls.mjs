import {connect,delay,device,prefix,attach} from './mobile-common.mjs';
const c=await connect(),rows=[],scenes=device==='iphone'?[
 ['home',`await ui.navigate({kind:'home'})`],['agent',`await ui.navigate({kind:'agent',agentId:'sol'})`],
 ['task',`await ui.navigate({kind:'task',taskId:p.store.state.sessions.find(s=>s.messages.length===2).id})`],
 ['model-sheet',`[...document.querySelectorAll('.ip-composer-model')].find(e=>!e.closest('[hidden]')).click()`],
 ['permission-sheet',`ui.shell.closeSheet();[...document.querySelectorAll('.ip-composer-icon')].find(e=>!e.closest('[hidden]')&&e.getAttribute('aria-label')?.includes('工作区权限')).click()`],
 ...[undefined,'general','model','agent','memory','caps','mods','account'].map(x=>['settings-'+(x??'root'),`ui.shell.closeSheet();await ui.settingsPages.open(${JSON.stringify(x)??'undefined'})`])
]:[
 ['home',`await p.ipadNavigation.openHome();app.workspace.rightSplit.collapse()`],['agent',`await p.openIPadAgent({kind:'agent',agentId:'sol'})`],
 ['task',`await p.openIPadAgent({kind:'task',taskId:p.store.state.sessions.find(s=>s.messages.length===2).id})`],
 ['model-sheet',`[...document.querySelectorAll('.pd-composer-model')].find(e=>!e.closest('[hidden]')).click()`],
 ['permission-sheet',`ui.shell.closeSheet();[...document.querySelectorAll('.pd-composer-icon')].find(e=>!e.closest('[hidden]')&&e.getAttribute('aria-label')?.includes('工作区权限')).click()`],
 ...[undefined,'general','model','agent','memory','caps','mods','account'].map(x=>['settings-'+(x??'root'),`ui.shell.closeSheet();app.workspace.rightSplit.collapse();await p.openIPadSettings(${JSON.stringify(x)??'undefined'})`])
];
try{
 const environment=await attach(c);
 await c.evaluate(`window.__blockAuditClick=e=>{if(e.isTrusted){e.preventDefault();e.stopImmediatePropagation();}};document.addEventListener('click',__blockAuditClick,true);
 window.__controlStyle=e=>[e,...e.querySelectorAll('span')].slice(0,15).map(n=>[null,'::before','::after'].map(pseudo=>{const s=getComputedStyle(n,pseudo);return [s.content,s.opacity,s.backgroundColor,s.color,s.transform,s.boxShadow,s.outlineColor];}));`);
 for(const [scene,setup] of scenes){
  await c.evaluate(`(async()=>{${setup}})()`);await delay(220);
  const count=await c.evaluate(`(()=>{const scope=${device==='ipad'&&scene.startsWith('settings-')?`document.querySelector('.pd-settings')`:'document'};if(!scope||scope instanceof HTMLElement&&!scope.getBoundingClientRect().height)throw Error('Expected scene root missing or hidden');window.__auditNodes=[...scope.querySelectorAll('.echoink-iphone button,.echoink-ipad button,.echoink-iphone summary,.echoink-ipad summary,.echoink-iphone input,.echoink-ipad input,.echoink-iphone textarea,.echoink-ipad textarea,.echoink-iphone select,.echoink-ipad select,.echoink-iphone a[href],.echoink-ipad a[href],.echoink-iphone [role="link"],.echoink-ipad [role="link"]')].filter(e=>!e.closest('[hidden],[inert],[aria-hidden="true"]')&&e.getBoundingClientRect().height);return __auditNodes.length;})()`);
  for(let i=0;i<count;i++){
   const target=await c.evaluate(`(()=>{const e=__auditNodes[${i}];if(!e?.isConnected)return {skip:'removed'};const row={label:(e.getAttribute('aria-label')||e.textContent||e.placeholder||'').trim().slice(0,90),tag:e.tagName,cls:String(e.className),type:e.type};if(e.disabled)return {...row,skip:'disabled'};if(e.tagName==='SELECT'||e.type==='range')return {...row,skip:'native chooser / range; device verification'};e.scrollIntoView({block:'center',inline:'nearest'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!e.contains(document.elementFromPoint(x,y)))return {...row,skip:'covered / outside viewport'};window.__control=e;window.__before=JSON.stringify(__controlStyle(e));window.__pressResult=null;window.__pressOnce=()=>{const t=performance.now();requestAnimationFrame(()=>{window.__pressResult={ms:performance.now()-t,changed:__before!==JSON.stringify(__controlStyle(e)),focused:document.activeElement===e,active:e.matches(':active'),connected:e.isConnected};});};document.addEventListener('touchstart',__pressOnce,{once:true,capture:true});return {...row,x,y};})()`);
   if(target.skip){rows.push({scene,...target});continue;}
   await c.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:target.x,y:target.y,id:1}]});
   let pressed;for(let n=0;n<20;n++){pressed=await c.evaluate('__pressResult');if(pressed)break;await delay(10);}
   await c.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
   rows.push({scene,...target,pressed,pass:!!(pressed?.changed||pressed?.focused)});
  }
  await c.write(device+'-controls.json',{device,environment,rows,summary:{total:rows.length,measured:rows.filter(r=>r.pressed).length,pass:rows.filter(r=>r.pass).length,fail:rows.filter(r=>r.pressed&&!r.pass).length},limitations:'Chromium touchStart first rAF including pseudo-element styles; click activation blocked. No claim for WebKit :active or native input/chooser.'});
 }
 console.log({device,total:rows.length,measured:rows.filter(r=>r.pressed).length,pass:rows.filter(r=>r.pass).length,failed:rows.filter(r=>r.pressed&&!r.pass).length});
}finally{await c.evaluate('document.removeEventListener("click",window.__blockAuditClick,true);document.removeEventListener("touchstart",window.__pressOnce,true)');c.close();}
