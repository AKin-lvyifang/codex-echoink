import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import {
  applyShadowChangeSet,
  cleanupMaintenanceShadowVault,
  loadMaintenanceShadowChangeSet,
  markMaintenanceShadowCommittedFromJournal,
  recoverMaintenanceShadowApplyTransactions,
  type MaintenanceShadowChangeSet,
  type MaintenanceShadowHandle
} from "../harness/maintenance/shadow-vault";
import {
  applyMaintenanceWorkflowManagedWrites,
  commitMaintenanceWorkflowSettingsDurably,
  confirmMaintenanceWorkflowNoop,
  confirmMaintenanceWorkflowShadowCommitted,
  createMaintenanceWorkflowNoopProof,
  finalizeMaintenanceWorkflowWal,
  listMaintenanceWorkflowWals,
  loadMaintenanceWorkflowWal,
  prepareMaintenanceWorkflowWal,
  removeFinalizedMaintenanceWorkflowWal,
  type LoadedMaintenanceWorkflowWal,
  type MaintenanceWorkflowManagedWriteDraft,
  type MaintenanceWorkflowSettingsHost,
  type MaintenanceWorkflowSettingsSnapshot,
  type MaintenanceWorkflowSourceRecord,
  type MaintenanceWorkflowWalHandle,
  type MaintenanceWorkflowWalIntent,
  type MaintenanceWorkflowWalIntentDraft,
  type MaintenanceWorkflowWalState
} from "../harness/maintenance/workflow-wal";

export type MaintenanceWorkflowBaseIntentDraft = Omit<
  MaintenanceWorkflowWalIntentDraft,
  "shadow" | "noopProof"
>;

export type MaintenanceWorkflowCoordinatorFaultPoint =
  | "after-prepare"
  | "after-shadow-apply"
  | "after-shadow-confirm"
  | "after-managed-commit"
  | "after-settings-commit"
  | "after-finalize"
  | "before-wal-remove";

export interface MaintenanceWorkflowShadowOutcome {
  kind: "shadow";
  changeSet: MaintenanceShadowChangeSet;
  /**
   * Exact sealed changes selected for commit. Omit to select the entire
   * changeset. The coordinator derives the durable selection digest itself.
   */
  allowPaths?: readonly string[];
}

export interface MaintenanceWorkflowNoopOutcome {
  kind: "noop";
  discoveredSources: MaintenanceWorkflowSourceRecord[];
  changedSources: MaintenanceWorkflowSourceRecord[];
}

export type MaintenanceWorkflowCommitOutcome =
  | MaintenanceWorkflowShadowOutcome
  | MaintenanceWorkflowNoopOutcome;

export interface PrepareAndCommitMaintenanceWorkflowInput<
  T extends MaintenanceWorkflowSettingsSnapshot
> {
  storageRootPath: string;
  liveVaultPath: string;
  draft: MaintenanceWorkflowBaseIntentDraft;
  managedWrites: MaintenanceWorkflowManagedWriteDraft[];
  outcome: MaintenanceWorkflowCommitOutcome;
  settingsHost: MaintenanceWorkflowSettingsHost<T>;
  faultInjector?: (
    point: MaintenanceWorkflowCoordinatorFaultPoint
  ) => void | Promise<void>;
}

export interface ResumeMaintenanceWorkflowInput<
  T extends MaintenanceWorkflowSettingsSnapshot
> {
  handle: MaintenanceWorkflowWalHandle;
  liveVaultPath: string;
  settingsHost: MaintenanceWorkflowSettingsHost<T>;
  faultInjector?: (
    point: MaintenanceWorkflowCoordinatorFaultPoint
  ) => void | Promise<void>;
}

export interface MaintenanceWorkflowCommitResult {
  handle: MaintenanceWorkflowWalHandle;
  intent: MaintenanceWorkflowWalIntent;
  state: MaintenanceWorkflowWalState;
  shadowAppliedPaths: string[];
  managedAppliedPaths: string[];
  settingsChanged: boolean;
  walRemoved: true;
}

export interface RecoverPendingMaintenanceWorkflowsInput<
  T extends MaintenanceWorkflowSettingsSnapshot
> {
  storageRootPath: string;
  liveVaultPath: string;
  settingsHost: MaintenanceWorkflowSettingsHost<T>;
}

export interface RecoverPendingMaintenanceWorkflowsResult {
  recovered: number;
  blocked: number;
  invalid: number;
  issues: string[];
}

