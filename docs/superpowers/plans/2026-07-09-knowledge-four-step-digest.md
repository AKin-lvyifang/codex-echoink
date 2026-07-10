# Knowledge Four Step Digest Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild EchoInk knowledge extraction so `/check`, `/maintain`, `/reingest`, `/calibrate raw`, and Home Raw actions follow the four-step protocol: understand source, extract knowledge, merge into Wiki / Projects, then mark Raw as digested only after evidence is verified.

**Architecture:** Keep Raw protection and transaction rollback in `KnowledgeBaseManager`, but extract digest status and digest evidence verification into focused knowledge-base modules. Then update prompts, command flow, dashboard state, and Home actions so “提炼” means structured knowledge integration, not summary generation.

**Tech Stack:** TypeScript, Obsidian plugin APIs, existing `src/tests/run-tests.ts` harness, EchoInk knowledge-base manager, Raw digest frontmatter / registry, Home dashboard snapshot.

---

## Source Spec

- `docs/superpowers/specs/2026-07-08-knowledge-four-step-digest-design.md`

## Current Evidence

- `src/knowledge-base/raw-digest.ts` already owns Raw managed fields: `已处理`、`提炼状态`、`提炼时间`、`提炼指纹`、`提炼报告`、`提炼证据`.
- `src/knowledge-base/manager.ts` already verifies that `/maintain` and `/reingest` wrote fresh report evidence and structure evidence before writing processed state.
- That verifier is still buried inside `manager.ts`; it should become a reusable digest verifier.
- `src/knowledge-base/prompt.ts` still says “Ingest 消化” and “3-5 句核心要点”; it does not clearly enforce the four-step protocol.
- `src/knowledge-base/dashboard.ts` currently collapses `changed` Raw into `Raw 待提炼`; the design needs a visible `待重新提炼`.
- `src/home/home-view.ts` currently fills `/maintain 重点处理 <path>` but does not directly submit a visible knowledge task.
- The worktree already has many unrelated dirty files. Implementation must stage only the files changed by each task.

## File Structure

Create:

- `src/knowledge-base/digest-status.ts`
  - Owns Raw digest state names, labels, score weights, and status derivation from frontmatter / registry / settings / tracker hints.
- `src/knowledge-base/digest-evidence.ts`
  - Owns structure evidence verification for Raw digestion.
  - Moves digest evidence helpers out of `src/knowledge-base/manager.ts`.

Modify:

- `src/knowledge-base/types.ts`
  - Export Raw digest state and status-count shape.
- `src/knowledge-base/raw-digest.ts`
  - Add managed statuses beyond `已提炼`: `待重新提炼`, `提炼失败`.
  - Keep `rawDigestRecordIsTrusted()` strict: only `已提炼` with matching fingerprint and evidence is trusted.
- `src/knowledge-base/dashboard.ts`
  - Use `digest-status.ts`.
  - Surface `待重新提炼` and `提炼失败`.
- `src/home/home-view.ts`
  - Update Raw filters and card actions.
  - Add visible direct execution for single Raw extraction.
- `src/ui/codex-view.ts`
  - Add a small public method to fill and submit a knowledge command from Home.
- `src/knowledge-base/prompt.ts`
  - Rewrite `/check`, `/maintain`, `/reingest`, `/outputs`, `/inbox` task wording around the four-step protocol.
- `src/knowledge-base/initializer.ts`
  - Update generated `LLM-WIKI.md` rules so new vaults inherit the four-step protocol.
- `src/knowledge-base/report.ts`
  - Update fallback report wording so reports never imply digest completion without Wiki / Projects evidence.
- `src/knowledge-base/manager.ts`
  - Use `digest-evidence.ts`.
  - Support explicit Raw path targeting from Home / command text.
  - Preserve transaction, Raw integrity, timeout, cancel, and backend routing behavior.
- `src/ui/codex-view/knowledge-dashboard.ts`
  - Update health reason wording if Raw status names change.
- `src/tests/run-tests.ts`
  - Add focused regression tests before each behavior change.

Do not create a second test runner unless `src/tests/run-tests.ts` becomes too large to safely edit.

## Acceptance Criteria

