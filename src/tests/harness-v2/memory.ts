import * as assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { compileContextBundle } from "../../harness/kernel/context-compiler";
import { buildCodexMemoryMigrationPreview, echoInkMemoryLayout, FileMemoryProvider, initializeEchoInkMemory } from "../../harness/memory/file-memory";

export async function runHarnessV2MemoryTests(): Promise<void> {
  await assertEchoInkMemoryInitializerCreatesLayout();
  await assertCodexMemoryMigrationPreviewIsReadOnly();
  await assertFileMemoryProviderCommitsRetrievesAndSupersedesItems();
  await assertMemoryCandidateExtractionRejectsFragmentsAndPlaceholders();
  await assertMemoryMvpCandidateReviewLifecycleAndPortability();
}

async function assertEchoInkMemoryInitializerCreatesLayout(): Promise<void> {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "echoink-memory-"));
  const result = await initializeEchoInkMemory({ vaultPath });
  const layout = echoInkMemoryLayout(vaultPath);

  assert.equal(result.created.length > 0, true);
  assert.equal(result.layout.root, path.join(vaultPath, ".echoink", "memory"));
  assert.equal(result.layout.current, layout.current);
  assert.equal(result.created.some((item) => item.endsWith("current.md")), true);
  assert.equal(result.created.some((item) => item.endsWith("index.json")), true);
  assert.equal(result.created.some((item) => item.endsWith("events.jsonl")), true);
}

async function assertCodexMemoryMigrationPreviewIsReadOnly(): Promise<void> {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "echoink-memory-migrate-"));
  await mkdir(path.join(vaultPath, ".codex-memory", "spec"), { recursive: true });
  await mkdir(path.join(vaultPath, ".codex-memory", "tasks"), { recursive: true });
  await writeFile(path.join(vaultPath, ".codex-memory", "current.md"), "# Current\n");
  await writeFile(path.join(vaultPath, ".codex-memory", "spec", "index.md"), "# Spec\n");
  await writeFile(path.join(vaultPath, ".codex-memory", "tasks", "index.md"), "# Tasks\n");

  const preview = await buildCodexMemoryMigrationPreview({ vaultPath });

  assert.equal(preview.sourceRoot, path.join(vaultPath, ".codex-memory"));
  assert.equal(preview.targetRoot, path.join(vaultPath, ".echoink", "memory"));
  assert.deepEqual(preview.mappings.map((item) => item.kind), ["current", "spec", "tasks"]);
  assert.equal(preview.willDeleteSource, false);
  assert.equal(preview.willRewriteAgentsMd, false);
}

async function assertFileMemoryProviderCommitsRetrievesAndSupersedesItems(): Promise<void> {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "echoink-memory-provider-"));
  await initializeEchoInkMemory({ vaultPath });
  const provider = new FileMemoryProvider({ vaultPath, now: () => 123 });
  const commit = await provider.commit([{
    id: "candidate-1",
    kind: "preference",
    statement: "用户偏好中文短句。",
    evidenceRefs: ["run-1"],
    sourceRunId: "run-1",
    confidence: 0.9,
    confirmed: true
  }]);

  assert.deepEqual(commit.committed, ["candidate-1"]);
  const retrieved = await provider.retrieve({
    runId: "run-2",
    sessionId: "session-1",
    workspace: { vaultPath, cwd: vaultPath },
    query: "中文怎么输出",
    maxItems: 5
  });

  assert.equal(retrieved.items.length, 1);
  assert.equal(retrieved.sections.length, 1);
  assert.match(retrieved.sections[0].content, /用户偏好中文短句/);

  await provider.supersede("candidate-1", "测试废弃");
  const afterSupersede = await provider.retrieve({
    runId: "run-3",
    sessionId: "session-1",
    workspace: { vaultPath, cwd: vaultPath },
    query: "中文",
    maxItems: 5
  });
  assert.equal(afterSupersede.items.length, 0);
}

async function assertMemoryCandidateExtractionRejectsFragmentsAndPlaceholders(): Promise<void> {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "echoink-memory-quality-"));
  const provider = new FileMemoryProvider({ vaultPath, now: () => 500 });
  const candidates = await provider.propose({
    runId: "run-quality",
    sessionId: "session-quality",
    workspace: { vaultPath, cwd: vaultPath },
    transcript: [
      "assistant: 所以 Codex Knowledge 记住的口令就是 ALPHA-731。",
      "assistant: 下一步：<前 1-3 个修复项>",
      "assistant: 限制：待补充",
      "assistant: 限制：延迟、成本、合规、团队规模",
      "user: 约束：只读、低成本",
      "user: 请记住项目代号 MEMORY-842。只回复：MEMORY-842",
      "user: 决定：只在 test vault 验收",
      "assistant: 下一步：修复 OpenCode Session 复用"
    ].join("\n")
  });

  assert.deepEqual(candidates.map((item) => [item.kind, item.statement]), [
    ["constraint", "只读、低成本"],
    ["current-state", "项目代号 MEMORY-842"],
    ["decision", "只在 test vault 验收"],
    ["open-loop", "修复 OpenCode Session 复用"]
  ]);
}

