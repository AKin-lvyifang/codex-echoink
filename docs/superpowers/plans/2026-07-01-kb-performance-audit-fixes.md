# Knowledge Base Performance Audit Fixes Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复审查 findings 1、2、3、6，让 EchoInk 知识库 dashboard、`/ask`、raw discovery 在大 Vault、大文件、二进制来源下不再全量读文件导致 Obsidian 卡死或内存暴涨。

**Architecture:** 把“是否允许读取文件正文、最多读多少、总读取预算多少”抽成 `src/knowledge-base/io-budget.ts`，由 dashboard、query、discovery 共用。dashboard 作为状态面优先使用 `stat + 已登记 fingerprint`，不为 UI 阻塞读大二进制；`/ask` 只读取 Markdown 前缀；discovery 对可信缓存命中的大文件复用旧 fingerprint，对超预算且无法证明未变的文件显式标记为跳过/待人工确认，不写假 fingerprint。

**Tech Stack:** TypeScript, Node `fs/promises`, Obsidian plugin runtime, existing esbuild-based `npm run test`.

---

## Goal Binding

当前修复 goal 应按以下目标执行：

> 按 `docs/superpowers/plans/2026-07-01-kb-performance-audit-fixes.md` 修复并验收 EchoInk 审查 findings 1、2、3、6。执行顺序必须是：先按本 plan 写失败测试并确认红灯，再逐项实现 dashboard、`/ask`、raw discovery 与结构测试改造，最后按本 plan 的验证清单完成 `npm run test`、`npm run typecheck`、`npm run build`、真实 Vault deploy 和 Obsidian 验收说明。

说明：当前 Codex active goal 已写入本 plan 路径；本区块作为本轮修复的具体执行合同。后续所有改动、测试和验收都必须对照本文档。

## Scope

- 修复：finding 1 dashboard 性能问题。
- 修复：finding 2 `/ask` 性能问题。
- 修复：finding 3 raw discovery 性能问题。
- 修复：finding 6 的当前可落地部分：先拆出可复用 I/O 预算模块与独立性能测试文件，避免继续把性能规则散落到巨型文件。
- 不修：finding 4，用户已单独开任务，并确认本质不应放进当前插件。
- 不做：大规模拆 `src/ui/codex-view.ts` 或 `src/knowledge-base/manager.ts`。这两个文件确实过大，但本轮根因在知识库 I/O 边界，贸然拆 UI/Manager 会扩大风险。

## Root Cause Evidence

- `src/knowledge-base/dashboard.ts:196-207` 每次构建 snapshot 会递归扫 `raw/`、`wiki/`、`outputs/`、`inbox/`，再对 raw source 调 `attachRawFingerprints()`。
- `src/knowledge-base/dashboard.ts:415-428` 的 `attachRawFingerprints()` 对每个 raw source 直接 `readFile()`，没有单文件大小、总字节预算或二进制排除。
- `src/knowledge-base/dashboard.ts:186` 的 raw 支持扩展包含 `.pdf/.docx/.png/.jpg/.jpeg/.webp/.gif`，所以 dashboard 会完整读取大 PDF/图片。
- `src/knowledge-base/query.ts:26-63` 的 `/ask` 递归扫 `wiki/`、`journal/`、`outputs/`，`src/knowledge-base/query.ts:35-36` 先完整 `readFile()`，再 `slice(0, MAX_FILE_CHARS)`；截断发生太晚。
- `src/knowledge-base/discovery.ts:9-24` 的 raw discovery 先 `walkExistingRawFiles()` 全量列文件，然后每个支持文件完整 `readFile()` 算 fingerprint，没有文件数、单文件、总字节预算。
- 当前结构可维护性风险是真实的：`src/ui/codex-view.ts` 5395 行，`src/knowledge-base/manager.ts` 3284 行，`src/tests/run-tests.ts` 8881 行。本轮先把性能策略抽到小模块，并把新增性能测试放到独立测试文件。

## File Map

- Create: `src/knowledge-base/io-budget.ts`
  - 负责 I/O 预算、单文件读取上限、前缀读取、缓存命中判断。
  - 不包含 dashboard/query/discovery 业务逻辑。
