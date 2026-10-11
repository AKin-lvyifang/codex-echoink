import assert from "node:assert/strict";
import { buildFinanceAnalysisInput, parseFinanceAnalysisResponse } from "../lifestyle/finance-analysis";
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
  for(const [month,next,days] of [["2026-09","2026-10",31],["2026-01","2026-02",28],["2028-01","2028-02",29],["2026-12","2027-01",31]] as const) {
    const input=JSON.parse(buildFinanceAnalysisInput(month,[],null,"2028-03-01",{}).text);
    assert.deepEqual([input.下一统计月份.月份,input.下一统计月份.月天数,input.下一统计月份.预算已配置],[next,days,false]);
    assert.equal(input.下一统计月份.预算,null);assert.match(input.下一统计月份.说明,/条件情景/);
    const configured=JSON.parse(buildFinanceAnalysisInput(month,[],{month,totalCents:99900,allocations:{}},"2028-03-01",{
      nextBudget:{month:next,totalCents:days*10000,allocations:{餐饮:150000}},nextBudgetSource:"month-override"}).text);
    assert.equal(configured.月预算事实.额度元,999);
    assert.equal(configured.下一统计月份.预算.额度元,days*100);
    assert.equal(configured.下一统计月份.预算.日均预算参考元,100);
    assert.equal(configured.下一统计月份.预算.分类额度元.餐饮,1500);
    assert.equal(configured.下一统计月份.预算.规则来源,"下月独立预算");
  }
  assertAdjustmentScenarios();
  console.log("PASS analysis inputs: next-month actual calendar and configured/unknown budget, whole-month/month-to-date comparison, missing history/income, sixth budget, same-purpose accumulation, equal daily spending, stored prior input and stable data fingerprint");
}

