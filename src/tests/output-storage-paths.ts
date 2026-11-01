import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveEnglishStoragePaths } from "../english-diary/storage-paths";
import { DEFAULT_ENGLISH_DIARY_SETTINGS } from "../english-diary/types";
import { emptyKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { readRawDigestRegistrySources } from "../knowledge-base/raw-digest";
import { registerKnowledgeFolderBindings } from "../knowledge-base/root-paths";

/** Output bindings must not move module-owned documents or broaden receipt reads to Raw. */
export async function runOutputStoragePathsTests(root: string): Promise<void> {
  const bindings = emptyKnowledgeFolderBindings();
  bindings.collectionTargets = { answer: "回答成果", generation: "生成成果" };
  Object.assign(bindings.roles.raw, { enabled: true, readPaths: ["所有资料"], writePath: "所有资料" });
  Object.assign(bindings.roles.outputs, { enabled: true, readPaths: ["历史成果"], writePath: "历史成果" });
  for (const englishDirectoryMode of [undefined, "role", "custom"] as const) {
    const settings = { ...DEFAULT_ENGLISH_DIARY_SETTINGS, englishDirectoryMode, expressionDirectoryMode: englishDirectoryMode,
      englishDirectory: "我的英文日记", expressionDirectory: "我的表达库", legacyEnglishDirectories: ["旧英文日记"] };
    const resolved = resolveEnglishStoragePaths(settings, bindings, ["Outputs", "输出"]);
    assert.equal(resolved.englishDirectory, settings.englishDirectory);
    assert.equal(resolved.expressionDirectory, settings.expressionDirectory);
    assert.ok(resolved.legacyEnglishDirectories.includes("旧英文日记"));
    assert.equal(resolved.legacyEnglishDirectories.includes(settings.englishDirectory), false);
  }
  const defaults = resolveEnglishStoragePaths(DEFAULT_ENGLISH_DIARY_SETTINGS, bindings, ["输出"]);
  assert.equal(defaults.englishDirectory, DEFAULT_ENGLISH_DIARY_SETTINGS.englishDirectory);
  assert.equal(defaults.expressionDirectory, DEFAULT_ENGLISH_DIARY_SETTINGS.expressionDirectory);
  console.log("PASS output paths: English Diary keeps its own directories across output bindings and legacy role modes");

  const vault = await mkdtemp(path.join(root, "output-receipts-"));
  const release = registerKnowledgeFolderBindings(vault, () => bindings);
  try {
    for (const directory of ["回答成果", "生成成果", "历史成果", "Outputs"]) {
      await mkdir(path.join(vault, directory));
      await writeFile(path.join(vault, directory, ".raw-digest-registry.json"), JSON.stringify({ schemaVersion: 1, updatedAt: "2026-11-01T00:00:00Z", entries: {} }));
    }
    await mkdir(path.join(vault, "所有资料"));
    await writeFile(path.join(vault, "所有资料", ".raw-digest-registry.json"), "RAW_DECOY_MUST_NOT_BE_READ");
    const stores = await readRawDigestRegistrySources(vault, true);
    assert.deepEqual([...new Set(stores.map(store => path.relative(vault, store.path).toLowerCase()))].sort(),
      ["回答成果", "生成成果", "历史成果", "outputs"].map(directory => `${directory}/.raw-digest-registry.json`).sort());
    assert.equal(stores.some(store => store.path.includes("所有资料")), false);
    console.log("PASS output paths: receipt reads include answer, generation and legacy output stores while leaving Raw untouched");
  } finally {
    release();
    await rm(vault, { recursive: true, force: true });
  }
}
