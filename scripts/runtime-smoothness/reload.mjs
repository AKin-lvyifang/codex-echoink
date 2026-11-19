import fs from 'node:fs/promises';
import path from 'node:path';
import {connect,delay,vault} from './cdp.mjs';

const c=await connect(),buildRoot=path.resolve(process.env.ECHOINK_PERF_BUILD_ROOT??process.cwd());
try{
  const deployment=[];
  if(process.argv.includes('--deploy')){
    const plugin=path.join(vault,'.obsidian/plugins/codex-echoink'),data=path.join(plugin,'data.json'),before=await fs.stat(data),settings=await fs.readFile(data);
    for(const [name,source] of [['main.js','dist/main.js'],['manifest.json','manifest.json'],['styles.css','styles.css']]){
      const artifact=path.join(buildRoot,source);await fs.copyFile(artifact,path.join(plugin,name));const bytes=await fs.readFile(artifact);
      if(!bytes.equals(await fs.readFile(path.join(plugin,name))))throw Error('Deployment readback differs: '+name);
      deployment.push({name,bytes:bytes.length,identical:true});
    }
    const after=await fs.stat(data);if(before.ino!==after.ino||before.mtimeMs!==after.mtimeMs||!settings.equals(await fs.readFile(data)))throw Error('Deployment changed settings');
  }
  await c.evaluate('app.setting?.close();void 0');
  await c.send('Page.enable');
  const loaded=new Promise(resolve=>c.on('Page.loadEventFired',resolve));
  await c.send('Page.reload',{ignoreCache:true});await loaded;
  for(let i=0;i<100;i++){if(await c.evaluate("!!window.app?.plugins?.manifests?.['codex-echoink']"))break;await delay(100);}
  await c.evaluate(`(async()=>{await app.plugins.setEnable(true);await app.plugins.loadPlugin('codex-echoink');window.p=app.plugins.plugins['codex-echoink'];if(!p)throw Error('plugin did not load');if(p.settings.apiProviders.some(a=>a.baseUrl!=='http://127.0.0.1:19464/v1'))throw Error('Configure the disposable fake Provider before reloading');await p.activateHomeAndSidebar();window.v=p.getCodexView();await p.ensurePiProductionRuntime();})()`);
  if(!process.argv.includes('--no-probe')){await c.evaluate(await fs.readFile(new URL('./probe.js',import.meta.url),'utf8'));await c.evaluate('__smooth.attach()');}
  await c.evaluate(`(()=>{const later=[...document.querySelectorAll('button')].find(button=>['稍后再说','Maybe later'].includes(button.textContent));later?.click();})()`);
  const trust=await c.evaluate(`(()=>{const modal=[...document.querySelectorAll('.modal-container')].find(e=>e.textContent.includes('信任这个仓库的作者'));if(!modal)return {present:false};const button=[...modal.querySelectorAll('button')].find(e=>e.textContent.includes('信任仓库作者并启用插件'));if(!button)throw Error('Expected own test Vault trust button missing');button.click();return {present:true,confirmedOwnTestBuild:true};})()`);
  if(trust.present)await delay(200);
  await c.evaluate(`if(document.querySelector('.modal-container'))throw Error('Blocking modal must be resolved before acceptance')`);
  const readback=await c.evaluate(`({vault:app.vault.adapter.getBasePath(),version:p.manifest.version,viewport:[innerWidth,innerHeight],stage:app.workspace.getLeavesOfType('codex-echoink-home')[0].view.weatherStage.agent,idlePauseMs:app.workspace.getLeavesOfType('codex-echoink-home')[0].view.weatherStage.idlePauseMs,refreshRunProgress:typeof v.messageListRenderer.refreshRunProgress,referenceVerificationMode:p.piRuntimeBundle.runtime.options.knowledge.referenceVerificationMode})`);
  await c.write('reload-deployment.json',{deployment,buildRoot,trust,dataPreserved:true,...readback});console.log(readback);
}finally{c.close();}
