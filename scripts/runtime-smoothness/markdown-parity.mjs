import assert from 'node:assert/strict';
import {connect} from './cdp.mjs';

// Run after render-replay.mjs. Compare the retained block tree with the same
// host's complete native Markdown renderer, at exactly the same width.
const c=await connect();
try{
  const result=await c.evaluate(`(async()=>{
    const current=v.virtualListEl.querySelector('.codex-assistant-turn-final .echoink-answer-markdown-host');
    if(!current||!window.__replayText)throw Error('Run render-replay.mjs first');
    const source=current.parentElement,host=source.cloneNode(false);
    Object.assign(host.style,{position:'fixed',left:'-10000px',top:'0',width:source.getBoundingClientRect().width+'px',height:'auto'});
    source.parentElement.append(host);
    const renderer=new v.messageListRenderer.answerMarkdown.constructor();
    try{
      await new Promise(resolve=>renderer.render({app,container:host,key:'native-comparison',text:__replayText,sourcePath:'',streaming:false,mutate:(_,change)=>change(),onCommit:resolve}));
      return {currentHeight:current.getBoundingClientRect().height,nativeHeight:host.getBoundingClientRect().height,
        currentText:current.textContent.replace(/\\s/gu,''),nativeText:host.textContent.replace(/\\s/gu,''),
        blocks:current.querySelectorAll('.echoink-answer-markdown-block').length};
    }finally{renderer.clear();host.remove();}
  })()`);
  await c.write('markdown-native-parity.json',result);
  assert.equal(result.currentText,result.nativeText);
  assert.ok(Math.abs(result.currentHeight-result.nativeHeight)<1,'native block spacing must match the full document');
  console.log({currentHeight:result.currentHeight,nativeHeight:result.nativeHeight,blocks:result.blocks,textMatches:true});
}finally{c.close();}