function assertAdjustmentScenarios() {
  const rows=[...Array.from({length:28},(_,i)=>row(`ordinary-${i}`,5500,"expense","餐饮",{description:"日常三餐"})),
    ...Array.from({length:2},(_,i)=>row(`party-${i}`,39000,"expense","餐饮",{description:"朋友聚餐"})),
    ...Array.from({length:18},(_,i)=>row(`tea-${i}`,2400,"expense","饮品",{description:"奶茶",merchant:`茶店${i%6}`})),
    row("ordinary-budget",8000,"expense","交通"),row("unallocated",10000,"expense","未设额度")];
  const budget={month:"2026-09",totalCents:400000,allocations:{餐饮:180000,饮品:24000,交通:8000}};
  const prepared=buildFinanceAnalysisInput("2026-09",rows,budget,"2026-10-12",{});
  const input=JSON.parse(prepared.text),scenarios=input.可核对调整情景.分类;
  assert.deepEqual(scenarios.map((item:any)=>item.分类),["餐饮","饮品"],"normal use and missing allocation do not produce adjustment scenarios");
  const dining=scenarios[0],party=dining.用途取舍.find((item:any)=>item.消费说明==="朋友聚餐");
  assert.equal(dining.本期净支出元,2320);assert.equal(dining.需减少或增加额度元,520);
  assert.deepEqual([party.本期用途金额元,party.本期其余金额元,party.保留用途后其余上限元,party.保留其余后用途上限元],[780,1540,1020,260]);
  assert.equal(party.本期用途金额元+party.保留用途后其余上限元,1800);
  assert.equal(party.本期其余金额元+party.保留其余后用途上限元,1800);
  assert.match(dining.条件,/若2026-10沿用本月/);assert.match(dining.条件,/以本期.*作对照/);
  assert.equal(dining.单独调拨后余量元,1360);
  assert.match(prepared.facts[dining.引用.单独调拨],/本月总预算与全部分类额度/);
  const tea=scenarios[1].用途取舍[0];
  assert.deepEqual([tea.用途单价元,tea.同价次数上限,tea.需减少同价次数,tea.减少同价金额元],[24,10,8,192]);
  const parsed=parseFinanceAnalysisResponse(JSON.stringify({version:8,sections:[{title:"取舍",blocks:[
    {type:"highlight",tone:"fact",markdown:"{{record_coverage}}"},
    {type:"actions",items:[`{{${party.引用.保留其余}}}`,`{{${tea.引用.同价次数}}} 每月预算最多10次，是条件选择。`]}]}]}),prepared);
  const action=parsed.sections![0].blocks.find(block=>block.type==="actions")!;
  assert.equal(action.type,"actions");if(action.type!=="actions")throw new Error("actions required");
  assert.doesNotMatch(action.items.join(""),/\{\{/);assert.match(action.items[0],/260/);assert.match(action.items[1],/192/);
  assert.match(parsed.conclusion,/记录完整性未知/);assert.equal(parsed.omittedSuggestionCount,0);
  const differentPrice=rows.map(item=>item.id==="tea-0"?{...item,amountCents:2500}:item);
  const varied=JSON.parse(buildFinanceAnalysisInput("2026-09",differentPrice,budget,"2026-10-12",{}).text).可核对调整情景.分类[1].用途取舍[0];
  assert.equal(varied.同价次数上限,null);assert.equal(varied.引用.同价次数,undefined,"varying prices cannot imply a fixed count limit");
  const refunded=JSON.parse(buildFinanceAnalysisInput("2026-09",[...rows,row("refund",10000,"refund","餐饮")],budget,"2026-10-12",{}).text).可核对调整情景.分类[0];
  assert.equal(refunded.本期净支出元,2220);assert.equal(refunded.需减少或增加额度元,420);
  assert.deepEqual(refunded.用途取舍,[],"category refunds cannot be attributed to an individual purpose");
  const high=buildFinanceAnalysisInput("2026-09",rows,budget,"2026-10-12",{nextBudget:{month:"2026-10",totalCents:500000,allocations:{餐饮:300000}},nextBudgetSource:"month-override"});
  const higher=JSON.parse(high.text).可核对调整情景.分类[0];
  assert.match(higher.条件,/2026-10独立预算/);assert.doesNotMatch(higher.条件,/沿用本月/);
  assert.equal(higher.情景分类额度元,3000);assert.equal(higher.需减少或增加额度元,0);assert.deepEqual(higher.用途取舍,[]);
  assert.match(high.facts[higher.引用.总额],/不需增额或减支/);
  const low=buildFinanceAnalysisInput("2026-09",rows,budget,"2026-10-12",{nextBudget:{month:"2026-10",totalCents:105000,allocations:{餐饮:100000}}});
  const lower=JSON.parse(low.text).可核对调整情景.分类[0],lowerParty=lower.用途取舍[0];
  assert.equal(lower.情景分类额度元,1000);assert.equal(lower.需减少或增加额度元,1320);
  assert.equal(lower.引用.单独调拨,undefined,"insufficient public allocation must not produce a reallocation option");
  assert.equal(lowerParty.保留用途后其余上限元,220);assert.equal(lowerParty.保留其余后用途上限元,null);
  assert.equal(lowerParty.同价次数上限,null);assert.match(low.facts[lowerParty.引用.保留其余],/不能.*可花金额/);
  const missingCategory=JSON.parse(buildFinanceAnalysisInput("2026-09",rows,budget,"2026-10-12",{nextBudget:{month:"2026-10",totalCents:500000,allocations:{交通:20000}}}).text).可核对调整情景.分类[0];
  assert.match(missingCategory.条件,/若2026-10沿用本月/);assert.equal(missingCategory.未分配余量元,null);
  assert.equal(missingCategory.引用.单独调拨,undefined,"unknown next-category baseline cannot use the next plan's entire public pool");
  const noAdjustment=buildFinanceAnalysisInput("2026-09",[row("normal",8000,"expense","交通")],budget,"2026-10-12",{});
  assert.deepEqual(JSON.parse(noAdjustment.text).可核对调整情景.分类,[]);
  assert.equal(Object.hasOwn(noAdjustment.facts,"adjustment_0_total"),false);
  const noActions=parseFinanceAnalysisResponse(JSON.stringify({version:8,sections:[{title:"记录回看",blocks:[{type:"text",markdown:"已记录支出80元，交通在额度内。"}]}]}),noAdjustment);
  assert.equal(noActions.sections![0].blocks.length,1,"empty adjustment context still supports a report without actions");
  console.log("PASS adjustment scenarios: exact sum/tradeoff, 18x24 within240, differing prices/refunds, next higher/lower/unknown budget, public pool feasibility and unchanged fact-reference/natural-number parser");
}
