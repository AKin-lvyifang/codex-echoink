import { TFile, type App } from "obsidian";
import { stringify } from "yaml";
import type { FinanceAnalysisInput, FinanceReportSnapshot, FinanceTableSnapshot } from "./finance-analysis";
import type { LifeReport, LifestyleStoreCore } from "./store-core";

export interface FinanceAnalysisArchiveRecord {
  id: string; period: string; version: number; createdAt: number;
  status: "raw" | "success" | "parse-failed"; path: string; snapshotPath: string;
}
export interface FinanceAnalysisArchiveDraft {
  id: string; period: string; createdAt: number; provider: string; promptVersion: string;
  input: string | null; raw: string; fingerprint: string; previousReportIds: string[];
  source: "model" | "legacy-report"; status: "raw" | "success" | "parse-failed";
  previousAttemptPaths?: { path:string; snapshotPath:string }[];
  preparedInput?: FinanceAnalysisInput; skillContent?: string;
  error?: string; report?: LifeReport; record?: FinanceAnalysisArchiveRecord;
}

const inside = (value: string, root: string) => value === root || value.startsWith(`${root}/`);
function recordField(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && key in value ? (value as Record<string, unknown>)[key] : undefined;
}
export function validateFinanceAnalysisDirectory(value: string, root: string, transactions: string, config = ".obsidian"): string {
  const result = value.trim() || `${root}/分析记录`;
  if (result.startsWith("/") || result.includes("\\") || /[:\p{Cc}]/u.test(result)
    || result.split("/").some(part => !part || part === "." || part === "..")) throw new Error("分析保存位置须为 Vault 内的相对目录，不能越界");
  if ([config, ".obsidian", transactions].some(path => inside(result, path))) throw new Error("分析保存位置不能使用插件配置或账目目录及其子目录");
  return result;
}
const pad = (value: number, width = 2) => String(value).padStart(width, "0");
function archiveTime(time: number) {
  const d = new Date(time), offset = -d.getTimezoneOffset();
  const date = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const stamp = `${date}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${pad(d.getMilliseconds(),3)}`;
  const precise = `${date}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(),3)}${offset < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(offset)/60))}:${pad(Math.abs(offset)%60)}`;
  return { stamp, precise };
}
const tableEscape = (value: string) => value.replace(/&/gu,"&amp;").replace(/</gu,"&lt;").replace(/>/gu,"&gt;")
  .replace(/([\\`*_{}[\]()#!~])/gu,"\\$1").replace(/\|/gu,"\\|").replace(/\r?\n/gu," ");
function tableMarkdown(table: FinanceTableSnapshot) {
  return [`| ${table.headers.map(tableEscape).join(" | ")} |`, `| ${table.headers.map(()=>"---").join(" | ")} |`,
    ...table.rows.map(row=>`| ${row.map(tableEscape).join(" | ")} |`)].join("\n");
}
export function financeReportMarkdown(report: LifeReport): string {
  const snapshot = report.financeSnapshot as FinanceReportSnapshot | undefined;
  const chart = (value: FinanceReportSnapshot["charts"][number]) => `### ${value.title}\n\n${tableMarkdown({ id:"category",title:value.title,
    headers:["项目","实际 · 元",...(value.points.some(p=>p.comparisonCents!==undefined)?["预算 · 元"]:[])],
    rows:value.points.map(p=>[p.label,(p.valueCents/100).toFixed(2),...(value.points.some(v=>v.comparisonCents!==undefined)?[p.comparisonCents===undefined?"未设额度":(p.comparisonCents/100).toFixed(2)]:[])]) })}\n\n${value.explanation}`;
  if (snapshot?.version === 8 && snapshot.sections) return snapshot.sections.map(section => `## ${section.title}\n\n` + section.blocks.map(block => {
    if (block.type === "text") return block.markdown;
    if (block.type === "highlight") return `> [!${{fact:"info",notice:"warning",positive:"success"}[block.tone]}]\n` + block.markdown.split("\n").map(line=>`> ${line}`).join("\n");
    if (block.type === "chart") return chart(block.chart);
    if (block.type === "table") return `### ${block.table.title}\n\n${tableMarkdown(block.table)}\n\n${block.explanation}`;
    return block.items.map(item=>`- ${item.replace(/\n/gu,"\n  ")}`).join("\n");
  }).join("\n\n")).join("\n\n") + (snapshot.omittedSuggestionCount ? `\n\n有 ${snapshot.omittedSuggestionCount} 条建议未能完整生成，未展示。` : "");
  if (snapshot?.conclusion) return [snapshot.conclusion,...(snapshot.charts??[]).map(chart),
    ...(snapshot.suggestions??[]).map(text=>`- ${text}`),snapshot.detail??""].filter(Boolean).join("\n\n");
  return report.text;
}

