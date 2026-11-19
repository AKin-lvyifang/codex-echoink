import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {connect,delay,out} from './cdp.mjs';
import {ownedSettings} from './owned-settings.mjs';

// Record separately from CPU baselines: screencasting adds renderer overhead.
const name=process.env.ECHOINK_PERF_NAME??'runtime-film',args=process.argv.slice(2);
let main;
const initial=await connect();
if(args[0]==='--settings'){args.shift();main=initial;await main.evaluate('(async()=>{app.setting.open();app.setting.openTabById("codex-echoink");await p.settingsTabInstance.activateSettingsTab("general",true)})()');}
const c=main?await ownedSettings(main):initial,frames=[],writes=[],directory=path.join(out,name+'-frames');
try{
  await fs.mkdir(directory,{recursive:true});
  c.on('Page.screencastFrame',e=>{
    void c.send('Page.screencastFrameAck',{sessionId:e.sessionId});
    const file=String(frames.length).padStart(5,'0')+'.jpg';
    frames.push({file,timestamp:e.metadata.timestamp});
    writes.push(fs.writeFile(path.join(directory,file),Buffer.from(e.data,'base64')));
  });
  await c.send('Page.startScreencast',{format:'jpeg',quality:85,maxWidth:1536,maxHeight:1200,everyNthFrame:1});
  if(args[0]==='--seconds')await delay(Number(args[1])*1000);
  else{
    const command=args.shift();if(!command)throw Error('Pass a command or --seconds N');
    const status=await new Promise((resolve,reject)=>{const p=spawn(command,args,{stdio:'inherit',env:process.env});p.on('error',reject);p.on('exit',resolve);});
    if(status!==0)throw Error('Recorded command failed: '+status);
  }
}finally{
  await c.send('Page.stopScreencast');await Promise.all(writes);await c.write(name+'-film.json',frames);c.close();main?.close();
}
if(frames.length){
  const lines=[];
  for(let i=0;i<frames.length;i++){
    lines.push("file '"+path.join(directory,frames[i].file).replaceAll("'","'\\''")+"'");
    if(i+1<frames.length)lines.push('duration '+Math.max(.001,frames[i+1].timestamp-frames[i].timestamp));
  }
  const manifest=path.join(out,name+'-concat.txt');await fs.writeFile(manifest,lines.join('\n')+'\n');
  const status=await new Promise((resolve,reject)=>{const p=spawn('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','concat','-safe','0','-i',manifest,'-vsync','vfr','-vf','pad=ceil(iw/2)*2:ceil(ih/2)*2','-c:v','libx264','-pix_fmt','yuv420p',path.join(out,name+'.mp4')],{stdio:'inherit'});p.on('error',reject);p.on('exit',resolve);});
  if(status!==0)throw Error('Film encoding failed: '+status);
}
console.log({film:name,frames:frames.length});
