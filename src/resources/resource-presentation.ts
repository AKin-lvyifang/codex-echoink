import { getBuiltinSkillDefinition, type BuiltinSkillId } from "../harness/resources/builtin-skills";
import type { SettingsLanguage } from "../settings/settings";
import type { EchoInkResource } from "./types";

export interface ResourcePresentation {
  name: string;
  description: string;
  aliases: readonly string[];
}

const ENGLISH_SKILLS: Record<BuiltinSkillId, { name: string; description: string }> = {
  "clarify-real-question": {
    name: "Clarify the Real Question",
    description: "Clarify one decisive point at a time when the goal, question, or key information is not clear enough to proceed safely."
  },
  "two-layer-explanation": {
    name: "Two-Layer Explanation",
    description: "Explain unfamiliar ideas in everyday language first, then add the precise mechanisms and limits."
  },
  "deep-understanding": {
    name: "Deep Understanding and Analysis",
    description: "Study excellent work or develop a systematic understanding of products, companies, people, technology, industries, and events."
  },
  "evidence-freshness-audit": {
    name: "Fact and Freshness Check",
    description: "Verify important facts, data, and the evidence behind plans, including knowledge that changes quickly or was recorded earlier."
  },
  "multi-lens-problem-solving": {
    name: "Multi-Perspective Problem Solving",
    description: "Use multiple perspectives, first principles, or ideas from other fields to address complex problems that one perspective or repeated fixes cannot explain."
  },
  "minimum-real-world-experiment": {
    name: "Smallest Real-World Experiment",
    description: "When more analysis cannot improve certainty, design a low-cost, reversible experiment that real-world feedback can disprove."
  },
  "knowledge-review": {
    name: "Knowledge Review",
    description: "Recommend recent topics from the current Vault's Wiki and Raw sources, then review each point with your agreement. Saving requires separate, explicit permission."
  },
  "self-discovery-life-design": {
    name: "Self-Discovery and Life Design",
    description: "Form testable ideas about your strengths from real experiences, or explore future paths through practical constraints and low-cost trials."
  },
  "daily-journal": {
    name: "Quick Journal",
    description: "Talk naturally in the home journal conversation, then safely create or append to today's journal when you are ready."
  },
  "english-diary": {
    name: "English Diary",
    description: "When you request an English diary, use the permitted context to produce natural English and explain expressions with traceable sources."
  },
  "obsidian-cli": {
    name: "Obsidian CLI",
    description: "Use when you explicitly request Obsidian CLI or native commands to read, list, or search the current Vault."
  },
  "obsidian-markdown": {
    name: "Obsidian Markdown",
    description: "Create or edit Obsidian Markdown, wikilinks, embeds, callouts, frontmatter, and tags."
  },
  "obsidian-bases": {
    name: "Obsidian Bases",
    description: "Create or edit .base files, note table views, filters, formulas, and summaries."
  },
  "json-canvas": {
    name: "JSON Canvas",
    description: "Create or edit .canvas files, nodes, connections, groups, mind maps, and flowcharts."
  },
  "finance-bill-import": {
    name: "WeChat and Alipay Bill Organization",
    description: "After the initial import, organize merchants, accounts, categories, spending descriptions, and brand icons for new WeChat or Alipay transactions."
  },
  "finance-analysis": {
    name: "Financial Review and Analysis",
    description: "When you request a new or refreshed analysis, review the month's recorded transactions and statistics to explain spending impacts and offer evidence-based suggestions."
  }
};

/** UI copy is separate from the name that Pi validates against SKILL.md. */
export function resourcePresentation(resource: EchoInkResource, language: SettingsLanguage): ResourcePresentation {
  if (resource.kind === "tool-bundle" && resource.source === "echoink-local" && resource.id === "echoink:english-diary") {
    return builtinPluginPresentation("english-diary", language);
  }
  const definition = resource.kind === "skill" && resource.source === "echoink-local"
    ? getBuiltinSkillDefinition(
        typeof resource.metadata?.resourceId === "string"
          ? resource.metadata.resourceId
          : resource.id.startsWith("echoink-local:skill:")
            ? resource.id.slice("echoink-local:skill:".length)
            : null
      )
    : null;
  if (!definition) {
    return { name: resource.name, description: resource.description, aliases: [resource.name] };
  }
  const english = ENGLISH_SKILLS[definition.id];
  const originalDescription = resource.description.trim() === definition.description.trim();
  return {
    name: language === "en" ? english.name : definition.title,
    description: originalDescription
      ? language === "en" ? english.description : definition.description
      : resource.description,
    aliases: [...new Set([definition.title, english.name, definition.id, resource.name])]
  };
}

export function builtinPluginPresentation(id: "finance" | "english-diary", language: SettingsLanguage): ResourcePresentation {
  const copy = id === "finance"
    ? {
        zhName: "财务", enName: "Finance",
        zhDescription: "导入微信、支付宝账单，查看收支、预算和财务分析。",
        enDescription: "Import WeChat and Alipay bills, track income and spending, and review budgets and financial analysis."
      }
    : {
        zhName: "英文日记", enName: "English Diary",
        zhDescription: "从日记生成自然英文，收录和回看表达。",
        enDescription: "Turn your diary into natural English and collect expressions to revisit."
      };
  return {
    name: language === "en" ? copy.enName : copy.zhName,
    description: language === "en" ? copy.enDescription : copy.zhDescription,
    aliases: [copy.zhName, copy.enName, id]
  };
}
