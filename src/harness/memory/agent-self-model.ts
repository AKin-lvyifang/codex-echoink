import { sha256Hex } from "../../utils/sha256";
import type { AgentIdentityState } from "./agent-identity-model";
import { DEFAULT_AGENT_DISPLAY_NAME, normalizeAgentDisplayName } from "./agent-identity-model";
import type { AgentTemplate } from "./agent-templates";

export const AGENT_MD_HARD_MAX_BYTES = 64 * 1024;
export const USER_MD_HARD_MAX_BYTES = 128 * 1024;
export const CURRENT_SELF_START = "<!-- echoink:current-self:start -->";
export const CURRENT_SELF_END = "<!-- echoink:current-self:end -->";
export const EMPTY_HABITS_SENTINEL = "- 目前还没有需要长期保留的后天习惯。";

export interface AgentSelfHabit {
  readonly key: string;
  readonly text: string;
}

export interface AgentSelfState {
  readonly complexProblemMethod: string;
  readonly tone: string;
  readonly responseStructure: string;
  readonly currentLearnedHabits: readonly AgentSelfHabit[];
}

export interface PublicAgentSelfProfile {
  readonly thinkingMethod: string;
  readonly answerTone: string;
  readonly answerStructure: string;
  readonly representativeHabits: readonly string[];
}

export type AgentSelfBaseField =
  | "complex_problem_method"
  | "tone"
  | "response_structure";

export type AgentSelfOperation =
  | Readonly<{ operation: "replace"; field: AgentSelfBaseField; value: string }>
  | Readonly<{ operation: "habit_add"; key?: string; text: string }>
  | Readonly<{ operation: "habit_replace"; key: string; text: string }>
  | Readonly<{ operation: "habit_retire"; key: string }>;

export type AgentSelfParseResult =
  | Readonly<{ kind: "ok"; state: AgentSelfState; start: number; end: number }>
  | Readonly<{ kind: "missing" | "invalid"; reason: string }>;

const FIELD_HEADINGS = Object.freeze([
  "## 我怎样处理问题",
  "## 我怎样回答",
  "## 我怎样与你相处",
  "## 我在长期相处中形成的习惯"
]);
const HABIT_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const RESERVED_SELF_SYNTAX = Object.freeze([
  CURRENT_SELF_START,
  CURRENT_SELF_END,
  "<!-- echoink:",
  ...FIELD_HEADINGS
]);
const ADAPTIVE_LANGUAGE_RULE = "我会默默参考 USER.md 和你当前的表达，调整术语、信息密度和例子。我不预设你已经掌握专业术语，但预设你有很强的理解和学习能力。如果回答依赖你可能不熟悉的知识，我会先用大白话说明，再给一个简单例子。";
const COLLABORATION_RULES = Object.freeze([
  "我不会为了配合你而默认你的判断一定正确。发现会实质影响结果的前提或方案问题时，我会说明顾虑、依据和更好的做法。",
  "如果你现在的要求与过去明确表达的选择不同，并且差异会影响本次结果或今后的长期协作，我会提醒你，并询问这是本次例外还是长期改变。",
  "如果过去只是我对你的推测，我会以你当前明确的话为准，不把自己的理解冒充你的承诺。",
  "如果一件事和我一贯坚持的重要原则有实质冲突，我会坦白顾虑并提出更好的做法。你考虑以后仍决定继续，我会按你的决定来；这次例外不会影响我平时的处事原则。"
]);

function oneLine(value: string, name: string): string {
  if (/[\r\n\u2028\u2029]/u.test(value)
    || RESERVED_SELF_SYNTAX.some((syntax) => value.includes(syntax))) {
    throw new Error(`agent_self_invalid:${name}_control_syntax`);
  }
  const normalized = value.replaceAll(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > 2_000) {
    throw new Error(`agent_self_invalid:${name}`);
  }
  return normalized.replace(/[。；;]+$/u, "");
}

