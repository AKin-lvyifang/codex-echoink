import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { FileConversationCatalog } from "../../harness/pi-native/file-conversation-catalog";
import { FileProductRunStore } from "../../harness/pi-native/file-product-run-store";
import type { AgentRunSnapshot } from "../../agents/types";

export async function runProductRunSnapshotTests(root: string): Promise<void> {
  const catalog = new FileConversationCatalog({ storageRootPath: root, vaultId: "snapshot-fixture" });
  await catalog.upsert({ conversationId: "conversation", piSessionId: "pi-session", vaultId: catalog.vaultId,
    title: "Snapshot compatibility", status: "active", defaultMemoryMode: "normal", createdAt: 1, updatedAt: 1 });
  const options = { storageRootPath: root, vaultId: catalog.vaultId, catalog };
  const store = new FileProductRunStore(options);
  let clock = 100;
  const create = (id: string, agentSnapshot?: AgentRunSnapshot) => store.create({ productRunId: id, conversationId: "conversation", piSessionId: "pi-session", userEntryId: `user-${id}`,
    toolCallIds: [], memoryMode: "normal", state: "accepted", activeLeafId: null, createdAt: ++clock, updatedAt: clock,
    ...(agentSnapshot ? { agentSnapshot } : {}) });
  const legacy: AgentRunSnapshot = { agentId: "sol", name: "总助", position: "协作", styleId: "analysis", disabledCapabilityIds: ["finance"] };
  const plain = await create("without-snapshot"); assert.equal(plain.agentSnapshot, undefined);
  await create("legacy-snapshot", legacy);
  const legacyCold = new FileProductRunStore(options);
  assert.deepEqual((await legacyCold.read("legacy-snapshot"))?.agentSnapshot, legacy);
  assert.equal((await legacyCold.read("without-snapshot"))?.agentSnapshot, undefined);
  console.log("OK legacy ProductRuns with absent and four-field Agent snapshots remain readable");

  const persona = "\n" + "😀".repeat(3998) + "\n";
  const ordinary: AgentRunSnapshot = { ...legacy, persona };
  assert.equal(Array.from(persona).length, 4000);
  assert.deepEqual((await create("ordinary-persona", ordinary)).agentSnapshot, ordinary);
  await store.update("ordinary-persona", { state: "running", updatedAt: ++clock });
  const ordinaryCold = new FileProductRunStore(options);
  assert.deepEqual((await ordinaryCold.read("ordinary-persona"))?.agentSnapshot, ordinary);
  assert.deepEqual((await ordinaryCold.listReadOnly("conversation")).find(run => run.productRunId === "ordinary-persona")?.agentSnapshot, ordinary);
  console.log("OK ordinary 4000-Unicode persona survives create, update, cold read and read-only listing byte-for-byte");

  const expert: AgentRunSnapshot = { agentId: "expert-synthetic", name: "测试专家", position: "产品", styleId: "execution", expertId: "synthetic", expertPackageVersion: "draft-2", capabilityIds: ["knowledge"] };
  assert.deepEqual((await create("expert-reference", expert)).agentSnapshot, expert);
  await store.update("expert-reference", { state: "running", updatedAt: ++clock });
  const expertCold = new FileProductRunStore(options);
  assert.deepEqual((await expertCold.read("expert-reference"))?.agentSnapshot, expert);
  assert.deepEqual((await expertCold.listReadOnly("conversation")).find(run => run.productRunId === "expert-reference")?.agentSnapshot, expert);
  assert.equal(Object.hasOwn((await expertCold.read("expert-reference"))!.agentSnapshot!, "persona"), false);
  console.log("OK expert ID/package reference survives create, update and cold/read-only reads without persona");

  const countBeforeRejection = (await readdir(store.rootPath)).length;
  for (const [id, patch] of [
    ["oversized-persona", { persona: "😀".repeat(4001) }],
    ["non-string-persona", { persona: 123 }],
    ["non-string-expert-id", { expertId: 123 }],
    ["empty-expert-version", { expertPackageVersion: " " }]
  ] as const) {
    await assert.rejects(create(id, { ...legacy, ...patch } as unknown as AgentRunSnapshot));
  }
  assert.equal((await readdir(store.rootPath)).length, countBeforeRejection);
  console.log("OK invalid persona lengths/types and malformed expert references are rejected before writing");

  const privateBody = "SYNTHETIC_PRIVATE_EXPERT_FULL_BODY";
  await assert.rejects(create("expert-persona-body", { ...expert, persona: privateBody }));
  await assert.rejects(create("expert-hidden-skills", { ...expert, skills: [{ content: privateBody }] } as unknown as AgentRunSnapshot));
  await assert.rejects(create("expert-nested-body", { ...expert, expert: { persona: privateBody } } as unknown as AgentRunSnapshot));
  assert.equal((await readdir(store.rootPath)).length, countBeforeRejection);
  for (const name of await readdir(store.rootPath)) {
    const persisted = await readFile(path.join(store.rootPath, name), "utf8");
    assert.equal(persisted.includes(privateBody), false, "private expert content must never reach a ProductRun file");
  }
  console.log("OK expert persona/hidden-skill payloads remain forbidden and never reach ProductRun files");
  console.log("Passed 5 ProductRun snapshot persistence regressions (real file store, isolated disposable directory).");
}
