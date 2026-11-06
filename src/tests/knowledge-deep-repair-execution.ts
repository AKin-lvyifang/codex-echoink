import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { sha256Hex } from "../utils/sha256";
import {
  KnowledgeUpgradeService,
  type KnowledgeUpgradeHost,
} from "../plugin/knowledge-upgrade-service";
import type { KnowledgeMaintenanceRecord } from "../knowledge-base/maintenance-record";
import { emptyKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";

const delay = () => new Promise((resolve) => setTimeout(resolve, 5));
async function settled(service: KnowledgeUpgradeService) {
  for (let i = 0; i < 1000 && service.running; i++) await delay();
  assert.equal(service.running, false);
  return service.getUpgradeSnapshot();
}
export async function runKnowledgeDeepRepairExecutionTests(root: string) {
  const vault = path.join(root, "deep-repair-execution");
  await fs.mkdir(path.join(vault, "Wiki"), { recursive: true });
  const originals = {
    "Wiki/home.md": "# Home\nExisting fact.\n",
    "Wiki/source.md": "# Source\nUnique fact.\n",
  };
  for (const [name, content] of Object.entries(originals))
    await fs.writeFile(path.join(vault, name), content);
  let records: KnowledgeMaintenanceRecord[] = [],
    writes = 0,
    moves = 0,
    models = 0,
    decisions = 0;
  let block = true;
  const bindings = emptyKnowledgeFolderBindings();
  const host: KnowledgeUpgradeHost = {
    vaultRoot: vault,
    bindings: () => bindings,
    records: async () => structuredClone(records),
    save: async (record) => {
      records = [structuredClone(record)];
    },
    createTask: async () => "deep-repair-test-task",
    taskStatus: async () => {},
    registerRoots: async () => bindings.revision,
    classify: async () => {
      models++;
      throw new Error("Confirmed repairs must never reclassify");
    },
    write: async (write, _record, signal) => {
      assert.equal(
        sha256Hex(await fs.readFile(path.join(vault, write.path), "utf8")),
        write.expectedVersion,
      );
      await fs.writeFile(path.join(vault, write.path), write.content);
      writes++;
      if (block) {
        block = false;
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      }
      return { done: true, revision: sha256Hex(write.content) };
    },
    repairMove: async (from, to) => {
      moves++;
      await fs.mkdir(path.dirname(path.join(vault, to)), { recursive: true });
      await fs.rename(path.join(vault, from), path.join(vault, to));
    },
    repairDecision: async () => {
      decisions++;
    },
    changed: () => {},
    notice: () => {},
  };
  const after = {
    "Wiki/home.md": "# Home\nExisting fact.\nUnique fact.\n",
    "Wiki/source.md": '---\n已合并到: "[[Wiki/home]]"\n---\n# Source\nUnique fact.\n',
  };
  let service = new KnowledgeUpgradeService(host);
  await service.ready;
  const preview = await service.prepareRepairs(
    Object.entries(originals).map(([name, content]) => ({
      path: name,
      title: name,
      content,
      revision: sha256Hex(content),
      after: after[name as keyof typeof after],
      descriptions: ["合并"],
    })),
    [],
    [
      {
        id: "merge-pair",
        kind: "duplicate",
        title: "Source ↔ Home",
        path: "Wiki/source.md",
        action: "合并",
        affectedPaths: ["Wiki/home.md", "Wiki/source.md"],
        operationIds: ["archive-source"],
      },
    ],
    {
      stopOnFailure: true,
      moves: [
        {
          id: "archive-source",
          from: "Wiki/source.md",
          to: "Wiki/已合并/source.md",
          revision: sha256Hex(after["Wiki/source.md"]),
        },
      ],
    },
  );
  await service.confirmUpgrade(preview.id);
  for (let i = 0; i < 1000 && !writes && service.running; i++) await delay();
  assert.equal(writes, 1, JSON.stringify(await service.getUpgradeSnapshot()));
  await service.stopUpgrade();
  assert.equal((await service.getUpgradeSnapshot()).status, "interrupted");
  assert.equal(writes, 1);
  assert.equal(moves, 0);
  const primaryHash = sha256Hex(await fs.readFile(path.join(vault, "Wiki/home.md"), "utf8"));
  await fs.appendFile(path.join(vault, "Wiki/home.md"), "External edit during interruption.\n");
  service = new KnowledgeUpgradeService(host);
  await service.ready;
  await service.resumeUpgrade();
  const changed = await settled(service);
  assert.equal(changed.status, "interrupted");
  assert.equal(writes, 1, "A changed completed file stops the remaining writes");
  assert.equal(moves, 0);
  assert.ok((await fs.readFile(path.join(vault, "Wiki/home.md"), "utf8")).endsWith("External edit during interruption.\n"));
  await fs.writeFile(path.join(vault, "Wiki/home.md"), after["Wiki/home.md"]);
  await service.resumeUpgrade();
  const done = await settled(service);
  assert.equal(done.status, "completed", JSON.stringify(done));
  assert.equal(writes, 2, "Cold recovery only writes the remaining file");
  assert.equal(moves, 1);
  assert.equal(models, 0);
  assert.equal(done.checkupResults?.[0].status, "success");
  assert.equal(sha256Hex(await fs.readFile(path.join(vault, "Wiki/home.md"), "utf8")), primaryHash);
  assert.equal(
    await fs.readFile(path.join(vault, "Wiki/已合并/source.md"), "utf8"),
    after["Wiki/source.md"],
  );

  const bad = await service.prepareRepairs(
    [],
    [],
    [
      {
        id: "bad-model",
        kind: "duplicate",
        title: "合并缺失小节",
        path: "Wiki/home.md",
        action: "合并",
        affectedPaths: [],
        failure: "被并页小节缺少去向，本项不写入。",
      },
    ],
  );
  await service.confirmUpgrade(bad.id);
  assert.equal((await settled(service)).checkupResults?.[0].status, "failed");
  assert.equal(writes, 2, "Validation failure is reported without writing or retrying the model");
  const separated = await service.prepareRepairs(
    [],
    [],
    [
      {
        id: "separate",
        kind: "nearDomain",
        title: "A ↔ B",
        path: "Wiki/home.md",
        action: "保持分开",
        affectedPaths: [],
        operationIds: ["decision"],
      },
    ],
    { decisions: [{ id: "decision", domains: ["A", "B"] }] },
  );
  await service.confirmUpgrade(separated.id);
  assert.equal((await settled(service)).checkupResults?.[0].status, "success");
  assert.equal(decisions, 1);
  assert.equal(models, 0);
  assert.equal(writes, 2);
  console.log(
    "PASS deep repair execution: original executor, durable write/rename steps, cold remaining-only recovery, zero model replay, validation receipt and setting-only decision.",
  );
}
