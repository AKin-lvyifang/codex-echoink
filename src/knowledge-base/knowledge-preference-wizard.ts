import type { KnowledgeMaintenancePreferenceSnapshot } from "./knowledge-maintenance-preferences";
import { createMaintenanceSectionSnapshot } from "./maintenance-section-patch";

export const KNOWLEDGE_PURPOSES = [
  { id: "study", zh: "学习备考", en: "Study and exams" },
  { id: "research", zh: "研究写论文", en: "Research and papers" },
  { id: "work", zh: "工作积累", en: "Build work knowledge" },
  { id: "writing", zh: "创作写东西", en: "Creative writing" },
] as const;
export type KnowledgePurpose = (typeof KNOWLEDGE_PURPOSES)[number]["id"];
export interface KnowledgePreferenceWizardHost {
  read(): Promise<Readonly<KnowledgeMaintenancePreferenceSnapshot>>;
  save(
    content: string,
    expectedRevision: string,
  ): Promise<Readonly<KnowledgeMaintenancePreferenceSnapshot>>;
  available(): boolean;
  generate(prompt: string, signal: AbortSignal): Promise<string>;
}
export interface KnowledgePreferenceProposal {
  content: string;
  expectedRevision: string;
  sections: { title: string; content: string }[];
}

export async function proposeKnowledgePreferences(
  host: KnowledgePreferenceWizardHost,
  baseline: Readonly<KnowledgeMaintenancePreferenceSnapshot>,
  purpose: KnowledgePurpose,
  language: "zh-CN" | "en",
  signal: AbortSignal,
): Promise<KnowledgePreferenceProposal> {
  if (!host.available())
    throw new Error(
      language === "en"
        ? "Connect a model, or skip and do this later in settings."
        : "请先连接模型，也可以跳过，以后在设置里做。",
    );
  const selected = KNOWLEDGE_PURPOSES.find((item) => item.id === purpose)!;
  const prompt = [
    "为用户的知识库生成整理偏好，只调整颗粒度与组织、表达风格。不要执行文件操作。",
    `主要用途：${selected.zh}。输出语言：${language === "en" ? "英文" : "中文"}。`,
    "根据用途明确条目如何拆分、怎样组织、保留什么上下文、怎样写结论和例子。偏好应具体、可执行，足以影响同一份资料的整理结果。",
    "学习备考考虑可复习的问题、概念边界与易错区别；研究考虑论点、方法、证据和限制；工作考虑决策条件、步骤与复用；创作考虑素材、观察、表达和叙事。不要套用与本用途无关的其他用途。",
    "只生成这两组偏好，不改提炼协议、来源规则、tag、目录或权限，不要求补材料中没有的事实，不改其他已有自定义偏好。",
    '只返回JSON对象：{"granularity":["每条一句话"],"expression":["每条一句话"]}，每组2到5条，不加Markdown代码围栏。',
  ].join("\n");
  const output = await host.generate(prompt, signal);
  if (signal.aborted) throw new Error("已取消生成。");
  const value = JSON.parse(
    output
      .trim()
      .replace(/^```(?:json)?\s*/u, "")
      .replace(/\s*```$/u, ""),
  ) as Record<string, unknown>;
  const eol = baseline.content.match(/\r\n|\n/u)?.[0] ?? "\n";
  const sections = [
    ["granularity", "颗粒度与组织"],
    ["expression", "表达风格"],
  ].map(([key, title]) => {
    const lines = value[key];
    if (
      !Array.isArray(lines) ||
      lines.length < 2 ||
      lines.length > 5 ||
      lines.some(
        (line) =>
          typeof line !== "string" || !line.trim() || /[\r\n]/u.test(line),
      )
    )
      throw new Error("偏好生成结果不完整，请重试或跳过。");
    return {
      title,
      content: (lines as string[]).map((line) => `- ${line.trim()}`).join(eol),
    };
  });
  let content = baseline.content;
  for (const section of sections) {
    const regions = createMaintenanceSectionSnapshot(content).regions.filter(
      (region) => region.title === section.title,
    );
    if (regions.length > 1)
      throw new Error("现有偏好有重名小节，请先在偏好编辑器核对。");
    const region = regions[0];
    content = region
      ? content.slice(0, region.contentStart) +
        section.content +
        eol + eol +
        content.slice(region.end)
      : content + (content.endsWith(eol + eol) ? "" : content.endsWith(eol) ? eol : eol + eol) +
        `## ${section.title}${eol}${section.content}${eol}`;
  }
  return { content, expectedRevision: baseline.revision, sections };
}
