import assert from "node:assert/strict";
import { assertMaintenanceCopyBudget, maintenanceChangedFragments, MaintenanceCopyError, maintenanceCopyProse } from "../knowledge-base/maintenance-copy-guard";

/** Deterministic synthetic prose with no user text and no accidental repeated long definitions. */
export function syntheticCopySource(size = 2000): string {
  let state = 173;
  return Array.from({ length: size }, () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return String.fromCharCode(0x4e00 + state % 16000); }).join("");
}
export function runMaintenanceCopyGuardTests(): void {
  const prose = syntheticCopySource(), sources = [{ path: "raw/synthetic.md", content: prose }];
  const check = (parts: string[]) => assertMaintenanceCopyBudget(parts, sources);
  for (const text of [prose, `# 合成知识\n\n导语。\n\n## 普通标题\n${prose}`, prose.slice(0, 600), prose.slice(0, 600).split("").join(" ")]) assert.throws(() => check([text]), MaintenanceCopyError);
  assert.throws(() => check([prose.slice(0, 500), prose.slice(650, 1150), prose.slice(1300, 1800)]), MaintenanceCopyError, "dispersed fragments cover most of the source");
  assert.throws(() => check(Array.from({ length: 30 }, (_, i) => prose.slice(i * 65, i * 65 + 50))), MaintenanceCopyError, "many shorter passages still accumulate toward source coverage");
  assert.doesNotThrow(() => check([prose.slice(0, 599)]), "continuous limit boundary stays permissive below 600");
  assert.doesNotThrow(() => check([prose.slice(0, 160), "这是模型重新提炼的合成观点，与引用之外的边界和用法。"]));
  assert.doesNotThrow(() => assertMaintenanceCopyBudget([prose.slice(0, 399)], [{ path: "short.md", content: prose.slice(0, 399) }]));
  assert.doesNotThrow(() => check(["```ts\n" + prose + "\n```\n必要的短说明。"]));
  assert.doesNotThrow(() => check(["`" + prose + "`\n必要定义。"]));
  const first = check([prose.slice(0, 400)]);
  assert.throws(() => assertMaintenanceCopyBudget([prose.slice(0, 400)], sources, [first]), MaintenanceCopyError, "repeated long copy across pages is blocked");
  const before = `# 手写笔记\n\n## 用户原有引用\n${prose}\n\n## 正文\n旧观点。\n`;
  const after = before + "补充一个已提炼的观点。\n";
  assert.doesNotThrow(() => check(maintenanceChangedFragments(before, after)), "existing user quotations do not count");
  assert.doesNotThrow(() => check(maintenanceChangedFragments(`## 正文\n说明${prose}保留。\n`, `## 正文\n新说明${prose}仍然保留。\n`)), "retained user text in a replaced paragraph is not a new copy");
  assert.throws(() => check(maintenanceChangedFragments("# 原有页\n\n## 正文\n短观点。\n", "# 原有页\n\n## 正文\n短观点。\n" + prose)), MaintenanceCopyError);
  assert.equal(maintenanceCopyProse("---\n属性: value\n---\nＡ B\nC"), "ABC", "OCR spaces and fullwidth typography share the same matching normalization");
  console.log("Maintenance copy guard: PASS (whole/long/dispersed/cross-page/append/OCR, short quotes/sources/code/definitions/user baseline)");
}
