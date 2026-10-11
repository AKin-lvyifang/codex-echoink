import assert from "node:assert/strict";
import { buildFinanceAnalysisInput } from "../lifestyle/finance-analysis";
import type { FinanceEntry } from "../lifestyle/store";
const row=(id:string,amountCents:number,kind:FinanceEntry["kind"],category="餐饮",overrides:Partial<FinanceEntry>={}):FinanceEntry=>({
  id,source:"manual",sourceId:id,date:"2026-09-20",merchant:"合成商户",category,kind,amountCents,status:"completed",account:"合成账户",description:"合成说明",currency:"CNY",note:"",...overrides});
export async function runFinanceAnalysisHistoryTests(){
  const dining = Array.from({ length: 28 }, (_, i) => row(`ordinary-${i}`, i === 27 ? 4207 : 4659, "expense", "餐饮", { date: `2026-09-${String(i + 1).padStart(2,"0")}`, description: "普通吃饭" }));
  dining.push(row("party1", 32500, "expense", "餐饮", {date:"2026-09-29", description:"聚餐"}), row("party2",32500,"expense","餐饮",{date:"2026-09-30", description:"聚餐"}));
  const small = Array.from({length:20}, (_,i) => row(`tea-${i}`,2000,"expense","奶茶",{merchant:`茶店${i%10}`,description:"奶茶"}));
  const contextRows = [...dining,...small,row("sixth",15000,"expense","第六类"),row("none",2000,"expense","无额度"),
    ...["2026-05-10","2026-07-10"].map(date=>row(date,10000,"expense","餐饮",{date}))];
  const context = JSON.parse(buildFinanceAnalysisInput("2026-09", contextRows,{month:"2026-09",totalCents:300000,
    allocations:{居住:50000,交通:20000,购物:20000,订阅:10000,餐饮:150000,第六类:5000}},"2026-10-12",{}).text);
  assert.equal(context.完整分类预算.find((v:any)=>v.分类==="餐饮").超额元,450);
  assert.equal(context.完整分类预算.find((v:any)=>v.分类==="第六类").超额元,100);
  assert.equal(context.完整分类预算.find((v:any)=>v.分类==="无额度").超额元,null);
  assert.equal(context.有效交易明细.filter((v:any)=>v.分类==="奶茶").length,20);
  assert.deepEqual(context.最近三个已有历史月.map((v:any)=>v.月份),["2026-05","2026-07"]);
  assert.deepEqual(context.缺月,["2026-08","2026-06"]);
  assert.equal(context.历史月份连续,false);
  assert.equal(context.上个自然月可比.汇总,null);
  assert.equal(context.统计范围.覆盖,"unknown");
  assert.equal(context.上个自然月可比.历史范围.天数,31);
  assert.equal(context.上个自然月可比.历史范围.止日,"2026-08-31");
  const monthMid=JSON.parse(buildFinanceAnalysisInput("2026-10",contextRows,null,"2026-10-12",{}).text);
  assert.equal(monthMid.上个自然月可比.历史范围.止日,"2026-09-12");
  assert.equal(monthMid.上个自然月可比.当前范围.天数,12);

  const candidate=context.用途累计候选.find((v:any)=>v.相同消费说明==="奶茶");
  assert.deepEqual([candidate.笔数,candidate.不同商户数,candidate.累计支出原额元],[20,10,400]);
  const dailyRows=[...Array.from({length:30},(_,i)=>row(`sep${i}`,10000,"expense","餐饮",{date:`2026-09-${String(i+1).padStart(2,"0")}`})),
    ...Array.from({length:31},(_,i)=>row(`aug${i}`,10000,"expense","餐饮",{date:`2026-08-${String(i+1).padStart(2,"0")}`}))];
  const equalDaily=JSON.parse(buildFinanceAnalysisInput("2026-09",dailyRows,null,"2026-10-12",{}).text);
  assert.equal(equalDaily.上个自然月可比.相关账目引用.历史月份,"2026-08");
  assert.equal(equalDaily.确定计算的前后变化.当前每日记录净支出元,100);
  assert.equal(equalDaily.确定计算的前后变化.前月每日记录净支出元,100);
  const before=buildFinanceAnalysisInput("2026-10",[row("old",10000,"expense","餐饮",{date:"2026-10-01"})],{month:"2026-10",totalCents:100000,allocations:{}},"2026-10-12",{});
  const oldReport={id:"earlier",kind:"finance",period:"2026-10",createdAt:1,provider:"合成",promptVersion:"old",inputFingerprint:before.fingerprint,inputSummary:"",text:"旧模型解释"};
  const changed=JSON.parse(buildFinanceAnalysisInput("2026-10",[row("old",10000,"expense","餐饮",{date:"2026-10-01"}),row("backfill",50000,"expense","餐饮",{date:"2026-10-05"})],{month:"2026-10",totalCents:200000,allocations:{}},"2026-10-12",{previousReports:[{report:oldReport,input:before.text}]}).text);
  assert.equal(changed.前次成功报告[0].当时资料.有效交易明细.length,1);
  assert.equal(changed.月预算事实.额度元,2000);
  assert.equal(changed.前次成功报告[0].当时资料.统计范围.止日,"2026-10-12");
  assert.equal(before.fingerprint,buildFinanceAnalysisInput("2026-10",[row("old",10000,"expense","餐饮",{date:"2026-10-01"})],{month:"2026-10",totalCents:100000,allocations:{}},"2026-10-12",{previousReports:[{report:oldReport,input:before.text}]}).fingerprint);
  console.log("PASS analysis inputs: whole-month/month-to-date comparison, missing history/income, sixth budget, same-purpose accumulation, equal daily spending, stored prior input and stable data fingerprint");
}
