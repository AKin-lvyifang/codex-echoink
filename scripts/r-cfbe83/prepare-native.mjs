import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
const vault=path.join(os.homedir(),'EchoInk-TestVaults/测试仓库-R-CFBE83验收');
const out=path.resolve('docs/internal/test-evidence/2026-11-17-R-CFBE83-建议卡与复制防护');
if(!await fs.stat(vault).catch(()=>null)){
 await fs.cp(path.join(os.homedir(),'EchoInk-TestVaults/测试样板'),vault,{recursive:true,dereference:false});
 const writable=async dir=>{await fs.chmod(dir,(await fs.stat(dir)).mode|0o700);for(const entry of await fs.readdir(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isSymbolicLink())continue;if(entry.isDirectory())await writable(file);else await fs.chmod(file,(await fs.stat(file)).mode|0o200);}};
 await writable(vault);await fs.writeFile(path.join(vault,'.r-cfbe83.json'),JSON.stringify({task:'R-CFBE83',syntheticOnly:true}));
}
if(JSON.parse(await fs.readFile(path.join(vault,'.r-cfbe83.json'),'utf8')).task!=='R-CFBE83')throw Error('Wrong disposable Vault');
const plugin=path.join(vault,'.obsidian/plugins/codex-echoink'),dataFile=path.join(plugin,'data.json'),before=await fs.stat(dataFile);
for(const [name,source]of [['main.js','dist/main.js'],['manifest.json','manifest.json'],['styles.css','styles.css']])await fs.copyFile(source,path.join(plugin,name));
const after=await fs.stat(dataFile);if(before.ino!==after.ino||before.mtimeMs!==after.mtimeMs||before.size!==after.size)throw Error('Deployment changed data.json');
// Configure this disposable copy only after deployment. Never output or use a template credential.
const data=JSON.parse(await fs.readFile(dataFile,'utf8'));
const provider={id:'r-cfbe83-fake',name:'本机合成回放',providerId:'custom',authMode:'api-key',apiProtocol:'openai-completions',baseUrl:'http://127.0.0.1:19684/v1',apiKey:'synthetic-loopback-only',defaultModelId:'synthetic',models:[{id:'synthetic',displayName:'合成模型',input:['text'],contextWindow:128000,maxOutputTokens:8192,reasoning:false,reasoningEnabled:false,toolCalling:true}]};
Object.assign(data,{apiProviders:[provider],activeApiProviderId:provider.id,defaultModel:'synthetic',defaultPermission:'workspace-write',autoOpenHome:true,syncMirrorEnabled:false,cloudSync:{enabled:false},smartJudgment:{enabled:false},workbenchOnboardingDismissed:true,workbenchDismissals:{version:1,entries:{}}});
if(data.memory)data.memory.dreamEnabled=false;
for(const agent of data.agentRegistry?.agents??[]){delete agent.model;delete agent.modelBinding;}
const roles=Object.fromEntries(['raw','wiki','projects','inbox','assets','journal','templates'].map(role=>[role,{enabled:['raw','wiki','inbox'].includes(role),readPaths:['R-CFBE83/'+role],writePath:'R-CFBE83/'+role,allowedSubdirectories:[]}]));
data.knowledgeBase={...data.knowledgeBase,folderBindings:{schemaVersion:1,revision:1,configured:true,organization:{enabled:false,scope:'all',paths:[]},roles,migrationIssues:[]},autoLinkEnabled:false,processedSources:{},maintenanceHistory:[]};
await fs.writeFile(dataFile,JSON.stringify(data));
for(const role of ['raw','wiki','inbox'])await fs.mkdir(path.join(vault,'R-CFBE83',role),{recursive:true});
for(let i=0;i<3;i++)await fs.writeFile(path.join(vault,`R-CFBE83/raw/合成资料${i+1}.md`),`# 合成资料${i+1}\n\n这是一份用于验证忽略建议的合成资料${i+1}。\n`);
await fs.writeFile(path.join(vault,'.obsidian/community-plugins.json'),'[]');
const profile=await fs.mkdtemp(path.join(os.tmpdir(),'echoink-r-cfbe83-'));
await fs.writeFile(path.join(profile,'obsidian.json'),JSON.stringify({vaults:{rcfbe83:{path:vault,ts:Date.now(),open:true}}}));
const child=spawn('/Applications/Obsidian.app/Contents/MacOS/Obsidian',['--user-data-dir='+profile,'--remote-debugging-port=19683','--use-mock-keychain','--no-first-run'],{detached:true,stdio:'ignore'});child.unref();
await fs.mkdir(out,{recursive:true});await fs.writeFile(path.join(out,'native-environment.json'),JSON.stringify({vault,profile,pid:child.pid,port:19683,dataPreservedAtDeployment:true,realModelCalls:0},null,2));
console.log({vault,port:19683,pid:child.pid,dataPreservedAtDeployment:true,realModelCalls:0});