/** The store keeps the durable index and pending payload; Vault files keep each immutable version. */
export class FinanceAnalysisArchive {
  private queue: Promise<unknown> = Promise.resolve();
  private history = new Map<string, { report: LifeReport; input?: string }>();
  constructor(private readonly app: App, private readonly store: LifestyleStoreCore,
    private readonly location: () => { root: string; directory: string; configured: string }) {}
  directory(value = this.location().configured): string {
    const { root, directory } = this.location();
    const path = validateFinanceAnalysisDirectory(value, root, directory, this.app.vault.configDir);
    let parent = "";
    for (const part of path.split("/")) {
      parent = parent ? `${parent}/${part}` : part;
      if (this.app.vault.getAbstractFileByPath(parent) instanceof TFile) throw new Error(`分析保存位置与文件冲突：${parent}`);
    }
    return path;
  }
  async validateDirectory(value = this.location().configured): Promise<string> {
    const directory=this.directory(value);
    let parent="";
    for(const part of [...directory.split("/"),"数据快照"]) {
      parent=parent?`${parent}/${part}`:part;
      if (await this.app.vault.adapter.exists(parent) && (await this.app.vault.adapter.stat(parent))?.type!=="folder")
        throw new Error(`分析保存位置与文件冲突：${parent}`);
    }
    return directory;
  }
  async initialize(): Promise<void> {
    const latest = new Map<string, FinanceAnalysisArchiveRecord>();
    for (const record of this.store.snapshot().financeAnalysisArchives ?? []) if (record.status === "success" &&
      (!latest.has(record.period) || record.version > latest.get(record.period)!.version)) latest.set(record.period, record);
    for (const record of latest.values()) {
      try {
        if (!await this.app.vault.adapter.exists(record.snapshotPath)) continue;
        const saved = JSON.parse(await this.app.vault.adapter.read(record.snapshotPath)) as FinanceAnalysisArchiveDraft;
        if (saved.report && saved.status === "success") this.history.set(record.period,{ report:saved.report, input:saved.input??undefined });
      } catch { /* Missing/corrupt archive is not a successful comparison source. */ }
    }
  }
  previous(month: string) {
    const before = [...this.history.keys()].filter(p=>p<month).sort().at(-1);
    return [this.history.get(month),before?this.history.get(before):undefined].filter((item): item is { report:LifeReport; input?:string }=>!!item);
  }
  pending(month: string): FinanceAnalysisArchiveDraft | undefined {
    return (this.store.snapshot().financeAnalysisPending ?? []).filter(p=>p.period===month).sort((a,b)=>b.createdAt-a.createdAt)[0];
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work,work); this.queue=next.catch(()=>undefined); return next;
  }
  async useCurrentDirectory(draft:FinanceAnalysisArchiveDraft) {
    const directory=this.directory();
    if (draft.record && draft.record.path.slice(0,draft.record.path.lastIndexOf("/"))!==directory) {
      draft.previousAttemptPaths=[...(draft.previousAttemptPaths??[]),{path:draft.record.path,snapshotPath:draft.record.snapshotPath}];
      draft.record=undefined;
    }
  }
  private async folders(directory: string) {
    let parent = "";
    for (const part of directory.split("/")) {
      parent=parent?`${parent}/${part}`:part;
      if (!await this.app.vault.adapter.exists(parent)) {
        if (parent.split("/").includes(".data")) await this.app.vault.adapter.mkdir(parent);
        else await this.app.vault.createFolder(parent);
      }
      else if ((await this.app.vault.adapter.stat(parent))?.type!=="folder") throw new Error(`分析保存位置与文件冲突：${parent}`);
    }
  }
  private async reserve(draft: FinanceAnalysisArchiveDraft) {
    if (draft.record) return;
    const directory = await this.validateDirectory(), stamp = archiveTime(draft.createdAt).stamp;
    let version = Math.max(0,...(this.store.snapshot().financeAnalysisArchives ?? []).filter(r=>r.period===draft.period).map(r=>r.version))+1;
    const paths = () => { const name = `${draft.period}__财务分析__${stamp}__v${pad(version,3)}`;
      return { path:`${directory}/${name}.md`,snapshotPath:`${directory}/数据快照/${name}.json` }; };
    while (await this.app.vault.adapter.exists(paths().path) || await this.app.vault.adapter.exists(paths().snapshotPath)) version++;
    draft.record={ id:draft.id,period:draft.period,createdAt:draft.createdAt,version,status:"raw",...paths() };
  }
  async capture(draft: FinanceAnalysisArchiveDraft): Promise<void> { await this.enqueue(async()=> {
    await this.persistPending(draft);
    await this.reserve(draft);
    await this.persistPending(draft);
    await this.folders(draft.record!.snapshotPath.slice(0,draft.record!.snapshotPath.lastIndexOf("/")));
    if (!await this.app.vault.adapter.exists(draft.record!.snapshotPath))
      await this.app.vault.adapter.write(draft.record!.snapshotPath,JSON.stringify({ ...draft, dataVersion:1 },null,2));
  }); }
  private async persistPending(draft: FinanceAnalysisArchiveDraft) {
    await this.store.update(data=> {
      data.financeAnalysisPending = [...(data.financeAnalysisPending??[]).filter(p=>p.id!==draft.id),structuredClone(draft)];
      if (draft.record) data.financeAnalysisArchives = [...(data.financeAnalysisArchives??[]).filter(r=>r.id!==draft.id),{ ...draft.record,status:"raw" }];
    });
  }
  async finish(draft: FinanceAnalysisArchiveDraft): Promise<void> { await this.enqueue(async()=> {
    await this.persistPending(draft); await this.reserve(draft); await this.persistPending(draft);
    const record = draft.record!;
    await this.folders(record.snapshotPath.slice(0,record.snapshotPath.lastIndexOf("/")));
    const snapshotExists = await this.app.vault.adapter.exists(record.snapshotPath);
    const snapshotText=JSON.stringify({ ...draft, dataVersion:1, generatedAt:archiveTime(draft.createdAt).precise },null,2);
    if (snapshotExists) {
      let old: unknown;
      try { old=JSON.parse(await this.app.vault.adapter.read(record.snapshotPath)); }
      catch { if (!this.store.snapshot().financeAnalysisArchives?.some(r=>r.id===draft.id&&r.status==="raw"&&r.snapshotPath===record.snapshotPath))
        throw new Error("存档文件无法核对，原记录已保留"); }
      if (old && recordField(old, "id")!==draft.id) throw new Error("存档文件冲突，原记录已保留");
    }
    await this.app.vault.adapter.write(record.snapshotPath,snapshotText);
    const input: unknown = draft.input ? JSON.parse(draft.input) : {};
    if (input === null) throw new Error("分析资料无法读取，原记录已保留");
    const period = recordField(input, "统计范围"), comparison = recordField(input, "上个自然月可比");
    const metadata=stringify({ type:"finance-analysis", analysis_id:draft.id, month:draft.period,
      generated_at:archiveTime(draft.createdAt).precise, month_version:record.version, model:draft.provider,
      skill_version:draft.promptVersion, data_version:1, status:draft.status, source:draft.source,
      as_of:recordField(period, "止日")??null, comparison_range:comparison ? { current:recordField(comparison, "当前范围"), previous:recordField(comparison, "历史范围") } : null, previous_report_ids:draft.previousReportIds,
      tags:["echoink/finance-analysis","finance/monthly-review"] });
    const body=draft.report?financeReportMarkdown(draft.report):`## 解析失败\n\n${draft.error??"内容无法展示"}\n\n原始最终响应保留在同名机器快照中。`;
    const markdown=`---\n${metadata}---\n\n${body}\n`;
    const file=this.app.vault.getAbstractFileByPath(record.path);
    if (file instanceof TFile) {
      const content=await this.app.vault.read(file);
      if (!content.includes(`analysis_id: ${draft.id}\n`)) throw new Error("存档文件冲突，原记录已保留");
      if (content!==markdown) throw new Error("存档正文已改变，保留原文并提示重试");
    } else await this.app.vault.create(record.path,markdown);
    await this.store.update(data=> {
      data.financeAnalysisArchives=(data.financeAnalysisArchives??[]).map(r=>r.id===draft.id?{...record,status:draft.status}:r);
      data.financeAnalysisPending=(data.financeAnalysisPending??[]).filter(p=>p.id!==draft.id);
      if (draft.report && draft.source==="model") {
        data.reports=data.reports.filter(r=>r.kind!=="finance" || r.period!==draft.period); data.reports.push(draft.report);
      }
    });
    if (draft.report) this.history.set(draft.period,{report:structuredClone(draft.report),input:draft.input??undefined});
  }); }
}
