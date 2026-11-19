import type { DreamPublicExperience } from './dream-experience-core';
import { parseMemoryQuoteSource, memoryQuoteSource, type MemoryQuotePointer, type MemoryQuoteResult, type MemoryOriginalQuotePort } from './memory-quote-core';
import type { PiConversationCatalogEntry, PiProductRunRecord } from '../pi-native/contracts';
export interface MemoryQuoteReadPort {
 vaultId: string;
 conversation(id: string): Promise<Readonly<PiConversationCatalogEntry> | null>;
 run(id: string): Promise<Readonly<PiProductRunRecord> | null>;
 session(file: string): Promise<{ valid: boolean; header: {id: string} | null; entries: readonly {id:string;type:string;timestamp:string;message?: {role:string;content?:string | readonly {type:string;text?:string}[]}}[] }>;
 mobile?: MemoryOriginalQuotePort;
}
/** Identity validation is shared; hosts only supply their original storage readers. */
export class MemoryOriginalQuoteResolver implements MemoryOriginalQuotePort {
 constructor(private readonly port: MemoryQuoteReadPort) {}
 async source(source: string): Promise<MemoryQuoteResult> {
  const pointer = parseMemoryQuoteSource(source); if (!pointer) return {reason:'source_unparseable'};
  if (pointer.sessionId===pointer.productRunId) return {reason:'legacy_mobile_source'};
  if (pointer.sessionId.startsWith('mobile:')) return this.port.mobile?.source(source) ?? {reason:'source_pending'};
  return this.read(pointer);
 }
 async experience(experience: DreamPublicExperience): Promise<MemoryQuoteResult> {
  if (experience.userEntryId.startsWith('mobile-user:')) return this.port.mobile?.experience(experience) ?? {reason:'source_pending'};
  try { const conversation = await this.port.conversation(experience.conversationId); if (!conversation) return {reason:'conversation_missing'};
   return this.read({vaultId:this.port.vaultId,conversationId:experience.conversationId,sessionId:conversation.piSessionId,entryId:experience.userEntryId,productRunId:experience.productRunId},experience);
  } catch { return {reason:'identity_unavailable'}; }
 }
 private async read(pointer: MemoryQuotePointer, experience?: DreamPublicExperience): Promise<MemoryQuoteResult> {
  try {
   if(pointer.vaultId!==this.port.vaultId)return {reason:'vault_mismatch'};
   const conversation=await this.port.conversation(pointer.conversationId);
   if(!conversation||conversation.status==='deleted')return {reason:conversation?.status==='deleted'?'conversation_deleted':'conversation_missing'};
   if(conversation.vaultId!==pointer.vaultId||conversation.piSessionId!==pointer.sessionId)return {reason:'session_mismatch'};
   const run=await this.port.run(pointer.productRunId); if(!run)return {reason:'product_run_missing'};
   if(run.conversationId!==pointer.conversationId||run.piSessionId!==pointer.sessionId||run.userEntryId!==pointer.entryId||run.memoryMode!=='normal'
    ||(experience&&(run.assistantEntryId!==experience.assistantEntryId||run.terminalState==='cancelled')))return {reason:'product_run_mismatch'};
   if(!conversation.sessionFile)return {reason:'session_missing'};
   const session=await this.port.session(conversation.sessionFile);
   if(!session.valid||session.header?.id!==pointer.sessionId)return {reason:'session_invalid'};
   const position=session.entries.findIndex(entry=>entry.id===pointer.entryId);if(position<0)return {reason:'entry_missing'};
   const entry=session.entries[position];if(entry.type!=='message'||entry.message?.role!=='user')return {reason:'role_mismatch'};
   if (!entry.message.content) return {reason:'user_text_missing'};
   const text=typeof entry.message.content==='string'?entry.message.content:entry.message.content.filter(part=>part.type==='text').map(part=>part.text??'').join('\n');
   if(!text.trim())return {reason:'user_text_missing'};if(experience&&text.trim()!==experience.userText.trim())return {reason:'experience_text_mismatch'};
   const timestamp=Date.parse(entry.timestamp);return {quote:{pointer,source:memoryQuoteSource(pointer),text,position,timestamp:Number.isFinite(timestamp)?timestamp:null}};
  }catch(error){return {reason:(error as {code?:string})?.code==='ENOENT'?'session_missing':'identity_unavailable'};}
 }
}
