import type { ContextSection } from "../../../harness/contracts/context";

export interface CoreKnowledgePolicyRule {
  id: string;
  title: string;
  body: string;
}

export interface CoreKnowledgePolicy {
  id: string;
  version: number;
  rules: CoreKnowledgePolicyRule[];
}

export const CORE_KNOWLEDGE_POLICY: CoreKnowledgePolicy = {
  id: "echoink-core-knowledge-policy",
  version: 1,
  rules: [
    {
      id: "raw-source-readonly",
      title: "Raw source is read-only for agents",
      body: "Raw 正文、标题、路径、附件和来源内容不能由 Agent 改写、移动、重命名、删除或格式化。只有 EchoInk 后处理可以写入托管元属性。"
    },
    {
      id: "allowed-write-roots",
      title: "Knowledge writes stay inside allowed roots",
      body: "自动知识库任务只能写入 wiki、projects、outputs、inbox 和必要索引。journal、work、templates、testing、assets 默认不纳入自动整理。"
    },
    {
      id: "evidence-required",
      title: "Evidence is required for digest completion",
      body: "Raw 被视为已提炼，必须在 wiki 或 projects 非索引正文页留下来源链接和附近实质内容。报告、tracker 或索引不能替代正文证据。"
    },
    {
      id: "transaction-required",
      title: "Transaction and rollback are mandatory",
      body: "Knowledge 写入必须经过快照、验证、提交或回滚。Raw 越权变化和证据验证失败必须阻止成功提交。"
    },
    {
      id: "check-is-readonly",
      title: "Check is read-only",
      body: "/check 只体检，不提炼，不写 Raw 托管属性，不写 wiki/projects 正文，不更新 tracker。"
    },
    {
      id: "calibrate-is-deterministic",
      title: "Calibrate raw is deterministic",
      body: "/calibrate raw 由确定性代码完成，不调用 Agent 判断业务状态。"
    },
    {
      id: "agent-final-text-not-success-source",
      title: "Agent final text is not business state",
      body: "Agent 最终文本不能决定业务成功。成功状态、进度、报告路径、processedSources、tracker 和回滚结果必须来自 EchoInk 代码、Ledger 和 Validator。"
    }
  ]
};

export function coreKnowledgePolicySections(policy = CORE_KNOWLEDGE_POLICY): ContextSection[] {
  return policy.rules.map((rule, index) => ({
    id: `core-policy:${rule.id}`,
    priority: 10_000 - index,
    channel: "system",
    content: `${rule.title}\n${rule.body}`,
    source: policy.id,
    required: true,
    sensitive: false
  }));
}
