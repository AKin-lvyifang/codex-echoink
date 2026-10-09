import {renderTavilySettings,renderProviderTabs} from "../settings/tavily-settings";
import {createOriginButton,createOriginInput,createOriginSelect,disposeOriginControls} from "../settings/origin-controls";
import {createOriginSelectHostFixture} from "./origin-obsidian-dom-shim";
import {homeWorkspaceMarkup} from "../home/home-workspace-template";
import {renderCodexHeader} from "../ui/codex-view/header";
import {renderCodexTabs} from "../ui/codex-view/tabs";
import {renderComposerShell,renderComposerToolbar} from "../ui/codex-view/composer";
import {renderSmoothAISuggestions} from "../ui/codex-view/smooth-chat-ui";
import type {StoredSession} from "../settings/settings";
import {Modal,type App} from "obsidian";
import {KnowledgeNotePickerModal} from "../settings/knowledge-note-picker-modal";
import {showEchoInkMenu} from "../ui/theme-boundary";
import {renderFinanceIcon} from "../lifestyle/finance-icon-picker";
import {FINANCE_BRAND_ASSETS} from "../lifestyle/finance-brand-assets";

// The real styles transition colors/borders for 160–200ms. Compare endpoints,
// not an in-between frame when switching the same DOM between stylesheets.
const frame = async () => {
 await new Promise<void>(resolve => {
  const start=performance.now();
  const tick=()=>performance.now()-start>=230?resolve():requestAnimationFrame(tick);
  requestAnimationFrame(tick);
});
 // A busy browser can start a transition after the first scheduled frame.
 // Wait for actual transition completion rather than accepting rounded colors.
 await Promise.all(document.getAnimations().filter(animation=>animation instanceof CSSTransition)
   .map(animation=>animation.finished.catch(()=>{})));
};
const assert = (value: unknown, message: string) => {if (!value) throw new Error(message);};
const properties = ["backgroundColor","color","borderTopWidth","borderTopStyle","borderTopColor","borderRadius","boxShadow",
  "height","width","padding","margin","fontFamily","fontSize","fontWeight","lineHeight","outlineStyle","outlineWidth"] as const;
const read = (element: HTMLElement, pseudo?: string) => {
  const css = element.ownerDocument.defaultView!.getComputedStyle(element,pseudo);
  return Object.fromEntries(properties.map(property => [property,css[property]]));
};
const key = (element: HTMLElement, value: string) => element.dispatchEvent(new (element.ownerDocument.defaultView!.KeyboardEvent)("keydown",{key:value,bubbles:true,cancelable:true}));

/** Browser host convenience methods only. Product renderers and primitives are real. */
function installDomMethods(owner: Window) {
  const prototype = (owner as typeof window).HTMLElement.prototype;
  prototype.createEl = function(tag: string, options: {cls?: string; text?: string; attr?: Record<string,string>; href?: string} = {}) {
    const element = this.ownerDocument.createElement(tag);
    if (options.cls) element.className=options.cls;
    if (options.text) element.textContent=options.text;
    for (const [key,value] of Object.entries(options.attr??{})) element.setAttribute(key,value);
    if (options.href) element.setAttribute("href",options.href);
    this.appendChild(element);return element;
  } as typeof prototype.createEl;
  prototype.createDiv = function(options = {}) {return this.createEl("div",options);};
  prototype.createSpan = function(options = {}) {return this.createEl("span",options);};
  prototype.addClass = function(...names) {this.classList.add(...names);};
  prototype.removeClass = function(...names) {this.classList.remove(...names);};
  prototype.setAttr = function(name,value) {this.setAttribute(name,String(value));};
  prototype.setText = function(text) {this.textContent=text;};
  prototype.empty = function() {this.replaceChildren();};
  prototype.setCssProps = function(props) {for (const [name,value] of Object.entries(props)) this.style.setProperty(name,String(value));};
  prototype.setCssStyles = function(styles) {Object.assign(this.style,styles);};
  prototype.toggleClass = function(name,value) {this.classList.toggle(name,value);};
  prototype.hasClass = function(name) {return this.classList.contains(name);};
  const elementPrototype=(owner as typeof window).Element.prototype;
  elementPrototype.addClass=prototype.addClass;
  elementPrototype.setAttr=prototype.setAttr;
}

