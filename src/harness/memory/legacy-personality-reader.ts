import { getDesktopCrypto } from "../../platform/desktop-crypto";
import { getDesktopPath } from "../../platform/desktop-paths";
import {
  cognitivePathExists,
  cognitiveReadJsonOrNull
} from "./cognitive-file-utils";
import { AGENT_MD_HARD_MAX_BYTES, stableSelfKey, type AgentSelfHabit } from "./agent-self";
import { AGENT_TEMPLATES, type AgentTemplateId } from "./agent-templates";

const { createHash } = getDesktopCrypto();

const path = getDesktopPath();

const LEGACY_PERSONALITY_SCHEMAS = new Set([
  "echoink.personality.v1",
  "echoink.personality.v2"
]);

export interface LegacyAgentRequirement {
  readonly id: string;
  readonly text: string;
  readonly basis: "explicit_memory" | "observed_memory";
  readonly status: "current" | "superseded";
  readonly sourceMemoryIds: readonly string[];
  readonly revision: number;
  readonly reason?: string;
}

export interface LegacyPersonalitySnapshot {
  readonly schema: "echoink.personality.v1" | "echoink.personality.v2";
  readonly templateId: string | null;
  readonly learnedRequirements: readonly LegacyAgentRequirement[];
}

export type LegacyPersonalityInspection =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "invalid"; reason: string }>
  | Readonly<{ kind: "valid"; state: LegacyPersonalitySnapshot }>;

export interface LegacyAgentMarkdownSnapshot {
  readonly format: "static_default" | "personality_projection_v1" | "personality_projection_v2";
  readonly templateId: AgentTemplateId | null;
  readonly habits: readonly AgentSelfHabit[];
}

export type LegacyAgentMarkdownInspection =
  | Readonly<{ kind: "valid"; state: LegacyAgentMarkdownSnapshot }>
  | Readonly<{ kind: "invalid"; reason: string }>;

const LEGACY_AGENT_DEFAULTS = new Set([
  [
    "# EchoInk Agent",
    "",
    "EchoInk 是同一 Vault 中持续协作的一位个人 Agent。",
    "",
    "## 表达",
    "",
    "- 先理解当前目标，再决定是否需要历史。",
    "- 真实、克制，有证据时才提醒、纠正或反对。",
    ""
  ].join("\n"),
  [
    "# EchoInk Agent",
    "",
    "EchoInk 是同一 Vault 中持续协作的一位个人 Agent。",
    "",
    "## 人格",
    "",
    "- 真诚、冷静、有主见，温和但不含糊。",
    "- 忠于事实、用户的长期目标和更好的结果；不以迎合用户或证明自己正确为目标。",
    "- 尊重用户的最终决定，同时保留独立判断。",
    "",
    "## 合作方式",
    "",
    "- 先理解当前目标，再决定是否需要历史。",
    "- 形成重要建议前，检查关键前提、相关经验、反例和信息时效。",
    "- 发现会影响结果的目标冲突或历史冲突时，先核对当前场景，再提醒、追问、纠正或反对。",
    "",
    "## 表达",
    "",
    "- 先给结论，再给依据、风险和下一步。",
    "- 语言自然、具体、克制；不奉承、不含糊、不抬杠。",
    "- 有证据时才提醒、纠正或反对；不确定时明确说明。",
    ""
  ].join("\n")
]);

const LEGACY_PROJECTION_EXPRESSION = Object.freeze([
  "- 语言自然、具体、克制。",
  "- 详略服从当前任务，不固定成长短模板。",
  "- 二级事实（llm-inferred-reference）只能作为系统推理参考，不得表述为用户亲口确认。"
]);
const LEGACY_V1_TRAIT_LINE = /^- (?:节奏|能量|思维|温度|秩序|立场)：[^\r\n]+$/u;
const LEGACY_V2_TRAIT_LINE = /^- (?:锋利度|主导度|较真度|条理性|果敢度|创意度)（[^\r\n]+）：[^\r\n]+$/u;

export function legacyPersonalityFilePath(root: string): string {
  return path.join(root, "agents", "echoink", "personality-state.json");
}

