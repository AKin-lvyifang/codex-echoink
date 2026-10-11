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
  assert.equal(equalDaily.确定计算的前后变化.每日记录净支出变化元,0);
  assertHistoricalDailyChanges();
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

function assertHistoricalDailyChanges() {
  const prepare=(month:string,rows:FinanceEntry[],asOf="2026-10-12")=>
    JSON.parse(buildFinanceAnalysisInput(month,rows,null,asOf,{}).text);
  const calendarRows=[row("aug-dining",310000,"expense","餐饮",{date:"2026-08-01"}),
    row("sep-dining",300000,"expense","餐饮",{date:"2026-09-01"}),row("reading",9900,"expense","阅读")];
  const calendar=prepare("2026-09",calendarRows),changes=calendar.确定计算的前后变化;
  assert.equal(changes.净支出变化元,-1);
  assert.equal(changes.当前每日记录净支出元,103.3);assert.equal(changes.前月每日记录净支出元,100);
  assert.ok(Math.abs(changes.每日记录净支出变化元-3.3)<1e-12);
  const dining=changes.分类变化.find((item:any)=>item.分类==="餐饮");
  assert.deepEqual([dining.当前每日记录净支出元,dining.前月每日记录净支出元,dining.每日记录净支出变化贡献元],[100,100,0]);
  const reading=changes.分类变化.find((item:any)=>item.分类==="阅读");
  assert.deepEqual([reading.当前每日记录净支出元,reading.前月每日记录净支出元,reading.每日记录净支出变化贡献元],[3.3,0,3.3]);
  assert.deepEqual([reading.当前该类有记录,reading.前月该类有记录,reading.当前覆盖,reading.前月覆盖],[true,false,"unknown","unknown"]);
  assert.match(changes.说明,/总额变化与日均变化是不同口径/);assert.match(changes.说明,/不代表真实消费为0/);
  assert.match(changes.说明,/记录变化不自动证明行为因果/);
  const assertContributions=(value:any)=>assert.ok(Math.abs(value.分类变化.reduce((sum:number,item:any)=>
    sum+item.每日记录净支出变化贡献元,0)-value.每日记录净支出变化元)<1e-12,"complete category contributions reconcile before rounding");
  assertContributions(changes);
  const fractionalRows=[...Array.from({length:8},(_,i)=>row(`sep-${i}`,i+1,"expense",`分类${i}`,{date:"2026-09-01"})),
    ...Array.from({length:8},(_,i)=>row(`aug-${i}`,i+2,"expense",`分类${i}`,{date:"2026-08-01"})),
    row("refund",4,"refund","分类0"),row("old-only",3,"expense","前月独有",{date:"2026-08-01"}),
    row("zero-expense",5,"expense","抵消分类"),row("zero-refund",5,"refund","抵消分类")];
  const fractional=prepare("2026-09",fractionalRows).确定计算的前后变化;
  assert.equal(fractional.分类变化.length,10,"daily contributions include all categories, without Top5 merging");
  const negative=fractional.分类变化.find((item:any)=>item.分类==="分类0");
  assert.equal(negative.当前每日记录净支出元,-.03/30);assert.equal(negative.前月每日记录净支出元,.02/31);
  assert.deepEqual(["前月独有","抵消分类"].map(name=>fractional.分类变化.find((item:any)=>item.分类===name))
    .map((item:any)=>[item.当前净支出元,item.当前该类有记录,item.前月该类有记录]),[[0,false,true],[0,true,false]]);
  assertContributions(fractional);
  const midmonth=prepare("2026-10",[row("previous",120000,"expense","餐饮",{date:"2026-09-01"}),
    row("outside",60000,"expense","餐饮",{date:"2026-09-13"}),
    row("current",60000,"expense","餐饮",{date:"2026-10-01"}),row("current-refund",12000,"refund","餐饮",{date:"2026-10-12"})]);
  assert.deepEqual([midmonth.统计范围.天数,midmonth.上个自然月可比.历史范围.天数],[12,12]);
  assert.deepEqual([midmonth.确定计算的前后变化.当前每日记录净支出元,midmonth.确定计算的前后变化.前月每日记录净支出元,
    midmonth.确定计算的前后变化.每日记录净支出变化元],[40,100,-60]);
  assertContributions(midmonth.确定计算的前后变化);
  for(const rows of [[],[calendarRows[0]],[calendarRows[1]],
    [calendarRows[0],row("current-transfer",10000,"transfer")],
    [calendarRows[1],row("previous-transfer",10000,"transfer","餐饮",{date:"2026-08-01"})]])
    assert.equal(prepare("2026-09",rows).确定计算的前后变化,null,"a missing period, including transfers only, is not zero spending");
  const future=prepare("2026-10",calendarRows,"2026-09-30");
  assert.equal(future.统计范围.天数,0);assert.equal(future.确定计算的前后变化,null,"zero days never produce a daily comparison");
  console.log("PASS history daily changes: 31/30-day dining stays 100/day, reading contributes the whole 3.3/day increase, complete unrounded/refunded category reconciliation, missing categories versus periods and month-to-date ranges");
}