- `/check` only writes a lint / extraction audit report. It does not update Raw managed status and does not write Wiki / Projects.
- `/maintain` only marks Raw as `已提炼` after Wiki / Projects contains structure evidence and source evidence.
- `/maintain raw/articles/a.md` processes that Raw path rather than the whole changed batch.
- `/reingest` treats old summary-only output as incomplete unless it has structured evidence.
- `/calibrate raw` can repair missing Raw status from existing Wiki / Projects evidence, and can downgrade stale or missing evidence.
- Dashboard distinguishes `Raw 待提炼`, `待校准`, `待重新提炼`, `已提炼`, `提炼失败`.
- Home Raw card `提炼` starts a visible knowledge-base task for that Raw path, with cancel/report visibility.
- Batch Home extraction shows a batch list before execution.
- No Raw body, path, title, or attachment is modified by Agent tasks.
- Fixed validation commands pass:

```bash
npm run test
npm run typecheck
npm run build
OBSIDIAN_VAULT=/Users/lyuakin/Documents/AKin-note-management npm run deploy
```

- Real Obsidian validation uses only `/Users/lyuakin/Documents/AKin-note-management/testing/`.

---

### Task 1: Raw Digest Status Model

**Files:**
- Create: `src/knowledge-base/digest-status.ts`
- Modify: `src/knowledge-base/types.ts`
- Modify: `src/knowledge-base/raw-digest.ts`
- Modify: `src/knowledge-base/dashboard.ts`
- Modify: `src/tests/run-tests.ts`

- [ ] **Step 1: Write failing tests for Raw status labels**

Add a dashboard test near the existing dashboard Raw digest tests in `src/tests/run-tests.ts`.

Test cases:

```ts
assert.ok(dashboard.recommendations.cards.some((card) => card.path === "raw/articles/changed.md" && card.status === "待重新提炼"));
assert.ok(dashboard.recommendations.cards.some((card) => card.path === "raw/articles/failed.md" && card.status === "提炼失败"));
assert.ok(dashboard.recommendations.cards.some((card) => card.path === "raw/articles/pending.md" && card.status === "Raw 待提炼"));
```

- [ ] **Step 2: Run the failing status test**

Run:

```bash
npm run test
```

Expected: FAIL because `changed` currently displays as `Raw 待提炼`, and `failed` has no model.

- [ ] **Step 3: Add exported status types**

In `src/knowledge-base/types.ts`, replace the implicit raw state shape with explicit names:

```ts
export type KnowledgeBaseRawDigestState = "digested" | "pending" | "changed" | "calibration" | "failed";

export interface KnowledgeBaseRawDigestStatus {
  digested: number;
  pending: number;
  changed: number;
  calibration: number;
  failed: number;
}
```

- [ ] **Step 4: Add managed Raw status constants**

In `src/knowledge-base/raw-digest.ts`, add:

```ts
export const RAW_DIGEST_STATUS_PENDING_REINGEST = "待重新提炼";
export const RAW_DIGEST_STATUS_FAILED = "提炼失败";
```

Do not weaken `rawDigestRecordIsTrusted()`. It must only trust `已提炼`.

- [ ] **Step 5: Create `digest-status.ts`**

Move status derivation out of `dashboard.ts` into:

```ts
export function rawDigestStateForRecord(input: {
  fingerprint: string;
  frontmatter: RawDigestFrontmatterRecord | null;
  previous?: { fingerprint?: string };
  registry?: RawDigestRegistryEntry;
  hasTrackerHint: boolean;
}): KnowledgeBaseRawDigestState {
  if (!input.fingerprint) return "pending";
  if (input.frontmatter?.status === RAW_DIGEST_STATUS_FAILED) return "failed";
  if (rawDigestRecordIsTrusted(input.frontmatter, input.fingerprint)) return "digested";
  if (input.registry?.fingerprint === input.fingerprint || input.previous?.fingerprint === input.fingerprint) return "digested";
  if (
    (input.frontmatter?.fingerprint && input.frontmatter.fingerprint !== input.fingerprint)
    || (input.registry?.fingerprint && input.registry.fingerprint !== input.fingerprint)
    || (input.previous?.fingerprint && input.previous.fingerprint !== input.fingerprint)
  ) return "changed";
  if (input.previous || input.hasTrackerHint || input.frontmatter?.processed) return "calibration";
  return "pending";
}

export function rawDigestStateLabel(state: KnowledgeBaseRawDigestState): string {
  if (state === "digested") return "已提炼";
  if (state === "calibration") return "待校准";
  if (state === "changed") return "待重新提炼";
  if (state === "failed") return "提炼失败";
  return "Raw 待提炼";
}
```

