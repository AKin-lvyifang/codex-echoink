import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {vault,out} from './cdp.mjs';

const parent=path.join(os.homedir(),'EchoInk-TestVaults');
if(path.dirname(vault)!==parent||!path.basename(vault).startsWith('测试仓库-')||path.basename(vault)==='测试样板')throw Error('Named disposable Vault required');
try{await fs.lstat(vault);throw Error('Target already exists; never overwrite an existing Vault');}catch(e){if(e.code!=='ENOENT')throw e;}
await fs.cp(path.join(parent,'测试样板'),vault,{recursive:true,dereference:false,preserveTimestamps:true});
async function writable(dir){for(const name of await fs.readdir(dir)){const p=path.join(dir,name),s=await fs.lstat(p);if(s.isSymbolicLink())continue;await fs.chmod(p,s.mode|0o200|(s.isDirectory()?0o100:0));if(s.isDirectory())await writable(p);}}
await fs.chmod(vault,(await fs.stat(vault)).mode|0o700);await writable(vault);
const built=spawnSync('npm',['run','build'],{stdio:'inherit'});
if(built.status!==0)throw Error('Production build failed');
const plugin=path.join(vault,'.obsidian/plugins/codex-echoink'),dataFile=path.join(plugin,'data.json');
const before=await fs.stat(dataFile);
for(const [name,source] of [['main.js','dist/main.js'],['manifest.json','manifest.json'],['styles.css','styles.css']])await fs.copyFile(source,path.join(plugin,name));
const after=await fs.stat(dataFile);
if(before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw Error('Deployment changed data.json');
await fs.writeFile(path.join(vault,'.obsidian/community-plugins.json'),'[]');
const profile=await fs.mkdtemp(path.join(os.tmpdir(),'echoink-smooth-profile-'));
await fs.writeFile(path.join(profile,'obsidian.json'),JSON.stringify({vaults:{a367a367a367a367:{path:vault,ts:Date.now(),open:true}}}));
await fs.mkdir(out,{recursive:true});
await fs.writeFile(path.join(out,'prepared-environment.json'),JSON.stringify({vault,profile,port:Number(process.env.ECHOINK_PERF_PORT??19463),pluginVersion:JSON.parse(await fs.readFile('manifest.json','utf8')).version,dataUntouchedAtDeploy:true},null,2));
console.log(JSON.stringify({profile,vault,launch:['/Applications/Obsidian.app/Contents/MacOS/Obsidian','--user-data-dir='+profile,'--remote-debugging-port='+Number(process.env.ECHOINK_PERF_PORT??19463),'--use-mock-keychain','--no-first-run']},null,2));
