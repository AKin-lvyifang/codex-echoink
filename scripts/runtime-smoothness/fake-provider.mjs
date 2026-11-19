import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {out,delay,vault} from './cdp.mjs';
export const reasoning = Array.from({length:24},(_,i)=>`第${i+1}步，检查输入和约束，按顺序核对性能测量的方法。此处是固定的合成思考文本，用于验证展开、滚动与刷新。`).join('\n\n');
export const answer = '# 固定回放：运行测量\n\n'+Array.from({length:12},(_,i)=>`## 第${i+1}节\n\n本段用于测量流式界面的渲染开销。我们把同一份文字按固定节奏分段送出，观察输入、绘制、滚动和保存是否互相影响。这些文字只存在于专用测试库，不代表模型质量或真实网络速度。\n\n- 核对事件数量与画面变化。\n- 保留已经读到的位置。\n- 记录主线程最忙的函数。\n\n`).join('')+'```javascript\nfunction measure(items) {\n  return items.map(item => ({ ...item, measured: true }));\n}\nconsole.log(measure([{ id: 1 }]));\n```\n\n| 场景 | 次数 | 说明 |\n| --- | ---: | --- |\n| 思考 | 3 | 固定事件 |\n| 回答 | 200 | 分段输出 |\n| 完成 | 1 | 保存结果 |\n';
const stats={started:new Date().toISOString(),realModelCalls:0,requests:[],answerChars:answer.length,reasoningChars:reasoning.length};
let speed=40;
let scenario={mode:'normal'};
const server=http.createServer(async(req,res)=>{
  // Mobile's production transport uses WebView fetch, including CORS preflight.
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','*');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
  if(req.url==='/stats'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(stats));return;}
  if(req.url?.startsWith('/speed/')){speed=Number(req.url.split('/').pop());res.end('ok');return;}
  const parts=[];for await(const chunk of req)parts.push(chunk);
  let body;try{body=JSON.parse(Buffer.concat(parts));}catch{res.writeHead(400);res.end();return;}
  if(req.url==='/scenario'){scenario=body;res.end('ok');return;}
  const maxTokens=body.max_tokens??body.max_completion_tokens;
  const auxiliary=Number(maxTokens)>0&&Number(maxTokens)<=256;
  const deliveredReferenceIds=[...new Set(JSON.stringify(body.messages??[]).match(/knowledge-reference:[a-f0-9]{64}/gu)??[])];
  const row={path:req.url,stream:!!body.stream,start:new Date().toISOString(),chunks:0,model:body.model,maxTokens,tools:body.tools?.length??0,auxiliary,deliveredReferenceIds};stats.requests.push(row);
  if(scenario.mode==='fail-once'&&!auxiliary&&!scenario.failed){scenario.failed=true;row.end=new Date().toISOString();res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'固定失败一次，用于验证重试。'}}));return;}
  if(!body.stream){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id:'perf-nonstream',object:'chat.completion',choices:[{index:0,message:{role:'assistant',content:'固定回放测试'},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:6,total_tokens:26}}));return;}
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});
  const emit=(delta,finish_reason=null)=>{if(delta.content&&!row.firstContentAt)row.firstContentAt=Date.now();if(delta.reasoning_content&&!row.firstReasoningAt)row.firstReasoningAt=Date.now();row.chunks++;res.write('data: '+JSON.stringify({id:'perf-stream',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta,finish_reason}]})+'\n\n');};
  try{
    emit({role:'assistant',content:''});
    if(auxiliary){emit({content:'固定性能测量'});emit({},'stop');res.write('data: [DONE]\n\n');res.end();return;}
    if(scenario.mode==='approval'&&body.tools?.some(tool=>tool.function?.name==='note_create')&&!body.messages.some(message=>message.role==='tool')){
      if(!/^性能审批验收\/(?:iphone|ipad)-[a-z0-9-]+\.md$/u.test(scenario.path))throw Error('Synthetic approval path required');
      emit({tool_calls:[{index:0,id:'perf-approval-write',type:'function',function:{name:'note_create',arguments:JSON.stringify({path:scenario.path,content:'# 固定审批\n\n只在本轮副本。'})}}]});
      emit({},'tool_calls');res.write('data: [DONE]\n\n');res.end();return;
    }
    if(scenario.mode==='note-reads'&&body.tools?.some(tool=>tool.function?.name==='note_read')&&!body.messages.some(message=>message.role==='tool')){
      const paths=scenario.paths;
      if(!Array.isArray(paths)||paths.length!==3||paths.some(p=>!/^工具图标验收\/[^/]+\.md$/u.test(p)))throw Error('Three synthetic note paths required');
      for(const [index,relativePath] of paths.entries())emit({tool_calls:[{index,id:'perf-note-read-'+index,type:'function',function:{name:'note_read',arguments:JSON.stringify({relativePath})}}]});
      emit({},'tool_calls');res.write('data: [DONE]\n\n');res.end();return;
    }
    if(scenario.mode==='tool-added'&&body.tools?.some(tool=>tool.function?.name==='knowledge_read')&&!body.messages.some(message=>message.role==='tool')){
      if(scenario.path!=='性能回放专用/后读.md'||path.dirname(vault)!==path.join(os.homedir(),'EchoInk-TestVaults')||!path.basename(vault).startsWith('测试仓库-'))throw Error('Disposable reference fixture required');
      await fs.writeFile(path.join(vault,scenario.path),scenario.content,{flag:'wx'});
      emit({tool_calls:[{index:0,id:'perf-knowledge-read',type:'function',function:{name:'knowledge_read',arguments:JSON.stringify({vaultRelativePath:scenario.path,expectedContentRevision:scenario.revision,lineStart:1,lineCount:20})}}]});
      emit({},'tool_calls');res.write('data: [DONE]\n\n');res.end();return;
    }
    for(let i=0;i<reasoning.length;i+=10){if(res.destroyed)break;emit({reasoning_content:reasoning.slice(i,i+10)});await delay(speed);}
    for(let i=0;i<answer.length;i+=12){if(res.destroyed)break;emit({content:answer.slice(i,i+12)});await delay(speed);}
    emit({},'stop');res.write('data: [DONE]\n\n');res.end();
  }finally{row.end=new Date().toISOString();await fs.mkdir(out,{recursive:true});await fs.writeFile(out+'/fake-provider-stats.json',JSON.stringify(stats,null,2));}
});
const port=Number(process.env.ECHOINK_FAKE_PORT??19464);
server.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({port,answerChars:answer.length,reasoningChars:reasoning.length})));
