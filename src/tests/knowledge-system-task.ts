import { normalizeConversationTaskMetadata } from "../agents/task-metadata";
import { taskSummary } from "../agents/task-presentation";
import assert from "node:assert/strict";
import {
  KnowledgeSystemTaskService,
  knowledgeSystemHash,
  type KnowledgeSystemTask,
  type KnowledgeSystemTaskHost,
} from "../knowledge-base/knowledge-system-task";
import { domainMapBlock } from "../knowledge-base/maintenance-tree-map";
import {
  holdMaintenancePages,
  releaseMaintenancePages,
} from "../knowledge-base/maintenance-page-lock";
import {
  createKnowledgeSystemTools,
  knowledgeSystemInlineExtension,
} from "../harness/pi-native/pi-knowledge-system-tools";
import type { KnowledgeDomainAnalysis } from "../knowledge-base/knowledge-system-analysis";

const block = (domain: string, body: string) =>
  `<!-- echoink-domain-map:BEGIN ${encodeURIComponent(domain)} -->\n<!-- echoink-domain-map:MODE list -->\n## ${domain}\n${body}\n<!-- echoink-domain-map:END ${encodeURIComponent(domain)} -->`;
const analysis = (domain: string, paths: string[]): KnowledgeDomainAnalysis => ({
  domain,
  frameworks: ["流程", "能力"].map((title) => ({
    title,
    rationale: "按本领域实际内容组织",
    order: "grouping",
    branches: [
      {
        title: title + "分支",
        rationale: "正文支持",
        entries: paths.map((path) => ({ path, why: "依据全文归位" })),
      },
    ],
    unplaced: [],
    gaps: [],
  })),
});

