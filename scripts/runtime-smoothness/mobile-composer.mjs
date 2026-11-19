import assert from 'node:assert/strict';
import path from 'node:path';
import {build} from 'esbuild';
import {mobileBuildOptions} from '../mobile-build.mjs';
import {connect,delay} from './cdp.mjs';

// Chromium layout of the real phone controller/CSS with an in-memory fixture.
// This is deliberately separate from iOS device acceptance.
const options=mobileBuildOptions();delete options.entryPoints;
const built=await build({...options,external:[],format:'iife',globalName:'__perfMobile',
  stdin:{contents:`export {MobileUI} from './src/ui/mobile/mobile-ui';export {MobileStore} from './src/mobile/store';export {MobileRuntime} from './src/mobile/runtime';export {loadMobileSettings} from './src/mobile/settings';export {createHost} from './tests/mobile/host.mjs';`,resolveDir:process.cwd(),loader:'ts'},
  alias:{obsidian:path.resolve('tests/mobile/browser-obsidian.ts')}});
const c=await connect(),result=[];
try{
  await c.evaluate(built.outputFiles[0].text);
  await c.evaluate(`(async()=>{const a=__perfMobile,h=a.createHost();h.app.workspace.containerEl=document.body;const store=new a.MobileStore(h.adapter,'plugin/mobile','perf');await store.load();const settings=a.loadMobileSettings({}),runtime=new a.MobileRuntime(h.app,store,()=>settings,async()=>{throw Error('No Provider calls in this fixture')});await runtime.initialize();const root=document.createElement('div');Object.assign(root.style,{position:'fixed',inset:'0',height:'800px',zIndex:'999999',background:'var(--background-primary)'});document.body.append(root);const ui=new a.MobileUI(root,{app:h.app,store,runtime,settings:()=>settings,async saveSettings(){},async openNote(){},beginRender(){},renderMarkdown(text,element){element.textContent=text;}});ui.mount();window.__mobileGeometry={root,ui,runtime,store};})()`);
  for(const width of [390,430]){
    await c.evaluate(`__mobileGeometry.root.style.width='${width}px'`);await delay(150);
    const samples=[];
    for(let i=0;i<50;i++){
      samples.push(await c.evaluate(`(()=>{const {root,ui}=__mobileGeometry;ui.refreshChat();const input=root.querySelector('.em-input'),r=input.getBoundingClientRect();return {y:r.y,height:r.height,same:!window.__mobilePreviousInput||window.__mobilePreviousInput===input,...(window.__mobilePreviousInput=input,{})};})()`));
      await delay(20);
    }
    const heights=[...new Set(samples.map(s=>s.height))],positions=[...new Set(samples.map(s=>s.y))];
    assert.equal(heights.length,1);assert.equal(positions.length,1);assert.ok(samples.every(s=>s.same));
    result.push({width,samples:50,heights,positions,inputIdentityRetained:true});await c.screenshot('mobile-composer-'+width);
  }
  await c.write('mobile-composer.json',{environment:'desktop Chromium, actual MobileUI and CSS; not iOS device',result});console.log(result);
}finally{await c.evaluate(`if(window.__mobileGeometry){const a=__mobileGeometry;a.ui.destroy();a.runtime.dispose();a.root.remove();delete window.__mobileGeometry;delete window.__mobilePreviousInput;}`);c.close();}