- Create: `src/tests/knowledge-base-performance-tests.ts`
  - 只放本轮性能回归测试。
  - 由 `src/tests/run-tests.ts` 调用，避免继续膨胀主测试文件。
- Modify: `src/tests/run-tests.ts`
  - 只新增一行 import 和一个 `await runKnowledgeBasePerformanceTests()` 调用。
- Modify: `src/knowledge-base/dashboard.ts`
  - `buildKnowledgeBaseDashboardSnapshot()` 增加可选性能参数。
  - `attachRawFingerprints()` 改用 I/O 预算和可信缓存。
- Modify: `src/knowledge-base/query.ts`
  - `findKnowledgeBaseAskMatches()` 增加可选性能参数。
  - Markdown 只读前缀，不完整读大文件。
- Modify: `src/knowledge-base/discovery.ts`
  - `discoverKnowledgeBaseSources()` 增加可选性能参数。
  - discovery 复用可信缓存，超预算文件不全量读。
- Modify: `src/knowledge-base/types.ts`
  - 给 `KnowledgeBaseDiscovery` 增加 `skippedSources`，用于说明超预算 raw 未纳入本轮处理。
  - 新增 `KnowledgeBaseSkippedSource`，避免把无真实 fingerprint 的超限文件伪装成 `KnowledgeBaseSource`。
- Modify: `src/knowledge-base/prompt.ts`
  - 在 `/maintain` prompt 里明确“超预算来源未纳入本轮，不要标记 processed”。

## Behavior Boundaries

- `raw/` 源文件内容、路径、附件仍不可改。
- 已有小文件 raw fingerprint 语义不变。
- 有可信 fingerprint 且 `size + mtime` 与当前文件一致的大文件，可以不读正文并复用缓存判定未变。
- 没有可信缓存或元数据不匹配的大文件，不能写假 fingerprint，不能标记 processed。
- `/ask` 仍只读，不写文件；命中质量以文件路径、标题和前缀正文为主。
- dashboard 允许显示“部分大文件未指纹化/待确认”的保守状态，但不能卡住 UI。

---

### Task 1: Add I/O Budget Primitives

**Files:**
- Create: `src/knowledge-base/io-budget.ts`
- Create: `src/tests/knowledge-base-performance-tests.ts`
- Modify: `src/tests/run-tests.ts`

- [x] **Step 1: Write the failing tests**

Add tests in `src/tests/knowledge-base-performance-tests.ts`:

```ts
import * as assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { normalizeSettingsData } from "../settings/settings";
import { buildKnowledgeBaseDashboardSnapshot } from "../knowledge-base/dashboard";
import { discoverKnowledgeBaseSources } from "../knowledge-base/discovery";
import {
  createKnowledgeBaseIoBudget,
  readKnowledgeBaseTextPrefix,
  shouldReadKnowledgeBaseFileContent
} from "../knowledge-base/io-budget";
import { contentFingerprint } from "../knowledge-base/raw-integrity";
import { findKnowledgeBaseAskMatches } from "../knowledge-base/query";

export async function runKnowledgeBasePerformanceTests(): Promise<void> {
  const budget = createKnowledgeBaseIoBudget({ maxFileBytes: 8, maxTotalBytes: 12 });
  assert.equal(shouldReadKnowledgeBaseFileContent({ size: 7 }, budget).ok, true);
  assert.equal(shouldReadKnowledgeBaseFileContent({ size: 7 }, budget).ok, false);
  assert.equal(shouldReadKnowledgeBaseFileContent({ size: 9 }, createKnowledgeBaseIoBudget({ maxFileBytes: 8 })).ok, false);

  const vault = await mkdtemp(path.join(tmpdir(), "codex-kb-io-budget-"));
  try {
    await mkdir(path.join(vault, "wiki"), { recursive: true });
    const file = path.join(vault, "wiki", "large.md");
    await writeFile(file, "# Title\n\nfirst line\n\nSHOULD_NOT_BE_READ", "utf8");
    const result = await readKnowledgeBaseTextPrefix(file, 18);
    assert.equal(result.truncated, true);
    assert.equal(result.text.includes("SHOULD_NOT_BE_READ"), false);
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
}
```

