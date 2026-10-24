import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
const root = fileURLToPath(new URL("../", import.meta.url));
// These are DOM unit tests; no Vault, installed plugin, network or stored account.
await mkdir(path.join(root,".tmp"),{recursive:true});
const run = await mkdtemp(path.join(root,".tmp/plan-entry-"));
const dom = new JSDOM("<!doctype html><body></body>",{pretendToBeVisual:true,url:"https://plan-entry.invalid"});
try {
  const win=dom.window;
  for(const name of ["window","document","navigator","Element","Node","NodeFilter","Document","DocumentFragment","MutationObserver","Event","CustomEvent","MouseEvent","KeyboardEvent","SVGElement","SVGSVGElement","DOMParser","XMLSerializer","FileReader","ShadowRoot",...Object.getOwnPropertyNames(win).filter(name=>/^HTML.*Element$/.test(name))]) Object.defineProperty(globalThis,name,{configurable:true,writable:true,value:name==="window"?win:win[name]});
  globalThis.getComputedStyle=win.getComputedStyle.bind(win);globalThis.requestAnimationFrame=win.requestAnimationFrame.bind(win);globalThis.cancelAnimationFrame=win.cancelAnimationFrame.bind(win);
  globalThis.ResizeObserver=class {observe(){} unobserve(){} disconnect(){}};
  win.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
  const output=path.join(run,"tests.mjs");
  await build({stdin:{resolveDir:root,loader:"ts",contents:`
    import assert from 'node:assert/strict';
    import {App} from './src/tests/obsidian-shim';
    import {installProviderBrowserHost} from './src/tests/provider-discovery-dom-host';
    import {createUnavailableAccountAdapter} from './src/settings/account-membership-model';
    import {mountDesktopAccountMembership} from './src/settings/desktop-account-membership';
    import {IPhoneAccountPages} from './src/ui/iphone/account-pages';
    import {createAccountPage} from './src/ui/ipad/account-pages';
    const tick=async()=>{for(let i=0;i<12;i++)await new Promise(r=>setTimeout(r,0));};
    export async function runTests(){
      installProviderBrowserHost(); HTMLElement.prototype.scrollIntoView=()=>{};
      for(const platform of ['desktop','iphone','ipad']){
        const empty=createUnavailableAccountAdapter().read();
        let vm={...empty,salesOpen:true,serviceAvailable:true};const listeners=new Set(),calls=[];
        const adapter={read:()=>vm,subscribe:f=>{listeners.add(f);return()=>listeners.delete(f);},actions:{selectPlan:async input=>{calls.push(input);}}};
        const emit=()=>listeners.forEach(f=>f());const host=document.body.createDiv();let dispose;
        if(platform==='desktop'){
          const ctl=mountDesktopAccountMembership(host,{app:new App(),viewModel:vm,read:()=>vm,subscribe:adapter.subscribe,actions:adapter.actions,language:'zh-CN',openProviders(){}});dispose=()=>ctl.dispose();
        }else if(platform==='iphone'){
          const pages=[];const shell={hasPage:id=>pages.some(p=>p.id===id),async push(p){pages.push(p);host.replaceChildren(p.content);return true;},async back(){pages.pop()?.dispose?.();return true;}};
          await new IPhoneAccountPages({document,shell,host:{accountService:adapter,settings:()=>({settingsLanguage:'zh-CN'})},error:e=>{throw e;}} as any).open();dispose=()=>pages.forEach(p=>p.dispose?.());
        }else{
          const ctx={root:host,document,host:{accountService:adapter,settings:()=>({settingsLanguage:'zh-CN'})},shell:{},error:e=>{throw e;},refresh(){},async push(){return true;},async back(){return true;}};
          const page=createAccountPage(ctx as any);host.append(page.content);dispose=()=>page.dispose?.();
        }
        await tick();const quarter=host.querySelector('[data-plan-id="quarter"] button');assert.ok(quarter,platform);assert.equal(quarter.disabled,false,platform);
        quarter.click();quarter.click();await tick();assert.equal(calls.length,1,platform+' blocks double clicks');assert.equal(calls[0].planId,'quarter');assert.equal(calls[0].currency,'CNY');
        assert.equal(host.querySelector('[data-plan-id="early"] button').disabled,true,platform+' lifetime stays unavailable');
        assert.equal(vm.membership.state,empty.membership.state,platform+' opening a plan never grants membership');
        vm={...vm,salesOpen:false};emit();await tick();assert.equal(host.querySelector('[data-plan-id="quarter"] button').disabled,true,platform+' follows the server flag');
        dispose();host.remove();assert.equal(listeners.size,0,platform+' releases subscriptions');
        console.log('PASS '+platform+' plan entry: selected plan, double-click guard, server flag and entitlement boundary');
      }
    }`},bundle:true,platform:"node",target:"node22",format:"esm",outfile:output,packages:"external",jsx:"automatic",loader:{".md":"text",".svg":"dataurl",".webp":"dataurl",".txt":"text"},alias:{obsidian:path.join(root,"src/tests/obsidian-shim.ts")},logLevel:"silent"});
  await (await import(pathToFileURL(output).href)).runTests();
} finally {dom.window.close();await rm(run,{recursive:true,force:true});}
