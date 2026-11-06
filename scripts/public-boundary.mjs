// 公开仓库边界：哪些路径属于内部资料（只进私有仓库 origin，不进公开仓库 public）。
// check-public-files.mjs 与 export-public.mjs 共用这一份清单。

export const internalRules = [
  {
    reason: "private local collaboration or memory state",
    matches: (file) =>
      /(?:^|\/)(?:AGENT|AGENTS|USER|MEMORY|CONTEXT)\.md$/i.test(file)
      || /^(?:CLAUDE|HANDOFF)\.md$/i.test(file)
      || file.startsWith(".codex-memory/")
      || file.startsWith(".claude/")
      || file.startsWith(".omx/")
  },
  {
    reason: "private project documentation",
    matches: (file) => file.startsWith("docs/")
  },
  {
    reason: "private experiment material",
    matches: (file) => file.startsWith("experiments/")
  },
  {
    reason: "private Agent Evals material",
    matches: (file) =>
      /^scripts\/agent-evals-.*\.mjs$/i.test(file)
      || file.startsWith("src/tests/agent-evals/")
      || file.startsWith("src/tests/fixtures/agent-evals-v1/")
  },
  {
    reason: "internal prototype source or artifact",
    matches: (file) => /(?:^|\/)prototypes?\//i.test(file)
  }
];

export function internalReason(file) {
  return internalRules.find((rule) => rule.matches(file))?.reason ?? null;
}
