import assert from "node:assert/strict";
import { planDeepCheckup } from "../knowledge-base/knowledge-deep-checkup-plan";
import { KnowledgeDeepCheckupTaskService, type DeepCheckupHost } from "../knowledge-base/knowledge-deep-checkup-task";
import { parseDeepCheckupFindings, type DeepCheckupDocument, type DeepCheckupTask } from "../knowledge-base/knowledge-deep-checkup";
import { sha256Hex } from "../utils/sha256";

export async function runKnowledgeDeepCheckupTests() {
  const make = (path: string, domain: string, content: string): DeepCheckupDocument => ({
    path, domain, content, revision: sha256Hex(content), notDuplicates: [], outdatedHandled: false,
  });
  const docs = Array.from({ length: 30 }, (_, i) => make(`Wiki/笔记${i}.md`, i < 22 ? "A" : "B",
    `文章讨论第${i}个具体研究问题。` + `材料${i}专有名词与执行细节。`.repeat(20)));
  const duplicate = "用户招募采用连续四周的实际使用频率筛选，研究样本分成新用户与熟练用户两组。";
  docs[0] = make(docs[0].path, "A", duplicate);
  docs[29] = make(docs[29].path, "B", duplicate + "研究笔记原始记录。");
  const plan = planDeepCheckup(docs);
  assert.equal(plan.filter((batch) => !batch.scope).flatMap((batch) => batch.primary).length, docs.length);
  assert.equal(new Set(plan.flatMap((batch) => batch.primary)).size, docs.length);
  assert.ok(plan.filter((batch) => batch.domain === "A").length >= 3);
  assert.ok(plan.some((batch) => batch.primary.includes(docs[0].path) && batch.paths.includes(docs[29].path)),
    "Misclassified cross-domain duplicate is shortlisted from body terms");
  assert.ok(plan.filter((batch) => !batch.scope)
    .every((batch) => batch.primary.length <= 8 && batch.paths.length <= 16));
  assert.ok(plan.some((batch) => batch.scope === "domains" && batch.paths.length <= 16 &&
    new Set(batch.paths.map(path => docs.find(doc => doc.path === path)!.domain)).size === 2),
    "Domain review caps representative full texts even when its character budget would fit every note");
  const aliasDocs = Array.from({ length: 20 }, (_, index) => make(`Wiki/独立${index}.md`, index < 19 ? "甲" : "乙",
    index === 0 ? "甲文讲述独立的业务规则。" : index === 19 ? "A mutex ticket guards repeated submissions." : `无关材料第${index}篇的说明。`));
  aliasDocs[0].title = "提交门闩";
  aliasDocs[19].title = "请求重放";
  aliasDocs[0].aliases = ["同一个请求机制"];
  aliasDocs[19].aliases = ["同一个请求机制"];
  assert.ok(planDeepCheckup(aliasDocs).some(batch => !batch.scope &&
    batch.paths.includes(aliasDocs[0].path) && batch.paths.includes(aliasDocs[19].path)),
  "A shared alias recalls a differently worded cross-domain document");
  const batch = plan.find((batch) => batch.primary.includes(docs[0].path))!;
  const input = docs.filter((doc) => batch.paths.includes(doc.path));
  const finding = {
    kind: "duplicate", confidence: "high", paths: [docs[0].path, docs[29].path], reason: "同一对象及筛选条件。",
    evidence: [{ path: docs[0].path, quote: duplicate }, { path: docs[29].path, quote: duplicate }],
  };
  assert.equal(parseDeepCheckupFindings(JSON.stringify([finding]), input).findings.length, 1);
  const mixed = parseDeepCheckupFindings(JSON.stringify([finding, { ...finding,
    evidence: [...finding.evidence, { path: docs[29].path, quote: "不存在的模型自造依据。" }],
  }]), input);
  assert.equal(mixed.findings.length, 1, "A valid finding survives a bad neighbour in the same response");
  assert.equal(mixed.discarded.length, 1);
  const typographyDocs = [make("Wiki/甲.md", "A", "同一对象（甲），只能在授权期间保留材料。"),
    make("Wiki/乙.md", "A", "同一对象（乙），只能在授权期间保留材料。")];
  const grounded = parseDeepCheckupFindings(JSON.stringify([{ ...finding,
    paths: typographyDocs.map(doc => doc.path), evidence: typographyDocs.map(doc => ({ path: doc.path,
      quote: doc.content.replace(/（/gu, "(").replace(/）/gu, ")").replace(/，/gu, ",") })),
  }]), typographyDocs);
  assert.equal(grounded.findings.length, 1);
  assert.equal(grounded.findings[0].evidence[0].quote, typographyDocs[0].content,
    "Normalized matches retain the exact source quote for later paragraph repairs");
  docs[0].notDuplicates = [docs[29].path];
  assert.equal(parseDeepCheckupFindings(JSON.stringify([finding]), input).findings.length, 0);
  docs[0].notDuplicates = [];
  const outdated = {
    kind: "outdated", confidence: "uncertain", paths: [docs[0].path], reason: "需要核对适用时间。",
    evidence: [{ path: docs[0].path, quote: duplicate }],
  };
  docs[0].outdatedHandled = true;
  assert.equal(parseDeepCheckupFindings(JSON.stringify([outdated]), input).findings.length, 0);
  docs[0].outdatedHandled = false;
  const withoutConfidence = { ...outdated, confidence: undefined };
  assert.equal(parseDeepCheckupFindings(JSON.stringify([withoutConfidence]), input).findings.length, 1,
    "Only duplicate findings require a confidence classification");
  const near = { ...finding, kind: "nearDomain", confidence: undefined };
  assert.equal(parseDeepCheckupFindings(JSON.stringify([near]), input).findings.length, 0);
  assert.equal(parseDeepCheckupFindings(JSON.stringify({ ...near, near: true }), input, "domains").findings.length, 1);
  assert.equal(parseDeepCheckupFindings(JSON.stringify({ near: false, reason: "业务边界不同" }), input, "domains").findings.length, 0);

  let saved: DeepCheckupTask | null = null;
  const calls: string[] = [];
  let service: KnowledgeDeepCheckupTaskService;
  let stopped = false;
  const host: DeepCheckupHost = {
    assertModel: () => {},
    documents: async () => structuredClone(docs),
    read: async (path) => docs.find((doc) => doc.path === path) ?? null,
    load: async () => structuredClone(saved),
    save: async (task) => { saved = structuredClone(task); },
    generate: async (prompt) => {
      const input = JSON.parse(prompt.split("\n").at(-1)!) as { primary: string[] };
      calls.push(input.primary.join("|"));
      if (prompt.startsWith("只读核对两个知识领域")) return JSON.stringify({ near: false, reason: "测试无近义领域" });
      return JSON.stringify(input.primary.includes(docs[0].path) ? [outdated] : []);
    },
  };
  service = new KnowledgeDeepCheckupTaskService(host);
  service.subscribe(() => {
    if (!stopped && saved?.batches.some((batch) => batch.completedAt)) {
      stopped = true;
      void service.stop();
    }
  });
  const wait = async (target: "interrupted" | "completed") => {
    for (let i = 0; i < 200; i++) {
      if ((await service.snapshot()).status === target) return;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error("Deep checkup did not settle");
  };
  await service.start();
  await wait("interrupted");
  assert.equal(calls.length, 1);
  service = new KnowledgeDeepCheckupTaskService(host);
  await service.ready;
  assert.equal((await service.snapshot()).findings.length, 1, "Findings survive a cold service restore");
  await service.resume();
  await wait("completed");
  assert.equal(new Set(calls).size, calls.length, "Completed batches never bill again on resume");
  assert.equal(calls.length, plan.length);
  const before = docs[0].content;
  docs[0].content += "用户修改了内容。";
  docs[0].revision = sha256Hex(docs[0].content);
  assert.equal((await service.snapshot()).findings.length, 0, "Changed content invalidates the finding");
  assert.equal((await service.snapshot()).invalidated, 1);
  docs[0].content = before;
  docs[0].revision = sha256Hex(before);
  docs[0].outdatedHandled = true;
  assert.equal((await service.snapshot()).findings.length, 0, "Handled outdated findings are suppressed");
  await service.dispose();
  const largeDocs = Array.from({ length: 410 }, (_, i) => make(`Wiki/成本${i}.md`, "A",
    `第${i}篇内容差异。` + "这是充分的知识正文，检查批次需要按全文长度规划。".repeat(50)));
  let expensiveCalls = 0, plannedCalls = 0, maximumCalls = 0;
  const expensive = new KnowledgeDeepCheckupTaskService({ ...host, load: async () => null,
    documents: async () => largeDocs, save: async () => {},
    generate: async () => { expensiveCalls++; return "[]"; } });
  await expensive.start();
  assert.equal(expensiveCalls, 0, "More than fifty batches require explicit cost consent at the service boundary");
  await expensive.start(async (count, maximum) => { plannedCalls = count; maximumCalls = maximum; return false; });
  assert.ok(plannedCalls > 50);
  assert.equal(maximumCalls, plannedCalls * 2);
  assert.equal(expensiveCalls, 0, "Declining the estimate does not call the model or replace the task");
  await expensive.dispose();
  const retryDocs = Array.from({ length: 17 }, (_, index) => make(`Wiki/重试${index}.md`, "A",
    index < 2 ? duplicate : `第${index}篇的独立业务材料与判断。`));
  const validRetry = { ...finding, paths: retryDocs.slice(0, 2).map(doc => doc.path),
    evidence: retryDocs.slice(0, 2).map(doc => ({ path: doc.path, quote: duplicate })) };
  let retrySaved: DeepCheckupTask | null = null, repairedResponse = false;
  const retryCalls: string[] = [];
  const retryHost: DeepCheckupHost = { ...host,
    documents: async () => retryDocs, read: async path => retryDocs.find(doc => doc.path === path) ?? null,
    load: async () => structuredClone(retrySaved), save: async task => { retrySaved = structuredClone(task); },
    generate: async prompt => {
      const primary = (JSON.parse(prompt.split("\n").at(-1)!) as { primary: string[] }).primary;
      retryCalls.push(primary.join("|"));
      return primary.includes(retryDocs[0].path) && !repairedResponse
        ? JSON.stringify([validRetry, { ...validRetry, evidence: [] }]) : "[]";
    },
  };
  let retryService = new KnowledgeDeepCheckupTaskService(retryHost);
  await retryService.start();
  while ((await retryService.snapshot()).status === "running") await new Promise(resolve => setTimeout(resolve, 1));
  const partial = await retryService.snapshot();
  assert.equal(partial.status, "interrupted");
  assert.equal(partial.findings.length, 1, "Valid findings survive both failed response attempts");
  assert.equal(partial.completedBatches, partial.totalBatches - 1, "One bad batch does not prevent checking the rest");
  assert.equal(retryCalls.length, partial.totalBatches + 1, "Only the bad batch gets one automatic retry");
  repairedResponse = true;
  retryService = new KnowledgeDeepCheckupTaskService(retryHost);
  await retryService.resume();
  while ((await retryService.snapshot()).status === "running") await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal((await retryService.snapshot()).status, "completed");
  assert.equal(retryCalls.length, partial.totalBatches + 2, "Cold resume pays only for the remaining batch");
  assert.equal((await retryService.snapshot()).findings.length, 1);
  await retryService.dispose();
  let invalidJsonCalls = 0;
  const jsonService = new KnowledgeDeepCheckupTaskService({ ...retryHost,
    documents: async () => retryDocs.slice(0, 2), load: async () => null, save: async () => {},
    generate: async () => ++invalidJsonCalls === 1 ? "{broken" : "[]",
  });
  await jsonService.start();
  while ((await jsonService.snapshot()).status === "running") await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(invalidJsonCalls, 2);
  assert.equal((await jsonService.snapshot()).status, "completed");
  await jsonService.dispose();
  let providerCalls = 0;
  const unavailableService = new KnowledgeDeepCheckupTaskService({ ...retryHost,
    load: async () => null, save: async () => {},
    generate: async () => { providerCalls++; throw new Error("模型连接失败"); },
  });
  await unavailableService.start();
  while ((await unavailableService.snapshot()).status === "running") await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(providerCalls, 1, "Connection failures stop the run instead of spending retries across all batches");
  assert.equal((await unavailableService.snapshot()).status, "interrupted");
  assert.equal((await unavailableService.snapshot()).completedBatches, 0);
  await unavailableService.dispose();
  console.log("PASS deep checkup: bounded cross-domain candidates, exact quotes, declined pairs, persisted stop/resume and stale findings.");
}
