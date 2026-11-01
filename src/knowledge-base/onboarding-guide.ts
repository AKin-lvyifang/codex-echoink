import zh from "./assets/guide/onboarding-guide.zh-CN.md";
import en from "./assets/guide/onboarding-guide.en.md";
import type { OnboardingSetupPlan } from "./onboarding-setup-plan";

export interface OnboardingGuideResult { path: string; action: "created" | "preserved" }

/** Fixed local copy, with only the confirmed paths and actual setup counts filled in. */
export function renderOnboardingGuide(plan: OnboardingSetupPlan, created: readonly string[]): string {
  const english = plan.language === "en";
  const bindings = plan.directoryPlan.bindings;
  const directory = (role: "raw" | "wiki" | "projects" | "inbox" | "journal") => bindings.roles[role].writePath ?? bindings.roles[role].readPaths[0] ?? (english ? "vault root" : "仓库根目录");
  const code = (value: string) => "`" + value.replaceAll("`", "\\`").replaceAll("|", "\\|") + "`";
  const values: Record<string, string> = {
    created: created.length ? created.map(code).join(english ? ", " : "、") : english ? "None" : "无需新建",
    sources: plan.sources.map(source => `${code(source.path)} (${source.noteCount}${english ? " notes" : " 篇"})`).join(english ? ", " : "、"),
    count: String(plan.noteCount), raw: code(directory("raw")), wiki: code(directory("wiki")), projects: code(directory("projects")),
    inbox: code(directory("inbox")), journal: code(directory("journal")), answer: code(plan.outputLocations.answer), generation: code(plan.outputLocations.generation)
  };
  values.outputs = plan.outputLocations.answer === plan.outputLocations.generation
    ? `| ${values.answer} | ${english ? "Saved answers, reports and generated drafts" : "AI 写给你的回答、报告、生成稿"} | AI |`
    : `| ${values.answer} | ${english ? "Saved answers and reports" : "AI 写给你的回答、报告"} | AI |\n| ${values.generation} | ${english ? "Generated drafts" : "生成稿"} | AI |`;
  return (english ? en : zh).replace(/\{(\w+)\}/gu, (placeholder, key: string) => values[key] ?? placeholder);
}