Modify `src/tests/run-tests.ts`:

```ts
import { runKnowledgeBasePerformanceTests } from "./knowledge-base-performance-tests";
...
await runKnowledgeBasePerformanceTests();
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm run test`

Expected: FAIL because `../knowledge-base/io-budget` does not exist.

- [x] **Step 3: Implement minimal I/O budget module**

Implement:

```ts
export interface KnowledgeBaseIoBudgetOptions {
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

export interface KnowledgeBaseIoBudget {
  maxFileBytes: number;
  maxTotalBytes: number;
  consumedBytes: number;
}

export function createKnowledgeBaseIoBudget(options: KnowledgeBaseIoBudgetOptions = {}): KnowledgeBaseIoBudget;
export function shouldReadKnowledgeBaseFileContent(file: { size: number }, budget: KnowledgeBaseIoBudget): { ok: boolean; reason?: string };
export async function readKnowledgeBaseTextPrefix(filePath: string, maxBytes: number): Promise<{ text: string; bytesRead: number; truncated: boolean }>;
```

- [x] **Step 4: Run test to verify it passes**

Run: `npm run test`

Expected: PASS.

- [x] **Step 5: Commit checkpoint if requested**

Do not commit unless user asks. If committing is requested: `git commit -m "test: add kb io budget coverage"`. Current status: not requested, no checkpoint commit made.

---

### Task 2: Fix `/ask` Full Markdown Reads

**Files:**
- Modify: `src/tests/knowledge-base-performance-tests.ts`
- Modify: `src/knowledge-base/query.ts`

- [x] **Step 1: Write the failing test**

Add to `runKnowledgeBasePerformanceTests()`:

```ts
const askVault = await mkdtemp(path.join(tmpdir(), "codex-kb-ask-budget-"));
try {
  await mkdir(path.join(askVault, "wiki"), { recursive: true });
  await writeFile(path.join(askVault, "wiki", "large.md"), [
    "# Harness",
    "",
    "Harness Engineering appears near the top.",
    "",
    "x".repeat(10_000),
    "TAIL_ONLY_TOKEN"
  ].join("\n"), "utf8");
  const matches = await findKnowledgeBaseAskMatches(askVault, "Harness Engineering TAIL_ONLY_TOKEN", 8, {
    maxFileReadBytes: 128
  });
  assert.equal(matches[0]?.relativePath, "wiki/large.md");
  assert.equal(matches[0]?.excerpt.includes("Harness Engineering"), true);
  assert.equal(matches[0]?.excerpt.includes("TAIL_ONLY_TOKEN"), false);
} finally {
  await rm(askVault, { recursive: true, force: true });
}
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm run test`

Expected: FAIL because `findKnowledgeBaseAskMatches()` does not accept the fourth options argument.

- [x] **Step 3: Implement bounded prefix read**

In `src/knowledge-base/query.ts`:

- Add options:

```ts
export interface KnowledgeBaseAskSearchOptions {
  maxFileReadBytes?: number;
  maxFilesPerRoot?: number;
}
```

- Replace `fsp.readFile(absolutePath, "utf8")` with `readKnowledgeBaseTextPrefix(absolutePath, maxFileReadBytes)`.
- Preserve existing default behavior semantically by setting default prefix large enough for normal notes, for example `240_000` bytes.
- Keep current score/excerpt/citation shape.

- [x] **Step 4: Run test to verify it passes**

Run: `npm run test`

Expected: PASS.

---

### Task 3: Fix Dashboard Raw Fingerprint Reads

**Files:**
- Modify: `src/tests/knowledge-base-performance-tests.ts`
- Modify: `src/knowledge-base/dashboard.ts`
- Modify: `src/knowledge-base/io-budget.ts`

- [x] **Step 1: Write the failing test**

Add a dashboard case:

