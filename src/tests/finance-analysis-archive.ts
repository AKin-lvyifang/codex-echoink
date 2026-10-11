import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { App } from "obsidian";
import { LifestyleStore, type LifeReport, type FinanceEntry } from "../lifestyle/store";
import { LifestyleFinanceService } from "../lifestyle/finance-service";
import type { LifestyleService } from "../lifestyle/service";
import { DEFAULT_LIFESTYLE_SETTINGS } from "../lifestyle/settings";
import { FinanceAnalysisArchive, validateFinanceAnalysisDirectory } from "../lifestyle/finance-analysis-archive";
import { FINANCE_ANALYSIS_SKILL } from "../harness/resources/finance-analysis-skill";
import { FakeVault } from "./lifestyle-finance-ledger";
import { paidTestAccess } from "./membership-access";

// The Obsidian file index deliberately excludes hidden .data; the adapter sees physical files.
Object.defineProperty(FakeVault.prototype,"adapter",{get(this:FakeVault){
  return { exists:async(p:string)=>this.files.has(p)||this.folders.has(p),
    read:async(p:string)=>{if(!this.files.has(p))throw new Error("missing file");return this.files.get(p)!.text;},
    write:async(p:string,text:string)=>{if(this.files.has(p))this.files.get(p)!.text=text;else await this.create(p,text);},
    mkdir:async(p:string)=>{await this.createFolder(p);},
    stat:async(p:string)=>this.folders.has(p)?{type:"folder"}:this.files.has(p)?{type:"file"}:null };
}});
const indexed=FakeVault.prototype.getAbstractFileByPath;
FakeVault.prototype.getAbstractFileByPath=function(p:string){return p.split("/").includes(".data")?null:indexed.call(this,p);};
export async function runFinanceAnalysisArchiveTests() {
  const temporary=await mkdtemp(path.join(tmpdir(),"echoink-analysis-archive-"));
  try {
    const file=path.join(temporary,"lifestyle.json"),store=new LifestyleStore(file);await store.initialize();
    const vault=new FakeVault(),app={vault,fileManager:{processFrontMatter:vault.processFrontMatter.bind(vault),renameFile:vault.rename.bind(vault)}} as unknown as App;
    const settings={lifestyle:structuredClone(DEFAULT_LIFESTYLE_SETTINGS),apiProviders:[{id:"p",name:"合成Provider",models:[{id:"m",displayName:"合成模型"}]}],activeApiProviderId:"p",defaultModel:"m"};
    settings.lifestyle.finance.enabled=settings.lifestyle.finance.aiEnabled=true;
    let calls=0,response=JSON.stringify({version:8,sections:[{title:"收支总览",blocks:[{type:"highlight",tone:"fact",markdown:"**记录中的结余**"},
      {type:"chart",id:"flow",explanation:"收入与净支出"},{type:"table",id:"budget",explanation:"完整预算核对"},{type:"actions",items:["核对餐饮预算"]}]}]});
    const plugin={app,settings,registerEvent(){},saveSettings:async()=>{},getSkillRuntimeCoordinator:()=>({resolveById:async()=>{},recordUse:async()=>{}}),
      requireAvailableEchoInkSkill:async()=>{},readEchoInkBuiltinSkill:async()=>({fileStatus:"ready",content:FINANCE_ANALYSIS_SKILL}),generateLifestyleText:async()=>{calls++;return response;}};
    const make=(data:LifestyleStore)=>new LifestyleFinanceService({store:data,plugin,refresh(){}} as unknown as LifestyleService,paidTestAccess);
    const finance=make(store);await finance.initialize();
    const entry:FinanceEntry={id:"sample",source:"manual",sourceId:"private-source",date:"2026-09-05",merchant:"合成餐厅",description:"普通吃饭",account:"合成账户",category:"餐饮",kind:"expense",amountCents:20000,status:"completed",currency:"CNY",note:"private-note"};
    await finance.ledger.add(entry);await finance.saveBudgetChanges({overrides:[{month:"2026-09",totalCents:100000,allocations:{餐饮:10000}}],removedMonths:[]});
    const first=await finance.analyze("2026-09",true),second=await finance.analyze("2026-09",true);
    let records=store.snapshot().financeAnalysisArchives!;
    assert.deepEqual(records.map(r=>r.version),[1,2]);assert.equal(records[0].status,"success");
    const saved=JSON.parse(vault.files.get(records[0].snapshotPath)!.text);
    assert.match(records[0].snapshotPath,/\/数据快照\/[^/]+\.json$/);
    assert.equal(saved.raw,response);assert.deepEqual(saved.report.financeSnapshot,first.financeSnapshot);
    assert.ok(saved.input.includes("普通吃饭"));assert.doesNotMatch(saved.input,/private-source|private-note/);
    assert.match(saved.generatedAt,/T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
    const markdown=vault.files.get(records[0].path)!.text;
    assert.match(records[0].path,/2026-09__财务分析__\d{4}-\d{2}-\d{2}_\d{9}__v001\.md$/);
    assert.match(markdown,/echoink\/finance-analysis/);assert.match(markdown,/finance\/monthly-review/);
    assert.match(markdown,/> \[!info\]/);assert.match(markdown,/收入与净支出/);assert.match(markdown,/完整预算核对/);
    const oldBytes=new Map([...vault.files].filter(([name])=>name.includes("分析记录")).map(([name,value])=>[name,value.text]));
    await finance.saveAnalysisDirectory("回顾/财务");await finance.analyze("2026-09",true);
    assert.equal(store.snapshot().financeAnalysisArchives!.at(-1)!.version,3);
    for(const [name,text] of oldBytes)assert.equal(vault.files.get(name)!.text,text,"change directory cannot move/change old versions");
    const reloaded=new LifestyleStore(file);await reloaded.initialize();const restart=make(reloaded);await restart.initialize();
    const previous=JSON.parse(restart.analysisInput("2026-09").text).前次成功报告;
    assert.equal(previous[0].分析ID,finance.latestReport("2026-09")!.id);
    assert.ok(previous[0].当时资料.有效交易明细.length);
    response="{ incomplete";
    await assert.rejects(restart.analyze("2026-09",true),/完整生成/);
    assert.equal(reloaded.snapshot().financeAnalysisArchives!.at(-1)!.status,"parse-failed");
    assert.equal(JSON.parse(restart.analysisInput("2026-09").text).前次成功报告[0].分析ID,previous[0].分析ID,"failed parse never becomes comparison history");
    response=JSON.stringify({version:8,sections:[{title:"存档重试",blocks:[{type:"text",markdown:"保留的完整内容"}]}]});
    vault.failMarkdownAfter=vault.createCount;const before=calls;
    await assert.rejects(restart.analyze("2026-09",true),/保存失败/);assert.equal(calls,before+1);
    assert.equal(restart.pendingAnalysisSave("2026-09"),true);
    assert.ok(reloaded.snapshot().financeAnalysisPending!.at(-1)!.report);
    const againStore=new LifestyleStore(file);await againStore.initialize();const again=make(againStore);await again.initialize();
    vault.failMarkdownAfter=Infinity;await again.saveAnalysisDirectory("新的保存位置");const retried=await again.retryAnalysisSave("2026-09");
    assert.equal(calls,before+1,"restart and save retry must not call model again");assert.equal(retried!.text,"保留的完整内容");
    assert.equal(again.pendingAnalysisSave("2026-09"),false);
    await again.retryAnalysisSave("2026-09").then(()=>assert.fail("retry without pending"),()=>{});
    // A directory collision happens before a path can be reserved, after the model has returned.
    await vault.create("early-conflict", "ordinary file");
    settings.lifestyle.finance.analysisDirectory="early-conflict/reports";
    const beforeEarly=calls;
    await assert.rejects(again.analyze("2026-09",true),/保存失败/);
    const early=againStore.snapshot().financeAnalysisPending!.at(-1)!;
    assert.equal(early.raw,response);assert.equal(early.record,undefined);
    assert.ok(!againStore.snapshot().financeAnalysisArchives!.some(r=>r.id===early.id),"unreserved draft is not an invalid archive index");
    const earlyStore=new LifestyleStore(file);await earlyStore.initialize();const earlyRestart=make(earlyStore);await earlyRestart.initialize();
    assert.equal(earlyRestart.pendingAnalysisSave("2026-09"),true);
    await earlyRestart.saveAnalysisDirectory("新的保存位置");
    const earlyReport=await earlyRestart.retryAnalysisSave("2026-09");
    assert.equal(calls,beforeEarly+1,"early directory failure survives restart and retries without model");
    assert.equal(earlyReport!.text,"保留的完整内容");
    // Old hidden snapshots stay readable through their indexed adapter path.
    const oldHidden=earlyStore.snapshot().financeAnalysisArchives!.find(r=>r.id===first.id)!;
    const hiddenPath=oldHidden.snapshotPath.replace("/数据快照/","/.data/");
    vault.files.set(hiddenPath,vault.files.get(oldHidden.snapshotPath)!);vault.files.delete(oldHidden.snapshotPath);
    await earlyStore.update(d=>{d.financeAnalysisArchives!.find(r=>r.id===first.id)!.snapshotPath=hiddenPath;});
    const hiddenArchive=new FinanceAnalysisArchive(app,earlyStore,()=>({root:"finance",directory:"finance/transactions",configured:""}));
    // Make this successful version the latest for its month to exercise initialize's history read.
    await earlyStore.update(d=>{d.financeAnalysisArchives!.find(r=>r.id===first.id)!.version=99;});
    await hiddenArchive.initialize();assert.equal(hiddenArchive.previous("2026-09")[0].report.id,first.id);
    // Use the latest durable store for the subsequent legacy upgrade checks.
    const legacy:LifeReport={id:"legacy-existing",kind:"finance",period:"2026-08",createdAt:new Date(2026,8,1,12).getTime(),provider:"旧模型",promptVersion:"old",inputFingerprint:"old",inputSummary:"旧账目",text:"实际存在的旧正文"};
    await earlyStore.update(data=>data.reports.push(legacy));const migrate=make(earlyStore);await migrate.initialize();
    const legacyRecord=earlyStore.snapshot().financeAnalysisArchives!.find(r=>r.id===legacy.id)!;
    assert.equal(legacyRecord.createdAt,legacy.createdAt);assert.equal(JSON.parse(vault.files.get(legacyRecord.snapshotPath)!.text).source,"legacy-report");
    assert.equal(earlyStore.snapshot().financeAnalysisArchives!.filter(r=>r.period==="2026-08").length,1,"only existing old report is migrated");
    for(const location of ["../escape","/tmp","C:/temp","finance/transactions","finance/transactions/sub",".obsidian/reports","custom-config/reports"])
      assert.throws(()=>validateFinanceAnalysisDirectory(location,"finance","finance/transactions","custom-config"));
    await vault.create("blocked","file");await assert.rejects(migrate.saveAnalysisDirectory("blocked/sub"),/文件冲突/);
    assert.equal(settings.lifestyle.finance.analysisDirectory,"新的保存位置");
    assert.notEqual(first.id,second.id);
    console.log("PASS analysis archives: raw/final/Markdown snapshots, versions, failed parse, directory changes, restart/save-only retry, existing legacy migration and path validation");
  } finally {await rm(temporary,{recursive:true,force:true});}
}