export async function inspectLegacyPersonalityFile(
  filePath: string
): Promise<LegacyPersonalityInspection> {
  const raw = await cognitiveReadJsonOrNull<Record<string, unknown>>(filePath);
  if (!raw) {
    return await cognitivePathExists(filePath)
      ? Object.freeze({ kind: "invalid", reason: "unparseable_json" })
      : Object.freeze({ kind: "missing" });
  }
  if (!LEGACY_PERSONALITY_SCHEMAS.has(String(raw.schema))) {
    return Object.freeze({ kind: "invalid", reason: "unknown_schema" });
  }
  if (!Number.isSafeInteger(raw.revision) || (raw.revision as number) < 0) {
    return Object.freeze({ kind: "invalid", reason: "invalid_revision" });
  }
  if (raw.templateId !== null && typeof raw.templateId !== "string") {
    return Object.freeze({ kind: "invalid", reason: "invalid_template" });
  }
  if (!Array.isArray(raw.learnedRequirements)) {
    return Object.freeze({ kind: "invalid", reason: "invalid_requirements" });
  }
  const requirements: LegacyAgentRequirement[] = [];
  for (const value of raw.learnedRequirements) {
    const parsed = parseLegacyRequirement(value);
    if (!parsed) return Object.freeze({ kind: "invalid", reason: "invalid_requirement" });
    requirements.push(parsed);
  }
  return Object.freeze({
    kind: "valid",
    state: Object.freeze({
      schema: raw.schema as "echoink.personality.v1" | "echoink.personality.v2",
      templateId: raw.templateId,
      learnedRequirements: Object.freeze(requirements)
    })
  });
}

export function inspectLegacyAgentMarkdown(markdown: string): LegacyAgentMarkdownInspection {
  if (Buffer.byteLength(markdown, "utf8") > AGENT_MD_HARD_MAX_BYTES) {
    return Object.freeze({ kind: "invalid", reason: "agent_md_utf8_limit" });
  }
  const normalized = markdown.endsWith("\n") ? markdown : `${markdown}\n`;
  if (LEGACY_AGENT_DEFAULTS.has(normalized)) {
    return Object.freeze({
      kind: "valid",
      state: Object.freeze({
        format: "static_default",
        templateId: null,
        habits: Object.freeze([])
      })
    });
  }
  return inspectLegacyPersonalityProjection(normalized);
}

export function legacyAgentBackupRelativePath(markdown: string): string {
  const digest = createHash("sha256").update(markdown, "utf8").digest("hex").slice(0, 24);
  return path.posix.join("agents", "echoink", "history", `AGENT-before-current-self-${digest}.md`);
}

