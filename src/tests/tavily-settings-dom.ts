import {renderTavilySettings,renderProviderTabs} from "../settings/tavily-settings";
import {createSettingsPage} from "../settings/settings-v2";
import {disposeOriginControls} from "../settings/origin-controls";
import type {searchTavily} from "../tools/tavily-search";
const prototype = HTMLElement.prototype;
function create(this:HTMLElement,tag:string,options:any={}){const el=this.ownerDocument.createElement(tag);if(typeof options==='string')el.className=options;else {if(options.cls)el.className=options.cls;if(options.text)el.textContent=options.text;if(options.href)el.setAttribute('href',options.href);for(const [k,v] of Object.entries(options.attr??{}))el.setAttribute(k,String(v));}this.append(el);return el;}
Object.assign(prototype,{empty(){this.replaceChildren();},addClass(...tokens:string[]){this.classList.add(...tokens);},setAttr(k:string,v:string){this.setAttribute(k,String(v));},createEl:create,createDiv(options:any){return create.call(this,'div',options);},createSpan(options:any){return create.call(this,'span',options);}});
const params = new URLSearchParams(location.search);
// Measure the production named container's content box, independently of the host sidebar.
const contentWidth = Number(params.get('width'));
if ([390, 599, 600, 601, 800].includes(contentWidth)) {
  Object.assign(document.querySelector<HTMLElement>('#fixture')!.style, {
    width: `${contentWidth}px`, maxWidth: 'none', boxSizing: 'content-box'
  });
}
const english = params.get('lang') === 'en';
document.body.classList.toggle('theme-dark',params.get('theme')==='dark');
let saves=0, calls=0; let respond:()=>void=()=>{};
const host={settings:{settingsLanguage:english?'en':'zh-CN',tavily:{enabled:false,apiKey:''}},async saveSettings(){saves++;}};
const search: typeof searchTavily = async request => {calls++; if(request.maxResults!==1)throw new Error('not small test'); await new Promise<void>(resolve=>{respond=resolve;});return {source:'web',provider:'Tavily',results:[]};};
const container=document.querySelector<HTMLElement>('#content')!;
let active:'models'|'tools'='tools';
function render(focus=false){disposeOriginControls(container);container.empty();const page=createSettingsPage(container,{title:english?'Models and providers':'模型与提供商',description:english?'Manage providers, models, and web search.':'管理模型与提供商，以及对话中使用的联网搜索。'});page.addClass('codex-provider-model-manager');const panel=renderProviderTabs(page,active,english,(tab,restore)=>{active=tab;render(restore);});if(active==='tools')renderTavilySettings(panel,host,search);else panel.createDiv({text:english?'Existing model manager location':'现有模型管理器位置（验证二级导航）'});if(focus)document.querySelector<HTMLElement>(`#echoink-provider-tab-${active}`)?.focus();}
render();
const results:string[]=[];
const assert=(condition:unknown,message:string)=>{if(!condition)throw new Error(message);results.push(`PASS ${message}`);};
const frame=()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
async function run(){
let input=container.querySelector<HTMLInputElement>('input')!;
const toggle=container.querySelector<HTMLButtonElement>('[role=switch]')!;
toggle.click();await frame();assert(!host.settings.tavily.enabled,'empty key cannot enable');
input.value='fixture-only';input.dispatchEvent(new Event('input',{bubbles:true}));
const reveal=container.querySelector<HTMLButtonElement>('[aria-pressed]')!;reveal.click();assert(input.type==='text','reveal key');reveal.click();assert(input.type==='password','hide key');
const test=container.querySelector<HTMLButtonElement>('.echoink-tavily-test button')!;test.click();await frame();assert(test.disabled,'pending test disabled');test.click();assert(calls===1,'duplicate test prevented');respond();await frame();assert(!!container.querySelector('.is-success'),'successful real-response path');assert(!host.settings.tavily.enabled,'test does not enable');
input.value='edited-fixture';input.dispatchEvent(new Event('input',{bubbles:true}));assert(!container.querySelector('.is-success'),'editing clears test');toggle.click();await frame();assert(host.settings.tavily.enabled,'user can enable without approval test');
test.click();await frame();input.value='another-fixture';input.dispatchEvent(new Event('input',{bubbles:true}));respond();await frame();assert(!container.querySelector('.is-success'),'stale response ignored after edit');
const tab=container.querySelector<HTMLElement>('#echoink-provider-tab-tools')!;tab.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true,cancelable:true}));assert(document.activeElement?.id==='echoink-provider-tab-models','Home changes tab and focus');document.activeElement!.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true,cancelable:true}));assert(document.activeElement?.id==='echoink-provider-tab-tools','End restores tool tab and focus');
assert(container.querySelector<HTMLInputElement>('input')!.value==='another-fixture','key survives rerender');assert(saves>0,'settings persisted through host');
input=container.querySelector<HTMLInputElement>('input')!;input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));
await frame();
const fixture=document.querySelector<HTMLElement>('#fixture')!;
const rect=(selector:string)=>container.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
const copy=rect('.echoink-tavily-card .setting-item-info');
const key=rect('.echoink-tavily-key-label');
const header=rect('.echoink-tavily-card h3');
const switchRect=rect('[role=switch]');
assert(getComputedStyle(fixture).containerName==='settings','production named settings container');
assert(Math.abs(copy.left-key.left)<1 && Math.abs(copy.left-header.left)<1,'search copy aligns with key and card heading');
assert(Math.abs(switchRect.right-key.right)<1,'switch aligns with card content right edge');
assert(switchRect.top>=copy.top-1 && switchRect.bottom<=copy.bottom+1 && switchRect.left>=copy.right,'switch stays beside copy');
assert(switchRect.width===36 && switchRect.height===21,'switch keeps intrinsic size');
assert(fixture.scrollWidth<=fixture.clientWidth && container.scrollWidth<=container.clientWidth,'settings content has no horizontal overflow');
const description=container.querySelector<HTMLElement>('.setting-item-description')!;
assert(description.scrollWidth<=description.clientWidth && description.scrollHeight<=description.clientHeight+1,'description fits without clipping');
if(english && contentWidth===390)assert(description.clientHeight>parseFloat(getComputedStyle(description).lineHeight),'narrow English description wraps');
(document.querySelector('#report') as HTMLElement).textContent=results.join('\n')+'\nBoundary: real browser and Origin controls; controlled search and host fixture, no live API or Obsidian.';
(document.querySelector('#report') as HTMLElement).dataset.result='passed';}
run().catch(error=>{const report=document.querySelector<HTMLElement>('#report')!;report.textContent=results.join('\n')+'\nFAIL '+error;report.dataset.result='failed';});
