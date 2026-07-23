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
import { buildKnowledgeBasePrompt } from "../knowledge-base/prompt";

export async function runKnowledgeBasePerformanceTests(): Promise<void> {
  const budget = createKnowledgeBaseIoBudget({ maxFileBytes: 8, maxTotalBytes: 12 });
  assert.equal(shouldReadKnowledgeBaseFileContent({ size: 7 }, budget).ok, true);
  assert.equal(shouldReadKnowledgeBaseFileContent({ size: 7 }, budget).ok, false);
  assert.equal(shouldReadKnowledgeBaseFileContent({ size: 9 }, createKnowledgeBaseIoBudget({ maxFileBytes: 8 })).ok, false);
  const chunkBudget = createKnowledgeBaseIoBudget({
    maxFileBytes: 8,
    maxTotalBytes: 20
  });
  assert.deepEqual(
    shouldReadKnowledgeBaseFileContent(
      { size: 18 },
      chunkBudget,
      { allowChunkedText: true }
    ),
    { ok: true, strategy: "chunked-text", maxChunkBytes: 8 }
  );
  assert.equal(chunkBudget.consumedBytes, 18);
  assert.equal(
    shouldReadKnowledgeBaseFileContent(
      { size: 18 },
      createKnowledgeBaseIoBudget({ maxFileBytes: 8, maxTotalBytes: 20 })
    ).ok,
    false,
    "binary/non-text callers must not inherit chunking"
  );

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

  const runTestsSource = await readFile(path.join(process.cwd(), "src/tests/run-tests.ts"), "utf8");
  assert.ok(runTestsSource.includes("runKnowledgeBasePerformanceTests"));
  assert.equal(runTestsSource.includes("maxRawFingerprintBytes"), false);

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
    const tailOnlyMatches = await findKnowledgeBaseAskMatches(askVault, "TAIL_ONLY_TOKEN", 8, {
      maxFileReadBytes: 128
    });
    assert.equal(tailOnlyMatches.length, 0);
  } finally {
    await rm(askVault, { recursive: true, force: true });
  }

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
    await writeFile(
      path.join(discoveryVault, "raw", "files", "chunked.md"),
      Buffer.from("# Chunked\n\n" + "中文分块内容。".repeat(32))
    );
    const uncached = await discoverKnowledgeBaseSources(discoveryVault, {}, "maintain", {
      maxRawFingerprintBytes: 16,
      maxTotalRawFingerprintBytes: 1024
    });
    const skippedPaths = new Set(uncached.skippedSources.map((source) => source.relativePath));
    assert.equal(skippedPaths.has("raw/files/big.pdf"), true);
    assert.equal(skippedPaths.has("raw/files/uncached.pdf"), true);
    const chunked = uncached.sources.find(
      (source) => source.relativePath === "raw/files/chunked.md"
    );
    assert.deepEqual(chunked?.readStrategy, {
      kind: "chunked-text",
      maxChunkBytes: 16
    });
    const prompt = buildKnowledgeBasePrompt({
      vaultPath: discoveryVault,
      mode: "maintain",
      reportPath: uncached.reportPath,
      sources: uncached.changedSources,
      skippedSources: uncached.skippedSources,
      sourceChunks: [{
        sourceRelativePath: "raw/files/chunked.md",
        relativePath: "raw/.echoink-source-chunks/test/part-0001-of-0002.md",
        index: 1,
        count: 2,
        startByte: 0,
        endByte: 16,
        size: 16,
        sha256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }, {
        sourceRelativePath: "raw/files/chunked.md",
        relativePath: "raw/.echoink-source-chunks/test/part-0002-of-0002.md",
        index: 2,
        count: 2,
        startByte: 16,
        endByte: 32,
        size: 16,
        sha256: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      }],
      rulesFilePath: "AGENTS.md",
      rulesFileExists: false,
      useCustomRulesFile: false,
      hasRawIndex: false,
      hasWikiIndex: false,
      hasTracker: false
    });
    assert.equal(prompt.includes("超出读取预算，未纳入本轮 raw 来源"), true);
    assert.equal(prompt.includes("raw/files/uncached.pdf"), true);
    assert.equal(prompt.includes("超限文本安全分块"), true);
    assert.equal(prompt.includes("必须按编号读完所有分块后再综合"), true);
    assert.equal(prompt.includes("原始来源：raw/files/chunked.md"), true);
  } finally {
    await rm(discoveryVault, { recursive: true, force: true });
  }
}
