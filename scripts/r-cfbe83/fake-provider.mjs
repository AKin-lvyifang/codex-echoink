import http from 'node:http';
import {createHash} from 'node:crypto';
let scenario=null,step=0;const events=[];
const hash=t=>'sha256:'+createHash('sha256').update(t).digest('hex');
const server=http.createServer(async(req,res)=>{
 res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','*');
 if(req.method==='OPTIONS'){res.end();return;}
 if(req.url==='/stats'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(events));return;}
 const chunks=[];for await(const c of req)chunks.push(c);let body;try{body=JSON.parse(Buffer.concat(chunks));}catch{res.writeHead(400);res.end();return;}
 if(req.url==='/scenario'){scenario=body;step=0;res.end('ok');return;}
 const tools=body.tools?.map(t=>t.function?.name)??[];let call=null;
 if(scenario&&tools.includes('knowledge_maintain')){
  const {sources,target,title,kind}=scenario;
  const unit={id:'synthetic-unit',type:'概念',domain:'合成验收',title,aliases:[],points:['只保留经过提炼的要点。'],evidence:[{sourcePath:sources[0].path,sourceRevision:hash(sources[0].content),quote:'必要短原句。'}]};
  const clean=`---\n类型: 概念\naliases: []\n建议领域: 合成验收\n---\n# ${title}\n\n这是一份提炼后的合成知识。\n\n## 要点\n\n根据材料提炼观点和边界，只保留必要的短引用。\n`;
  const raw=sources[0].content.split('\n').find(line=>line.length>600)??'';
  const bad=kind==='dispersed'?raw.slice(0,500)+'\n\n'+raw.slice(650,1150)+'\n\n'+raw.slice(1300,1800):kind==='ordinary'?`\n## 普通标题\n${raw}`:raw;
  const actions=[...sources.map(source=>['note_read',{relativePath:source.path}]),['knowledge_maintain',{stage:'decompose',decompositions:sources.map((source,i)=>({sourcePath:source.path,summary:'合成验收摘要',units:i?[]:[unit]}))}],['note_read',{relativePath:target}],['knowledge_maintain',{stage:'plan',writingPlan:[{id:'one',targetPath:target,sourcePaths:[sources[0].path],expectedTarget:scenario.before?{kind:'file',contentRevision:hash(scenario.before)}:{kind:'missing'},knowledge:{unitIds:[unit.id],decision:scenario.before?{kind:'same_point',reason:'同一合成知识点的新材料',candidatePath:target}:{kind:'new',reason:'独立合成知识点'}}}]}]];
  if(kind==='append'){
    actions.push(['knowledge_maintain',{stage:'sections',targetPath:target}]);
    const serialized=JSON.stringify(body.messages??[]);const matches=[...serialized.matchAll(/section:[a-f0-9]{64}:\d+/g)];
    const region=matches.at(-1)?.[0];
    actions.push(['knowledge_maintain',{stage:'write',pageId:'one',sectionPatches:[{regionId:region??'missing',operation:'append',content:bad}]}],['knowledge_maintain',{stage:'write',pageId:'one',sectionPatches:[{regionId:region??'missing',operation:'append',content:'新增提炼观点：材料可用于说明方法边界，只保留必要短引用。'}]}]);
  }else actions.push(['knowledge_maintain',{stage:'write',pageId:'one',content:clean+'\n'+bad}],['knowledge_maintain',{stage:'write',pageId:'one',content:clean+'\n短引用：'+raw.slice(0,80)}]);
  if(step<actions.length){const [name,args]=actions[step++];call={id:'r-cfbe83-'+step,type:'function',function:{name,arguments:JSON.stringify(args)}};events.push({kind,step,tool:name,stage:args.stage??null,copyRejectedSeen:JSON.stringify(body.messages??[]).includes("本页复制来源过多")});}
 }
 const message=call?{role:'assistant',content:null,tool_calls:[call]}:{role:'assistant',content:'合成验收已结束。'};
 if(body.stream){res.setHeader('Content-Type','text/event-stream');const delta=call?{role:'assistant',tool_calls:[{index:0,...call}]}:message;res.write('data: '+JSON.stringify({id:'synthetic',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta,finish_reason:null}]})+'\n\n');res.write('data: '+JSON.stringify({id:'synthetic',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta:{},finish_reason:call?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');res.end();}
 else{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'synthetic',object:'chat.completion',created:1,model:body.model,choices:[{index:0,message,finish_reason:call?'tool_calls':'stop'}],usage:{prompt_tokens:20,completion_tokens:20,total_tokens:40}}));}
});server.listen(19684,'127.0.0.1',()=>console.log('Synthetic Provider listening on 127.0.0.1:19684; no upstream calls'));
