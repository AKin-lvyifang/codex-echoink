import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const vault = process.argv[process.argv.indexOf("--vault") + 1];
if (!process.argv.includes("--vault") || !vault) throw new Error("Use --vault <disposable test Vault>");
const roots = await readdir(vault);
const root = (role) => {
  const matches = roots.filter((name) => name === role || name.endsWith(`（${role}）`));
  if (matches.length !== 1) throw new Error(`Expected one existing ${role} root`);
  return matches[0];
};
const wiki = root("wiki"), raw = root("raw"), projects = root("projects");
const wp = (name) => `${wiki}/ask-reading-v1/${name}.md`;
const rp = `${raw}/ask-reading-v1/上海大会报销补充通知.md`;
const link = (name) => `[[${wp(name)}]]`;
const fixtures = new Map([
  [wp("01-2026上海大会总览"), ["# 2026 上海大会总览", "", "本目录全部是虚构测试资料。活动代号 SH-2026，2026年9月18日在上海举办。", "本页是活动导航，数字和具体执行事项按各专项材料为准。", "", ...Array.from({ length: 65 }, (_, index) => `归档备注 ${index + 1}：仅作版面占位，无额外业务事实。`), "", "## 专项资料", ...["02-现场安排补充", "04-原版预算", "05-预算v2", "06-实际支出明细", "08-人员便笺"].map(link), "[[尚未上传的舞台效果图]]"].join("\n")],
  [wp("02-现场安排补充"), "# 现场安排补充\n工作人员14:20在东门集合。正式开场15:00。\n"],
  [wp("03-设备交接补遗"), `# 设备交接补遗\n对应活动：${link("01-2026上海大会总览")}\n租赁设备于活动次日10:30—11:00归还，勿混用前一天布场时间。\n`],
  [wp("04-原版预算"), `# 原版预算\n对象：2026上海大会 SH-2026\n资料性质：活动前预算\n预计收入120万元，预计成本60万元。\n修订计划请对照 ${link("05-预算v2")}；本页不是实际结算。\n`],
  [wp("05-预算v2"), `# 预算v2\n对象：2026上海大会 SH-2026\n资料性质：修订预算\n适用时间：会前计划\n预计收入120万元，预计成本66万元。\n实际支出见 ${link("06-实际支出明细")}，预算值不能直接视为实际值。\n`],
  [wp("06-实际支出明细"), `# 实际支出明细\n对象：2026上海大会 SH-2026\n资料性质：活动后实际支出\n适用时间：9月19日结算记录\n场地40万元，餐饮20万元，物料12万元。以上均为本活动实际发生支出。\n实际收入：尚未填写，待财务补录。\n预计收入可查 ${link("05-预算v2")}，不得冒充已确认实际收入。\n`],
  [wp("07-2025北京复盘"), "# 2025 北京大会复盘\n对象：BJ-2025，北京，2025年9月18日。\n资料性质：已结算实际记录\n实际收入100万元，实际成本80万元。此旧活动资料于2026年9月20日重新归档；归档日期不改变活动年份。\n"],
  [wp("08-人员便笺"), `# 人员便笺\n上海这场（SH-2026）现场到场1200人，报名1500人；别把报名当实到。\n未整理成规范表格。名单附件暂缺：[[未上传的到场名单]]。\n${link("01-2026上海大会总览")}\n`],
  [rp, `# 上海大会报销补充通知\n本通知为虚构测试资料。对象为2026上海大会 SH-2026。\n报销截止2026年9月30日17:00。\n仅餐饮项目缺发票时，可以付款截图补充报销。设备租赁仍须正式发票，付款截图不能替代。\n适用阶段：活动结束后的报销办理。\n活动总览：${link("01-2026上海大会总览")}\n`],
  [`${projects}/ask-reading-v1/复测入口.md`, `# Ask 关联阅读复测入口\n全部为虚构材料。\n活动入口：${link("01-2026上海大会总览")}\n维护对象：[[${rp}]]\n\n可在新会话使用 /ask 提问工作人员集合、设备归还、实际支出和利润率、按人数计算人均成本。\n可对上述单篇Raw执行 /maintain，然后在新会话问设备租赁能否凭付款截图报销以及截止时间。\n验收预期与运行证据保存在开发任务报告中，本库只存业务资料。\n`]
]);
for (const [relative, content] of fixtures) {
  const target = path.join(vault, relative);
  const text = content.trimEnd() + "\n";
  await mkdir(path.dirname(target), { recursive: true });
  try { await writeFile(target, text, { encoding: "utf8", flag: "wx" }); }
  catch (error) {
    if (error.code !== "EEXIST" || await readFile(target, "utf8") !== text) throw error;
  }
}
console.log(`Prepared ${fixtures.size} fictional articles under existing knowledge roots / ask-reading-v1`);
