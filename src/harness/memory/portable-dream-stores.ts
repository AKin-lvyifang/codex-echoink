import { defaultDreamState, parseDreamState, type DreamState, DREAM_STATE_RELATIVE_PATH } from './dream-state-core';
import { DREAM_EXPERIENCE_INBOX_RELATIVE_PATH, defaultDreamExperienceInboxState, parseDreamExperienceInboxState, appendDreamPublicExperience, markDreamExperiencesEvaluated, markDreamExperiencesReconciled, type DreamExperienceInboxState, type DreamPublicExperienceInput } from './dream-experience-core';
import { cognitiveJsonText } from './cognitive-text';
export interface CognitiveFilePort { read(path:string):Promise<string|null>; replace(path:string,content:string,expected:string|null):Promise<void> }
/** Store lanes serialize only disk work; model requests never hold them. Reads remain fresh across sync. */
class StoreLane {
 private tail:Promise<unknown>=Promise.resolve();
 protected lane<T>(action:()=>Promise<T>):Promise<T>{const run=this.tail.catch(()=>{}).then(action);this.tail=run;return run;}
}
export class PortableDreamStateStore extends StoreLane {
 constructor(private readonly files:CognitiveFilePort){super();}
 async read():Promise<DreamState>{const raw=await this.files.read(DREAM_STATE_RELATIVE_PATH);if(raw===null)return defaultDreamState();const state=parseDreamState(JSON.parse(raw) as Record<string, unknown>);if(!state)throw new Error('dream_state_invalid');return state;}
 update(updater:(state:DreamState)=>DreamState):Promise<DreamState>{return this.lane(async()=>{const raw=await this.files.read(DREAM_STATE_RELATIVE_PATH);const current=raw===null?defaultDreamState():parseDreamState(JSON.parse(raw) as Record<string, unknown>);if(!current)throw new Error('dream_state_invalid');const next=updater(current);await this.files.replace(DREAM_STATE_RELATIVE_PATH,cognitiveJsonText(next),raw);return next;});}
 invalidate():void {} // The portable adapter does not cache synchronized files.
 updateCache(_state:DreamState):void {}
}
export class PortableDreamInboxStore extends StoreLane {
 constructor(private readonly files:CognitiveFilePort){super();}
 private async load(){const raw=await this.files.read(DREAM_EXPERIENCE_INBOX_RELATIVE_PATH);const state=raw===null?defaultDreamExperienceInboxState():parseDreamExperienceInboxState(JSON.parse(raw) as Record<string, unknown>);if(!state)throw new Error('dream_experience_inbox_invalid');return {raw,state};}
 async read(){return (await this.load()).state;}
 append(input:DreamPublicExperienceInput,now=Date.now()){return this.lane(async()=>{const {raw,state}=await this.load();const next=appendDreamPublicExperience(state,input,now);await this.files.replace(DREAM_EXPERIENCE_INBOX_RELATIVE_PATH,cognitiveJsonText(next),raw);return next;});}
 commitEvaluations<T>(ids:ReadonlySet<string>,now:number,commit:(next:DreamExperienceInboxState)=>Promise<T>){return this.lane(async()=>{const next=markDreamExperiencesEvaluated((await this.load()).state,ids,now);const result=await commit(next);return {result,state:next};});}
 commitCorrections<T>(ids:ReadonlySet<string>,now:number,commit:(next:DreamExperienceInboxState)=>Promise<T>){return this.lane(async()=>commit(markDreamExperiencesReconciled((await this.load()).state,ids,now)));}
}
