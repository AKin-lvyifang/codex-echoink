import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { KnowledgeAgentIndex } from "../knowledge-base/knowledge-agent-index";
import { KnowledgeRetriever, formatKnowledgeReferencesForPrompt } from "../knowledge-base/query";
import { extractKnowledgeLinks, extractKnowledgeApplicability, resolveKnowledgeLink } from "../knowledge-base/knowledge-relations";
import { completeKnowledgeMaintenanceCandidateSources, echoInkKnowledgeMaintenanceProtocolPrompt } from "../knowledge-base/knowledge-maintenance-protocol";
import { PiKnowledgeReadToolSecurity, createPiKnowledgeReadToolDefinitions } from "../harness/pi-native/pi-knowledge-read-tools";
import { EchoInkVaultToolEgressPolicy } from "../harness/pi-native/vault-tool-result-safety";
import { knowledgeReadingState } from "../harness/pi-native/knowledge-ask-protocol";
import { createProductionPiKnowledgeRuntime, createPiKnowledgeInlineExtension } from "../plugin/pi-production-runtime-composition";

export async function runKnowledgeAssociativeReadingTests(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "echoink-associative-"));
  const vaultPath = path.join(root, "vault");
  const storageRootPath = path.join(root, "state");
  const write = async (name: string, content: string) => {
    const target = path.join(vaultPath, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  };
  try {
    const links = extractKnowledgeLinks('[[B#时间|别名]] [现场](../raw/B%20C.md#标题)\n`[[非链接]]`\n```md\n[[示例]]\n```\n<!-- [[注释]] -->\n[[坏%ZZ]] [网页](https://example.com)');
    assert.deepEqual(links.map((link) => link.target), ["B", "../raw/B C.md", "坏%ZZ"]);
    assert.equal(links[0].anchor, "时间");
    assert.equal(extractKnowledgeLinks("[实际费用](./费用(实际).md)")[0].target, "./费用(实际).md");
    assert.deepEqual(extractKnowledgeLinks("````md\n```md\n[[仅为示例]]\n```\n````\n[[真实]]").map((link) => link.target), ["真实"]);
    assert.deepEqual(extractKnowledgeApplicability("- 对象：2026上海大会\n```md\n- 对象：2025北京大会\n```"), { subjects: ["2026上海大会"] });
    assert.deepEqual(resolveKnowledgeLink({ link: extractKnowledgeLinks("[[duplicate]]")[0], sourcePath: "wiki/A.md", paths: ["wiki/duplicate.md", "projects/duplicate.md"], resolveAlias: (value) => value, hostResolver: () => "wiki/duplicate.md" }), ["wiki/duplicate.md"]);
    for (const platform of [path.posix, path.win32, path.posix]) {
      const source = platform.join("wiki", "case", "A.md").replace(/\\/gu, "/");
      const link = extractKnowledgeLinks(platform === path.win32 ? '[[..\\B.md#标题]]' : '[[../B.md#标题]]')[0];
      assert.deepEqual(resolveKnowledgeLink({ link, sourcePath: source, paths: ["wiki/B.md"], resolveAlias: (value) => value }), ["wiki/B.md"]);
    }
    const source = ["# A", "MAIN_ONLY_TOKEN", ...Array.from({ length: 90 }, (_, i) => `背景第${i}行`), "[[B#时间|现场说明]]", "[[missing]]", "[[duplicate]]", "[[../../private-note.md]]", ...Array.from({ length: 12 }, (_, i) => `[[extra-${i}]]`)].join("\n");
    await write("wiki/A.md", source);
    await write("wiki/B.md", "# B\n## 时间\n14:20 集合\n");
    await write("wiki/back.md", "# Back\n归还设备次日10:30\n[[A]]\n");
    await write("wiki/x/duplicate.md", "# 甲\n自由格式\n");
    await write("projects/y/duplicate.md", "# 乙\n没有元数据\n");
    await write("private-note.md", "不应被关系解析扩权读取");
    const index = new KnowledgeAgentIndex({ vaultPath, storageRootPath, linkResolver: () => { throw new Error("host cache unavailable"); } });
    await index.refresh();
    const retriever = new KnowledgeRetriever(vaultPath, { agentIndex: index });
    const first = await retriever.retrieve({ question: "MAIN_ONLY_TOKEN", limit: 1 });
    assert.equal(first.status, "ready");
    assert.ok(first.references[0].lineEnd < 90);
    assert.equal(first.references[0].hasMore, true);
    assert.ok(first.references[0].related?.items.some((item) => item.target?.vaultRelativePath === "wiki/B.md"));
    assert.match(formatKnowledgeReferencesForPrompt(first.references), /仅交付片段/u);
    const page = await index.related({ vaultRelativePath: "wiki/A.md", limit: 50 });
    assert.ok(page.items.some((item) => item.direction === "incoming" && item.source.vaultRelativePath === "wiki/back.md"));
    const ambiguous = page.items.find((item) => item.original === "[[duplicate]]")!;
    assert.equal(ambiguous.status, "ambiguous");
    assert.equal(ambiguous.candidates?.length, 2);
    assert.equal(page.items.find((item) => item.original.includes("private-note"))?.target, undefined);
    assert.equal(page.items.find((item) => item.original === "[[missing]]")?.status, "unresolved");
    const small = await index.search({ mode: "related", vaultRelativePath: "wiki/A.md", limit: 2 });
    const next = await index.search({ mode: "related", vaultRelativePath: "wiki/A.md", limit: 2, cursor: small.continuationCursor });
    assert.equal(small.hasMore, true);
    assert.equal(next.related?.items[0].original, page.items[2].original);
    assert.equal((await new KnowledgeAgentIndex({ vaultPath, storageRootPath }).related({ vaultRelativePath: "wiki/A.md" })).total, page.total, "persisted links rebuild incoming edges without rereading unchanged bodies");

    const identity = { vaultId: "test", conversationId: "test", piSessionId: "test", productRunId: "test" };
    const observed: string[] = [];
    const security = new PiKnowledgeReadToolSecurity({ currentRunIdentity: () => identity, currentWorkflow: () => "ask", onSourceRead: (ref) => observed.push(ref.referenceId), egress: new EchoInkVaultToolEgressPolicy() });
    const tools = createPiKnowledgeReadToolDefinitions({ retriever, security });
    let sequence = 0;
    const call = async (name: "knowledge_search" | "knowledge_read", input: Record<string, unknown>, targetSecurity = security) => {
      const id = `case-${++sequence}`;
      const targetTools = targetSecurity === security ? tools : createPiKnowledgeReadToolDefinitions({ retriever, security: targetSecurity });
      assert.equal(await targetSecurity.handleToolCall({ toolName: name, toolCallId: id, input } as never, undefined), undefined);
      try { await targetTools.find((tool) => tool.name === name)!.execute(id, input, undefined, undefined); } catch { /* safe result owns failure */ }
      const result = await targetSecurity.handleToolResult({ toolName: name, toolCallId: id, isError: false } as never);
      return { role: "toolResult" as const, toolName: name, toolCallId: id, timestamp: Date.now(), ...result };
    };
    const read = await call("knowledge_read", { vaultRelativePath: "wiki/A.md", expectedContentRevision: first.references[0].contentRevision, lineCount: 2 });
    assert.equal(read.isError, false);
    const body = JSON.parse(read.content[0].text);
    assert.equal(body.lineEnd, 2);
    assert.equal(body.related.hasMore, true);
    assert.ok(body.related.items.some((item: { target?: { vaultRelativePath: string } }) => item.target?.vaultRelativePath === "wiki/B.md"));
    assert.equal(observed.length, 1);
    const denied = new PiKnowledgeReadToolSecurity({ currentRunIdentity: () => identity, currentWorkflow: () => "ask", onSourceRead: () => assert.fail("denied result counted as read"), egress: { assertAllowed() { throw new Error("denied"); } } });
    const refused = await call("knowledge_read", { vaultRelativePath: "wiki/A.md", expectedContentRevision: first.references[0].contentRevision }, denied);
    assert.equal(refused.isError, true);
    const state = knowledgeReadingState(first.references, [read, refused] as never);
    assert.match(state, /"lines":\[1,2\]/u);
    assert.match(state, /knowledge_read_failed/u);
    assert.ok(!state.includes('"path":"wiki/B.md"'), "relation candidate is not a delivered body");
    assert.equal(knowledgeReadingState([], []), "", "new turn does not inherit reads");

    await write("wiki/long.md", "L".repeat(50_000));
    index.invalidate("wiki/long.md");
    const long = (await index.search({ query: "long" })).hits[0];
    const truncated = await call("knowledge_read", { vaultRelativePath: long.vaultRelativePath, expectedContentRevision: long.contentRevision });
    assert.equal(truncated.details.truncated, true);
    assert.equal(truncated.details.references, undefined);
    assert.equal(observed.length, 1);

    await write("wiki/B.md", "# B\n已变更为14:40\n");
    index.invalidate("wiki/B.md");
    await assert.rejects(index.search({ mode: "related", vaultRelativePath: "wiki/A.md", cursor: small.continuationCursor }), { code: "cursor_stale" });
    const stale = await call("knowledge_read", { vaultRelativePath: "wiki/B.md", expectedContentRevision: body.related.items.find((item: { target?: { vaultRelativePath: string } }) => item.target?.vaultRelativePath === "wiki/B.md").target.contentRevision });
    assert.equal(stale.isError, true);
    assert.match(stale.content[0].text, /source_changed/u);
    assert.equal((await index.read({ vaultRelativePath: "wiki/A.md" })).content, source);

    await write("raw/notice.md", "# 通知\n设备租赁需正式发票。截止9月30日17:00。\n");
    index.invalidate();
    const raw = await index.read({ vaultRelativePath: "raw/notice.md" });
    const candidate = completeKnowledgeMaintenanceCandidateSources({ targetPath: "wiki/notice.md", content: "# 结算须知\n设备租赁需正式发票。\n## 适用范围与关联\n- 对象：上海大会\n- 适用时间：活动结束后的结算阶段\n- 资料性质：报销规则\n- 对照材料：[[A]]，该活动的总览。\n[[broken-relation]]\n", selectedSources: [{ relativePath: raw.vaultRelativePath, contentSha256: raw.contentRevision.slice(7) }] });
    await write("wiki/notice.md", candidate);
    index.invalidate("wiki/notice.md");
    const maintained = (await index.search({ query: "结算须知" })).hits.find((hit) => hit.vaultRelativePath === "wiki/notice.md")!;
    assert.equal(maintained.documentKind, "报销规则");
    assert.deepEqual(maintained.subjects, ["上海大会"]);
    const linked = await call("knowledge_read", { vaultRelativePath: maintained.vaultRelativePath, expectedContentRevision: maintained.contentRevision });
    assert.equal(JSON.parse(linked.content[0].text).applicability.applicableTime, "活动结束后的结算阶段");
    assert.ok(JSON.parse(linked.content[0].text).related.items.some((item: { target?: { vaultRelativePath: string } }) => item.target?.vaultRelativePath === "raw/notice.md"));
    assert.match(echoInkKnowledgeMaintenanceProtocolPrompt(), /字段全部可选/u);

    const production = createProductionPiKnowledgeRuntime({ vaultRootPath: vaultPath, knowledgeAgentIndex: index, knowledgePreferences: {} as never, usage: {} as never });
    const preflight = await production.retrieveAsk({ ...identity, question: "MAIN_ONLY_TOKEN", explicitPaths: [], includeUnrefined: false });
    assert.match(preflight.providerResourceText, /mode=related/u);
    const partial = await retriever.retrieve({ question: "MAIN_ONLY_TOKEN", explicitPaths: ["wiki/deleted.md"] });
    assert.equal(partial.status, "ready");
    assert.equal(partial.localIssues?.[0].status, "not-found");
    const handlers = new Map<string, (...args: any[]) => any>();
    let currentTurn: any = { kind: "ask", providerResourceText: preflight.providerResourceText, references: preflight.references };
    const extension = createPiKnowledgeInlineExtension({ vaultSecurity: { name: "fixture", factory() {} }, currentTurn: () => currentTurn });
    await extension.factory({ on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler) } as never);
    const before = await handlers.get("before_agent_start")!({ systemPrompt: "test", prompt: "question" });
    const user = { role: "user", content: "question", timestamp: Date.now() };
    const resource = { role: "custom", timestamp: Date.now(), ...before.message };
    const context = await handlers.get("context")!({ messages: [user, resource, read] });
    assert.equal(context.messages.filter((message: any) => message.customType === "echoink-knowledge-reading-state-v1").length, 1);
    assert.match(context.messages.at(-1).content, /MAIN_ONLY_TOKEN|wiki\/A.md/u);
    currentTurn = null;
    await handlers.get("before_agent_start")!({ systemPrompt: "test", prompt: "new question" });
    const nextContext = await handlers.get("context")!({ messages: [...context.messages, { ...user, content: "new question" }] });
    assert.equal(nextContext.messages.filter((message: any) => message.customType === "echoink-knowledge-reading-state-v1").length, 0);

    await write("wiki/A.md", source + "\nchanged\n");
    const finalCheck = await production.verifyAskReferences({ ...identity, references: preflight.references });
    assert.equal(finalCheck.status, "valid", "source change annotates delivered snapshots rather than discarding the answer");
    if (finalCheck.status === "valid") assert.ok(finalCheck.references.some((ref) => ref.verificationStatus === "source_link_changed"));
  } finally { await rm(root, { recursive: true, force: true }); }
  console.log("Ask associative reading: parsing, platform paths, graph, excerpts, paging, failures, delivered records, maintenance consumption PASS");
}