- [ ] **Step 6: Update dashboard to use `digest-status.ts`**

Remove local `RawDigestState`, `rawDigestState()`, and direct label mapping from `src/knowledge-base/dashboard.ts`.

Use:

```ts
const rawState = kind === "raw" ? rawDigestStateForRecord(...) : null;
const status = rawState ? rawDigestStateLabel(rawState) : dashboardCardStatus(...);
```

- [ ] **Step 7: Run status tests**

Run:

```bash
npm run test
```

Expected: PASS for Raw status tests.

---

### Task 2: Extract Digest Evidence Verifier

**Files:**
- Create: `src/knowledge-base/digest-evidence.ts`
- Modify: `src/knowledge-base/manager.ts`
- Modify: `src/tests/run-tests.ts`

- [ ] **Step 1: Write failing direct verifier tests**

Add focused tests in `src/tests/run-tests.ts` for:

- Report mentions source but Wiki / Projects did not change: fail.
- Wiki page only adds `[[raw/...]]` link: fail.
- Wiki page adds source link plus real content: pass and returns evidence path.
- Projects page adds source link plus real content: pass.
- `outputs/maintenance` only: fail.

- [ ] **Step 2: Run tests before extraction**

Run:

```bash
npm run test
```

Expected: FAIL because verifier is not exported and direct tests cannot call it.

- [ ] **Step 3: Create `digest-evidence.ts`**

Move these functions and their private helpers out of `src/knowledge-base/manager.ts`:

- `assertFreshMaintenanceReportCoversSources`
- `assertKnowledgeStructureDigestsSources`
- `isKnowledgeStructureDigestEvidencePath`
- `transactionFileIntroducesSourceEvidence`
- all helper functions used only by structure evidence detection

Expose one high-level API:

```ts
export async function verifyDigestEvidence(input: {
  vaultPath: string;
  reportPath: string;
  sources: KnowledgeBaseSource[];
  startedAt: number;
  previousReportMtime?: number | null;
  transactionBefore: KnowledgeTransactionSnapshot | null;
  processedSourcesBeforeRun: Record<string, KnowledgeBaseProcessedSource>;
}): Promise<Record<string, string[]>> {
  await assertFreshMaintenanceReportCoversSources(...);
  return assertKnowledgeStructureDigestsSources(...);
}
```

If needed, export small test-only helpers rather than keeping the verifier trapped in `manager.ts`.

- [ ] **Step 4: Update manager imports**

In `src/knowledge-base/manager.ts`, replace:

```ts
await assertFreshMaintenanceReportCoversSources(...);
digestEvidencePaths = await assertKnowledgeStructureDigestsSources(...);
```

with:

```ts
digestEvidencePaths = await verifyDigestEvidence({
  vaultPath,
  reportPath,
  sources: runSources,
  startedAt,
  previousReportMtime: reportPath === discovery.reportPath ? reportMtimeBefore : null,
  transactionBefore,
  processedSourcesBeforeRun
});
```

- [ ] **Step 5: Run full tests**

Run:

```bash
npm run test
```

Expected: PASS with no behavior change.

---

### Task 3: Four-Step Agent Prompt Contract

**Files:**
- Modify: `src/knowledge-base/prompt.ts`
- Modify: `src/knowledge-base/initializer.ts`
- Modify: `src/knowledge-base/report.ts`
- Modify: `src/tests/run-tests.ts`

- [ ] **Step 1: Write prompt contract tests**

Add tests for `buildKnowledgeBasePrompt()`:

