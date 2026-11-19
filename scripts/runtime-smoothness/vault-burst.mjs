import {connect,delay} from './cdp.mjs';
const c=await connect();
try{
  await c.evaluate(`(async()=>{window.p=app.plugins.plugins['codex-echoink'];await p.activateHomeView({keepRightSidebar:true});window.h=app.workspace.getLeavesOfType('codex-echoink-home')[0].view;for(const key of ['refresh','scheduleRefresh','refreshDaily'])__smooth.wrap(h,key,'home.'+key);__smooth.wrap(p.piRuntimeBundle.knowledgeAgentIndex,'invalidate','index.invalidate');})()`);
  const file=await c.evaluate(`(async()=>{const name='性能合成事件-'+Date.now()+'.md';await app.vault.create(name,'合成测量，不含真实内容。');return name;})()`);
  await delay(1000);await c.traceStart();await c.evaluate(`__smooth.reset();window.__perfVaultEvents={};window.__perfVaultTrigger=app.vault.trigger;app.vault.trigger=function(type,...args){if(['modify','create','rename','delete'].includes(type))__perfVaultEvents[type]=(__perfVaultEvents[type]??0)+1;return __perfVaultTrigger.call(this,type,...args);};`);
  const result=await c.evaluate(`(async()=>{const t=performance.now(),f=app.vault.getAbstractFileByPath(${JSON.stringify(file)});for(let i=0;i<100;i++)await app.vault.modify(f,'合成测量 '+i+'。');return {modifications:100,wallMs:performance.now()-t};})()`);
  await delay(1300);await c.traceEnd('vault-burst');await c.write('vault-burst.json',{...result,...await c.evaluate('({...__smooth.snapshot(),vaultEvents:__perfVaultEvents})')});
  await c.evaluate(`app.vault.trigger=__perfVaultTrigger;`);console.log(result);
}finally{c.close();}