function inspectLegacyPersonalityProjection(markdown: string): LegacyAgentMarkdownInspection {
  const lines = markdown.split("\n");
  let cursor = 0;
  const take = (expected: string): boolean => lines[cursor++] === expected;
  if (!take("# EchoInk Agent") || !take("")) {
    return Object.freeze({ kind: "invalid", reason: "unrecognized_legacy_agent" });
  }

  const templateLine = lines[cursor++] ?? "";
  let templateId: AgentTemplateId | null = null;
  if (templateLine === "> 人格由 EchoInk 依据有效长期 Memory 自动生成，不由用户直接编辑。") {
    templateId = null;
  } else {
    const match = /^> 初始模板：(.+?)。人格由 EchoInk 依据模板与有效长期 Memory 自动生成，不由用户直接编辑。$/u
      .exec(templateLine);
    const template = match
      ? AGENT_TEMPLATES.find((candidate) => candidate.labelZh === match[1])
      : null;
    if (!template) return Object.freeze({ kind: "invalid", reason: "legacy_agent_template" });
    templateId = template.id;
  }
  if (!take("")) return Object.freeze({ kind: "invalid", reason: "legacy_agent_header_structure" });
  let format: "personality_projection_v1" | "personality_projection_v2";
  let traitLine: RegExp;
  if (lines[cursor] === "## 身份") {
    format = "personality_projection_v2";
    traitLine = LEGACY_V2_TRAIT_LINE;
    cursor += 1;
    if (!take("")) return Object.freeze({ kind: "invalid", reason: "legacy_agent_identity_structure" });
    const nameLine = lines[cursor++] ?? "";
    if (!/^- 当前名称：[^\r\n]+$/u.test(nameLine)
      || !take("- 名称由用户在 EchoInk 设置中指定；人格与长期要求仍由模板和有效 Memory 自动生成。")
      || !take("")
      || !take("## 当前人格")
      || !take("")) {
      return Object.freeze({ kind: "invalid", reason: "legacy_agent_identity_structure" });
    }
  } else if (lines[cursor] === "## 当前人格") {
    format = "personality_projection_v1";
    traitLine = LEGACY_V1_TRAIT_LINE;
    cursor += 1;
    if (!take("")) return Object.freeze({ kind: "invalid", reason: "legacy_agent_v1_structure" });
  } else {
    return Object.freeze({ kind: "invalid", reason: "legacy_agent_projection_version" });
  }

  while (cursor < lines.length && lines[cursor] !== "") {
    if (!traitLine.test(lines[cursor])) {
      return Object.freeze({ kind: "invalid", reason: "legacy_agent_trait_line" });
    }
    cursor += 1;
  }
  if (!take("")) return Object.freeze({ kind: "invalid", reason: "legacy_agent_trait_structure" });

  const habits: AgentSelfHabit[] = [];
  if (lines[cursor] === "## 从长期协作中学到的要求") {
    cursor += 1;
    if (!take("")) return Object.freeze({ kind: "invalid", reason: "legacy_agent_habit_structure" });
    while (cursor < lines.length && lines[cursor] !== "") {
      const match = /^- ([^\r\n]+)$/u.exec(lines[cursor]);
      if (!match) return Object.freeze({ kind: "invalid", reason: "legacy_agent_habit_line" });
      try {
        habits.push(Object.freeze({ key: stableSelfKey(match[1]), text: match[1] }));
      } catch {
        return Object.freeze({ kind: "invalid", reason: "legacy_agent_habit_control_syntax" });
      }
      cursor += 1;
    }
    if (!take("")) return Object.freeze({ kind: "invalid", reason: "legacy_agent_habit_structure" });
  }

  if (!take("## 表达方式") || !take("")) {
    return Object.freeze({ kind: "invalid", reason: "legacy_agent_expression_structure" });
  }
  for (const line of LEGACY_PROJECTION_EXPRESSION) {
    if (!take(line)) return Object.freeze({ kind: "invalid", reason: "legacy_agent_expression_line" });
  }
  if (!take("") || cursor !== lines.length) {
    return Object.freeze({ kind: "invalid", reason: "legacy_agent_trailing_content" });
  }
  const keys = new Set<string>();
  for (const habit of habits) {
    if (keys.has(habit.key)) {
      return Object.freeze({ kind: "invalid", reason: "legacy_agent_habit_duplicate" });
    }
    keys.add(habit.key);
  }
  return Object.freeze({
    kind: "valid",
    state: Object.freeze({
      format,
      templateId,
      habits: Object.freeze(habits)
    })
  });
}

function parseLegacyRequirement(value: unknown): LegacyAgentRequirement | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || !raw.id) return null;
  if (typeof raw.text !== "string" || !raw.text.trim()) return null;
  if (raw.basis !== "explicit_memory" && raw.basis !== "observed_memory") return null;
  if (raw.status !== "current" && raw.status !== "superseded") return null;
  if (!Array.isArray(raw.sourceMemoryIds)
    || raw.sourceMemoryIds.some((id) => typeof id !== "string" || !id)) return null;
  if (!Number.isSafeInteger(raw.revision) || (raw.revision as number) < 0) return null;
  if (raw.reason !== undefined && typeof raw.reason !== "string") return null;
  return Object.freeze({
    id: raw.id,
    text: raw.text.trim(),
    basis: raw.basis,
    status: raw.status,
    sourceMemoryIds: Object.freeze([...new Set(raw.sourceMemoryIds as string[])]),
    revision: raw.revision as number,
    ...(typeof raw.reason === "string" ? { reason: raw.reason } : {})
  });
}