/**
 * The WAL core creates its own control subdirectory. Its storage root must be
 * the shared per-Vault Shadow root so every intent can prove that its Shadow
 * control directory is a descendant of the same trusted root.
 */
export function maintenanceWorkflowStorageRoot(
  maintenanceShadowStorageRootPath: string
): string {
  return path.resolve(maintenanceShadowStorageRootPath);
}

export function maintenanceShadowStorageRootForVault(
  liveVaultPath: string
): string {
  const vaultToken = createHash("sha256")
    .update(path.resolve(liveVaultPath))
    .digest("hex")
    .slice(0, 24);
  return path.join(
    homedir(),
    ".codex-echoink",
    "maintenance-shadows",
    vaultToken
  );
}

export function maintenanceWorkflowStorageRootForVault(
  liveVaultPath: string
): string {
  return maintenanceWorkflowStorageRoot(
    maintenanceShadowStorageRootForVault(liveVaultPath)
  );
}

/**
 * Publishes the immutable workflow intent before the first live-Vault write,
 * then delegates every remaining phase to the replayable coordinator.
 */
export async function prepareAndCommitMaintenanceWorkflow<
  T extends MaintenanceWorkflowSettingsSnapshot
>(
  input: PrepareAndCommitMaintenanceWorkflowInput<T>
): Promise<MaintenanceWorkflowCommitResult> {
  const draft = await materializeWorkflowDraft(
    input.liveVaultPath,
    input.draft,
    input.outcome
  );
  const storageRootPath = await realpath(input.storageRootPath);
  const prepared = await prepareMaintenanceWorkflowWal({
    storageRootPath,
    draft,
    managedWrites: input.managedWrites
  });
  await input.faultInjector?.("after-prepare");
  return await resumeMaintenanceWorkflow({
    handle: prepared.handle,
    liveVaultPath: input.liveVaultPath,
    settingsHost: input.settingsHost,
    faultInjector: input.faultInjector
  });
}

/**
 * Replays exactly the winner and immutable commit plan already sealed in the
 * WAL. It never invokes Agent routing, readiness checks, or discovery.
 */
export async function resumeMaintenanceWorkflow<
  T extends MaintenanceWorkflowSettingsSnapshot
>(
  input: ResumeMaintenanceWorkflowInput<T>
): Promise<MaintenanceWorkflowCommitResult> {
  let loaded = await loadMaintenanceWorkflowWal(input.handle);
  const intent = loaded.intent;
  let settingsChanged = false;

  if (loaded.state.blocked) {
    throw new Error(
      `workflow WAL 已阻断：${loaded.state.blocked.code} ${loaded.state.blocked.message}`
    );
  }

  if (loaded.state.phase === "prepared") {
    if (intent.completion === "noop") {
      if (!intent.noopProof) {
        throw new Error("noop workflow 缺少 durable proof");
      }
      await confirmMaintenanceWorkflowNoop(
        loaded.handle,
        input.liveVaultPath,
        intent.noopProof
      );
    } else {
      const changeSet = await loadWorkflowShadowChangeSet(intent);
      const applied = await applyShadowChangeSet(
        input.liveVaultPath,
        changeSet,
        { allowPaths: intent.shadow?.allowPaths }
      );
      if (!applied.commitReceipt) {
        throw new Error("Shadow apply 未返回 durable commit receipt");
      }
      assertSamePathSet(
        applied.appliedPaths,
        intent.shadow?.expectedAppliedPaths ?? [],
        "Shadow applied paths"
      );
      assertSamePathSet(
        applied.skippedPaths,
        intent.shadow?.skippedPaths ?? [],
        "Shadow skipped paths"
      );
      await input.faultInjector?.("after-shadow-apply");
      await confirmMaintenanceWorkflowShadowCommitted(
        loaded.handle,
        input.liveVaultPath,
        {
          changeSetDigest: changeSet.digest,
          selectionDigest: intent.shadow!.selectionDigest,
          appliedPaths: applied.appliedPaths
        }
      );
    }
    await input.faultInjector?.("after-shadow-confirm");
    loaded = await loadMaintenanceWorkflowWal(loaded.handle);
  }

  if (loaded.state.phase === "shadow_committed") {
    await applyMaintenanceWorkflowManagedWrites(
      loaded.handle,
      input.liveVaultPath
    );
    await input.faultInjector?.("after-managed-commit");
    loaded = await loadMaintenanceWorkflowWal(loaded.handle);
  }

  if (loaded.state.phase === "managed_committed") {
    const committed = await commitMaintenanceWorkflowSettingsDurably(
      loaded.handle,
      input.liveVaultPath,
      input.settingsHost
    );
    settingsChanged = committed.changed;
    await input.faultInjector?.("after-settings-commit");
    loaded = await loadMaintenanceWorkflowWal(loaded.handle);
  }

  if (loaded.state.phase === "settings_committed") {
    await finalizeMaintenanceWorkflowWal(
      loaded.handle,
      input.liveVaultPath,
      async (finalIntent) => {
        if (!finalIntent.shadow || !finalIntent.winner) return;
        const shadowHandle = maintenanceShadowHandleFromIntent(finalIntent);
        const shadowPaths = new Set(
          finalIntent.shadow.expectedAppliedPaths
        );
        await markMaintenanceShadowCommittedFromJournal(
          shadowHandle,
          input.liveVaultPath,
          {
            overriddenTargets: finalIntent.managedWrites
              .filter((write) => shadowPaths.has(write.relativePath))
              .map((write) => ({
                relativePath: write.relativePath,
                expected: write.expected,
                desired: write.desired
              }))
          }
        );
        await cleanupMaintenanceShadowVault(shadowHandle);
      },
      { settingsHost: input.settingsHost }
    );
    await input.faultInjector?.("after-finalize");
    loaded = await loadMaintenanceWorkflowWal(loaded.handle);
  }

  if (loaded.state.phase !== "finalized") {
    throw new Error(
      `workflow WAL 未到达 finalized：${loaded.state.phase}`
    );
  }

  const result: MaintenanceWorkflowCommitResult = {
    handle: loaded.handle,
    intent,
    state: loaded.state,
    shadowAppliedPaths: intent.shadow?.expectedAppliedPaths ?? [],
    managedAppliedPaths: intent.managedWrites.map(
      (write) => write.relativePath
    ),
    settingsChanged,
    walRemoved: true
  };
  await input.faultInjector?.("before-wal-remove");
  await removeFinalizedMaintenanceWorkflowWal(loaded.handle);
  return result;
}