export function stableSelfKey(value: string): string {
  if (/[\r\n\u2028\u2029]/u.test(value)
    || RESERVED_SELF_SYNTAX.some((syntax) => value.includes(syntax))) {
    throw new Error("agent_self_invalid:habit_key_control_syntax");
  }
  const canonical = value.normalize("NFKC").toLocaleLowerCase("en-US")
    .replaceAll(/\s+/gu, " ")
    .trim();
  const hasNonAsciiWord = Array.from(canonical).some((character) => character.charCodeAt(0) > 0x7f);
  const ascii = canonical
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 48)
    .replaceAll(/-+$/gu, "");
  if (!hasNonAsciiWord && ascii && HABIT_KEY.test(ascii)) return ascii;
  return `h-${sha256Hex(canonical).slice(0, 16)}`;
}

export function normalizeAgentSelf(input: AgentSelfState): AgentSelfState {
  const habits: AgentSelfHabit[] = [];
  const habitKeys = new Set<string>();
  for (const habit of input.currentLearnedHabits) {
    const text = oneLine(habit.text, "habit");
    const key = habit.key || stableSelfKey(text);
    if (!HABIT_KEY.test(key) || key.length > 48) {
      throw new Error("agent_self_invalid:habit_key");
    }
    if (habitKeys.has(key)) throw new Error("agent_self_invalid:habit_key_duplicate");
    habitKeys.add(key);
    habits.push(Object.freeze({ key, text }));
  }
  return Object.freeze({
    complexProblemMethod: oneLine(input.complexProblemMethod, "complex_problem_method"),
    tone: oneLine(input.tone, "tone"),
    responseStructure: oneLine(input.responseStructure, "response_structure"),
    currentLearnedHabits: Object.freeze(habits)
  });
}

export function agentSelfFromTemplate(template: AgentTemplate, habits: readonly AgentSelfHabit[] = []): AgentSelfState {
  return normalizeAgentSelf({
    complexProblemMethod: template.complexProblemMethod,
    tone: template.tone,
    responseStructure: template.responseStructure,
    currentLearnedHabits: habits
  });
}

export function applyAgentSelfOperations(
  currentInput: AgentSelfState,
  operations: readonly AgentSelfOperation[]
): AgentSelfState {
  if (operations.length === 0) throw new Error("agent_self_operation_empty");
  const current = normalizeAgentSelf(currentInput);
  const next = {
    complexProblemMethod: current.complexProblemMethod,
    tone: current.tone,
    responseStructure: current.responseStructure,
    currentLearnedHabits: [...current.currentLearnedHabits]
  };
  const touched = new Set<string>();
  for (const operation of operations) {
    if (operation.operation === "replace") {
      const target = `field:${operation.field}`;
      if (touched.has(target)) throw new Error("agent_self_operation_duplicate_target");
      touched.add(target);
      const value = oneLine(operation.value, operation.field);
      if (operation.field === "complex_problem_method") next.complexProblemMethod = value;
      else if (operation.field === "tone") next.tone = value;
      else next.responseStructure = value;
      continue;
    }

    const key = operation.operation === "habit_add"
      ? stableSelfKey(operation.key || operation.text)
      : operation.key;
    if (!HABIT_KEY.test(key) || key.length > 48) throw new Error("agent_self_invalid:habit_key");
    const target = `habit:${key}`;
    if (touched.has(target)) throw new Error("agent_self_operation_duplicate_target");
    touched.add(target);
    const index = next.currentLearnedHabits.findIndex((habit) => habit.key === key);
    if (operation.operation === "habit_add") {
      if (index >= 0) throw new Error("agent_self_habit_already_exists");
      next.currentLearnedHabits.push(Object.freeze({ key, text: oneLine(operation.text, "habit") }));
    } else if (operation.operation === "habit_replace") {
      if (index < 0) throw new Error("agent_self_habit_not_found");
      next.currentLearnedHabits[index] = Object.freeze({
        key,
        text: oneLine(operation.text, "habit")
      });
    } else {
      if (index < 0) throw new Error("agent_self_habit_not_found");
      next.currentLearnedHabits.splice(index, 1);
    }
  }
  return normalizeAgentSelf(next);
}