/** Incremental proof for the two confirmed gaps, without replaying other checks. */
export async function runThemeIsolationExtras(AvatarFields:new()=>{render(parent:HTMLElement):void}) {
  installDomMethods(window);
  const fixture=document.querySelector<HTMLElement>("#fixture")!,report=document.querySelector<HTMLElement>("#report")!;
  const product=document.querySelector<HTMLStyleElement>("#product")!,before=document.querySelector<HTMLStyleElement>("#theme-before")!,after=document.querySelector<HTMLStyleElement>("#theme-after")!;
  const [baseline,current,interference]=await Promise.all(["baseline.css","styles.css","things-theme.css"].map(path=>fetch(path).then(response=>response.text())));
  fixture.style.pointerEvents="none";
  const finance=fixture.createDiv({cls:"echoink-finance-dialog"});finance.createEl("h3",{text:"财务品牌图标"});
  const art=finance.createSpan({cls:"echoink-finance-icon-art"});renderFinanceIcon(art,FINANCE_BRAND_ASSETS[0].id);
  const avatar=fixture.createDiv({cls:"echoink-theme-boundary"});avatar.createEl("h3",{text:"身份头像选项"});new AvatarFields().render(avatar);
  const settings=fixture.createDiv({cls:"echoink-settings-demo"});settings.createEl("h3",{text:"设置等宽输入"});const settingEditor=settings.createEl("textarea");settingEditor.value="const note = 'EchoInk';";
  const diary=fixture.createDiv({cls:"echoink-diary-view"});diary.createEl("h3",{text:"英文日记等宽输入"});const diaryEditor=diary.createEl("textarea",{cls:"echoink-diary-editor"});diaryEditor.value="Today I made a little progress.";
  const content=diary.createDiv({cls:"echoink-diary-reading"}).createEl("img",{attr:{src:art.querySelector<HTMLImageElement>("img")!.src,alt:"User content control"}});
  content.style.width="22px";
  const outside=fixture.createEl("img",{attr:{src:content.src,alt:"Host image control"}});outside.style.width="22px";
  const images=[art.querySelector<HTMLImageElement>("img")!,avatar.querySelector<HTMLImageElement>("img")!],editors=[settingEditor,diaryEditor];
  const results:string[]=[];
  const run=async(name:string,test:()=>Promise<void>)=>{try{await test();results.push(`PASS ${name}`);}catch(error){results.push(`FAIL ${name}: ${String(error)}`);}report.textContent=results.join("\n");};
  for(const mode of ["theme-light","theme-dark"]){
    await run(`${mode}: production UI images preserve default shape/shadow`,async()=>{
      document.body.className=mode+" mod-macos";document.body.dataset.echoinkTheme="green";before.textContent=after.textContent="";product.textContent=baseline;await frame();const original=images.map(image=>read(image));
      product.textContent=current;await frame();assert(JSON.stringify(images.map(image=>read(image)))===JSON.stringify(original),"default image geometry/style changed");
      for(const order of [before,after]){
        order.textContent=interference;await frame();
        images.forEach((image,index)=>assert(JSON.stringify(read(image))===JSON.stringify(original[index]),`${image.parentElement!.className}: ${JSON.stringify(original[index])} -> ${JSON.stringify(read(image))}`));
        assert(getComputedStyle(outside).boxShadow!=="none"&&getComputedStyle(content).boxShadow!=="none","UI image reset leaked into host/user content");order.textContent="";
      }
    });
    for(const override of ["'??'","'Courier New'"])for(const size of [16,24])await run(`${mode}/mono=${override}/H=${size}: default and user override chain`,async()=>{
      document.body.className=mode+" mod-macos";document.body.style.setProperty("--font-monospace-override",override);document.body.style.setProperty("--font-text-size",`${size}px`);
      before.textContent=after.textContent="";product.textContent=baseline;await frame();const original=editors.map(editor=>read(editor));
      product.textContent=current;await frame();assert(JSON.stringify(editors.map(editor=>read(editor)))===JSON.stringify(original),"default monospace style changed");
      for(const order of [before,after]){order.textContent=interference;await frame();editors.forEach((editor,index)=>assert(JSON.stringify(read(editor))===JSON.stringify(original[index]),`monospace chain changed: ${original[index].fontFamily} -> ${read(editor).fontFamily}`));order.textContent="";}
    });
  }
  document.body.className="theme-light mod-macos";document.body.style.setProperty("--font-monospace-override","'??'");document.body.style.setProperty("--font-text-size","16px");fixture.style.removeProperty("pointer-events");product.textContent=current;after.textContent=interference;
  report.dataset.result=results.some(result=>result.startsWith("FAIL"))?"failed":"passed";report.textContent=results.join("\n")+"\nBoundary: incremental image/monospace proof, production renderers and exact immutable default CSS; native acceptance remains with control.";
}

