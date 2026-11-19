import { serializeRecallBlocks, type PersonalMemoryPreparedTurnContext } from '../harness/memory/personal-memory-recall-harness';
import { mergeInjectedMemorySources } from '../harness/pi-native/pi-memory-sources';
import type { InjectedPersonalMemorySourceReference } from '../settings/settings';
export function mobilePreparedMemory(prepared:PersonalMemoryPreparedTurnContext) {
 const recall=prepared.recall;
 const sources:InjectedPersonalMemorySourceReference[]=mergeInjectedMemorySources((prepared.core??[]).map(record=>({...record,reason:'pinned' as const})),(recall?.candidates??[]).map(candidate=>({id:candidate.id,title:candidate.title,revision:candidate.revision,reason:candidate.relatedFrom?'related' as const:candidate.recallReason==='title_or_trigger'?'title_or_trigger' as const:'content_or_association' as const,...(candidate.relatedFrom?{relatedFrom:candidate.relatedFrom}:{})})));
 const blocks=recall?serializeRecallBlocks({...recall,secondaryFacts:recall.candidates.flatMap(candidate=>(candidate.secondaryMatches??[]).map(fact=>({parentId:candidate.id,parentTitle:candidate.title,fact})))}).combined:'';
 const prompt=[prepared.user?`<echoink_user_profile trust="user-owned-memory">\n${prepared.user}\n</echoink_user_profile>`:'',prepared.core?.length?`<echoink_memory_core>\n${JSON.stringify(prepared.core.map(({id,title,summary})=>({id,title,summary})))}\n</echoink_memory_core>`:'',blocks,prepared.navigation?.content??''].filter(Boolean).join('\n\n');
 return {prompt,sources,receipt:prepared.selectionReceipt};
}