```ts
const dashboardVault = await mkdtemp(path.join(tmpdir(), "codex-kb-dashboard-budget-"));
try {
  await mkdir(path.join(dashboardVault, "raw", "files"), { recursive: true });
  await mkdir(path.join(dashboardVault, "wiki"), { recursive: true });
  await mkdir(path.join(dashboardVault, "outputs"), { recursive: true });
  await mkdir(path.join(dashboardVault, "inbox"), { recursive: true });
  const pdfPath = path.join(dashboardVault, "raw", "files", "big.pdf");
  const pdfContent = Buffer.from("%PDF-" + "x".repeat(256));
  await writeFile(pdfPath, pdfContent);
  const pdfStat = await stat(pdfPath);
  const fingerprint = contentFingerprint(pdfContent);
  await chmod(pdfPath, 0o000);
  const snapshot = await buildKnowledgeBaseDashboardSnapshot(
    dashboardVault,
    normalizeSettingsData({
      settingsVersion: 27,
      knowledgeBase: {
        processedSources: {
          "raw/files/big.pdf": {
            path: "raw/files/big.pdf",
            size: pdfStat.size,
            mtime: pdfStat.mtimeMs,
            fingerprint,
            digestedAt: 1
          }
        }
      }
    }).settings.knowledgeBase,
    { maxRawFingerprintBytes: 16, maxTotalRawFingerprintBytes: 16 }
  );
  assert.equal(snapshot.raw.changedCount, 0);
  assert.equal(snapshot.recommendations.cards.find((card) => card.path === "raw/files/big.pdf")?.status, "已提炼");
} finally {
  await chmod(path.join(dashboardVault, "raw", "files", "big.pdf"), 0o644).catch(() => undefined);
  await rm(dashboardVault, { recursive: true, force: true });
}
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm run test`

Expected: FAIL because `buildKnowledgeBaseDashboardSnapshot()` does not accept options and dashboard does not reuse cached fingerprint under budget.

- [x] **Step 3: Implement dashboard cache-first fingerprinting**

In `src/knowledge-base/dashboard.ts`:

- Add `KnowledgeBaseDashboardOptions` with `maxRawFingerprintBytes`, `maxTotalRawFingerprintBytes`.
- Pass processed sources and registry entries into `attachRawFingerprints()`.
- If current `size + mtime` match processed source or registry entry with fingerprint, set `file.fingerprint` from cache without reading.
- Only read content when `shouldReadKnowledgeBaseFileContent()` allows.
- Never read `.pdf/.docx/.png/.jpg/.jpeg/.webp/.gif` beyond budget for dashboard.
- Preserve small Markdown frontmatter parsing.

- [x] **Step 4: Run test to verify it passes**

Run: `npm run test`

Expected: PASS.

---

### Task 4: Fix Raw Discovery Full Reads

**Files:**
- Modify: `src/tests/knowledge-base-performance-tests.ts`
- Modify: `src/knowledge-base/discovery.ts`
- Modify: `src/knowledge-base/types.ts`
- Modify: `src/knowledge-base/prompt.ts`

- [x] **Step 1: Write the failing test**

Add discovery cases:

```ts
const discoveryVault = await mkdtemp(path.join(tmpdir(), "codex-kb-discovery-budget-"));
try {
  await mkdir(path.join(discoveryVault, "raw", "files"), { recursive: true });
  const bigPath = path.join(discoveryVault, "raw", "files", "big.pdf");
  const bigContent = Buffer.from("%PDF-" + "x".repeat(256));
  await writeFile(bigPath, bigContent);
  const bigStat = await stat(bigPath);
  const fingerprint = contentFingerprint(bigContent);
  const cached = await discoverKnowledgeBaseSources(discoveryVault, {
    "raw/files/big.pdf": {
      path: "raw/files/big.pdf",
      size: bigStat.size,
      mtime: bigStat.mtimeMs,
      fingerprint,
      digestedAt: 1
    }
  }, "maintain", { maxRawFingerprintBytes: 16, maxTotalRawFingerprintBytes: 16 });
  assert.equal(cached.sources.find((source) => source.relativePath === "raw/files/big.pdf")?.changed, false);

  await writeFile(path.join(discoveryVault, "raw", "files", "uncached.pdf"), Buffer.from("%PDF-" + "y".repeat(256)));
  const uncached = await discoverKnowledgeBaseSources(discoveryVault, {}, "maintain", {
    maxRawFingerprintBytes: 16,
    maxTotalRawFingerprintBytes: 16
  });
  const skippedPaths = new Set(uncached.skippedSources.map((source) => source.relativePath));
  assert.equal(skippedPaths.has("raw/files/big.pdf"), true);
  assert.equal(skippedPaths.has("raw/files/uncached.pdf"), true);
} finally {
  await rm(discoveryVault, { recursive: true, force: true });
}
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm run test`

