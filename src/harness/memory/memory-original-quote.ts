import type { FileConversationCatalog } from '../pi-native/file-conversation-catalog';
import type { FileProductRunStore } from '../pi-native/file-product-run-store';
import { inspectPiSessionJsonl } from '../pi-native/pi-session-durability';
import type { MemoryOriginalQuotePort } from './memory-quote-core';
import { MemoryOriginalQuoteResolver } from './memory-quote-reader';
export * from './memory-quote-core';
/** Desktop keeps its stable, read-only JSONL inspection and file ownership checks. */
export class MemoryOriginalQuoteReader extends MemoryOriginalQuoteResolver {
 constructor(catalog: FileConversationCatalog, runs: FileProductRunStore, mobile?: MemoryOriginalQuotePort) {
  super({get vaultId() { return catalog.vaultId; },conversation:id=>catalog.get(id),run:async id=>{
   if(runs.vaultId!==catalog.vaultId)throw new Error('vault_mismatch');return runs.readReadOnly(id);
  },session:async file=>inspectPiSessionJsonl({sessionRoot:catalog.sessionRootPath,sessionFile:file}),mobile});
 }
}
