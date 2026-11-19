import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {connect,delay,out} from './cdp.mjs';

const c=await connect(),baseline=process.argv.includes('--baseline'),result={baseline,realModelCalls:0};
try {
  await fetch('http://127.0.0.1:19464/speed/10');
  await c.evaluate(`(async()=>{window.p=app.plugins.plugins['codex-echoink'];await p.activateView();window.v=p.getCodexView();if(p.settings.apiProviders.some(a=>a.baseUrl!=='http://127.0.0.1:19464/v1'))throw Error('Local fake Provider required');await v.openAgentTaskList('sol');if(document.querySelector('.modal-container'))throw Error('Blocked by modal');window.__receiptPrevious=p.settings.activeSessionId;window.__receiptWatch={frames:[],first:null,previous:null,replacements:0};
    const frame=()=>{const current=p.settings.activeSessionId!==__receiptPrevious&&v.taskDetailLoaded&&v.taskNavigation.page.kind==='detail'&&v.taskNavigation.page.taskId===p.settings.activeSessionId;const b=current?v.virtualListEl.querySelector('.codex-memory-receipt'):null;if(b&&!__receiptWatch.first)__receiptWatch.first=b;if(b&&__receiptWatch.previous&&b!==__receiptWatch.previous)__receiptWatch.replacements++;if(b)__receiptWatch.previous=b;__receiptWatch.frames.push({t:performance.now(),current,present:!!b,running:current&&v.running,first:!!b&&b===__receiptWatch.first});if(!__receiptWatch.stop)__receiptWatch.raf=requestAnimationFrame(frame);};frame();
    v.inputEl.value='银槐验收的首选颜色和饮品是什么？请只回答，不调用工具。';v.inputEl.dispatchEvent(new Event('input',{bubbles:true}));void v.sendMessage();})()`);
  let seen=false;
  for(let n=0;n<300;n++) {
    const state=await c.evaluate(`({id:p.settings.activeSessionId,running:v.running,button:!!v.virtualListEl.querySelector('.codex-memory-receipt')})`);
    if(state.id!==await c.evaluate('__receiptPrevious')&&state.running)seen=true;
    if(seen&&!state.running)break;
    await delay(100);
  }
  assert.ok(seen&&!await c.evaluate('v.running'),'the current fake-model turn must finish');
  await delay(250);
  result.lifecycle=await c.evaluate(`(()=>{const b=v.virtualListEl.querySelector('.codex-memory-receipt');if(!b)throw Error('The actual response has no memory receipt');window.__receiptButton=b;window.__receiptSvg=b.querySelector('svg');return {replacements:__receiptWatch.replacements,firstSurvives:b===__receiptWatch.first,frames:__receiptWatch.frames,sourceCount:v.ensureSession().messages.flatMap(m=>m.injectedMemorySources??[]).length,label:b.textContent,svg:__receiptSvg.outerHTML};})()`);
  assert.ok(result.lifecycle.sourceCount>=2,'the formal fake-model turn must actually inject the two memories');
  const snapshot=label=>c.evaluate(`(async()=>{await new Promise(requestAnimationFrame);const b=__receiptButton,s=b.querySelector('svg'),r=s.getBoundingClientRect(),style=getComputedStyle(b);return {label:${JSON.stringify(label)},animations:b.getAnimations({subtree:true}).map(a=>a.animationName??'WAAPI'),same:b===v.virtualListEl.querySelector('.codex-memory-receipt'),svgSame:s===__receiptSvg,rect:{width:r.width,height:r.height},background:style.backgroundColor,filter:style.filter,focusVisible:b.matches(':focus-visible'),expanded:b.getAttribute('aria-expanded')};})()`);
  await c.evaluate(`__receiptButton.scrollIntoView({block:'center'});document.activeElement?.blur();`);
  await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:30,y:70});await delay(800);
  result.states=[await snapshot('default')];
  const point=await c.evaluate(`(()=>{const r=__receiptButton.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',...point});result.states.push(await snapshot('hover'));
  await c.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});result.states.push(await snapshot('pressed'));
  await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});result.states.push(await snapshot('expanded'));
  await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:30,y:70});
  await c.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  await c.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  await c.evaluate('__receiptButton.focus({preventScroll:true})');result.states.push(await snapshot('keyboard-focus'));
  result.virtualRedraw=await c.evaluate(`(()=>{v.renderMessages({preserveScroll:true});const b=v.virtualListEl.querySelector('.codex-memory-receipt');return {same:b===__receiptButton,svgSame:b?.querySelector('svg')===__receiptSvg,expanded:b?.getAttribute('aria-expanded'),animations:b?.getAnimations({subtree:true}).map(a=>a.animationName)};})()`);
  if(!baseline) {
    const original=JSON.parse(await fs.readFile(path.join(out,'../baseline/memory-receipt.json'),'utf8'));
    assert.equal(result.lifecycle.svg,original.lifecycle.svg,'the exact resting SVG is unchanged');
    result.freshness=await c.evaluate(`(async()=>{const messages=v.ensureSession().messages,m=messages.filter(m=>m.itemType==='assistant').at(-1),previous=m.knowledgeReferences;
      const folder='图标验收专用',path=folder+'/来源.md';if(!app.vault.getAbstractFileByPath(folder))await app.vault.createFolder(folder);if(!app.vault.getAbstractFileByPath(path))await app.vault.create(path,'仅用于图标验收的合成来源。');
      const file=app.vault.getAbstractFileByPath(path),text=await app.vault.read(file);
      const reference={referenceId:'icon-fixture',vaultRelativePath:path,title:'合成来源',excerpt:'仅用于图标验收',contentRevision:'sha256:'+require('crypto').createHash('sha256').update(text).digest('hex'),lineStart:1,lineEnd:1,verificationStatus:'local_revision_verified'};const records=[];
      try {for(const status of ['local_revision_verified','source_link_changed']){if(status==='source_link_changed')await app.vault.modify(file,text+'\\n合成来源已更新。');m.knowledgeReferences=[{...reference,verificationStatus:status}];const incremental=v.messageListRenderer.tryUpdateVisibleMessages(messages);if(!incremental)v.renderMessages({preserveScroll:true});const b=v.virtualListEl.querySelector('.codex-memory-receipt');records.push({status,incremental,same:b===__receiptButton,svgSame:b.querySelector('svg')===__receiptSvg,animations:b.getAnimations({subtree:true}).length});}}
      finally{await app.vault.modify(file,text);if(previous===undefined)delete m.knowledgeReferences;else m.knowledgeReferences=previous;if(!v.messageListRenderer.tryUpdateVisibleMessages(messages))v.renderMessages({preserveScroll:true});}return records;})()`);
    assert.ok(result.freshness.every(s=>s.same&&s.svgSame&&s.animations===0),'reference changes keep the receipt');
    result.themes=[];
    const initialDark=await c.evaluate('document.body.classList.contains("theme-dark")');
    for(let pass=0;pass<2;pass++){
      if(pass)await c.evaluate('app.commands.executeCommandById("theme:toggle-light-dark")');await delay(250);
      const theme=await c.evaluate('document.body.classList.contains("theme-dark")?"dark":"light"');
      await c.evaluate('__receiptButton.scrollIntoView({block:"center"})');await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:500,y:150});await delay(200);await c.screenshot('memory-receipt-'+theme);result.themes.push(theme);
    }
    if(initialDark!==await c.evaluate('document.body.classList.contains("theme-dark")'))await c.evaluate('app.commands.executeCommandById("theme:toggle-light-dark")');
  }
  result.mobileCss=await c.evaluate(`(()=>{const mobile=document.body.classList.contains('is-mobile'),root=document.createElement('div');root.className='echoink-mobile';Object.assign(root.style,{position:'fixed',top:'80px',left:'20px',width:'390px',zIndex:'999999',background:'var(--background-primary)'});document.body.append(root);document.body.classList.add('is-mobile');
      const renderer=new v.messageListRenderer.constructor();renderer.env={...v.messageListRenderer.env,sessionId:'mobile-receipt-fixture'};const turn=v.messageListRenderer.currentRows.find(r=>r.kind==='assistantTurn').turn;renderer.renderAnswerSources(root,turn);const button=root.querySelector('.codex-memory-receipt');
      window.__mobileReceipt={mobile,root,renderer,button};return {environment:'actual shared receipt renderer under mobile CSS at 390px; not iOS device',states:[]};})()`);
  try {
    const snap=state=>c.evaluate(`(async()=>{await new Promise(requestAnimationFrame);const b=__mobileReceipt.button,r=b.querySelector('svg').getBoundingClientRect(),animations=b.getAnimations({subtree:true});return {state:${JSON.stringify(state)},animations:animations.length,names:animations.map(a=>a.animationName??a.transitionProperty??'WAAPI'),expanded:b.getAttribute('aria-expanded'),width:r.width,height:r.height,focusVisible:b.matches(':focus-visible')};})()`);
    await c.evaluate('document.activeElement?.blur()');await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:900,y:70});await delay(750);result.mobileCss.states.push(await snap('default'));
    const point=await c.evaluate(`(()=>{const r=__mobileReceipt.button.getBoundingClientRect();if(!r.width||!r.height)throw Error('Hidden mobile receipt fixture');return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',...point});result.mobileCss.states.push(await snap('hover'));
    await c.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});result.mobileCss.states.push(await snap('pressed'));
    await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});result.mobileCss.states.push(await snap('expanded'));
    await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:900,y:70});await c.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await c.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await c.evaluate('__mobileReceipt.button.focus({preventScroll:true})');result.mobileCss.states.push(await snap('keyboard-focus'));
    if(!baseline)assert.ok(result.mobileCss.states.every(s=>s.animations===0&&s.width===14));
  } finally {await c.evaluate(`if(window.__mobileReceipt){const a=__mobileReceipt;a.renderer.dispose();a.root.remove();if(!a.mobile)document.body.classList.remove('is-mobile');delete window.__mobileReceipt;}`);}
  if(!baseline){
    await c.evaluate(`window.__brainControl=document.createElement('button');__brainControl.append(__receiptSvg.cloneNode(true));Object.assign(__brainControl.style,{position:'fixed',left:'20px',top:'80px',zIndex:'99999'});document.body.append(__brainControl);`);
    try {const point=await c.evaluate(`(()=>{const r=__brainControl.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',...point});result.otherBrainAnimations=await c.evaluate(`(async()=>{await new Promise(requestAnimationFrame);return __brainControl.getAnimations({subtree:true}).length;})()`);assert.ok(result.otherBrainAnimations>0,'other brain icons retain their motion');}finally{await c.evaluate('__brainControl.remove()');}
  }
  await c.write('memory-receipt.json',result);
  if(!baseline){for(const state of result.states)assert.deepEqual(state.animations,[],state.label);assert.ok(result.virtualRedraw.same,'virtual redraw keeps the receipt button');assert.ok(result.virtualRedraw.svgSame);assert.ok(result.lifecycle.firstSurvives,'completion retains the initial receipt');const first=result.lifecycle.frames.findIndex(f=>f.present);assert.ok(first>=0&&result.lifecycle.frames.slice(first).every(f=>f.present&&f.first),'the observed receipt never disappears during this turn');}
  console.log({lifecycle:{...result.lifecycle,frames:result.lifecycle.frames.length,svg:undefined},states:result.states,virtualRedraw:result.virtualRedraw});
}catch(error){await c.write('memory-receipt-failure.json',{...result,error:String(error)});throw error;}finally{await c.evaluate(`if(window.__receiptWatch){__receiptWatch.stop=true;cancelAnimationFrame(__receiptWatch.raf)}`);await fetch('http://127.0.0.1:19464/speed/40');c.close();}