Expected: FAIL because `discoverKnowledgeBaseSources()` has no options and discovery result has no `skippedSources`.

- [x] **Step 3: Implement cache-first bounded discovery**

In `src/knowledge-base/discovery.ts`:

- Add `KnowledgeBaseDiscoveryOptions`.
- Add `skippedSources` to `KnowledgeBaseDiscovery`, where each skipped source uses a new `KnowledgeBaseSkippedSource` type with `relativePath`, `absolutePath`, `size`, `mtime`, `mime`, `modality`, and `reason`, but no `fingerprint`.
- Before reading content, check processed source and raw digest registry:
  - if cached fingerprint exists and current `size + mtime` match, create unchanged source with cached fingerprint and do not read.
  - if not cached or metadata differs, only read if budget allows.
  - if budget denies, add to `skippedSources` and do not add to `changedSources`.
- Keep missing raw directory behavior unchanged.

In `src/knowledge-base/prompt.ts`:

- Add skipped source summary so Agent does not mark skipped raw as processed.

- [x] **Step 4: Run test to verify it passes**

Run: `npm run test`

Expected: PASS.

---

### Task 5: Architecture Guard For Finding 6

**Files:**
- Modify: `src/tests/knowledge-base-performance-tests.ts`
- Modify: `src/tests/run-tests.ts`
- Verify: `src/knowledge-base/io-budget.ts`

- [x] **Step 1: Write the failing structure test**

Add a simple source-level guard:

```ts
const runTestsSource = await readFile(path.join(process.cwd(), "src/tests/run-tests.ts"), "utf8");
assert.ok(runTestsSource.includes("runKnowledgeBasePerformanceTests"));
assert.equal(runTestsSource.includes("maxRawFingerprintBytes"), false);
```

This prevents the new performance cases from being pasted directly into the already oversized runner.

- [x] **Step 2: Run test to verify it fails if Task 1 wiring was incomplete**

Run: `npm run test`

Expected: PASS after Task 1, or FAIL if performance tests were accidentally added directly to `run-tests.ts`.

- [x] **Step 3: Refactor only if needed**

If `run-tests.ts` contains the detailed performance cases, move them back to `src/tests/knowledge-base-performance-tests.ts`.

- [x] **Step 4: Run test to verify it passes**

Run: `npm run test`

Expected: PASS.

---

### Task 6: Final Verification

**Files:**
- Verify all touched files.

- [x] **Step 1: Run unit tests**

Run: `npm run test`

Expected: `All tests passed`.

- [x] **Step 2: Run typecheck**

Run: `npm run typecheck`

Expected: exit 0.

- [x] **Step 3: Run build**

Run: `npm run build`

Expected: exit 0 and `dist/main.js` generated.

- [x] **Step 4: Deploy to real Vault**

Run: `OBSIDIAN_VAULT=/Users/lyuakin/Documents/AKin-note-management npm run deploy`

Expected: deploy succeeds.

- [x] **Step 5: Real Obsidian verification**

Open `/Users/lyuakin/Documents/AKin-note-management` in Obsidian and verify:

- EchoInk 首页仍能打开。
- Knowledge dashboard 不因 raw 大文件卡死。
- `/ask` 可返回本地来源。
- 若 UI automation is unavailable, report that real Obsidian interaction was not fully automated.

Evidence:
- Obsidian window title: `EchoInk 首页 - AKin-note-management - Obsidian 1.13.1`.
- Screenshot: `/tmp/echoink-kb-performance-real-obsidian-clean.png`.

---

## Rollback Plan

- If bounded discovery creates false processed state, stop and revert discovery changes first.
- Do not revert unrelated main-worktree changes.
- Because this worktree is isolated, rollback can be limited to this branch.
