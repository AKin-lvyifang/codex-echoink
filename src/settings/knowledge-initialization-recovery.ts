import type {
  KnowledgeInitializationJob,
  KnowledgeInitializationProviderSnapshot
} from "../knowledge-base/initializer";

/**
 * 暂停/冲突态的恢复方式。完全由结构化字段派生（job.status、两个 digest、
 * job 内 Provider 快照与当前 Provider），禁止解析 lastError 中文字符串：
 *
 * - continue：cancelled / failed_recoverable / write_uncertain / paused，
 *   且 digest 一致、Provider 未变化 —— 直接调用现有 continue API。
 * - recheck-conflict：blocked_conflict —— 禁止「继续初始化」（必然失败），
 *   只能重新扫描检查冲突（推荐模式重扫后确认；自定义模式回到可修改 preview）。
 * - recheck-preview：Provider 缺失/变化，或 confirmedDigest 与 planDigest
 *   不一致 —— 不能直接 continueJob()，必须重新生成 preview 再确认。
 */
export type KnowledgeInitializationRecoveryKind =
  | "continue"
  | "recheck-conflict"
  | "recheck-preview";

export interface KnowledgeInitializationRecoveryInput {
  readonly job: Pick<
    KnowledgeInitializationJob,
    "status" | "mode" | "confirmedDigest" | "planDigest" | "provider" | "extractionQueue"
  >;
  /** 当前设置派生出的可用 Provider 快照；没有可用 Provider 时为 null。 */
  readonly currentProvider: KnowledgeInitializationProviderSnapshot | null;
}

export interface KnowledgeInitializationRecovery {
  readonly kind: KnowledgeInitializationRecoveryKind;
  /** digest 不一致（含从未确认）。 */
  readonly digestMismatch: boolean;
  /** Provider 快照变化，或待提炼队列非空但当前没有可用 Provider。 */
  readonly providerOutdated: boolean;
}

function providerKey(provider: KnowledgeInitializationProviderSnapshot | null): string {
  return provider ? `${provider.providerId}\u0000${provider.model}` : "";
}

export function deriveKnowledgeInitializationRecovery(
  input: KnowledgeInitializationRecoveryInput
): KnowledgeInitializationRecovery {
  const { job, currentProvider } = input;
  const digestMismatch =
    job.confirmedDigest === null || job.confirmedDigest !== job.planDigest;
  const providerChanged = providerKey(currentProvider) !== providerKey(job.provider);
  const providerMissing = job.extractionQueue.length > 0 && currentProvider === null;
  const providerOutdated = providerChanged || providerMissing;

  if (job.status === "blocked_conflict") {
    return { kind: "recheck-conflict", digestMismatch, providerOutdated };
  }
  if (digestMismatch) {
    return { kind: "recheck-preview", digestMismatch, providerOutdated };
  }
  return { kind: "continue", digestMismatch, providerOutdated };
}