export async function runKnowledgeSystemTaskTests(): Promise<void> {
  const mapPath = "wiki/共享/index.md",
    a = "wiki/A/甲.md",
    b = "wiki/B/乙.md";
  const initialA = block(
      "A",
      "### 概念\n- [甲](../A/%E7%94%B2.md) <!-- echoink-placement: {\"branch\":\"概念\"} -->\n\n用户手写树内说明。  \n\n### 来源\n[[raw/来源.md]]\n",
    ),
    initialB = block("B", "### 概念\n- [[wiki/B/乙.md]]\n");
  const prefix = "---\ncustom: 0021 # 用户属性\n---\n# 导航\n用户开头。\n\n",
    suffix = "\n用户尾部。\n";
  const files = new Map([
    [mapPath, prefix + initialA + "\n\n" + initialB + suffix],
    [a, "A领域全文" + "具体解释。".repeat(3000)],
    [b, "B领域全文"],
  ]);
  let saved: KnowledgeSystemTask[] = [],
    writes = 0,
    writable = true,
    created = 0;
  const changes: string[] = [];
  const host: KnowledgeSystemTaskHost = {
    vaultRoot: "system-task-fixture",
    load: async () => structuredClone(saved),
    save: async (tasks) => {
      saved = structuredClone([...tasks]);
    },
    discover: async (domain) => {
      const paths = domain === "A" ? [a] : [b];
      return {
        documents: paths.map((path) => ({
          path,
          content: files.get(path)!,
          revision: knowledgeSystemHash(files.get(path)!),
        })),
        mapPath,
        block: domainMapBlock(files.get(mapPath)!, domain),
        bindingRevision: 1,
        declined: [],
      };
    },
    createConversation: async (domain) => `${domain}-conversation-${++created}`,
    assertAccess: async (_task, write) => {
      if (write && !writable) throw new Error("当前只读");
    },
    read: async (path) => files.get(path) ?? null,
    write: async (task, signal) => {
      if (signal.aborted) throw new Error("stopped");
      assert.equal(files.get(task.write!.path) ?? null, task.write!.before);
      writes++;
      files.set(task.write!.path, task.write!.after);
    },
    changed: (task) => {
      changes.push(`${task.domain}:${task.phase}`);
    },
  };
  let service = new KnowledgeSystemTaskService(host);
  await service.ready;
  const [{ task: ta }, repeated] = await Promise.all([
    service.start("A", "knowledge-owner"),
    service.start("A", "knowledge-owner"),
  ]);
  assert.equal(ta.id, repeated.task.id);
  assert.equal(created, 1, "same-domain launch is deduplicated before IO");
  await service.beginTurn(ta.conversationId);
  const proposalA = analysis("A", [a]);
  await assert.rejects(service.propose(ta.conversationId, proposalA), /读完/u);
  await assert.rejects(service.readNext(ta.conversationId, b), /冻结/u);
  await assert.rejects(service.readNext(ta.conversationId, a, 12), /跳过/u);
  const first = await service.readNext(ta.conversationId);
  assert.equal(first.start, 0);
  assert.equal(first.end, 12000);
  assert.equal(service.readCount(ta), 0, "a partial article is not a completed full read");
  await service.stop(ta.conversationId);
  assert.equal(ta.phase, "interrupted");
  service = new KnowledgeSystemTaskService(host);
  await service.ready;
  assert.equal(await service.resume(ta.conversationId), "model");
  await service.beginTurn(ta.conversationId);
  const next = await service.readNext(ta.conversationId);
  assert.equal(next.start, 12000, "cold resume continues at the saved character offset");
  while (service.readCount(service.get(ta.id)) < 1) await service.readNext(ta.conversationId);
  assert.equal(writes, 0);
  assert.equal(
    files.get(mapPath),
    prefix + initialA + "\n\n" + initialB + suffix,
    "reads/proposals never change notes",
  );
  await service.propose(ta.conversationId, proposalA);
  const beforeAdjustment = service.confirmation(service.get(ta.id), 0);
  await service.beginTurn(ta.conversationId);
  await assert.rejects(service.confirm(beforeAdjustment), /选择|失效/u);
  const adjusted = structuredClone(proposalA);
  adjusted.frameworks[0].branches[0].title = "调整后的分支";
  await service.propose(ta.conversationId, adjusted);
  await assert.rejects(service.confirm(beforeAdjustment), /失效/u);
  const taskA = service.get(ta.id),
    current = service.confirmation(taskA, 0);
  const beforeColdCard = changes.length;
  service = new KnowledgeSystemTaskService(host);
  await service.ready;
  assert.ok(
    changes.slice(beforeColdCard).includes("A:awaiting-confirmation"),
    "a durable card restores its waiting metadata after generic runtime startup",
  );
  await service.stop(ta.conversationId);
  service = new KnowledgeSystemTaskService(host);
  await service.ready;
  assert.equal(await service.resume(ta.conversationId), "restored");
  assert.equal(
    service.get(ta.id).proposal!.version,
    current.proposalVersion,
    "card-stage interruption keeps the exact proposal binding",
  );
  writable = false;
  await assert.rejects(service.confirm(current), /只读/u);
  assert.equal(writes, 0);
  writable = true;
  for (const patch of [
    { conversationId: "wrong" },
    { taskId: "wrong" },
    { operationsDigest: "wrong" },
    { proposalVersion: current.proposalVersion - 1 },
  ])
    await assert.rejects(service.confirm({ ...current, ...patch }));
  const { task: tb } = await service.start("B", "other-owner");
  await service.beginTurn(tb.conversationId);
  await service.readNext(tb.conversationId);
  await service.propose(tb.conversationId, analysis("B", [b]));
  holdMaintenancePages("maintain-fixture", host.vaultRoot, [mapPath]);
  const pending = service.confirm(current);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(writes, 0);
  assert.equal(service.get(ta.id).phase, "waiting-maintain");
  releaseMaintenancePages("maintain-fixture");
  await pending;
  assert.equal(service.get(ta.id).phase, "completed");
  const afterA = files.get(mapPath)!;
  assert.equal(domainMapBlock(afterA, "B"), initialB);
  assert.ok(afterA.startsWith(prefix));
  assert.ok(afterA.endsWith(suffix));
  assert.ok(afterA.includes("用户手写树内说明。  "));
  assert.ok(afterA.includes("### 来源\n[[raw/来源.md]]"));
  assert.ok(afterA.includes("MODE tree"));
  assert.ok(afterA.includes("调整后的分支"));
  assert.ok(!afterA.includes("echoink-placement"), "Reorganizing consumes old pending suggestions");
  assert.ok(
    !afterA.includes("../A/%E7%94%B2.md"),
    "old managed list is replaced rather than duplicated",
  );
  assert.ok(!afterA.includes("依据全文归位"), "proposal reasons never enter maps");
  await service.confirm(service.confirmation(tb, 1));
  assert.equal(domainMapBlock(files.get(mapPath)!, "A"), domainMapBlock(afterA, "A"));
  assert.equal(service.get(tb.id).selected, 1);
  assert.equal(writes, 2, "shared-file writes preserve the other domain");
  await service.dispose();

  // The registered proposal tool has no write authority, and the inline extension refuses all other tools.
  const toolService = new KnowledgeSystemTaskService(host);
  await toolService.ready;
  const { task: tc } = await toolService.start("A", "knowledge-owner");
  const handlers = new Map<string, (event: unknown) => Promise<unknown>>();
  const extension = knowledgeSystemInlineExtension(
    toolService,
    tc.conversationId,
    async () => "真实负责人身份",
  );
  await extension.factory({
    on: (name: string, handler: (event: unknown) => Promise<unknown>) =>
      handlers.set(name, handler),
  } as never);
  const prompt = (await handlers.get("before_agent_start")!({ systemPrompt: "base" })) as {
    systemPrompt: string;
  };
  assert.ok(prompt.systemPrompt.includes("真实负责人身份"));
  assert.deepEqual(await handlers.get("tool_call")!({ toolName: "note_update" }), {
    block: true,
    reason: "梳理会话只允许读取全文和提交提案。",
  });
  assert.deepEqual(
    createKnowledgeSystemTools(toolService, tc.conversationId).map((tool) => tool.name),
    ["knowledge_system_read", "knowledge_system_propose"],
  );
  await toolService.detach(tc.conversationId);
  assert.equal(toolService.ownsConversation(tc.conversationId), false);
  const newTask = await toolService.start("A", "knowledge-owner");
  assert.notEqual(
    newTask.task.conversationId,
    tc.conversationId,
    "archived/deleted checkpoints cannot capture the next launch",
  );
  newTask.task.moveProgress = { moved: [], linked: [], currentMove: "wiki/A1.md" };
  newTask.task.phase = "interrupted";
  await assert.rejects(toolService.prepareStatusChange(newTask.task.conversationId, "deleted"), /先继续或归档/u);
  await toolService.prepareStatusChange(newTask.task.conversationId, "archived");
  await toolService.detach(newTask.task.conversationId);
  assert.equal(toolService.ownsConversation(newTask.task.conversationId), true,
    "An interrupted in-flight rename retains its checkpoint when archived");
  assert.equal((await toolService.start("A", "knowledge-owner")).task.id, newTask.task.id,
    "Relaunch resumes the same pending work rather than making a second move plan");
  newTask.task.phase = "completed";
  await toolService.detach(newTask.task.conversationId);
  assert.equal(toolService.ownsConversation(newTask.task.conversationId), false);
  const metadata = normalizeConversationTaskMetadata({
    taskStatus: "completed",
    resultSummary: "已梳理：1 条知识、1 个分支。",
  });
  assert.equal(
    taskSummary(metadata as never, {
      messages: [{ role: "assistant", text: "旧提案已准备好" } as never],
    }),
    metadata.resultSummary,
  );
  await toolService.dispose();
  console.log(
    "PASS knowledge system 3A: full-text chunk coverage, cold read/card resume, exact confirmation i" +
      "dentities, adjustment revocation, read-only denial, shared indexes, Maintain wait, handwritten/" +
      "provenance preservation and read/proposal-only tools.",
  );
}