async function assertMemoryMvpCandidateReviewLifecycleAndPortability(): Promise<void> {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "echoink-memory-mvp-"));
  let now = 1_000;
  const provider = new FileMemoryProvider({ vaultPath, now: () => now });
  const workspace = { vaultPath, cwd: vaultPath };
  const candidates = await provider.propose({
    runId: "run-propose-1",
    sessionId: "session-1",
    workspace,
    transcript: [
      "user: 用户偏好：输出语言：中文",
      "user: 决定：只在 test vault 验收",
      "user: 请记住项目代号 MEMORY-731"
    ].join("\n")
  });

  assert.deepEqual(candidates.map((item) => item.kind), ["preference", "decision", "current-state"]);
  const firstCommit = await provider.commit(candidates);
  assert.equal(firstCommit.committed.length, 1, "safe current-state candidate may commit without confirmation");
  assert.equal(firstCommit.pendingConfirmation?.length, 2);

  const confirmed = await provider.commit(candidates.map((candidate) => ({ ...candidate, confirmed: true })));
  assert.equal(confirmed.committed.length, 2, "duplicate current-state candidate should be skipped");
  assert.equal(confirmed.skipped.length, 1);

  const conflicting = await provider.propose({
    runId: "run-propose-2",
    sessionId: "session-1",
    workspace,
    transcript: "user: 用户偏好：输出语言：英文"
  });
  assert.equal(conflicting[0].conflictsWith?.length, 1);
  const blockedConflict = await provider.commit(conflicting);
  assert.deepEqual(blockedConflict.conflicts, [conflicting[0].id]);
  const resolvedConflict = await provider.commit([{ ...conflicting[0], confirmed: true }]);
  assert.deepEqual(resolvedConflict.committed, [conflicting[0].id]);

  const summary = await provider.inspect();
  const decision = summary.active.find((item) => item.kind === "decision");
  const current = summary.active.find((item) => item.kind === "current-state");
  assert.ok(decision);
  assert.ok(current);
  assert.equal(summary.archived.some((item) => item.kind === "preference" && /中文/.test(item.statement)), true);

  const sharedMemory = await provider.retrieve({ runId: "run-new-session", sessionId: "new-session", workspace, query: "MEMORY-731", maxItems: 5 });
  for (const backendId of ["codex-cli", "hermes"]) {
    const context = compileContextBundle({
      runId: `run-${backendId}`,
      session: { id: "new-session", title: "New", messages: [], createdAt: now, updatedAt: now },
      backendId,
      workflow: "chat",
      userInput: { text: "项目代号是什么？", attachments: [] },
      memory: sharedMemory,
      corePolicySections: []
    });
    assert.match(context.memoryContext.map((section) => section.content).join("\n"), /MEMORY-731/, `new ${backendId} session must receive the same EchoInk Memory`);
  }

  assert.equal(await provider.remove(decision.id, "用户删除"), true);
  assert.equal(await provider.expire(current.id, now + 10), true);
  now += 11;
  assert.deepEqual(await provider.purgeExpired(), [current.id]);
  const retrieved = await provider.retrieve({ runId: "run-read", sessionId: "session-2", workspace, query: "中文 MEMORY-731", maxItems: 10 });
  assert.equal(retrieved.items.some((item) => item.id === decision.id || item.id === current.id), false, "deleted and expired memories must not be injected");

  const layout = echoInkMemoryLayout(vaultPath);
  const archiveProjection = await readFile(path.join(layout.archive, "index.md"), "utf8");
  assert.match(archiveProjection, /用户删除/);
  assert.match(archiveProjection, /Expired: yes/);

  const exported = await provider.export();
  const backup = await provider.backup();
  assert.equal((await stat(exported)).isFile(), true);
  assert.equal((await stat(path.join(backup, "index.json"))).isFile(), true);
  const audit = await provider.readAudit();
  for (const type of ["proposed", "committed", "superseded", "deleted", "expiration-set", "expired", "exported", "backed-up"]) {
    assert.equal(audit.some((event) => event.type === type), true, `missing memory audit event ${type}`);
  }
}
