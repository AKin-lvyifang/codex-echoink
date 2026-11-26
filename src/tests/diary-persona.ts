import assert from "node:assert/strict";
import {
  PERSONA_MIN_ENTRIES, acceptPersonaResult, bodyChars, eligibleEntries, isMonthOpen, isPersonaEligible, journalBodyText, normalizeDiaryPersonaState,
  personaDelta, personaErrorCode, personaErrorText, personaMarkdown, personaRequestBody, previousMonthKey, type PersonaResult
} from "../home/diary-persona-core";

const result = (month: string, letters: string, percents: number[]): PersonaResult => ({
  month, type: letters, name: "安静充电的一个月", keywords: ["独处", "复盘", "倾听"], summary: "这个月你常在一个人的时候写日记。",
  dims: [...letters].map((letter, i) => ({ letter, percent: percents[i], quotes: i === 0 ? [{ date: `${month}-07`, text: "一个人去了趟西湖" }] : [] })),
  entries: 8, model: "gpt-6.1-terra", generatedAt: Date.UTC(2026, 10, 25),
});

export function runDiaryPersonaTests(): void {
  // 正文口径：模板记号、frontmatter、图片和链接地址都不算字。
  const template = "---\ndate: 2026-11-02\n---\n# 今天\n\n## 心情\n\n- [ ] \n\n![[photo.png]]\n";
  assert.equal(bodyChars(journalBodyText(template)), "今天心情".length);
  assert.equal(journalBodyText("见 [[2026-11-01|昨天]] 和 [文章](https://x.test/a)"), "见 昨天 和 文章");
  const long = "下班后一个人在江边走了四十分钟。".repeat(7);
  const entries = [...Array.from({ length: 7 }, (_, i) => ({ date: `2026-11-0${i + 1}`, path: `Journal/2026-11-0${i + 1}.md`, text: long })),
    { date: "2026-11-08", path: "Journal/2026-11-08.md", text: "累" }];
  assert.equal(eligibleEntries(entries).length, 7);
  assert.equal(isPersonaEligible(entries), false, "seven real entries plus a stub stay hidden");
  entries.push({ date: "2026-11-09", path: "Journal/2026-11-09.md", text: long });
  assert.equal(isPersonaEligible(entries), true);
  assert.equal(PERSONA_MIN_ENTRIES, 8);

  // 请求只带够数的日记正文，不带路径；上月结果只带字母和比例。
  const previous = result("2026-10", "ENFJ", [71, 54, 66, 63]);
  const body = personaRequestBody("2026-11", "zh", entries, previous);
  assert.equal(body.entries.length, 8);
  assert.ok(body.entries.every(entry => !("path" in entry)));
  assert.deepEqual(body.previous, { month: "2026-10", type: "ENFJ", dims: [{ letter: "E", percent: 71 }, { letter: "N", percent: 54 }, { letter: "F", percent: 66 }, { letter: "J", percent: 63 }] });

  // 较上月：翻转写来源字母，同侧写差值；没有上月返回 null。
  const current = result("2026-11", "INFJ", [68, 57, 61, 74]);
  assert.deepEqual(personaDelta(current, previous), [{ flipFrom: "E" }, { delta: 3 }, { delta: -5 }, { delta: 11 }]);
  assert.equal(personaDelta(current, null), null);
  assert.equal(previousMonthKey("2026-01"), "2025-12");
  assert.equal(isMonthOpen("2026-11", new Date(2026, 10, 25)), true);
  assert.equal(isMonthOpen("2026-10", new Date(2026, 10, 25)), false);

  // 存储：坏数据被丢弃，月份键必须和结果一致，字母必须在对应维度里。
  const state = normalizeDiaryPersonaState({ results: { "2026-11": current, "2026-10": current, "2026-09": { ...result("2026-09", "XNFJ", [60, 60, 60, 60]) } }, seen: ["2026-11", "bad", "2026-11"] });
  assert.deepEqual(Object.keys(state.results), ["2026-11"]);
  assert.deepEqual(state.seen, ["2026-11"]);
  assert.deepEqual(normalizeDiaryPersonaState(undefined), { results: {}, seen: [] });
  assert.equal(acceptPersonaResult({ ...current, dims: current.dims.map(d => ({ ...d, percent: 140 })) })?.dims[0].percent, 100);

  // 存入笔记：原句带双链指回日记，较上月写在维度标题上。
  const markdown = personaMarkdown(current, date => date === "2026-11-07" ? "Journal/2026-11-07" : null, true, previous);
  assert.match(markdown, /# 2026 年 11 月人格：INFJ/u);
  assert.match(markdown, /> 一个人去了趟西湖\n> — \[\[Journal\/2026-11-07\|2026-11-07\]\]/u);
  assert.match(markdown, /## I · 内向 68%（由 E 转来）/u);
  assert.match(markdown, /## J · 判断 74%（较上月 \+11）/u);

  // 报错：正式口吻、先结果后下一步；限流码透传。
  assert.equal(personaErrorCode(401, null), "SIGN_IN");
  assert.equal(personaErrorCode(429, { error: "PERSONA_PERIOD_LIMIT" }), "PERSONA_PERIOD_LIMIT");
  assert.equal(personaErrorCode(502, { error: "AI_PROVIDER_FAILED" }), "UNAVAILABLE");
  const reset = new Date("2026-11-30T16:00:00.000Z");
  assert.equal(personaErrorText("PERSONA_PERIOD_LIMIT", true, reset.toISOString()), `本月生成次数已用完，${reset.getMonth() + 1} 月 ${reset.getDate()} 日恢复。`);
  assert.equal(personaErrorText("SIGN_IN", true), "未登录 EchoInk 账号。请在 设置 → 账号与会员 中登录后再生成。");
  console.log("Diary persona tests: PASS");
}