```ts
const maintainPrompt = buildKnowledgeBasePrompt(...mode: "maintain"...);
assert.ok(maintainPrompt.includes("读懂原文 -> 拆出知识 -> 融入 Wiki / Projects -> 回写 Raw 已提炼状态"));
assert.ok(maintainPrompt.includes("报告不能代替 Wiki / Projects 正文"));
assert.ok(maintainPrompt.includes("优先更新已有主题页"));

const lintPrompt = buildKnowledgeBasePrompt(...mode: "lint"...);
assert.ok(lintPrompt.includes("只体检，不提炼"));
assert.ok(lintPrompt.includes("不要写 Raw 托管属性"));
assert.ok(lintPrompt.includes("不要写 Wiki / Projects 正文"));
```

- [ ] **Step 2: Run prompt tests**

Run:

```bash
npm run test
```

Expected: FAIL because prompt still uses old ingest wording.

- [ ] **Step 3: Rewrite `taskForMode()`**

Use mode-specific wording:

- `lint`: “提炼审计，只验真，不提炼。”
- `maintain`: “执行四步提炼协议。”
- `reingest`: “强制重新执行四步提炼，旧摘要型产物不算完成。”
- `outputs`: “只把长期价值提炼进 Wiki / Projects，过程稿留在 outputs。”
- `inbox`: “分流 inbox，只有可长期复用内容才进入 Wiki / Projects。”

- [ ] **Step 4: Rewrite standard steps**

Replace current “3-5 句核心要点” wording with:

```text
1. 读懂原文：识别主题、来源类型、适用范围和不确定点。
2. 拆出知识：事实、观点、方法、案例、风险、行动项、问题。
3. 路由目标页：优先更新已有 wiki/projects 正文页；没有稳定承载页才新建。
4. 融入正文：合并、去重、调整小节，不把摘要贴在页面底部。
5. 写来源证据：每个 Raw 在目标页留下来源链接和附近实质内容。
6. 报告输出：列出 Raw、目标页、知识类型、证据位置、失败原因。
```

- [ ] **Step 5: Update initializer rules**

In `src/knowledge-base/initializer.ts`, update generated knowledge rules so new vaults use the same four-step protocol and Raw status boundary.

- [ ] **Step 6: Update fallback report wording**

In `src/knowledge-base/report.ts`, make fallback reports say:

```text
Agent 未写出报告；该报告只是过程记录，不代表 Raw 已提炼。
```

For non-lint fallback with sources, avoid wording that implies digest success.

- [ ] **Step 7: Run tests**

Run:

```bash
npm run test
```

Expected: PASS.

---

### Task 4: Explicit Raw Path Targeting

**Files:**
- Modify: `src/knowledge-base/manager.ts`
- Modify: `src/knowledge-base/prompt.ts`
- Modify: `src/home/home-view.ts`
- Modify: `src/tests/run-tests.ts`

- [ ] **Step 1: Write targeting tests**

Add tests for a helper that extracts explicit Raw paths from user request:

```ts
assert.deepEqual(extractRequestedRawPaths("/maintain raw/articles/a.md"), ["raw/articles/a.md"]);
assert.deepEqual(extractRequestedRawPaths("重点处理 [[raw/articles/a]]"), ["raw/articles/a.md"]);
assert.deepEqual(extractRequestedRawPaths("处理 raw/articles/a.md 和 raw/articles/b.md"), ["raw/articles/a.md", "raw/articles/b.md"]);
assert.deepEqual(extractRequestedRawPaths("维护今天新增"), []);
```

Then add a `selectSourcesForRunMode()` test proving explicit paths narrow the source batch.

- [ ] **Step 2: Run targeting tests**

Run:

```bash
npm run test
```

Expected: FAIL because targeting helper does not exist.

- [ ] **Step 3: Implement targeting helper**

Create the helper near source selection in `src/knowledge-base/manager.ts`, or move it to a small module if it grows:

```ts
export function extractRequestedRawPaths(text: string): string[] {
  // Support raw/foo.md and [[raw/foo]].
}
```

Normalize:

- Strip surrounding punctuation.
- Add `.md` for wiki-link style raw paths without extension.
- Reject absolute paths and `../`.
- Keep only paths starting with `raw/`.

- [ ] **Step 4: Apply targeting in run source selection**

