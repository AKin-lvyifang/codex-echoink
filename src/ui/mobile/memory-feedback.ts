import { setIcon } from 'obsidian';
import { ownedEl } from '../owned-dom';
import { mergeInjectedMemorySources } from '../../harness/pi-native/pi-memory-sources';
import type { MobileTaskRun } from '../../mobile/store';
import type { MobileMemoryCorrectionEvent, MobileMemorySettingsPort } from '../../mobile/memory-contracts';
const expandedByDocument=new WeakMap<Document,Map<string,boolean>>();
function expansion(document:Document):Map<string,boolean>{let map=expandedByDocument.get(document);if(!map){map=new Map<string,boolean>();expandedByDocument.set(document,map);}return map;}
function remember(details:HTMLDetailsElement,key:string){const state=expansion(details.ownerDocument);details.open=state.get(key)??false;details.addEventListener('toggle',()=>{state.set(key,details.open);if(state.size>256){for(const oldest of state.keys()){state.delete(oldest);break;}}});}
function text(parent:HTMLElement,tag:keyof HTMLElementTagNameMap,cls:string,value:string){const node=ownedEl(parent.ownerDocument,tag);node.className=cls;node.textContent=value;parent.append(node);return node;}
function disclosureChevron(summary:HTMLElement) { const icon=ownedEl(summary.ownerDocument,'span');icon.className='echoink-memory-disclosure-icon';icon.setAttribute('aria-hidden','true');setIcon(icon,'chevron-down');summary.append(icon); }
/** MEMORY-01: shared mobile DOM; touch geometry and type inherit each device's shell. */
export function renderMobileMemoryReceipt(parent:HTMLElement,run:MobileTaskRun|undefined,language:string){
 const sources=mergeInjectedMemorySources(run?.memorySources??[]);if(!sources.length||!run)return;
 const english=language==='en',details=ownedEl(parent.ownerDocument,'details');details.className='echoink-memory-receipt';details.dataset.memoryRun=run.id;
 const summary=text(details,'summary','echoink-memory-receipt-summary','');const icon=ownedEl(parent.ownerDocument,'span');icon.className='echoink-memory-receipt-icon';icon.setAttribute('aria-hidden','true');setIcon(icon,'brain');summary.append(icon);text(summary,'span','',english?`Used ${sources.length} memories`:`用了 ${sources.length} 条记忆`);disclosureChevron(summary);
 const body=text(details,'div','echoink-memory-receipt-body','');
 for(const source of sources){const row=text(body,'div','echoink-memory-source','');text(row,'div','echoink-memory-source-title',source.title);
  const reason=source.reason==='tool_read'?(english?'Read directly':'主动读取'):source.reason==='pinned'?(english?'Pinned memory':'固定记忆'):source.relatedFrom?(english?`Related to “${source.relatedFrom.title}”`:`由「${source.relatedFrom.title}」带出`):source.reason==='title_or_trigger'?(english?'Matched this question':'与本轮问题相关'):(english?'Relevant context':'相关内容');text(row,'div','echoink-memory-source-reason',reason);
 }
 remember(details,`receipt:${run.id}`);parent.append(details);
}
export function renderMobileCorrections(parent:HTMLElement,events:readonly MobileMemoryCorrectionEvent[],options:{language:string;service:Pick<MobileMemorySettingsPort,'originalQuote'|'undoCorrection'>;reload(restoredId?:string):void|Promise<void>;error(error:unknown):void}){
 const english=options.language==='en',t=(zh:string,en:string)=>english?en:zh;
 for(const event of events){const details=ownedEl(parent.ownerDocument,'details');details.className='echoink-memory-correction';details.dataset.correctionId=event.id;
  const summary=text(details,'summary','',event.undoneAt!==undefined?t('已撤销这次更新','Update undone'):event.action==='obsolete'?t('已按你的原话关闭','Closed after your statement'):t('已按你的原话更新','Updated after your statement'));disclosureChevron(summary);
  const body=text(details,'div','echoink-memory-correction-body','');
  for(const [label,record] of [[t('改前','Before'),event.before],[t('改后','After'),event.after]] as const){if(!record)continue;text(body,'div','echoink-memory-source-reason',label);text(body,'div','echoink-memory-version',`${record.title}\n${record.content}`);}
  const quote=text(body,'div','echoink-memory-original','');text(quote,'div','echoink-memory-source-reason',t('依据原话','Original statement'));const quoteText=text(quote,'div','',t('读取中…','Loading…'));let loaded=false;
  details.addEventListener('toggle',()=>{if(!details.open||loaded)return;loaded=true;void options.service.originalQuote(event.source).then(result=>{if(details.isConnected)quoteText.textContent=result.quote?.text??t('依据原话暂不可用','Original statement unavailable');}).catch(()=>{if(details.isConnected)quoteText.textContent=t('依据原话暂不可用','Original statement unavailable');});});
  if(event.undoneAt===undefined){if(event.canUndo){const actions=text(body,'div','echoink-memory-correction-actions',''),button=text(actions,'button','',t('撤销','Undo')) as HTMLButtonElement;button.type='button';button.addEventListener('click',()=>{if(button.disabled)return;button.disabled=true;void options.service.undoCorrection(event.id).then(restoredId=>options.reload(restoredId)).catch(error=>{button.disabled=false;options.error(error);});});}
   else text(body,'div','echoink-memory-source-reason',t('这条之后又更新过','This memory was updated again'));}
  remember(details,`correction:${event.id}`);parent.append(details);
 }
}
