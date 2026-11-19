import assert from 'node:assert/strict';
import {connect,delay} from './cdp.mjs';
const c=await connect();
const checkBlocks=process.argv.includes('--check-blocks');
const prefix=process.argv.includes('--indented-code')?'缩进代码块补验。\n\n    const first = 1;\n\n    const second = 2;\n\n后续段落。\n\n':'';
try{
  await c.evaluate(`(async()=>{window.p=app.plugins.plugins['codex-echoink'];window.v=p.getCodexView();const id=p.settings.sessions.find(s=>s.messages.length===3).id;await v.openTaskDetail(id);__smooth.attach();window.__replaySession=v.ensureSession();window.__replayOriginal=structuredClone(__replaySession.messages);window.__replayAnswer=__replaySession.messages.find(m=>m.itemType==='assistant');window.__replayText=__replayAnswer.text;window.__replayState=p.getConversationRunService().stateFor(id);__replayState.running=true;__replayState.activeTurnId=__replayAnswer.turnId;for(const m of __replaySession.messages)if(m.assistantTurn)m.assistantTurn={...m.assistantTurn,status:'running'};__replayAnswer.status='running';__replayAnswer.text='';v.renderMessages({forceBottom:true});})()`);
  if(prefix)await c.evaluate(`__replayText=${JSON.stringify(prefix)}+__replayText`);
  await delay(400);await c.traceStart();await c.evaluate('__smooth.reset()');
  if(checkBlocks)await c.evaluate(`window.__blockNodes=new Map();window.__blockMismatches=0;window.__blockClears=0;window.__blockSelection=null;
    window.__blockObserver=new MutationObserver(records=>{for(const record of records)if(record.type==='childList'&&record.removedNodes.length&&record.target instanceof Element&&record.target.matches('.echoink-answer-markdown-stream,.echoink-answer-markdown-host')&&record.target.closest('.codex-assistant-turn-final'))__blockClears++;});
    __blockObserver.observe(v.virtualListEl,{childList:true,subtree:true});window.__checkBlocks=()=>{
      const blocks=[...v.virtualListEl.querySelectorAll('.codex-assistant-turn-final .echoink-answer-markdown-block')];
      blocks.forEach((block,index)=>{const native=block.querySelector('.markdown-rendered');if(!native)return;const previous=__blockNodes.get(index);if(previous&&previous!==native)__blockMismatches++;else __blockNodes.set(index,native);});
      if(!__blockSelection){const node=[...v.virtualListEl.querySelectorAll('.codex-assistant-turn-final .markdown-rendered p')].map(p=>p.firstChild).find(n=>n?.nodeType===Node.TEXT_NODE&&n.textContent.length>8);if(node){const r=document.createRange();r.setStart(node,0);r.setEnd(node,8);getSelection().removeAllRanges();getSelection().addRange(r);__blockSelection=getSelection().toString();}}
    };`);
  const samples=[];
  const length=await c.evaluate('__replayText.length');
  for(let i=12;i<length+12;i+=12){
    samples.push(await c.evaluate(`(()=>{performance.mark('render-replay-delta');__replayAnswer.text=__replayText.slice(0,${i});v.renderMessagesIfActive(__replaySession,__replayAnswer);return {at:performance.now(),textChars:__replayAnswer.text.length,domChars:v.virtualListEl.querySelector('.codex-assistant-turn-final')?.textContent.length,rows:v.virtualListEl.children.length};})()`));
    await delay(40);
    if(checkBlocks)await c.evaluate('__checkBlocks()');
  }
  await c.evaluate(`__replayAnswer.status='completed';v.renderMessagesIfActive(__replaySession,__replayAnswer)`);await delay(350);
  const blocks=checkBlocks?await c.evaluate(`(__checkBlocks(),{stableNativeBlocks:__blockNodes.size,identityChanges:__blockMismatches,wholeAnswerClears:__blockClears,expectedSelection:__blockSelection,selection:getSelection().toString()})`):undefined;
  if(blocks){assert.ok(blocks.stableNativeBlocks>10);assert.equal(blocks.identityChanges,0);assert.equal(blocks.wholeAnswerClears,0);assert.equal(blocks.selection,blocks.expectedSelection);}
  await c.traceEnd('render-replay');await c.write('render-replay.json',{chunks:samples.length,textChars:length,samples,blocks,...await c.evaluate('__smooth.snapshot()')});await c.screenshot('render-replay');
  console.log({chunks:samples.length,length,calls:await c.evaluate(`Object.fromEntries(Object.entries(__smooth.calls).filter(([k])=>/markdown|list.render$|plugin.save/.test(k)))`)});
}finally{
  await c.evaluate(`window.__blockObserver?.disconnect();if(window.__replayOriginal){__replaySession.messages=__replayOriginal;__replayState.running=false;p.getConversationRunService().runs.delete(__replaySession.id);v.renderMessages({forceBottom:true});}`);c.close();
}
