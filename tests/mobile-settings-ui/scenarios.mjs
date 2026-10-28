import assert from "node:assert/strict";
import { createHost, answer } from "../mobile/host.mjs";
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const visible = node => !node.closest("[hidden],[inert]");
async function until(check, label) { const end = Date.now() + 5000; while (!check() && Date.now() < end) await tick(); assert.ok(check(), label); }
const buttons = root => [...root.querySelectorAll("button")].filter(visible);
function button(root, text) { const found = buttons(root).find(node => node.getAttribute("aria-label") === text || node.textContent.trim() === text || node.firstChild?.textContent?.trim() === text || node.querySelector('.ip-settings-name,.pd-settings-name,.echoink-theme-choice-title')?.textContent === text); assert.ok(found, `visible button ${text}`); return found; }
async function click(root, text) { button(root, text).click(); await tick(); await tick(); }
function field(win, root, label, value) { const node = [...root.querySelectorAll(`[aria-label="${label}"]`)].find(visible); assert.ok(node, label); node.value = value; node.dispatchEvent(new win.Event("input", { bubbles: true })); return node; }
function select(root, label) { const node = [...root.querySelectorAll("select")].find(node => visible(node) && node.getAttribute("aria-label") === label); assert.ok(node, `native select ${label}`); return node; }
function choose(win, node, value) { node.value = value; node.dispatchEvent(new win.Event("change", { bubbles: true })); }
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
  const syntheticProAccess={...api.createUnavailableAccountAdapter(),checkCapability:()=>true,requireCapability(){},subscribe:()=>()=>{}};
  Object.assign(plugin,{store,runtime,settings,modelRequest:request,accountService:syntheticProAccess,registerEvent(){}}); let failSave=false; const saved=[];
  plugin.saveData = async value => { if(failSave) throw new Error('测试保存失败'); saved.push(structuredClone(value)); };
  plugin.services = new api.MobileServices(plugin,'plugin/mobile'); await plugin.services.initialize();
  const chat=win.document.createElement('main'),home=win.document.createElement('main'),central=win.document.createElement('main');
  for(const node of [chat,home,central]) { node.getBoundingClientRect=()=>({width,height:800,top:0,bottom:800,left:0,right:width}); win.document.body.append(node); }
  const fixture=api.mobileWorkspaceFixture(plugin,{chat,home,settings:central},tablet);
  const root = tablet ? central : chat;
  const test = async (label,run) => { await run(); console.log(`ok ${++passed} - ${tablet?'iPad':'iPhone'} ${width}px ${label}`); };
  const openCategory = async label => {
   await plugin.showPage('settings');
   for(let level=0; level<5 && !buttons(root).some(node=>node.textContent.trim()===label||node.querySelector('.ip-settings-name,.pd-settings-name')?.textContent===label);level++) {
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
    const beforeLocked=saved.length;syntheticProAccess.checkCapability=()=>false;await click(root,'荧光笔记');
    assert.equal(settings.colorTheme,'manifesto','unentitled choice cannot change the palette');assert.equal(saved.length,beforeLocked,'unentitled choice does not save');syntheticProAccess.checkCapability=()=>true;
    const selected=button(root,'黄白宣言');assert.ok(selected.parentElement.querySelector('button'),'segmented choices share a parent track');
   });
   await test('startup behavior consumes saved setting and does not start a task',async()=>{
    let callback,opened=0;memory.app.workspace.onLayoutReady=fn=>{callback=fn;};
    const navigation=tablet?plugin.ipadNavigation:plugin.iphoneNavigation;const method=tablet?'openHome':'open';const original=navigation[method];navigation[method]=async()=>{opened++;};
    plugin.registerStartupWorkbench();settings.autoOpenHome=false;callback();await tick();assert.equal(opened,0);
    settings.autoOpenHome=true;callback();await tick();assert.equal(opened,1);navigation[method]=original;assert.equal(requests.length,0);
   });
   await test('language uses an inline native select with save rollback and no extra page',async()=>{
    const language=select(root,'界面语言');assert.equal(language.closest('button'),null,'native select is not nested in an action row');
    assert.deepEqual([...language.options].map(option=>[option.value,option.textContent]),[['zh-CN','简体中文'],['en','English']]);
    const saveData=plugin.saveData,before=saved.length;let release;const pending=new Promise(resolve=>{release=resolve;});
    plugin.saveData=async value=>{await pending;await saveData(value);};
    choose(win,language,'en');assert.equal(language.disabled,true,'saving disables the native picker');
    choose(win,language,'zh-CN');assert.equal(language.value,'en','duplicate change restores the in-flight value');
    release();await until(()=>saved.length===before+1&&!select(root,'Interface language').disabled,'language saved and refreshed');plugin.saveData=saveData;
    assert.equal(settings.settingsLanguage,'en');assert.equal(saved.at(-1).settingsLanguage,'en');
    assert.equal(root.querySelector('[data-page-id$="-language"]'),null,'language selection does not push a page');
    failSave=true;choose(win,select(root,'Interface language'),'zh-CN');
    await until(()=>settings.settingsLanguage==='en'&&!select(root,'Interface language').disabled,'failed language save restores the previous value');
    assert.equal(select(root,'Interface language').value,'en');failSave=false;
    choose(win,select(root,'Interface language'),'zh-CN');await until(()=>saved.at(-1)?.settingsLanguage==='zh-CN'&&!select(root,'界面语言').disabled,'language returns to Chinese');
   });
   await test('module and memory switches persist real state without deleting history',async()=>{
    await openCategory('模块');const disabled=[...root.querySelectorAll('[role="switch"]')].find(n=>visible(n)&&n.getAttribute('aria-label')==='启用待办');assert.ok(disabled,'module switch');
    const count=store.state.sessions.length;disabled.checked=false;disabled.dispatchEvent(new win.Event('change',{bubbles:true}));await until(()=>settings.mobileUi.moduleEnabled?.todos===false,'module disabled saved');assert.equal(store.state.sessions.length,count,'module toggle preserves tasks');
    disabled.checked=true;disabled.dispatchEvent(new win.Event('change',{bubbles:true}));await until(()=>settings.mobileUi.moduleEnabled?.todos===true,'module reenabled saved');
    await openCategory('Agent');const memorySwitch=[...root.querySelectorAll('[role="switch"]')].find(n=>visible(n)&&n.getAttribute('aria-label')==='长期记忆');assert.ok(memorySwitch);const memories=store.state.memories.length;memorySwitch.checked=false;memorySwitch.dispatchEvent(new win.Event('change',{bubbles:true}));await until(()=>store.state.memoryEnabled===false,'memory disabled via real writer');assert.equal(store.state.memories.length,memories,'memory switch preserves records');memorySwitch.checked=true;memorySwitch.dispatchEvent(new win.Event('change',{bubbles:true}));await until(()=>store.state.memoryEnabled===true,'memory reenabled');
   });
   await test('module owners select inline and preserve version checks, failures and identity refresh',async()=>{
    const agents=plugin.services.agents,snapshot=await agents.snapshot(),name='负责复杂研究与资料归档工作的助理';
    await agents.createAgent({id:'research',name,avatar:{kind:'preset',presetId:'lin'},position:'合成测试负责人',styleId:'analysis',capabilityIds:['knowledge']},snapshot.version);
    await plugin.services.refreshAgentIdentity();await openCategory('Agent');
    const owner=()=>[...root.querySelectorAll('select[data-module-owner="knowledge-base"]')].find(visible);
    await until(()=>owner()?.options.length===2&&!owner().matches(':disabled'),'fresh owner snapshot loaded');
    assert.equal([...root.querySelectorAll('select[data-module-owner]')].filter(visible).length,6);
    assert.equal(owner().closest('button'),null);assert.deepEqual([...owner().options].map(option=>option.textContent),['总助',name]);
    const initialAvatar=owner().parentElement.querySelector('img')?.getAttribute('src'),setOwner=agents.setOwner.bind(agents),refresh=plugin.services.refreshAgentIdentity.bind(plugin.services),calls=[];let identityRefreshes=0;
    agents.setOwner=async(...args)=>{calls.push(args);return setOwner(...args);};plugin.services.refreshAgentIdentity=async()=>{identityRefreshes++;await refresh();};
    const saveData=plugin.saveData;let release;const pending=new Promise(resolve=>{release=resolve;});plugin.saveData=async value=>{await pending;await saveData(value);};
    choose(win,owner(),'research');assert.equal(owner().matches(':disabled'),true,'saving disables owner selection');choose(win,owner(),'sol');release();
    await until(()=>settings.agentRegistry.moduleOwners['knowledge-base']==='research'&&owner()?.value==='research'&&!owner().matches(':disabled'),'owner saved and redrawn');plugin.saveData=saveData;
    assert.equal(calls.length,1,'duplicate changes do not submit again');assert.equal(identityRefreshes,1,'saved owner refreshes identity');
    assert.notEqual(owner().parentElement.querySelector('img')?.getAttribute('src'),initialAvatar,'selected avatar follows saved owner');
    assert.equal(root.querySelector('[data-page-id*="settings-owner-"]'),null,'owner selection does not push a page');
    failSave=true;choose(win,owner(),'sol');await until(()=>owner()?.value==='research'&&!owner().matches(':disabled'),'failed owner save restores selected owner');failSave=false;
    assert.equal(settings.agentRegistry.moduleOwners['knowledge-base'],'research');assert.ok([...root.querySelectorAll('[role="alert"]')].some(node=>visible(node)&&node.textContent.trim()),'failed save remains visible');
    const latest=await agents.snapshot();await agents.update(registry=>{registry.agents.find(agent=>agent.id==='research').name='更新后的真实负责人';registry.moduleOwners['knowledge-base']='sol';},latest.version);
    choose(win,owner(),'sol');await until(()=>owner()?.value==='sol'&&[...owner().options].some(option=>option.textContent==='更新后的真实负责人')&&!owner().matches(':disabled'),'conflict refreshes owner and candidates');
    assert.equal(settings.agentRegistry.moduleOwners['knowledge-base'],'sol','stale choice does not overwrite newer owner');assert.ok(root.textContent.includes('Agent 配置已变化'));
    const retryVersion=(await agents.snapshot()).version;choose(win,owner(),'research');await until(()=>settings.agentRegistry.moduleOwners['knowledge-base']==='research'&&owner()?.value==='research'&&!owner().matches(':disabled'),'explicit choice after conflict uses refreshed version');
    assert.equal(calls.at(-1)[2],retryVersion,'retry uses the refreshed snapshot version');
    agents.setOwner=setOwner;plugin.services.refreshAgentIdentity=refresh;
   });
   await test('default model continues to open its selection page without repeated scope copy',async()=>{
    await openCategory('模型');
    await click(root,'deepseek-chat');assert.equal(button(root,'deepseek-chat').closest('[data-page-id]')?.dataset.pageId,tablet?'ipad-model-default':'iphone-settings-default-model','default model keeps its own page');
    await click(root,'返回');
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