export function renderCurrentSelfBlock(stateInput: AgentSelfState): string {
  const state = normalizeAgentSelf(stateInput);
  const habitLines = state.currentLearnedHabits.length > 0
    ? state.currentLearnedHabits.map((habit) => `- <!-- echoink:habit:${habit.key} --> ${habit.text}`)
    : [EMPTY_HABITS_SENTINEL];
  const block = [
    CURRENT_SELF_START,
    "## 我怎样处理问题",
    "",
    `遇到重要或复杂的问题时，我会：${state.complexProblemMethod}。`,
    "",
    "## 我怎样回答",
    "",
    `我的语气是：${state.tone}。`,
    "",
    `我的回答通常会：${state.responseStructure}。`,
    "",
    ADAPTIVE_LANGUAGE_RULE,
    "",
    "## 我怎样与你相处",
    "",
    COLLABORATION_RULES[0],
    "",
    COLLABORATION_RULES[1],
    "",
    COLLABORATION_RULES[2],
    "",
    COLLABORATION_RULES[3],
    "",
    "## 我在长期相处中形成的习惯",
    "",
    ...habitLines,
    CURRENT_SELF_END
  ].join("\n");
  const parsed = parseAgentCurrentSelf(block);
  if (parsed.kind !== "ok") throw new Error(`agent_self_round_trip_failed:${parsed.reason}`);
  return block;
}

export function renderAgentMarkdown(input: Readonly<{
  identity?: AgentIdentityState | null;
  styleName: string;
  self: AgentSelfState;
}>): string {
  const displayName = normalizeAgentDisplayName(input.identity?.displayName ?? "")
    ?? DEFAULT_AGENT_DISPLAY_NAME;
  const text = [
    `# ${displayName}`,
    "",
    "## 我是谁",
    "",
    `我的名字是 ${displayName}。`,
    "",
    `我的初始风格来自「${input.styleName}」。`,
    "",
    renderCurrentSelfBlock(input.self),
    ""
  ].join("\n");
  assertUtf8HardLimit(text, AGENT_MD_HARD_MAX_BYTES, "AGENT.md");
  const parsed = parseAgentCurrentSelf(text);
  if (parsed.kind !== "ok") throw new Error(`agent_self_round_trip_failed:${parsed.reason}`);
  return text;
}

export function parseAgentCurrentSelf(markdown: string): AgentSelfParseResult {
  if (new TextEncoder().encode(markdown).length > AGENT_MD_HARD_MAX_BYTES) {
    return { kind: "invalid", reason: "agent_md_utf8_limit" };
  }
  const starts = markdown.split(CURRENT_SELF_START).length - 1;
  const ends = markdown.split(CURRENT_SELF_END).length - 1;
  if (starts === 0 && ends === 0) return { kind: "missing", reason: "current_self_missing" };
  if (starts !== 1 || ends !== 1) return { kind: "invalid", reason: "current_self_marker_count" };
  const start = markdown.indexOf(CURRENT_SELF_START);
  const endMarker = markdown.indexOf(CURRENT_SELF_END);
  if (endMarker <= start) return { kind: "invalid", reason: "current_self_marker_order" };
  const end = endMarker + CURRENT_SELF_END.length;
  const block = markdown.slice(start, end);
  const positions = FIELD_HEADINGS.map((heading) => ({
    heading,
    count: block.split(heading).length - 1,
    index: block.indexOf(heading)
  }));
  if (positions.some((item) => item.count !== 1)
    || positions.some((item, index) => index > 0 && item.index <= positions[index - 1].index)) {
    return { kind: "invalid", reason: "current_self_field_structure" };
  }
  const sectionLines = (index: number): string[] => {
    const from = positions[index].index + positions[index].heading.length;
    const to = index + 1 < positions.length ? positions[index + 1].index : block.indexOf(CURRENT_SELF_END);
    return block.slice(from, to).split("\n").map((line) => line.trim()).filter(Boolean);
  };
  const complexLines = sectionLines(0);
  const answerLines = sectionLines(1);
  const collaborationLines = sectionLines(2);
  const complex = complexLines.length === 1
    ? /^遇到重要或复杂的问题时，我会：(.+?)。$/u.exec(complexLines[0])?.[1]
    : undefined;
  const tone = answerLines.length === 3 && answerLines[2] === ADAPTIVE_LANGUAGE_RULE
    ? /^我的语气是：(.+?)。$/u.exec(answerLines[0])?.[1]
    : undefined;
  const structure = answerLines.length === 3 && answerLines[2] === ADAPTIVE_LANGUAGE_RULE
    ? /^我的回答通常会：(.+?)。$/u.exec(answerLines[1])?.[1]
    : undefined;
  if (!complex || !tone || !structure) return { kind: "invalid", reason: "current_self_field_value" };
  if (collaborationLines.length !== COLLABORATION_RULES.length
    || collaborationLines.some((line, index) => line !== COLLABORATION_RULES[index])) {
    return { kind: "invalid", reason: "current_self_shared_rules" };
  }
  const habitsSection = sectionLines(3);
  const habits: AgentSelfHabit[] = [];
  const habitKeys = new Set<string>();
  const habitLines = habitsSection;
  if (habitLines.length === 1 && habitLines[0] === EMPTY_HABITS_SENTINEL) {
    // The only accepted empty-list representation.
  } else {
    if (habitLines.length === 0 || habitLines.includes(EMPTY_HABITS_SENTINEL)) {
      return { kind: "invalid", reason: "current_self_habit_sentinel" };
    }
    for (const line of habitLines) {
      const match = /^- <!-- echoink:habit:([a-z0-9]+(?:-[a-z0-9]+)*) --> (.+)$/u.exec(line);
      if (!match || match[1].length > 48) {
        return { kind: "invalid", reason: "current_self_habit_line" };
      }
      if (habitKeys.has(match[1])) {
        return { kind: "invalid", reason: "current_self_habit_duplicate" };
      }
      habitKeys.add(match[1]);
      habits.push(Object.freeze({ key: match[1], text: match[2] }));
    }
  }
  try {
    return Object.freeze({
      kind: "ok" as const,
      state: normalizeAgentSelf({
        complexProblemMethod: complex,
        tone,
        responseStructure: structure,
        currentLearnedHabits: habits
      }),
      start,
      end
    });
  } catch {
    return { kind: "invalid", reason: "current_self_normalization" };
  }
}

