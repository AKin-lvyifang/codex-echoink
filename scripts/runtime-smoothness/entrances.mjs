import {connect,delay} from './cdp.mjs';
const c=await connect();
try {
 const result=await c.evaluate(`(async()=>{
   const runtime=p.piRuntimeBundle.runtime,id='perf-entry-'+Date.now(),entry=await p.createPiConversation({conversationId:id,title:'入口验收·200条',agentId:'sol',cwd:p.getVaultPath(),defaultMemoryMode:'normal'});
   await runtime.activateConversation(id);const a=runtime.active.get(id),usage={input:10,output:10,cacheRead:0,cacheWrite:0,totalTokens:20,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
   for(let i=0;i<100;i++){a.sessionManager.appendMessage({role:'user',content:[{type:'text',text:'第'+i+'个合成问题'}],timestamp:Date.now()});a.sessionManager.appendMessage({role:'assistant',content:[{type:'text',text:('这是用于衡量长会话打开与滚动的固定文字。'.repeat(10))+'\\n\\n- 第一项\\n- 第二项'}],api:'openai-completions',provider:'deepseek',model:'deepseek-flash',usage,stopReason:'stop',timestamp:Date.now()});}
   runtime.checkpointConversationLeaf(a);await runtime.releaseConversation(id);
   const samples=[];for(let i=0;i<4;i++){await v.openAgentTaskList('sol');const t=performance.now(),open=v.openTaskDetail(id);while(!v.taskDetailLoaded||p.settings.activeSessionId!==id)await new Promise(requestAnimationFrame);await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const painted=performance.now()-t;await open;samples.push({cold:i===0,contentPaintMs:painted,actionSettledMs:performance.now()-t,messages:v.ensureSession().messages.length,rows:v.virtualListEl.children.length});}
   return {id,samples};})()`);
 await c.write('entrances.json',result);console.log(result);
} finally {c.close()}