/**
 * Startup/reload gate. Invalid or explicitly blocked intents prevent all
 * automatic replay. Otherwise ready intents replay oldest-first and never
 * re-enter Agent routing.
 */
export async function recoverPendingMaintenanceWorkflows<
  T extends MaintenanceWorkflowSettingsSnapshot
>(
  input: RecoverPendingMaintenanceWorkflowsInput<T>
): Promise<RecoverPendingMaintenanceWorkflowsResult> {
  await mkdir(input.storageRootPath, {
    recursive: true,
    mode: 0o700
  });
  const storageRootPath = await realpath(input.storageRootPath);
  const listed = await listMaintenanceWorkflowWals(storageRootPath);
  const result: RecoverPendingMaintenanceWorkflowsResult = {
    recovered: 0,
    blocked: 0,
    invalid: 0,
    issues: []
  };
  const ready: LoadedMaintenanceWorkflowWal[] = [];

  for (const entry of listed) {
    if (entry.status === "invalid") {
      result.invalid += 1;
      result.issues.push(
        `${entry.location.runToken}: ${entry.error}`
      );
      continue;
    }
    if (entry.status === "blocked") {
      result.blocked += 1;
      result.issues.push(
        `${entry.wal.intent.workflowRunId}: ${entry.wal.state.blocked?.message ?? "workflow WAL blocked"}`
      );
      continue;
    }
    ready.push(entry.wal);
  }

  if (result.blocked > 0 || result.invalid > 0) return result;

  ready.sort((left, right) =>
    left.intent.startedAt - right.intent.startedAt
    || left.intent.workflowRunId.localeCompare(right.intent.workflowRunId)
  );
  for (const wal of ready) {
    try {
      await resumeMaintenanceWorkflow({
        handle: wal.handle,
        liveVaultPath: input.liveVaultPath,
        settingsHost: input.settingsHost
      });
      result.recovered += 1;
    } catch (error) {
      result.blocked += 1;
      result.issues.push(
        `${wal.intent.workflowRunId}: ${errorMessage(error)}`
      );
      break;
    }
  }
  if (result.blocked === 0 && result.invalid === 0) {
    await recoverMaintenanceShadowApplyTransactions(
      input.liveVaultPath,
      storageRootPath
    );
  }
  return result;
}

