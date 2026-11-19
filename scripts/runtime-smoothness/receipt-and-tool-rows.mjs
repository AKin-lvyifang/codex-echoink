import assert from 'node:assert/strict';
import {connect,delay} from './cdp.mjs';

const c=await connect(),result={realModelCalls:0};
const paths=['工具图标验收/甲.md','工具图标验收/乙.md','工具图标验收/丙.md'];
const rowsExpression=`[...v.virtualListEl.querySelectorAll('.codex-assistant-turn-action-node')].map(row=>{
  const icon=row.querySelector('.codex-action-item-icon');return {id:row.dataset.messageId,status:row.dataset.nodeStatus,
    toolStatus:row.getAttribute('data-tool-status'),icon:icon?.dataset.icon,iconRunning:icon?.classList.contains('is-running')};})`;
const alignmentExpression=`(root)=>{
  const textRects=el=>{const range=document.createRange();range.selectNodeContents(el);return [...range.getClientRects()].filter(r=>r.width>0).map(r=>({x:r.x,y:r.y,width:r.width}));};
  const button=root.querySelector('.codex-memory-receipt'),x=textRects(button.lastElementChild)[0].x;
  return {buttonTextX:x,animations:button.getAnimations({subtree:true}).length,
    rows:[...root.querySelectorAll('.codex-memory-receipt-row')].map(row=>({title:row.firstElementChild.textContent,
      delta:textRects(row.firstElementChild).map(r=>r.x-x),lines:textRects(row.firstElementChild).length,
      reasonColor:getComputedStyle(row.lastElementChild).color,titleColor:getComputedStyle(row.firstElementChild).color,
      justifyContent:getComputedStyle(row).justifyContent})),
    notes:[...root.querySelectorAll('.codex-ai-elements-source-title')].flatMap(el=>textRects(el).map(r=>r.x-x))};
}`;
function checkAlignment(sample){
  assert.equal(sample.animations,0);
  assert.ok(sample.rows.length>=2&&sample.rows.every(row=>row.justifyContent==='flex-start'&&row.delta.every(x=>Math.abs(x)<.5)));
  assert.ok(sample.rows.some(row=>row.lines>1),'a long memory title must really wrap');
  assert.ok(sample.notes.length>=3&&sample.notes.every(x=>Number.isFinite(x)&&Math.abs(x)<.5),'note and receipt text must share the same left edge');
}
try{
  await c.evaluate(`(async()=>{
    if(window.__smooth)throw Error('Reload without the performance probe before UI acceptance');
    if(p.settings.apiProviders.some(a=>a.baseUrl!=='http://127.0.0.1:19464/v1'))throw Error('Local fake Provider required');
    for(const path of ${JSON.stringify(paths)}){const folder=path.split('/')[0];if(!app.vault.getAbstractFileByPath(folder))await app.vault.createFolder(folder);if(!app.vault.getAbstractFileByPath(path))await app.vault.create(path,'合成工具图标验收笔记：'+path);}
    const local=await p.ensurePiLocalData(),context={vaultId:local.vaultIdentity.vaultId,conversationId:'receipt-layout-fixture',piSessionId:'receipt-layout-fixture',productRunId:'receipt-layout-fixture',userEntryId:'receipt-layout-fixture',memoryMode:'normal',explicitlyAuthorized:true};
    const memories=[['银槐验收颜色','银槐验收的首选颜色是湖蓝。'],['银槐验收饮品与长标题换行检查：'+ '标题换行后仍须靠左'.repeat(4),'银槐验收的首选饮品是无糖桂花乌龙。']];
    for(const [index,[title,content]] of memories.entries()){const saved=await local.personalMemory.write({operation:'create',kind:'fact',title,content,pinned:true,basis:'explicit',recallWhen:'银槐验收颜色与饮品'},{...context,toolCallId:'receipt-layout-'+index});if(!saved.record)throw Error('Fixture memory write failed');}
    await v.openAgentTaskList('sol');window.__rowsPrevious=p.settings.activeSessionId;
    const renderer=v.messageListRenderer;window.__rowProbe={renderer,original:renderer.tryUpdateAssistantTurnMessage,partialCalls:0};
    renderer.tryUpdateAssistantTurnMessage=function(...args){__rowProbe.partialCalls++;return __rowProbe.original.apply(this,args);};
  })()`);
  await fetch('http://127.0.0.1:19464/scenario',{method:'POST',body:JSON.stringify({mode:'note-reads',paths})});
  await c.evaluate(`v.inputEl.value=${JSON.stringify('请读取 '+paths.join('、')+'，然后回答银槐验收的首选颜色和饮品。')};v.inputEl.dispatchEvent(new Event('input',{bubbles:true}));void v.sendMessage();`);
  let seen=false,film=false;
  result.streaming=[];
  for(let i=0;i<600;i++){
    const state=await c.evaluate(`({current:p.settings.activeSessionId!==__rowsPrevious,running:v.running,
      bodyChars:v.virtualListEl.querySelector('.codex-assistant-turn-final .codex-message-content')?.textContent.length??0,
      bodyText:v.virtualListEl.querySelector('.codex-assistant-turn-final .codex-message-content')?.textContent.slice(0,80),
      tools:v.ensureSession().messages.filter(m=>m.itemType==='dynamicToolCall').map(m=>({id:m.id,status:m.status})),
      nodes:v.messageListRenderer.currentRows.find(r=>r.kind==='assistantTurn')?.turn.processNodes.map(n=>({id:n.nodeId,source:n.sourceMessageId,status:n.status})),
      answerChars:v.ensureSession().messages.filter(m=>m.itemType==='assistant'&&m.status==='running').reduce((n,m)=>n+(m.text?.length??0),0),
      placeholder:!!v.virtualListEl.querySelector('.codex-assistant-turn-final .codex-smooth-ai-loader'),
      rows:${rowsExpression}})`);
    if(state.current&&state.running)seen=true;
    if(state.current&&state.running&&state.answerChars>30&&state.answerChars<1883&&!state.placeholder&&state.rows.length>=3){
      result.streaming.push(state);
      assert.ok(state.rows.every(r=>r.status==='completed'&&r.toolStatus==='success'&&r.icon==='file-text'&&!r.iconRunning), 'every completed note read must stop showing progress while the answer streams');
      if(!film){
        await c.evaluate(`(()=>{v.messageScrollFollow.pauseFromUser();
          for(const detail of v.virtualListEl.querySelectorAll('.codex-assistant-turn-reasoning-node[open]'))detail.querySelector('summary')?.click();
          const first=v.virtualListEl.querySelector('.codex-assistant-turn-action-node');
          v.messagesEl.scrollTop+=first.getBoundingClientRect().top-v.messagesEl.getBoundingClientRect().top-12;})()`);
        await c.screenshot('tools-during-stream');film=true;
      }
    }
    if(seen&&!state.running)break;
    await delay(100);
  }
  assert.ok(seen&&result.streaming.length>0,'observe the real tool continuation before the answer finishes');
  assert.equal(await c.evaluate('v.running'),false);
  result.partialCalls=await c.evaluate('__rowProbe.partialCalls');
  assert.ok(result.partialCalls>0);
  result.incrementalIcons=await c.evaluate(rowsExpression);
  await c.evaluate('v.renderMessages({preserveScroll:true})');
  result.fullRenderIcons=await c.evaluate(rowsExpression);
  assert.deepEqual(result.incrementalIcons,result.fullRenderIcons,'incremental and complete renders must agree');
  result.injectedSourceCount=await c.evaluate(`new Set(v.ensureSession().messages.flatMap(m=>m.injectedMemorySources??[]).map(s=>s.id)).size`);
  assert.equal(result.injectedSourceCount,2);
  await c.evaluate(`window.__layoutReceipt=v.virtualListEl.querySelector('.codex-memory-receipt');__layoutReceipt.scrollIntoView({block:'center'});`);
  await c.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const point=await c.evaluate(`(()=>{const r=__layoutReceipt.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;
    if(document.elementFromPoint(x,y)?.closest('.codex-memory-receipt')!==__layoutReceipt)throw Error('Receipt pointer target is covered');return {x,y};})()`);
  await c.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
  await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
  assert.equal(await c.evaluate('__layoutReceipt.getAttribute("aria-expanded")'),'true');
  result.desktop=await c.evaluate(`(${alignmentExpression})(v.virtualListEl)`);
  checkAlignment(result.desktop);
  const initialDark=await c.evaluate('document.body.classList.contains("theme-dark")');
  result.themes=[];
  for(let i=0;i<2;i++){
    if(i)await c.evaluate('app.commands.executeCommandById("theme:toggle-light-dark")');
    await delay(250);
    await c.evaluate('__layoutReceipt.scrollIntoView({block:"center"})');
    const theme=await c.evaluate('document.body.classList.contains("theme-dark")?"dark":"light"');
    await c.screenshot('receipt-alignment-'+theme);result.themes.push(theme);
  }
  if(initialDark!==await c.evaluate('document.body.classList.contains("theme-dark")'))await c.evaluate('app.commands.executeCommandById("theme:toggle-light-dark")');
  await c.evaluate(`(()=>{
    const root=document.createElement('div');root.className='echoink-mobile';Object.assign(root.style,{position:'fixed',top:'70px',left:'20px',width:'390px',zIndex:999999,background:'var(--background-primary)'});document.body.append(root);
    const wasMobile=document.body.classList.contains('is-mobile');document.body.classList.add('is-mobile');
    const renderer=new v.messageListRenderer.constructor();renderer.env={...v.messageListRenderer.env,sessionId:'receipt-layout-mobile'};
    const turn=v.messageListRenderer.currentRows.find(r=>r.kind==='assistantTurn').turn;renderer.renderAnswerSources(root,turn);root.querySelector('.codex-memory-receipt').click();window.__mobileRows={root,renderer,wasMobile};
  })()`);
  try{result.mobileCss=await c.evaluate(`(${alignmentExpression})(__mobileRows.root)`);checkAlignment(result.mobileCss);await c.screenshot('receipt-mobile-css');}
  finally{await c.evaluate('__mobileRows.renderer.dispose();__mobileRows.root.remove();if(!__mobileRows.wasMobile)document.body.classList.remove("is-mobile");delete window.__mobileRows');}
  await c.write('receipt-and-tool-rows.json',result);
  console.log({streamingSamples:result.streaming.length,partialCalls:result.partialCalls,desktop:result.desktop,mobileCss:result.mobileCss});
}catch(error){await c.write('receipt-and-tool-rows-failure.json',{...result,error:String(error)});throw error;}
finally{
  await fetch('http://127.0.0.1:19464/scenario',{method:'POST',body:JSON.stringify({mode:'normal'})});
  await c.evaluate('if(window.__rowProbe){__rowProbe.renderer.tryUpdateAssistantTurnMessage=__rowProbe.original;delete window.__rowProbe;}');
  c.close();
}