export function replaceAgentCurrentSelf(markdown: string, next: AgentSelfState): string {
  const parsed = parseAgentCurrentSelf(markdown);
  if (parsed.kind !== "ok") throw new Error(`agent_self_update_blocked:${parsed.reason}`);
  const updated = `${markdown.slice(0, parsed.start)}${renderCurrentSelfBlock(next)}${markdown.slice(parsed.end)}`;
  assertUtf8HardLimit(updated, AGENT_MD_HARD_MAX_BYTES, "AGENT.md");
  const reparsed = parseAgentCurrentSelf(updated);
  if (reparsed.kind !== "ok") throw new Error(`agent_self_round_trip_failed:${reparsed.reason}`);
  return updated;
}

export function renderBaseAgentMarkdown(markdown: string): string {
  const parsed = parseAgentCurrentSelf(markdown);
  if (parsed.kind !== "ok") throw new Error(`agent_self_read_blocked:${parsed.reason}`);
  return replaceAgentCurrentSelf(markdown, {
    ...parsed.state,
    currentLearnedHabits: Object.freeze([])
  });
}

export function publicAgentSelfProfile(state: AgentSelfState): PublicAgentSelfProfile {
  const normalized = normalizeAgentSelf(state);
  return Object.freeze({
    thinkingMethod: `我处理重要或复杂问题的方式是：${normalized.complexProblemMethod}。`,
    answerTone: `我的语气会保持${normalized.tone}。`,
    answerStructure: `我的回答通常会按${normalized.responseStructure}来组织。`,
    representativeHabits: Object.freeze(
      normalized.currentLearnedHabits.slice(0, 3).map((habit) => publicHabitNarration(habit.text))
    )
  });
}

function publicHabitNarration(value: string): string {
  const habit = value.trim();
  const withoutTrailingPause = habit.replace(/[，、；;：:]+$/u, "");
  return /[。！？!?]$/u.test(withoutTrailingPause)
    ? withoutTrailingPause
    : `${withoutTrailingPause}。`;
}

export function assertUtf8HardLimit(value: string, maxBytes: number, name: string): void {
  const bytes = new TextEncoder().encode(value).length;
  if (bytes > maxBytes) throw new Error(`${name}_utf8_limit_exceeded:${bytes}:${maxBytes}`);
}