async function materializeWorkflowDraft(
  liveVaultPath: string,
  base: MaintenanceWorkflowBaseIntentDraft,
  outcome: MaintenanceWorkflowCommitOutcome
): Promise<MaintenanceWorkflowWalIntentDraft> {
  if (outcome.kind === "noop") {
    if (
      base.completion !== "noop"
      || base.winner !== null
      || base.attempts.length !== 0
    ) {
      throw new Error("noop workflow 必须是零 Agent、零 winner");
    }
    const noopProof = await createMaintenanceWorkflowNoopProof({
      liveVaultPath,
      discoveredSources: outcome.discoveredSources,
      changedSources: outcome.changedSources
    });
    return {
      ...base,
      shadow: null,
      noopProof
    };
  }

  if (
    base.completion === "noop"
    || !base.winner
    || base.winner.attemptId !== outcome.changeSet.attemptId
  ) {
    throw new Error("Shadow workflow winner 与 sealed changeset 不匹配");
  }
  const selection = selectShadowPaths(
    outcome.changeSet,
    outcome.allowPaths
  );
  if (selection.expectedAppliedPaths.length === 0) {
    throw new Error("非 noop workflow 缺少可提交的 Shadow 路径");
  }
  return {
    ...base,
    shadow: {
      controlRootPath: await realpath(outcome.changeSet.controlRootPath),
      changeSetDigest: outcome.changeSet.digest,
      selectionDigest: digestJson(selection.selectionOrder),
      liveVaultFingerprint: outcome.changeSet.liveVaultFingerprint,
      allowPaths: selection.expectedAppliedPaths,
      expectedAppliedPaths: selection.expectedAppliedPaths,
      skippedPaths: selection.skippedPaths
    }
  };
}

function selectShadowPaths(
  changeSet: MaintenanceShadowChangeSet,
  allowPaths: readonly string[] | undefined
): {
  selectionOrder: string[];
  expectedAppliedPaths: string[];
  skippedPaths: string[];
} {
  const allPaths = changeSet.changes.map((change) => change.relativePath);
  const selectedSet = allowPaths
    ? new Set(allowPaths)
    : new Set(allPaths);
  if (allowPaths && selectedSet.size !== allowPaths.length) {
    throw new Error("Shadow allowPaths 含重复路径");
  }
  for (const relativePath of selectedSet) {
    if (!allPaths.includes(relativePath)) {
      throw new Error(`Shadow allowPaths 不属于 sealed changeset：${relativePath}`);
    }
  }
  const selectionOrder = allPaths.filter((relativePath) =>
    selectedSet.has(relativePath)
  );
  return {
    selectionOrder,
    expectedAppliedPaths: [...selectionOrder].sort(),
    skippedPaths: allPaths
      .filter((relativePath) => !selectedSet.has(relativePath))
      .sort()
  };
}

async function loadWorkflowShadowChangeSet(
  intent: MaintenanceWorkflowWalIntent
): Promise<MaintenanceShadowChangeSet> {
  if (!intent.shadow || !intent.winner) {
    throw new Error("workflow intent 缺少 Shadow winner");
  }
  const changeSet = await loadMaintenanceShadowChangeSet(
    maintenanceShadowHandleFromIntent(intent)
  );
  if (
    changeSet.digest !== intent.shadow.changeSetDigest
    || changeSet.liveVaultFingerprint !== intent.shadow.liveVaultFingerprint
    || changeSet.attemptId !== intent.winner.attemptId
  ) {
    throw new Error("durable Shadow changeset 与 workflow WAL intent 不匹配");
  }
  return changeSet;
}

function maintenanceShadowHandleFromIntent(
  intent: MaintenanceWorkflowWalIntent
): MaintenanceShadowHandle {
  if (!intent.shadow || !intent.winner) {
    throw new Error("workflow intent 缺少 Shadow handle");
  }
  const rootPath = path.resolve(intent.shadow.controlRootPath);
  return {
    attemptId: intent.winner.attemptId,
    rootPath,
    agentVaultPath: path.join(rootPath, "vault"),
    manifestPath: path.join(rootPath, "manifest.json")
  };
}

function assertSamePathSet(
  actual: readonly string[],
  expected: readonly string[],
  label: string
): void {
  const left = Array.from(new Set(actual)).sort();
  const right = Array.from(new Set(expected)).sort();
  if (
    left.length !== actual.length
    || right.length !== expected.length
    || left.length !== right.length
    || left.some((value, index) => value !== right[index])
  ) {
    throw new Error(`${label} 与 workflow intent 不一致`);
  }
}

function digestJson(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(Buffer.from(stableStringify(value), "utf8"))
    .digest("hex")}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return value === undefined ? "null" : JSON.stringify(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