Change:

```ts
const promptSources = selectSourcesForRunMode(mode, discovery);
```

to:

```ts
const promptSources = selectSourcesForRunMode(mode, discovery, userRequest);
```

For `maintain` and `reingest`, explicit paths should include matching sources from `discovery.sources`, not only `changedSources`.

If a requested Raw path is missing, the prompt/report should mention it as skipped rather than silently ignoring it.

- [ ] **Step 5: Include target paths in prompt**

Add a short prompt section:

```text
## 用户指定 Raw
- raw/articles/a.md
```

This prevents the Agent from broadening the task.

- [ ] **Step 6: Run tests**

Run:

```bash
npm run test
```

Expected: PASS.

---

### Task 5: Command Flow and Raw Status Writeback

**Files:**
- Modify: `src/knowledge-base/manager.ts`
- Modify: `src/knowledge-base/raw-digest.ts`
- Modify: `src/knowledge-base/report.ts`
- Modify: `src/tests/run-tests.ts`

- [ ] **Step 1: Write command responsibility tests**

Add tests using `KnowledgeBaseManager` test doubles:

- `/check` does not call `writeRawDigestMetadataForSources`.
- `/maintain` with report-only output fails before tracker write.
- `/maintain` with link-only Wiki evidence fails before tracker write.
- `/maintain` with real Wiki evidence writes Raw digest metadata.
- Raw body modification still fails and rolls back.

- [ ] **Step 2: Run tests**

Run:

```bash
npm run test
```

Expected: some tests fail until manager uses extracted verifier consistently.

- [ ] **Step 3: Keep `/check` lint-only**

Confirm `knowledgeTransactionRootsForMode("lint")` returns only `["outputs"]` and `runKnowledgeAgentTask()` uses read-only / knowledge-lint scope.

If prompt changes tempt the Agent to write Wiki during `/check`, the sandbox must still block it.

- [ ] **Step 4: Use verifier result as the only writeback gate**

In `runMaintenance()`, keep this order:

1. Agent run.
2. Raw integrity check.
3. Structure normalize when allowed.
4. `verifyDigestEvidence()`.
5. `writeRawDigestMetadataForSources()`.
6. tracker/settings commit.

Do not write `processedSources` before step 4 succeeds.

- [ ] **Step 5: Record failed status without corrupting Raw**

If implementing `提炼失败` this iteration, store failure in a safe plugin-owned place first, not in Raw body during rollback-sensitive paths.

Preferred first pass:

- Add failure to maintenance report and dashboard via `lastRunStatus` / report parsing.
- Only write Raw `提炼失败` managed status in a controlled post-processing path after Raw integrity is stable.

If this becomes too large, defer persistent `提炼失败` but keep UI support for future state.

- [ ] **Step 6: Run full tests**

Run:

```bash
npm run test
```

Expected: PASS.

---

### Task 6: Calibration Becomes Evidence Repair

**Files:**
- Modify: `src/knowledge-base/manager.ts`
- Modify: `src/knowledge-base/raw-digest.ts`
- Modify: `src/tests/run-tests.ts`

- [ ] **Step 1: Write calibration tests**

Add tests for `calibrateRawDigestStatus()`:

- Existing Wiki / Projects evidence plus matching fingerprint writes Raw managed metadata with confidence `repaired`.
- Tracker-only evidence leaves status as `待校准`.
- Raw status says `已提炼` but evidence path is missing: downgrade from trusted state.
- Fingerprint mismatch becomes `待重新提炼`.

- [ ] **Step 2: Run calibration tests**

Run:

```bash
npm run test
```

Expected: FAIL for downgrade / changed-state behavior if not implemented.

- [ ] **Step 3: Reuse digest evidence scanner**

Calibration should not call an Agent. It should scan existing Wiki / Projects evidence and Raw managed fields.

Use verifier helpers for:

- valid evidence path
- source link plus nearby content
- non-index Wiki / Projects page only

- [ ] **Step 4: Write repaired status**

When evidence is valid:

```ts
confidence: "repaired"
```

When evidence is invalid:

- Do not mark `已提炼`.
- Produce calibration report with reason.

- [ ] **Step 5: Run tests**

