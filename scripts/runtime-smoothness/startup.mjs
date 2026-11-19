import fs from 'node:fs/promises';
import {connect,delay} from './cdp.mjs';
const c=await connect();
try {
  await c.evaluate(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent==='信任仓库作者并启用插件');b?.click(); })()`);
  await delay(300);
  if(await c.evaluate(`!!app.plugins.plugins['codex-echoink']`))throw Error('First-load trace requires plugin disabled at process start');
  await c.evaluate(await fs.readFile(new URL('./probe.js',import.meta.url),'utf8'));
  await c.evaluate(`(() => { const old=app.plugins.plugins;app.plugins.plugins=new Proxy(old,{set(target,key,value){if(key==='codex-echoink'){window.__smoothPhases=[];for(const prop of ['settings','appearance','homeActivity','usageStore','accountService','lifestyle','inlineAgent','noteComments','quickChatWindow','diaryOrganizer']){let current=value[prop];Object.defineProperty(value,prop,{configurable:true,enumerable:true,get(){return current;},set(next){current=next;__smoothPhases.push({phase:prop,at:performance.now()});for(const method of ['initialize','register','start'])__smooth.wrap(next,method,'startup.'+prop+'.'+method);}});}const onload=value.onload;value.onload=function(...args){__smoothPhases.push({phase:'onload:start',at:performance.now()});const r=onload.apply(this,args);r.then(()=>__smoothPhases.push({phase:'onload:done',at:performance.now()}));return r;};for(const name of ['onload','loadSettings','loadCSS','startDecisionClient','initializeKnowledgeActivityStatusBar','applyAppearanceTheme','getTodoReminderService'])__smooth.wrap(value,name,'startup.'+name);}target[key]=value;return true;}}); })()`);
  await c.traceStart();
  const result=await c.evaluate(`(async()=>{const t=performance.now();await app.plugins.enablePlugin('codex-echoink');return {loadPluginMs:performance.now()-t,vault:app.vault.adapter.getBasePath(),version:app.plugins.manifests['codex-echoink'].version,userAgent:navigator.userAgent,viewport:{w:innerWidth,h:innerHeight,dpr:devicePixelRatio},plugins:Object.keys(app.plugins.plugins)};})()`);
  await delay(1500);
  await c.traceEnd(process.env.ECHOINK_PERF_NAME??'startup-phases');
  await c.write((process.env.ECHOINK_PERF_NAME??'startup-phases')+'.json',{...result,...await c.evaluate('({...__smooth.snapshot(),phases:__smoothPhases})')});
  await c.screenshot(process.env.ECHOINK_PERF_NAME??'startup-phases');
  console.log(result);
}finally{c.close();}
