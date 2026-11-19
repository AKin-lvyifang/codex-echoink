import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {connect,delay,device,size,attach,fake,vault,out} from './mobile-common.mjs';
const mode=process.argv[2]??'setup',c=mode==='configure'?null:await connect();
try{
  if(mode==='configure'){
    const file=path.join(vault,'.obsidian/plugins/codex-echoink/data.json'),data=JSON.parse(await fs.readFile(file,'utf8'));
    const provider={id:'mobile-perf-local',name:'本机固定回放',providerId:'deepseek',authMode:'api-key',apiProtocol:'openai-completions',baseUrl:fake+'/v1',apiKey:'fake-local-only',mobileStreaming:true,defaultModelId:'deepseek-chat',models:[{id:'deepseek-chat',displayName:'固定回放',input:['text'],contextWindow:64000,maxOutputTokens:4096,reasoning:true,reasoningEnabled:true,toolCalling:true}]};
    Object.assign(data,{apiProviders:[provider],activeApiProviderId:provider.id,defaultModel:'deepseek-chat',autoOpenHome:false,syncMirrorEnabled:false,cloudSync:{enabled:false},smartJudgment:{enabled:false},mobileMemory:{dreamEnabled:false,autoArchive:false}});
    for(const agent of data.agentRegistry?.agents??[]){delete agent.model;delete agent.modelBinding;}
    await fs.writeFile(file,JSON.stringify(data));
    const preparedFile=path.join(out,'prepared-environment.json'),prepared=JSON.parse(await fs.readFile(preparedFile,'utf8'));
    prepared.sourceCommit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
    await fs.writeFile(preparedFile,JSON.stringify(prepared,null,2));
    console.log('Configured only the disposable copy with a fake loopback provider; no key output');
  }else if(mode==='deploy'){
    const plugin=path.join(vault,'.obsidian/plugins/codex-echoink'),data=path.join(plugin,'data.json'),before=await fs.stat(data),artifacts=[],buildRoot=process.env.ECHOINK_PERF_BUILD_ROOT??process.cwd();
    for(const [name,source] of [['main.js','dist/main.js'],['manifest.json','manifest.json'],['styles.css','styles.css']]){
      await fs.copyFile(path.join(buildRoot,source),path.join(plugin,name));artifacts.push({name,bytes:(await fs.stat(path.join(plugin,name))).size});
    }
    const after=await fs.stat(data);if(before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw Error('Deployment changed data.json');
    await c.write('deployment.json',{sourceCommit:execFileSync('git',['-C',buildRoot,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),buildRoot,artifacts,dataPreserved:true});console.log({artifacts,dataPreserved:true});
  }else if(mode==='setup'){
    await c.send('Emulation.setDeviceMetricsOverride',{...size,deviceScaleFactor:2,mobile:true});
    await c.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
    await c.send('Page.reload');await delay(1400);
    await c.evaluate(`(async()=>{
      if(!document.body.classList.contains('emulate-mobile'))throw Error('Call app.emulateMobile(true) once before setup');
      await app.plugins.unloadPlugin('codex-echoink');
      const original=window.eval;window.__mobilePlatformBefore=null;
      window.eval=function(source){const compiled=original(source);if(typeof source!=='string'||!source.includes('sourceURL=plugin:codex-echoink'))return compiled;
        return function(require,module,exports){return compiled(id=>{const value=require(id);if(id!=='obsidian')return value;
          window.__mobilePlatformBefore={...value.Platform};return {...value,Platform:{...value.Platform,isMobileApp:true,isDesktopApp:false,isDesktop:false,isMobile:true,isPhone:${device==='iphone'},isTablet:${device==='ipad'},isIosApp:true,isAndroidApp:false}};
        },module,exports);};};
      document.body.classList.toggle('is-phone',${device==='iphone'});document.body.classList.toggle('is-tablet',${device==='ipad'});
      try{await app.plugins.setEnable(true);await app.plugins.loadPlugin('codex-echoink');}finally{window.eval=original;}
      window.p=app.plugins.plugins['codex-echoink'];
      if(p.settings.apiProviders.some(a=>a.baseUrl!==${JSON.stringify(fake+'/v1')}))throw Error('Fake provider configuration required');
      // Start every cold/warm pair with the same one-empty-task population.
      ${process.argv.includes('--preserve')?'':`const seed=await p.store.createSession('sol');await p.store.update(s=>{s.sessions=[seed];s.activeSessionId=seed.id;s.page={kind:'list',agentId:'sol'};});`}
      ${device==='iphone'?'await p.openIPhoneRoute({kind:"agent",agentId:"sol"});':'await p.ipadNavigation.openHome();await p.openIPadAgent({kind:"agent",agentId:"sol"});await app.workspace.rightSplit.expand();'}
      return true;
    })()`);
    await delay(1000);const result=await attach(c);
    result.platformBefore=await c.evaluate(`Object.fromEntries(['isMobileApp','isDesktopApp','isMobile','isPhone','isTablet','isIosApp','isSafari','version','build'].map(k=>[k,__mobilePlatformBefore[k]]))`);
    result.platformOverride='Only the measured plugin require("obsidian").Platform; host emulate-mobile plus phone/tablet classes; artifact bytes unchanged';
    result.host=await c.evaluate('({electron:process.versions.electron,chrome:process.versions.chrome,app:app.getVersion?.(),focus:document.hasFocus(),visibility:document.visibilityState,screen:[innerWidth,innerHeight],touch:navigator.maxTouchPoints})');
    await c.write(device+'-environment.json',result);await c.screenshot(device+'-environment');console.log(result);
  }else throw Error('Unknown mode');
}finally{c?.close();}
