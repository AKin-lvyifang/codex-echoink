import type { HarnessWorkflow, MemoryPolicy } from "../contracts/run";

export type MemoryCaptureMode = "none" | "signal" | "workflow-result";
export type MemorySyncGate = "never" | "run-terminal" | "local-commit";

export interface MemoryWorkflowPolicy {
  read: boolean;
  capture: MemoryCaptureMode;
  sync: MemorySyncGate;
}

const DISABLED_POLICY: MemoryWorkflowPolicy = { read: false, capture: "none", sync: "never" };
const SIGNAL_POLICY: MemoryWorkflowPolicy = { read: true, capture: "signal", sync: "run-terminal" };
const WORKFLOW_RESULT_POLICY: MemoryWorkflowPolicy = { read: false, capture: "workflow-result", sync: "local-commit" };

const POLICIES: Partial<Record<HarnessWorkflow, MemoryWorkflowPolicy>> = {
  "chat.generic": SIGNAL_POLICY,
  "knowledge.ask": SIGNAL_POLICY,
  "knowledge.maintain": WORKFLOW_RESULT_POLICY,
  "knowledge.reingest": WORKFLOW_RESULT_POLICY,
  "knowledge.calibrate": WORKFLOW_RESULT_POLICY,
  "knowledge.outputs": WORKFLOW_RESULT_POLICY,
  "knowledge.inbox": WORKFLOW_RESULT_POLICY,
  "knowledge.journal": WORKFLOW_RESULT_POLICY,
  "knowledge.check": DISABLED_POLICY,
  "prompt.enhance": DISABLED_POLICY,
  "editor.rewrite": DISABLED_POLICY,
  "editor.expand": DISABLED_POLICY,
  "editor.continue": DISABLED_POLICY,
  "editor.translate": DISABLED_POLICY,
  "review.weekly": DISABLED_POLICY,
  "memory.curate": DISABLED_POLICY
};

export function memoryWorkflowPolicy(workflow: HarnessWorkflow | string): MemoryWorkflowPolicy {
  return POLICIES[workflow as HarnessWorkflow] ?? DISABLED_POLICY;
}

export function memoryRequestPolicy(workflow: HarnessWorkflow | string, maxReadItems = 8): MemoryPolicy {
  const policy = memoryWorkflowPolicy(workflow);
  return {
    enabled: policy.read || policy.capture !== "none",
    maxItems: policy.read ? Math.max(0, maxReadItems) : 0
  };
}

export function hasExplicitMemorySignal(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  return /(?:请|帮我)?记住|长期记忆|以后(?:都|默认|请)|下次(?:继续|记得)|(?:用户)?偏好\s*[:：]|(?:决定|决策|约束|限制|工作流规则|规则|当前状态|任务状态|进度|待办|下一步|未完成|经验|教训)\s*[:：]/i.test(normalized);
}