export async function runThemeIsolation(ProviderFields: new()=>{render(parent: HTMLElement):void}) {
  installDomMethods(window);
  const fixture=document.querySelector<HTMLElement>("#fixture")!;
  // Focus scrolls can place a different control under the stationary cursor.
  // The matrix compares normal/focus states; manual preview covers hovering.
  fixture.style.pointerEvents="none";
  const report=document.querySelector<HTMLElement>("#report")!;
  const product=document.querySelector<HTMLStyleElement>("#product")!;
  const before=document.querySelector<HTMLStyleElement>("#theme-before")!;
  const after=document.querySelector<HTMLStyleElement>("#theme-after")!;
  const [baseline,current]=await Promise.all([fetch("baseline.css").then(r=>r.text()),fetch("styles.css").then(r=>r.text())]);
  const results:string[]=[];
  const evidence:unknown[]=[];
  const run=async(name:string,test:()=>Promise<void>)=>{try{await test();results.push(`PASS ${name}`);}catch(error){results.push(`FAIL ${name}: ${String(error)}`);}report.textContent=results.join("\n");};
  // Exact measured Things failure: host generic button rule + theme token.
  // Also exercise a focus-ring token and hover color used by existing surfaces.
  const interference=await fetch("things-theme.css").then(r=>r.text());
  const settings=fixture.createDiv({cls:"echoink-settings-demo echoink-native-settings-workspace"});
  const navigation=settings.createDiv({cls:"codex-settings-tabs"});
  const primary=createOriginButton(navigation,{cls:"codex-settings-tab is-active",text:"API Provider",attr:{role:"tab","aria-selected":"true"}});
  const body=settings.createDiv({cls:"codex-settings-body"});
  const page=body.createDiv({cls:"echoink-settings-page"});
  const panel=renderProviderTabs(page,"tools",false,()=>{});
  renderTavilySettings(panel,{settings:{settingsLanguage:"zh-CN",tavily:{enabled:false,apiKey:""}},saveSettings:async()=>{}},async()=>{throw new Error("Fixture must not make a request");});
  const provider=page.createDiv({cls:"provider-fields"});new ProviderFields().render(provider);
  const resource=page.createDiv({cls:"codex-resource-manager"});renderProviderTabs(resource,"models",false,()=>{});
  const home=fixture.createDiv({cls:"echoink-home-workspace"});home.innerHTML=homeWorkspaceMarkup("zh-CN");
  home.querySelector(".inline-search")!.classList.add("is-open");
  const conversation=fixture.createDiv({cls:"codex-container"});renderCodexHeader(conversation,{onOpenSettings(){},onOpenWorkspaceResources(){}});
  const session={id:"theme-session",title:"新会话",createdAt:1,updatedAt:1,messages:[],workspacePath:"",mode:"agent",permission:"workspace-write"} as unknown as StoredSession;
  const tabs=conversation.createDiv({cls:"codex-tabs"});
  renderCodexTabs(tabs,[session],session.id,{onActivate(){},onContextMenu(){},onRename(){},onArchive(){},onDeleteSessions(){},onCreateSession(){}});
  renderSmoothAISuggestions(conversation,[{id:"one",label:"整理笔记",prompt:"整理"}],()=>{});
  const shell=renderComposerShell(conversation,{onInputChanged(){},onPasteFiles(){},onSendMessage(){},onDropFiles(){}});
  renderComposerToolbar(shell.toolbarEl,shell.workspaceEl,{session,knowledgeTaskRunning:false,selectedSkill:null,selectedPermission:"workspace-write",selectedMode:"agent",running:false,promptEnhancerRunning:false,hasDraft:false,hasTextDraft:false,hasQueuedItems:false,currentComposerModel:"",currentComposerProviderBrand:"deepseek",currentComposerSummaryTitle:"",workspacePath:"",workspaceDisplayName:"",workspaceValid:true,contextPanelOpen:false},
    {onOpenAddMenu(){},onEnhancePrompt(){},onCaptureKnowledgeSource(){},onPermissionChange(){},onOpenWorkspaceMenu(){},onOpenModelMenu(){},onToggleContextPanel(){},onMicInput(){},onCancelKnowledgeTask(){},onStopTurn(){},onSteerPiChat(){},onEnqueueDraft(){},onResumeQueue(){},onSendMessage(){}});
  const scopes=["echoink-lifestyle-view","echoink-diary-view","echoink-journal-template-modal","echoink-todo-form-modal","echoink-finance-dialog"];
  for(const scope of scopes){
    const root=fixture.createDiv({cls:scope});root.createEl("button",{text:scope});
    for(const level of [1,2,3,4,5,6])root.createEl(`h${level}`,{text:`模块标题 ${level}`});
    const number=root.createDiv({cls:"echoink-finance-card"}).createEl("strong",{cls:"echoink-finance-number"});
    number.createSpan({cls:"echoink-finance-currency",text:"¥ "});
    root.createEl("em",{text:"说明"});
  }
  const outside=fixture.createEl("button",{text:"Other plugin / host control"});
  const tavily=panel.querySelector<HTMLInputElement>('input[type=password]')!;
  assert(tavily.closest("label.echoink-tavily-key-label"),"Production nested Tavily label is missing");
  const inputs=[tavily,...provider.querySelectorAll<HTMLInputElement>("input")];
  const tracked=[settings,primary,...page.querySelectorAll<HTMLElement>("[role=tab],input,label,.codex-provider-modal-description,.setting-item-info"),
    ...home.querySelectorAll<HTMLElement>("button,input"),...conversation.querySelectorAll<HTMLElement>("button,select,textarea"),...scopes.flatMap(scope=>Array.from(fixture.querySelectorAll<HTMLElement>(`.${scope} button,.${scope} strong,.${scope} em,.${scope} .echoink-finance-currency`))),...fixture.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6")];
  const readPlaceholder=(element:HTMLElement)=>{
    const pseudo=element.ownerDocument.defaultView!.getComputedStyle(element,"::placeholder");
    return {color:pseudo.color,opacity:pseudo.opacity,fontFamily:pseudo.fontFamily,fontSize:pseudo.fontSize};
  };
  const snapshots=()=>tracked.map(element=>({style:read(element),after:element.matches(".codex-resource-tab")?read(element,"::after"):null,
    placeholder:element.matches("input,textarea")?readPlaceholder(element):null}));
  const equal=(expected:ReturnType<typeof snapshots>,actual:ReturnType<typeof snapshots>,phase:string)=>{
    expected.forEach((item,index)=>{
      for(const [property,value] of Object.entries(item.style)) {
        // Sole deliberate correction: remove the old field focus outline.
        if(tracked[index].matches("input")&&property.startsWith("outline"))continue;
        assert(actual[index].style[property]===value,`${phase}: ${tracked[index].className} ${property}: ${value} -> ${actual[index].style[property]}`);
      }
      assert(JSON.stringify(actual[index].after)===JSON.stringify(item.after),`${phase}: navigation underline changed`);
      assert(JSON.stringify(actual[index].placeholder)===JSON.stringify(item.placeholder),`${phase}: placeholder changed`);
    });
  };
  if(new URLSearchParams(location.search).has("placeholder")){
    const fields=tracked.filter(element=>element.matches("input,textarea"));
    const capture=()=>fields.map(element=>({placeholder:readPlaceholder(element),caretColor:getComputedStyle(element).caretColor}));
    for(const mode of ["theme-light","theme-dark"])for(const theme of ["green","violet"])for(const size of [16,24])await run(`${mode}/${theme}/H=${size}: production placeholder and caret`,async()=>{
      document.body.className=mode+" mod-macos";document.body.dataset.echoinkTheme=theme;document.body.style.setProperty("--font-text-size",`${size}px`);
      document.body.style.setProperty("--font-interface-override",size===24?"Georgia":"'??'");
      before.textContent=after.textContent="";product.textContent=baseline;outside.focus();await frame();const original=capture();
      product.textContent=current;await frame();assert(JSON.stringify(capture())===JSON.stringify(original),"default placeholder/caret changed");
      for(const order of [before,after]){
        order.textContent=interference;await frame();const actual=capture();
        fields.forEach((field,index)=>assert(JSON.stringify(actual[index])===JSON.stringify(original[index]),`${field.getAttribute("aria-label")??field.className}: ${JSON.stringify(original[index])} -> ${JSON.stringify(actual[index])}`));order.textContent="";
      }
    });
    document.body.className="theme-light mod-macos";document.body.dataset.echoinkTheme="green";document.body.style.setProperty("--font-text-size","16px");document.body.style.setProperty("--font-interface-override","'??'");product.textContent=current;after.textContent=interference;
    report.dataset.result=results.some(result=>result.startsWith("FAIL"))?"failed":"passed";report.textContent=results.join("\n")+"\nBoundary: incremental production placeholder pseudo-element/caret comparison; native acceptance remains with control.";
    fixture.style.removeProperty("pointer-events");
    return;
  }
  for(const mode of ["theme-light","theme-dark"])for(const theme of ["green","violet"])for(const size of [16,24]) {
    await run(`${mode}/${theme}/H=${size}: immutable baseline + theme load order`,async()=>{
      document.body.className=mode+" mod-macos";document.body.dataset.echoinkTheme=theme;document.body.style.setProperty("--font-text-size",`${size}px`);
      document.body.style.setProperty("--font-interface-override",size===24?"Georgia":"'??'");
      before.textContent=after.textContent="";product.textContent=baseline;outside.focus();await frame();const normal=snapshots();
      tavily.focus();await frame();const focus=snapshots();
      product.textContent=current;await frame();equal(focus,snapshots(),"current default focus");
      outside.focus();await frame();equal(normal,snapshots(),"current default normal");
      for(const order of [before,after]){
        order.textContent=interference;await frame();equal(normal,snapshots(),"interfered normal");
        for(const input of inputs){
          const ancestor=input.closest<HTMLElement>("label")??input.closest<HTMLElement>(".codex-provider-modal-field")!;
          const labelStyle=read(ancestor);input.focus();await frame();const css=read(input);
          assert(css.boxShadow==="none"&&css.outlineStyle==="none","focused field ring leaked");
          assert(JSON.stringify(read(ancestor))===JSON.stringify(labelStyle),"input focus changed containing label/description");
          assert(input===document.activeElement,"focus detached production input");
          input.blur();
        }
        tavily.focus();await frame();equal(focus,snapshots(),"interfered focus");
        assert(getComputedStyle(outside).boxShadow!=="none","boundary leaked into another plugin");
        order.textContent="";outside.focus();await frame();
      }
      evidence.push({mode,theme,size,nodes:tracked.length,primary:read(primary),tavily:read(tavily)});
    });
  }
  await run("production Provider reveal and Tavily reveal keep nodes",async()=>{
    const providerKey=provider.querySelector<HTMLInputElement>('input[type=password]')!;
    provider.querySelector<HTMLButtonElement>('[data-modal-focus-key="toggle-api-key"]')!.click();await frame();
    assert(providerKey.type==="text"&&providerKey.isConnected,"provider reveal replaced input");
    panel.querySelector<HTMLButtonElement>('[aria-pressed="false"]')!.click();await frame();
    assert(tavily.type==="text"&&tavily.isConnected,"Tavily reveal replaced input");
  });
  await run("body Select inherits owning boundary, keyboard and Scope release",async()=>{
    document.body.className="theme-dark mod-macos";document.body.dataset.echoinkTheme="violet";
    settings.style.setProperty("--font-interface","Georgia");document.body.style.setProperty("--font-text-size","24px");
    const host=createOriginSelectHostFixture(window);
    const select=createOriginSelect(page,{attr:{"aria-label":"Language"}},[{value:"zh",label:"中文"},{value:"en",label:"English"}],"zh",host.app).element;
    after.textContent=interference;select.focus();key(select,"Enter");await frame();
    const popup=document.querySelector<HTMLElement>('[data-slot=select-content]')!;
    assert(popup.ownerDocument===select.ownerDocument&&popup.classList.contains("echoink-theme-overlay"),"portal left owning boundary");
    assert(getComputedStyle(popup).fontFamily.includes("Georgia")&&getComputedStyle(popup).colorScheme==="dark","portal font/mode differs from trigger");
    key(document.activeElement as HTMLElement,"ArrowDown");await frame();key(document.activeElement as HTMLElement,"Enter");await frame();
    assert(select.value==="en"&&host.depth===0,"selection failed or leaked Scope");
    select.focus();key(select,"Enter");await frame();key(document.activeElement as HTMLElement,"Escape");await frame();
    assert(!document.querySelector('[data-slot=select-content]')&&document.activeElement===select&&host.depth===0,"Escape did not close and restore focus");
    host.dispose();after.textContent="";
  });
  await run("owned Menu marker never touches existing host menus",async()=>{
    const existing=document.body.createDiv({cls:"menu"});
    let own:HTMLElement|undefined;
    showEchoInkMenu(document,()=>{own=document.body.createDiv({cls:"menu"});});
    assert(own?.classList.contains("echoink-theme-boundary")&&!existing.classList.contains("echoink-theme-boundary"),"menu ownership leaked");
    existing.remove();own?.remove();
  });
  await run("native host field keeps default focus and Review keeps default surface",async()=>{
    const native=fixture.createDiv({cls:"modal echoink-theme-boundary"});
    const input=native.createEl("input",{attr:{type:"text"}});
    const review=fixture.createDiv({cls:"codex-review-preview"});
    try{
      for(const mode of ["theme-light","theme-dark"]){
        document.body.className=mode+" mod-macos";before.textContent=after.textContent="";
        product.textContent=baseline;input.focus();await frame();const original=read(input);
        const defaultSurface=getComputedStyle(document.body).getPropertyValue("--background-primary").trim();
        product.textContent=current;await frame();assert(JSON.stringify(read(input))===JSON.stringify(original),"native default focus changed");
        assert(getComputedStyle(native).getPropertyValue("--input-border-width-focus").trim()==="2px","native focus width changed");
        const surface=read(review).backgroundColor;assert(surface!=="rgba(0, 0, 0, 0)",`Review lost default surface ${defaultSurface}`);
        after.textContent=interference;await frame();assert(JSON.stringify(read(input))===JSON.stringify(original),"theme changed native field focus");
        assert(read(review).backgroundColor===surface,"theme changed Review surface");
      }
    }finally{native.remove();review.remove();after.textContent="";}
  });
  await run("host dimmed modal shell: finance default border, geometry and shadow",async()=>{
    const modal=new Modal({} as App);modal.containerEl.addClass("mod-dim");modal.modalEl.addClass("echoink-finance-dialog");
    modal.contentEl.createEl("h2",{text:"记一笔"});modal.contentEl.createEl("input",{attr:{type:"text"}});modal.open();
    try{
      for(const mode of ["theme-light","theme-dark"])for(const theme of ["green","violet"]){
        document.body.className=mode+" mod-macos";document.body.dataset.echoinkTheme=theme;
        before.textContent=after.textContent="";product.textContent=baseline;outside.focus();await frame();const original=read(modal.modalEl);
        product.textContent=current;await frame();assert(JSON.stringify(read(modal.modalEl))===JSON.stringify(original),`default modal shell changed ${mode}/${theme}: ${JSON.stringify(original)} -> ${JSON.stringify(read(modal.modalEl))}`);
        for(const order of [before,after]){
          order.textContent=interference;await frame();assert(JSON.stringify(read(modal.modalEl))===JSON.stringify(original),`theme changed modal shell ${mode}/${theme}`);order.textContent="";
        }
      }
    }finally{modal.close();before.textContent=after.textContent="";}
  });
  await run("production note picker in another document: search, draft, retry, Escape",async()=>{
    const iframe=document.createElement("iframe");iframe.style.cssText="width:390px;height:700px;border:0";document.body.append(iframe);
    await new Promise<void>(resolve=>{iframe.onload=()=>resolve();iframe.srcdoc='<link rel="stylesheet" href="obsidian-app.css"><link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="things-theme.css"><style>body{display:block;margin:0}.modal-container{position:fixed;inset:0;display:flex;align-items:center;justify-content:center}</style><main class="echoink-settings-demo"></main>';});
    const owner=iframe.contentDocument!;installDomMethods(owner.defaultView!);owner.body.className="theme-dark mod-macos";owner.body.dataset.echoinkTheme="violet";
    const root=owner.querySelector<HTMLElement>("main")!;root.style.setProperty("--font-interface","Georgia");root.style.setProperty("--font-text-size","24px");
    const trigger=createOriginButton(root,{text:"Add notes"});
    const picker=new KnowledgeNotePickerModal({fixtureDocument:owner} as unknown as App,{zh:false,targetRole:"wiki",targetLabel:"Wiki",triggerEl:trigger,notes:[{sourcePath:"Raw/First note.md",role:"raw"},{sourcePath:"Reviews/Second note.md",role:"review"}],onConfirm:async()=>{throw new Error("Fixture save failure");}});
    try{
      trigger.focus();picker.open();await frame();const modal=picker.modalEl;const search=modal.querySelector<HTMLInputElement>("input")!;
      assert(owner.activeElement===search&&modal.ownerDocument===owner,"picker owns wrong window/focus");
      assert(getComputedStyle(search).fontFamily.includes("Georgia")&&getComputedStyle(search).fontSize==="18px","picker lost source font/scale");
      assert(owner.defaultView!.getComputedStyle(search.parentElement!).boxShadow==="none","search wrapper has old ring");
      const check=modal.querySelector<HTMLButtonElement>(".echoink-knowledge-note-picker-checkbox")!;check.click();await frame();
      assert(picker.selectedCount===1,"selection was not saved in draft");
      search.value="Second";search.dispatchEvent(new owner.defaultView!.Event("input",{bubbles:true}));await frame();
      assert(picker.selectedCount===1&&modal.querySelectorAll(".echoink-knowledge-note-picker-row").length===1,"search lost draft");
      modal.querySelector<HTMLButtonElement>(".echoink-knowledge-note-picker-confirm")!.click();await frame();
      assert(!picker.isSubmitting&&modal.querySelector('[role=alert]')&&picker.selectedCount===1,"failed save lost retry state");
      const bounds=modal.getBoundingClientRect(),footer=modal.querySelector<HTMLElement>(".echoink-knowledge-note-picker-footer")!.getBoundingClientRect();
      assert(modal.scrollWidth<=modal.clientWidth+1&&bounds.width<=390&&footer.bottom<=bounds.bottom+1,"narrow picker clipped footer or overflowed");
      search.focus();key(search,"Tab");await frame();assert(modal.contains(owner.activeElement),"Tab escaped picker");
      key(owner.activeElement as HTMLElement,"Escape");await frame();assert(!modal.isConnected&&owner.activeElement===trigger,"Escape/restore focus failed");
    }finally{if(picker.modalEl.isConnected)picker.close();disposeOriginControls(root);iframe.remove();}
  });
  document.body.className="theme-light mod-macos";document.body.dataset.echoinkTheme="green";document.body.style.setProperty("--font-text-size","16px");document.body.style.setProperty("--font-interface-override","'??'");settings.style.removeProperty("--font-interface");
  (window as Window & {themeIsolationEvidence?:unknown[]}).themeIsolationEvidence=evidence;
  report.dataset.result=results.some(result=>result.startsWith("FAIL"))?"failed":"passed";
  report.textContent=results.join("\n")+"\nBoundary: production renderers/fields, synthetic browser host; native Obsidian acceptance belongs to control.";
  fixture.style.removeProperty("pointer-events");
  const preview=document.body.createDiv({cls:"preview-controls"});document.body.prepend(preview);
  let previewBaseline=false,previewThings=false,previewDark=false,previewLarge=false,previewNarrow=false;
  const refreshPreview=()=>{
    product.textContent=previewBaseline?baseline:current;before.textContent="";after.textContent=previewThings?interference:"";
    document.body.className=(previewDark?"theme-dark":"theme-light")+" mod-macos";
    document.body.style.setProperty("--font-text-size",previewLarge?"24px":"16px");document.body.style.setProperty("--font-interface-override",previewLarge?"Georgia":"'??'");
    fixture.style.width=previewNarrow?"390px":"900px";
  };
  for(const [name,toggle] of [["Baseline / current",()=>previewBaseline=!previewBaseline],["Default / Things",()=>previewThings=!previewThings],["Light / dark",()=>previewDark=!previewDark],["16 / 24 Georgia",()=>previewLarge=!previewLarge],["900 / 390 container",()=>previewNarrow=!previewNarrow]] as const){
    const button=preview.createEl("button",{text:name});button.onclick=()=>{toggle();refreshPreview();};
  }
  refreshPreview();
}
