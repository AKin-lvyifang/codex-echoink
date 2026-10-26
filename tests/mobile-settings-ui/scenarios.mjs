import assert from "node:assert/strict";
import { createHost, answer } from "../mobile/host.mjs";
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const visible = node => !node.closest("[hidden],[inert]");
async function until(check, label) { const end = Date.now() + 5000; while (!check() && Date.now() < end) await tick(); assert.ok(check(), label); }
const buttons = root => [...root.querySelectorAll("button")].filter(visible);
function button(root, text) { const found = buttons(root).find(node => node.getAttribute("aria-label") === text || node.textContent.trim() === text || node.querySelector('.ip-settings-name,.pd-settings-name')?.textContent === text); assert.ok(found, `visible button ${text}`); return found; }
async function click(root, text) { button(root, text).click(); await tick(); await tick(); }
function field(win, root, label, value) { const node = [...root.querySelectorAll(`[aria-label="${label}"]`)].find(visible); assert.ok(node, label); node.value = value; node.dispatchEvent(new win.Event("input", { bubbles: true })); return node; }
export async function runMobileSettingsScenarios(api, win) {
 let passed = 0;
 for (const [tablet, width] of [[false,330],[false,390],[true,744],[true,1100]]) {
  api.Platform.isTablet = tablet;
  const memory = createHost(); memory.app.workspace.containerEl = win.document.body;
  const store = new api.MobileStore(memory.adapter, "plugin/mobile", `settings-${tablet}`); await store.load();
  const provider = api.mobileProvider("deepseek"); Object.assign(provider,{apiKey:"synthetic-test-only",models:[api.mobileModel("deepseek-chat")],defaultModelId:"deepseek-chat"});
  const settings = api.loadMobileSettings({apiProviders:[provider],activeApiProviderId:provider.id,defaultModel:provider.defaultModelId});
  const requests=[]; const request = async req => { requests.push(req.method); return req.method === 'GET' ? {status:200,json:{data:[{id:'verified-model',name:'Verified model',supports_tool_calling:true,context_window:128000,max_output_tokens:8192}]}} : answer('openai-completions','OK'); };
  const runtime = new api.MobileRuntime(memory.app,store,()=>settings,request); await runtime.initialize();
  const plugin = new api.EchoInkMobilePlugin(memory.app,{id:'codex-echoink',version:'M7 test'});
  Object.assign(plugin,{store,runtime,settings,modelRequest:request,registerEvent(){}}); let failSave=false; const saved=[];
  plugin.saveData = async value => { if(failSave) throw new Error('测试保存失败'); saved.push(structuredClone(value)); };
  plugin.services = new api.MobileServices(plugin,'plugin/mobile'); await plugin.services.initialize();
  const chat=win.document.createElement('main'),home=win.document.createElement('main'),central=win.document.createElement('main');
  for(const node of [chat,home,central]) { node.getBoundingClientRect=()=>({width,height:800,top:0,bottom:800,left:0,right:width}); win.document.body.append(node); }
  const fixture=api.mobileWorkspaceFixture(plugin,{chat,home,settings:central},tablet);
  const root = tablet ? central : chat;
  const test = async (label,run) => { await run(); console.log(`ok ${++passed} - ${tablet?'iPad':'iPhone'} ${width}px ${label}`); };
  const openCategory = async label => {
   await plugin.showPage('settings');
   for(let level=0; level<5 && !buttons(root).some(node=>node.textContent.trim()===label);level++) {
    const back=[...root.querySelectorAll('[aria-label="返回"],[aria-label="Back"]')].find(visible); assert.ok(back,`return to settings categories for ${label}`);
    back.click();await tick();await tick();
   }
   await click(root,label);
  };
  try {
   await plugin.open();
   await test('six independent settings categories and native central reuse',async()=>{
    await plugin.showPage('settings'); await plugin.showPage('settings');
    const text=root.textContent;
    for(const name of ['通用','模型','Agent','能力','模块','账号与会员']) assert.ok(text.includes(name),name);
    if(tablet) assert.equal(fixture.leaves.filter(leaf=>leaf.view.getViewType()==='echoink-ipad-settings-shell').length,1);
    assert.ok(!root.querySelector('.em-sidebar'),'old eight-group sidebar is not the formal settings root');
   });
   await test('palette has a shared track and start switch persists with rollback',async()=>{
    if(!root.querySelector('[aria-label="启动时打开工作台"]')) await click(root,'通用');
    const toggle=[...root.querySelectorAll('[role="switch"]')].find(node=>visible(node)&&node.getAttribute('aria-label')==='启动时打开工作台'); assert.ok(toggle); assert.equal(toggle.type,'checkbox');
    toggle.checked=true;toggle.dispatchEvent(new win.Event('change',{bubbles:true})); await until(()=>settings.autoOpenHome===true && saved.at(-1)?.autoOpenHome===true,'start saved');
    failSave=true;toggle.checked=false;toggle.dispatchEvent(new win.Event('change',{bubbles:true})); await tick();await tick();await tick(); assert.equal(settings.autoOpenHome,true,'failed save restores value');assert.equal(toggle.checked,true,'failed save restores visible switch');failSave=false;
    for (const [label, value] of [['极简黑白','minimal'],['荧光笔记','highlighter'],['黄白宣言','manifesto']]) {
     await click(root,label); assert.equal(settings.colorTheme,value); assert.equal(win.document.body.dataset.echoinkTheme,value);
     assert.equal(button(root,label).getAttribute('aria-pressed'),'true');
    }
    failSave=true; await click(root,'荧光笔记'); await tick(); await tick(); assert.equal(settings.colorTheme,'manifesto','palette save failure restores previous appearance'); failSave=false;
    const selected=buttons(root).find(n=>n.textContent.trim()==='黄白宣言');assert.ok(selected.parentElement.querySelector('button'),'segmented choices share a parent track');
   });
   await test('startup behavior consumes saved setting and does not start a task',async()=>{
    let callback,opened=0;memory.app.workspace.onLayoutReady=fn=>{callback=fn;};
    const navigation=tablet?plugin.ipadNavigation:plugin.iphoneNavigation;const method=tablet?'openHome':'open';const original=navigation[method];navigation[method]=async()=>{opened++;};
    plugin.registerStartupWorkbench();settings.autoOpenHome=false;callback();await tick();assert.equal(opened,0);
    settings.autoOpenHome=true;callback();await tick();assert.equal(opened,1);navigation[method]=original;assert.equal(requests.length,0);
   });
   await test('module and memory switches persist real state without deleting history',async()=>{
    await openCategory('模块');const disabled=[...root.querySelectorAll('[role="switch"]')].find(n=>visible(n)&&n.getAttribute('aria-label')==='启用待办');assert.ok(disabled,'module switch');
    const count=store.state.sessions.length;disabled.checked=false;disabled.dispatchEvent(new win.Event('change',{bubbles:true}));await until(()=>settings.mobileUi.moduleEnabled?.todos===false,'module disabled saved');assert.equal(store.state.sessions.length,count,'module toggle preserves tasks');
    disabled.checked=true;disabled.dispatchEvent(new win.Event('change',{bubbles:true}));await until(()=>settings.mobileUi.moduleEnabled?.todos===true,'module reenabled saved');
    await openCategory('Agent');const memorySwitch=[...root.querySelectorAll('[role="switch"]')].find(n=>visible(n)&&n.getAttribute('aria-label')==='长期记忆');assert.ok(memorySwitch);const memories=store.state.memories.length;memorySwitch.checked=false;memorySwitch.dispatchEvent(new win.Event('change',{bubbles:true}));await until(()=>store.state.memoryEnabled===false,'memory disabled via real writer');assert.equal(store.state.memories.length,memories,'memory switch preserves records');memorySwitch.checked=true;memorySwitch.dispatchEvent(new win.Event('change',{bubbles:true}));await until(()=>store.state.memoryEnabled===true,'memory reenabled');
   });
   await test('model form parameters and return preserve the exact connection draft',async()=>{
    await plugin.showPage('providers');await click(root,'添加模型服务');await click(root,'DeepSeek');
    assert.equal(button(root,'测试并保存').disabled,true,'preset metadata is not a fetched model list');await click(root,'参数');await click(root,'返回');assert.equal(button(root,'测试并保存').disabled,true,'opening parameters is not manual model admission');await click(root,'取消');await click(root,'自定义服务');
    field(win,root,'连接名称','M7 UI 合成服务');field(win,root,'API Key','synthetic-never-real');field(win,root,'接口地址','https://models.invalid/v1');
    const before=field(win,root,'API Key','synthetic-never-real');await click(root,'参数');
    assert.ok(root.textContent.includes('手动添加 Model ID'),'empty custom service offers manual model, without fabricated metadata');await click(root,'返回');
    const after=[...root.querySelectorAll('[aria-label="API Key"]')].find(visible);assert.equal(after,before);assert.equal(after.value,'synthetic-never-real');assert.equal(settings.apiProviders.length,1);
   });
   await test('fetch select test save and readback use the real model service',async()=>{
    await click(root,'获取模型');await until(()=>root.textContent.includes('Verified model'),'fetched option');
    const checkbox=[...root.querySelectorAll('input[type="checkbox"]')].find(n=>visible(n)&&n.closest('label')?.textContent.includes('Verified model'));assert.ok(checkbox,'fetched model checkbox');if(!checkbox.checked){checkbox.checked=true;checkbox.dispatchEvent(new win.Event('change',{bubbles:true}));}
    await click(root,'测试并保存');await until(()=>settings.apiProviders.length===2,'service saved');
    assert.equal(settings.apiProviders.find(p=>p.name==='M7 UI 合成服务').models[0].id,'verified-model');assert.ok(requests.includes('GET')&&requests.includes('POST'));
    assert.ok(saved.at(-1).apiProviders.some(p=>p.name==='M7 UI 合成服务'));
    await until(()=>buttons(root).some(node=>node.querySelector('.ip-settings-name,.pd-settings-name')?.textContent==='M7 UI 合成服务'),'successful save returns to service list');
   });
   await test('English appearance names remain available in the narrow/wide settings shell',async()=>{
    settings.settingsLanguage='en';await plugin.saveSettings();await openCategory('General');
    for(const name of ['Minimal','Highlighter','Manifesto']) assert.ok(button(root,name));
   });
  } finally { await fixture.dispose();await runtime.shutdown('plugin_disabled');runtime.dispose();await plugin.services.dispose();chat.remove();home.remove();central.remove(); }
 }
 console.log(`Mobile settings UI: ${passed} passed (DOM and Provider fixtures, not native devices)`);
}
