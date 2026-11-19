import {connect} from './cdp.mjs';
/** Only discover the settings document owned by this disposable Vault. */
export async function ownedSettings(main) {
 const tag='smooth-settings-'+Date.now();
 await main.evaluate(`(()=>{const w=p.settingsTabInstance.containerEl.ownerDocument.defaultView;w.__smoothApp=app;w.p=p;w.v=v;w.__smoothAuditTag=${JSON.stringify(tag)};})()`);
 const targets=await(await fetch('http://127.0.0.1:'+Number(process.env.ECHOINK_PERF_PORT??19463)+'/json/list')).json();
 for(const target of targets.filter(t=>t.type==='page'&&t.url==='about:blank')){
  let child;try {child=await connect({targetId:target.id});if(await child.evaluate('window.__smoothAuditTag')===tag)return child;}catch{}child?.close();
 }
 throw Error('Owned settings document not found');
}