Run:

```bash
npm run test
```

Expected: PASS.

---

### Task 7: Home Raw Action and Batch UX

**Files:**
- Modify: `src/home/home-view.ts`
- Modify: `src/ui/codex-view.ts`
- Modify: `src/tests/run-tests.ts`

- [ ] **Step 1: Write Home action tests**

Add tests for:

- Raw card refine command becomes `/maintain raw/articles/a.md`.
- Non-Raw card refine remains read-only `/ask ...`.
- Raw filter includes `Raw 待提炼`, `待重新提炼`, and `提炼失败`, but not `已提炼`.
- Batch command creates a list before execution.

- [ ] **Step 2: Add CodexView public submit method**

In `src/ui/codex-view.ts`, add a small public wrapper:

```ts
async submitKnowledgeBaseCommand(command: string): Promise<void> {
  await this.plugin.activateKnowledgeBaseChannel();
  this.fillKnowledgeBaseCommand(command);
  await this.sendMessage();
}
```

If `sendMessage()` must stay private, expose a narrower method that internally calls it.

- [ ] **Step 3: Directly submit single Raw extraction**

In `src/home/home-view.ts`, change Raw refine action to:

```ts
await this.plugin.activateKnowledgeBaseChannel();
await this.plugin.getCodexView()?.submitKnowledgeBaseCommand(`/maintain ${card.path}`);
```

The task is visible in the knowledge channel and can be canceled through existing knowledge task controls.

- [ ] **Step 4: Keep batch guarded**

For batch extraction, show a modal/list first:

- number of Raw items
- first 20 paths
- command that will run
- explicit confirm button

Do not silently run a large batch from a filter click.

- [ ] **Step 5: Run tests**

Run:

```bash
npm run test
```

Expected: PASS.

---

### Task 8: Documentation and UI Copy

**Files:**
- Modify: `README.md`
- Modify: `README_CN.md`
- Modify: `src/settings/i18n.ts`
- Modify: `src/ui/codex-view/knowledge-dashboard.ts`
- Modify: `src/tests/run-tests.ts`

- [ ] **Step 1: Update public wording**

Replace “摘要 / 消化” user-facing wording where it can mislead:

- “提炼 = 写入 Wiki / Projects + 来源证据 + Raw 托管状态”
- `/check` = “提炼审计 / 只验真”
- `/maintain` = “四步提炼”
- `/calibrate raw` = “状态校准”

- [ ] **Step 2: Update health reason text**

`Raw 待提炼` reason should say:

```text
来源还没有进入 Wiki / Projects 的结构化知识，或缺少可信来源证据。
```

- [ ] **Step 3: Run docs-related tests**

Run:

```bash
npm run test
```

Expected: PASS.

---

### Task 9: Full Verification and Real Obsidian Check

**Files:**
- No new code files unless tests expose a bug.

- [ ] **Step 1: Run full local verification**

Run:

```bash
npm run test
npm run typecheck
npm run build
```

Expected: all pass.

- [ ] **Step 2: Deploy to real Vault**

Run:

```bash
OBSIDIAN_VAULT=/Users/lyuakin/Documents/AKin-note-management npm run deploy
```

Expected: deploy passes and plugin files copy into:

```text
/Users/lyuakin/Documents/AKin-note-management/.obsidian/plugins/codex-echoink
```

- [ ] **Step 3: Real Obsidian validation in testing only**

Use only:

```text
/Users/lyuakin/Documents/AKin-note-management/testing/
```

Create or reuse test notes:

- one Raw-like source file for a new source
- one existing Wiki / Projects target page
- one old summary-only page

Validate:

- Single Raw card `提炼` starts a visible knowledge task.
- `/check` produces audit report and does not mark Raw.
- `/maintain <raw path>` writes structure knowledge into Wiki / Projects and marks Raw only after evidence exists.
- `/reingest <raw path>` upgrades summary-only content.
- `/calibrate raw` repairs status only when evidence exists.
- Failure path does not leave fake `已提炼`.

- [ ] **Step 4: Report evidence**

Final response must include:

- changed files
- commands run
- deploy result
- real Obsidian validation status
- exact testing note paths

