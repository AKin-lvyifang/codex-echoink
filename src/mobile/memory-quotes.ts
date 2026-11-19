import type { DataAdapter } from 'obsidian';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { MobileSession, MobileState, MobileTaskRun } from './store';
import { sha256Hex } from '../utils/sha256';
import { MemoryOriginalQuoteResolver } from '../harness/memory/memory-quote-reader';
import { parseMemoryQuoteSource, memoryQuoteSource, type MemoryQuoteResult, type MemoryOriginalQuotePort } from '../harness/memory/memory-quote-core';
import type { DreamPublicExperience } from '../harness/memory/dream-experience-core';
const safeId=(id:string)=>/^[a-zA-Z0-9_-]{1,128}$/u.test(id);
export function mobileMessageText(message: AgentMessage): string {
 if (!('content' in message)) return '';
 return typeof message.content==='string'?message.content:message.content.filter(part=>part.type==='text').map(part=>part.text).join('\n');
}
export function mobileUserEntryId(device:string,run:string) { return `mobile-user:${device}:${run}`; }
export function mobileAssistantEntryId(device:string,run:string) { return `mobile-assistant:${device}:${run}`; }
export function mobileExperienceTerminalState(run: MobileTaskRun): 'completed' | 'failed' | null {
 return run.status === 'completed' ? 'completed' : run.status === 'interrupted' && run.interruption?.reason === 'run_failed' ? 'failed' : null;
}
/** Native mobile history is the authority. Stable run coordinates survive context compaction. */
export class MobileMemoryQuoteReader implements MemoryOriginalQuotePort {
 constructor(private readonly adapter:Pick<DataAdapter,'exists'|'read'>,private readonly directory:string,private readonly vaultId:string) {}
 async source(source:string):Promise<MemoryQuoteResult>{
  const p=parseMemoryQuoteSource(source);if(!p)return {reason:'source_unparseable'};
  if(p.vaultId!==this.vaultId)return {reason:'vault_mismatch'};
  if(!p.sessionId.startsWith('mobile:'))return {reason:'legacy_mobile_source'};
  const device=p.sessionId.slice(7);if(!safeId(device)||!safeId(p.productRunId)||p.entryId!==mobileUserEntryId(device,p.productRunId))return {reason:'source_unparseable'};
  const path=`${this.directory}/devices/${device}/state.json`;
  try {
   if(!await this.adapter.exists(path))return {reason:'source_pending'};
   const state=JSON.parse(await this.adapter.read(path)) as {instanceId:string;sessions:MobileSession[]};
   if(state.instanceId!==device||!Array.isArray(state.sessions))return {reason:'mobile_identity_invalid'};
   const task=state.sessions.find(item=>item.id===p.conversationId);if(!task)return {reason:'source_pending'};
   const run=task?.runs?.find(item=>item.id===p.productRunId);if(!run)return {reason:'source_pending'};
   if(run.userMessageIndex===undefined||!run.userMessageDigest)return {reason:'legacy_mobile_source'};
   const message=task.messages[run.userMessageIndex];if(message?.role!=='user')return {reason:'role_mismatch'};
   if(sha256Hex(JSON.stringify(message))!==run.userMessageDigest)return {reason:'mobile_message_changed'};
   const text=mobileMessageText(message);if(!text.trim())return {reason:'user_text_missing'};
   return {quote:{pointer:p,source:memoryQuoteSource(p),text,position:run.userMessageIndex,timestamp:Number.isFinite(message.timestamp)?message.timestamp:null}};
  }catch{return {reason:'identity_unavailable'};}
 }
 async experience(experience:DreamPublicExperience):Promise<MemoryQuoteResult>{
  const match=/^mobile-user:([a-zA-Z0-9_-]+):([a-zA-Z0-9_-]+)$/u.exec(experience.userEntryId);
  if(!match||match[2]!==experience.productRunId||experience.assistantEntryId!==mobileAssistantEntryId(match[1],match[2]))return {reason:'mobile_identity_invalid'};
  const result=await this.source(memoryQuoteSource({vaultId:this.vaultId,conversationId:experience.conversationId,sessionId:`mobile:${match[1]}`,entryId:experience.userEntryId,productRunId:experience.productRunId}));
  if(!result.quote)return result;
  try {const state=JSON.parse(await this.adapter.read(`${this.directory}/devices/${match[1]}/state.json`)) as MobileState;const task=state.sessions.find((t:MobileSession)=>t.id===experience.conversationId);const run=task?.runs?.find(r=>r.id===experience.productRunId);
   const assistant=run?.assistantMessageIndex===undefined?undefined:task?.messages[run.assistantMessageIndex];
   if(!run||!mobileExperienceTerminalState(run)||assistant?.role!=='assistant'||sha256Hex(JSON.stringify(assistant))!==run.assistantMessageDigest)return {reason:'mobile_run_mismatch'};
   return result.quote.text.trim()===experience.userText.trim()?result:{reason:'experience_text_mismatch'};
  }catch{return {reason:'identity_unavailable'};}
 }
}
/** DataAdapter reads the original desktop catalog/runs/JSONL, never neutral sync summaries. */
export function adapterMemoryQuoteReader(adapter:Pick<DataAdapter,'exists'|'read'>, root:string, mobileDirectory:string, vaultId:string):MemoryOriginalQuotePort {
 const base=`${root}/vaults/${sha256Hex(vaultId)}`;
 const json=async<T>(path:string):Promise<T|null>=>await adapter.exists(path)?JSON.parse(await adapter.read(path)) as T:null;
 return new MemoryOriginalQuoteResolver({vaultId,mobile:new MobileMemoryQuoteReader(adapter,mobileDirectory,vaultId),
  conversation:async id=>{const value=await json<{vaultId:string;entries:import("../harness/pi-native/contracts").PiConversationCatalogEntry[]}>(`${base}/conversation-catalog.v1.json`);if(value&&value.vaultId!==vaultId)throw new Error('vault_mismatch');return value?.entries?.find((item:{conversationId:string})=>item.conversationId===id)??null;},
  run:async id=>{const value=await json<{vaultId:string;run:import("../harness/pi-native/contracts").PiProductRunRecord}>(`${base}/product-runs/${sha256Hex(id)}.json`);if(value&&(value.vaultId!==vaultId||value.run?.productRunId!==id))throw new Error('vault_mismatch');return value?.run??null;},
  session:async file=>{if(file.startsWith('/')||file.includes('\\')||file.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error('unsafe_path');const path=`${base}/sessions/${file}`;
   if(!await adapter.exists(path))throw Object.assign(new Error('session_missing'),{code:'ENOENT'});
   const text=await adapter.read(path);if(!text.endsWith('\n'))return {valid:false,header:null,entries:[]};
   const rows=text.trimEnd().split('\n').map(line=>JSON.parse(line) as Awaited<ReturnType<import("../harness/memory/memory-quote-reader").MemoryQuoteReadPort["session"]>>["entries"][number]),header=rows.shift();const ids=new Set<string>();
   const valid=header?.type==='session'&&typeof header.id==='string'&&rows.every(row=>typeof row.id==='string'&&!ids.has(row.id)&&!!ids.add(row.id));
   return {valid,header:header??null,entries:rows};}
 });
}