function assertAdjustmentScenarios() {
  const rows=[...Array.from({length:28},(_,i)=>row(`ordinary-${i}`,5500,"expense","餐饮",{date:`2026-09-${String(i+1).padStart(2,"0")}`,description:"普通一日三餐"})),
    row("party-friend",39000,"expense","餐饮",{date:"2026-09-15",description:"朋友聚餐"}),
    row("party-birthday",39000,"expense","餐饮",{date:"2026-09-25",description:"生日聚餐"}),
    ...Array.from({length:18},(_,i)=>row(`tea-${i}`,2400,"expense","饮品",{description:"奶茶",merchant:`茶店${i%9}`})),
    row("ordinary-budget",8000,"expense","交通"),row("unallocated",10000,"expense","未设额度")];
  const budget={month:"2026-09",totalCents:400000,allocations:{餐饮:180000,饮品:24000,交通:8000}};
  const prepared=buildFinanceAnalysisInput("2026-09",rows,budget,"2026-10-12",{});
  const input=JSON.parse(prepared.text),scenarios=input.可核对调整情景.分类;
  assert.deepEqual(scenarios.map((item:any)=>item.分类),["餐饮","饮品"],"normal use and missing allocation do not produce adjustment scenarios");
  const dining=scenarios[0],ordinary=dining.用途取舍.find((item:any)=>item.消费说明==="普通一日三餐");
  assert.equal(dining.本期净支出元,2320);assert.equal(dining.需减少或增加额度元,520);
  assert.equal(dining.用途取舍.length,3,"three distinct recorded purposes remain distinct");
  assert.deepEqual([ordinary.本期用途金额元,ordinary.本期其余金额元,ordinary.保留用途后其余上限元,ordinary.保留其余后用途上限元],[1540,780,260,1020]);
  assert.equal(ordinary.本期用途金额元+ordinary.保留用途后其余上限元,1800);
  assert.equal(ordinary.本期其余金额元+ordinary.保留其余后用途上限元,1800);
  const combined=rows.map(item=>item.id.startsWith("party-")?{...item,description:"聚餐"}:item);
  const complementary=JSON.parse(buildFinanceAnalysisInput("2026-09",combined,budget,"2026-10-12",{}).text).可核对调整情景.分类[0].用途取舍;
  assert.equal(complementary.length,1,"two complementary purpose groups share one pair of amount choices");
  assert.deepEqual([complementary[0].本期用途金额元,complementary[0].本期其余金额元,complementary[0].保留用途后其余上限元,complementary[0].保留其余后用途上限元],[780,1540,1020,260]);
  assert.match(dining.条件,/若2026-10沿用本月/);assert.match(dining.条件,/以本期.*作对照/);
  assert.equal(dining.单独调拨后余量元,1360);
  assert.match(prepared.facts[dining.引用.单独调拨],/本月总预算与全部分类额度/);
  const tea=scenarios[1].用途取舍[0];
  assert.deepEqual([scenarios[1].本期净支出元,scenarios[1].情景分类额度元,scenarios[1].需减少或增加额度元],[432,240,192]);
  assert.deepEqual([tea.本期用途金额元,tea.本期其余金额元,tea.保留其余后用途上限元],[432,0,240]);
  for(const scenario of scenarios) for(const choice of scenario.用途取舍) {
    assert.equal(Object.hasOwn(choice,"同价次数上限"),false);
    assert.equal(Object.hasOwn(choice,"需减少同价次数"),false);
    assert.equal(Object.hasOwn(choice,"减少同价金额元"),false);
    assert.equal(choice.引用.同价次数,undefined,"same-price records do not supply activity-count advice");
  }
  assert.equal(Object.keys(prepared.facts).some(key=>/^adjustment_.*_count$/u.test(key)),false);
  assert.doesNotMatch(Object.entries(prepared.facts).filter(([key])=>key.startsWith("adjustment_")).map(([,value])=>value).join(""),/最多 \d+ 笔|需减少 \d+ 笔/u);
  const diningHistory=input.用途累计候选.find((item:any)=>item.相同消费说明==="普通一日三餐");
  const teaHistory=input.用途累计候选.find((item:any)=>item.相同消费说明==="奶茶");
  assert.deepEqual([diningHistory.笔数,diningHistory.累计支出原额元,diningHistory.相同单笔金额元],[28,1540,55]);
  assert.deepEqual([teaHistory.笔数,teaHistory.不同商户数,teaHistory.累计支出原额元,teaHistory.相同单笔金额元],[18,9,432,24]);
  const parsed=parseFinanceAnalysisResponse(JSON.stringify({version:8,sections:[{title:"取舍",blocks:[
    {type:"highlight",tone:"fact",markdown:"{{record_coverage}}"},
    {type:"actions",items:[`{{${ordinary.引用.保留用途}}}`,`{{${tea.引用.保留其余}}}`]},
    {type:"text",markdown:"餐饮净支出2320元，超额520元；饮品432元，按240元额度需减少192元。"}]}]}),prepared);
  const action=parsed.sections![0].blocks.find(block=>block.type==="actions")!;
  assert.equal(action.type,"actions");if(action.type!=="actions")throw new Error("actions required");
  assert.doesNotMatch(action.items.join(""),/\{\{/);assert.match(action.items[0],/260/);assert.match(action.items[1],/192/);
  assert.match(parsed.conclusion,/记录完整性未知/);assert.equal(parsed.omittedSuggestionCount,0);
  const differentPrice=rows.map(item=>item.id==="tea-0"?{...item,amountCents:2500}:item);
  const varied=JSON.parse(buildFinanceAnalysisInput("2026-09",differentPrice,budget,"2026-10-12",{}).text);
  assert.equal(varied.可核对调整情景.分类[1].需减少或增加额度元,193);
  assert.equal(varied.用途累计候选.find((item:any)=>item.相同消费说明==="奶茶").相同单笔金额元,null);
  const refunded=JSON.parse(buildFinanceAnalysisInput("2026-09",[...rows,row("refund",10000,"refund","餐饮")],budget,"2026-10-12",{}).text).可核对调整情景.分类[0];
  assert.equal(refunded.本期净支出元,2220);assert.equal(refunded.需减少或增加额度元,420);
  assert.deepEqual(refunded.用途取舍,[],"category refunds cannot be attributed to an individual purpose");
  const high=buildFinanceAnalysisInput("2026-09",rows,budget,"2026-10-12",{nextBudget:{month:"2026-10",totalCents:500000,allocations:{餐饮:300000}},nextBudgetSource:"month-override"});
  const higher=JSON.parse(high.text).可核对调整情景.分类[0];
  assert.match(higher.条件,/2026-10独立预算/);assert.doesNotMatch(higher.条件,/沿用本月/);
  assert.equal(higher.情景分类额度元,3000);assert.equal(higher.需减少或增加额度元,0);assert.deepEqual(higher.用途取舍,[]);
  assert.match(high.facts[higher.引用.总额],/不需增额或减支/);
  const low=buildFinanceAnalysisInput("2026-09",rows,budget,"2026-10-12",{nextBudget:{month:"2026-10",totalCents:105000,allocations:{餐饮:100000}}});
  const lower=JSON.parse(low.text).可核对调整情景.分类[0],lowerOrdinary=lower.用途取舍[0],lowerParty=lower.用途取舍[1];
  assert.equal(lower.情景分类额度元,1000);assert.equal(lower.需减少或增加额度元,1320);
  assert.equal(lower.引用.单独调拨,undefined,"insufficient public allocation must not produce a reallocation option");
  assert.equal(lowerOrdinary.保留用途后其余上限元,null);assert.equal(lowerOrdinary.保留其余后用途上限元,220);
  assert.equal(lowerParty.保留用途后其余上限元,610);assert.equal(lowerParty.保留其余后用途上限元,null);
  assert.match(low.facts[lowerParty.引用.保留其余],/不能.*可花金额/);
  const missingCategory=JSON.parse(buildFinanceAnalysisInput("2026-09",rows,budget,"2026-10-12",{nextBudget:{month:"2026-10",totalCents:500000,allocations:{交通:20000}}}).text).可核对调整情景.分类[0];
  assert.match(missingCategory.条件,/若2026-10沿用本月/);assert.equal(missingCategory.未分配余量元,null);
  assert.equal(missingCategory.引用.单独调拨,undefined,"unknown next-category baseline cannot use the next plan's entire public pool");
  const noAdjustment=buildFinanceAnalysisInput("2026-09",[row("normal",8000,"expense","交通")],budget,"2026-10-12",{});
  assert.deepEqual(JSON.parse(noAdjustment.text).可核对调整情景.分类,[]);
  assert.equal(Object.hasOwn(noAdjustment.facts,"adjustment_0_total"),false);
  const noActions=parseFinanceAnalysisResponse(JSON.stringify({version:8,sections:[{title:"记录回看",blocks:[{type:"text",markdown:"已记录支出80元，交通在额度内。"}]}]}),noAdjustment);
  assert.equal(noActions.sections![0].blocks.length,1,"empty adjustment context still supports a report without actions");
  console.log("PASS adjustment scenarios: three real purpose groups, exact amount tradeoffs without activity-count advice, recorded price/frequency retained, refunds and next budgets, public pool feasibility and unchanged fact-reference/natural-number parser");
}
