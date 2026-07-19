import * as assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  stat
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  ECHOINK_RECORD_MUTATION_ROOT_IDS,
  echoInkRecordMutationRootPath,
  prepareEchoInkRecordMutationRuntimeRoots,
  type EchoInkRecordMutationRootId
} from "../../harness/lifecycle/record-mutation-production";
import {
  echoInkMemoryV2Layout,
  initializeEchoInkMemoryV2
} from "../../harness/memory/v2-store";
import { pluginDataDir } from "../../core/raw-message-store";

export async function runHarnessV2RecordMutationProductionTests():
Promise<void> {
  await assertProductionRootsUseCanonicalEchoInkLayout();
  await assertProductionRootSelectionIsDeterministic();
}

async function assertProductionRootsUseCanonicalEchoInkLayout():
Promise<void> {
  const vaultPath = await mkdtemp(
    path.join(tmpdir(), "echoink-production-roots-")
  );
  try {
    const pluginDir = "codex-echoink";
    const selected = selectedRootIds([
      ECHOINK_RECORD_MUTATION_ROOT_IDS.conversation,
      ECHOINK_RECORD_MUTATION_ROOT_IDS.memory,
      ECHOINK_RECORD_MUTATION_ROOT_IDS.trash
    ]);
    await assert.rejects(
      prepareEchoInkRecordMutationRuntimeRoots({
        vaultPath,
        pluginDir,
        rootIds: selected,
        createdAt: 3_000
      })
    );
    assert.equal(
      await exists(echoInkMemoryV2Layout(vaultPath).root),
      false,
      "destructive wiring must not initialize a missing formal Memory store"
    );

    await initializeEchoInkMemoryV2(vaultPath);
    const prepared = await prepareEchoInkRecordMutationRuntimeRoots({
      vaultPath,
      pluginDir,
      rootIds: selected,
      createdAt: 3_001
    });
    assert.equal(
      prepared.storageRootPath,
      pluginDataDir(vaultPath, pluginDir)
    );
    assert.deepEqual(
      prepared.roots.map((root) => root.rootId),
      selected
    );
    assert.equal(
      prepared.roots.find(
        (root) => root.rootId === ECHOINK_RECORD_MUTATION_ROOT_IDS.memory
      )?.rootBinding.authority,
      "vault-managed"
    );
    assert.equal(
      prepared.roots.find(
        (root) => root.rootId === ECHOINK_RECORD_MUTATION_ROOT_IDS.trash
      )?.rootBinding.authority,
      "plugin-owned"
    );
    assert.equal(
      echoInkRecordMutationRootPath({
        vaultPath,
        pluginDir,
        rootId: ECHOINK_RECORD_MUTATION_ROOT_IDS.conversation
      }),
      path.join(pluginDataDir(vaultPath, pluginDir), "conversations")
    );
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
}

async function assertProductionRootSelectionIsDeterministic():
Promise<void> {
  const vaultPath = await mkdtemp(
    path.join(tmpdir(), "echoink-production-selection-")
  );
  try {
    await initializeEchoInkMemoryV2(vaultPath);
    const all = selectedRootIds(
      Object.values(ECHOINK_RECORD_MUTATION_ROOT_IDS)
    );
    const prepared = await prepareEchoInkRecordMutationRuntimeRoots({
      vaultPath,
      pluginDir: "codex-echoink",
      rootIds: all,
      createdAt: 3_100
    });
    assert.deepEqual(
      prepared.roots.map((root) => root.rootId),
      all
    );
    for (const root of prepared.roots) {
      assert.equal(await exists(root.rootPath), true);
    }

    const unsorted = [...all].reverse();
    await assert.rejects(
      prepareEchoInkRecordMutationRuntimeRoots({
        vaultPath,
        pluginDir: "codex-echoink",
        rootIds: unsorted,
        createdAt: 3_101
      }),
      /唯一且按 rootId 排序/
    );
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
}

function selectedRootIds(
  rootIds: readonly EchoInkRecordMutationRootId[]
): EchoInkRecordMutationRootId[] {
  return [...rootIds].sort((left, right) => left.localeCompare(right));
}

async function exists(absolutePath: string): Promise<boolean> {
  return await stat(absolutePath).then(() => true, () => false);
}
