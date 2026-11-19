import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { DecisionClient, financeWriteAllowed, type DecisionFetch, type DecisionPersistentState } from "../membership/decision-client";
import { maintenanceConfirmationWithJudgment } from "../harness/pi-native/maintenance-scope-context";
import { shouldPreflightPersonalKnowledgeWithJudgment } from "../harness/pi-native/pi-native-conversation-runtime";
import { selectExpertSkills } from "../experts/prompt";
import { organizeFinanceRows } from "../lifestyle/finance-import";
import { readFinanceBill } from "../lifestyle/finance-domain";
import { DEFAULT_LIFESTYLE_SETTINGS } from "../lifestyle/settings";
import { DiaryOrganizerEngine } from "../diary-organizer/engine";
import { validateDiaryCandidate } from "../diary-organizer/validation";
import type { DiaryCandidate, DiaryOrganizerPorts, DiaryOrganizerState, DiaryWrittenRecord } from "../diary-organizer/types";
import { PersonalMemoryRecallHarness } from "../harness/memory/personal-memory-recall-harness";
import { withPersonalMemoryFixture } from "./personal-memory-fixture";
import { initializeVaultResourceStore } from "../harness/resources/vault-store";
import { SkillRuntimeCoordinator } from "../harness/resources/skill-runtime";
import { nodeSkillFiles, routingFixtureResolver } from "./skill-delivery-fixture";
import { mkdir, rename, stat } from "node:fs/promises";
import type { DataAdapter } from "obsidian";
import { MobileSkillsService } from "../mobile/skills";
import { loadMobileSettings } from "../mobile/settings";
import type { MobileCapabilityPolicy } from "../mobile/capability-policy";
import { judgeMobileTurn, mobileSkillDecision, mobileTurnJudgment, recentMessageTexts } from "../mobile/decision-turn";
import { setDecisionClient } from "../membership/decision-client";
import { SMART_JUDGMENT_HELP, smartJudgmentView } from "../settings/smart-judgment-settings";
import { smartJudgmentExhaustedActions, smartJudgmentExhaustedText } from "../ui/smart-judgment-copy";
import { financeIntentWithJudgment, hasDirectFinanceIntent, type FinanceToolRequest, type PiFinanceToolId } from "../harness/pi-native/finance-tool-policy";
import type { PersonalMemoryRecord } from "../harness/memory/personal-memory-contracts";

/* ——— 假服务器：真实本地 HTTP，按场景切换返回 ——— */
type Mode = "ok" | "slow" | "401" | "403" | "quota" | "busy" | "404";
interface Seen { path: string; auth: string | undefined; body: Record<string, unknown> | null; status?: number }
const QUOTA = { used: 186, limit: 300, remaining: 114, resetAt: "2099-12-01T00:00:00+08:00", showCount: true };

async function fakeServer() {
  let mode: Mode = "ok";
  const seen: Seen[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let raw = "";
    request.on("data", chunk => { raw += String(chunk); });
    request.on("end", () => {
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : null;
      const visit: Seen = { path: request.url ?? "", auth: request.headers.authorization, body }; seen.push(visit);
      const send = (status: number, json: unknown) => { visit.status = status; response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(json)); };
      if (mode === "404") return send(404, { error: "NOT_FOUND" });
      if (mode === "401") return send(401, { error: "UNAUTHORIZED" });
      if (mode === "403") return send(403, { error: "NOT_ENTITLED" });
      if (mode === "quota") return send(429, { error: "QUOTA_EXHAUSTED", resetAt: "2099-12-01T00:00:00+08:00" });
      if (mode === "busy") return send(503, { error: "DECISIONS_BUSY" });
      const reply = () => {
        if (request.url === "/api/decisions/status") return send(200, { available: true, tier: "beta", reason: null, quota: QUOTA, thresholds: { memory: 0.9, financeWrite: 0.8, financeWriteBlock: 0.2, fresh: 0.5, knowledge: 0.5 } });
        if (request.url === "/api/decisions/turn") return send(200, { skill: { id: "finance-operations", probability: 0.97, none: 0.02 }, fresh: 0.1, financeWrite: 0.98, knowledge: 0.2, maintenance: { continue: 0.9, new: 0.03, stop: 0.02, discuss: 0.05 }, quota: { ...QUOTA, used: 187, remaining: 113 } });
        if (request.url === "/api/decisions/memory") return send(200, { probabilities: { m01: 0.98, m02: 0.1 }, selected: ["m01"], threshold: 0.9, orderEnsemble: "full", quota: QUOTA });
        if (request.url === "/api/decisions/finance-import") return send(200, { rows: [{ id: "r1", category: { id: "餐饮", probability: 0.99 }, merchant: null, account: null, icon: null }], quota: QUOTA });
        if (request.url === "/api/decisions/diary") return send(200, { expenses: [], todos: [{ id: "t1", same: 0.97 }], entries: [], quota: QUOTA });
        return send(404, { error: "NOT_FOUND" });
      };
      if (mode === "slow") setTimeout(reply, 600); else reply();
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fetcher: DecisionFetch = async (endpoint, method, body, token) => {
    const response = await fetch(base + endpoint, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    let json: unknown = null;
    try { json = await response.json(); } catch { json = null; }
    return { status: response.status, json };
  };
  return { seen, fetcher, setMode: (next: Mode) => { mode = next; }, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

function client(fetcher: DecisionFetch, state: DecisionPersistentState = { enabled: true, introSeen: false }, token: string | null = "token-1") {
  const saved: DecisionPersistentState[] = [];
  const instance = new DecisionClient({ fetch: fetcher, token: () => token, state: () => state,
    saveState: next => { state = next; saved.push(next); }, timeouts: { turn: 250, memory: 400, status: 400 }, uuid: () => "req-1" });
  return { instance, saved, state: () => state };
}

async function clientScenarios() {
  const server = await fakeServer();
  try {
    // 1 成功：/status、/turn、/memory 带同一个 turnId，登录令牌和小echo 一样走 Bearer。
    const ok = client(server.fetcher);
    const status = await ok.instance.refreshStatus();
    assert.equal(status?.available, true);
    assert.equal(ok.instance.thresholds().memory, 0.9);
    assert.equal(ok.instance.shouldShowIntro(), true, "first PRO start shows the intro once");
    const turn = await ok.instance.judgeTurn({ turnId: "turn-1", conversationId: "c1", text: "咖啡钱 18，微信付的", recent: ["a", "b", "c", "d"],
      skills: [{ id: "finance-operations", name: "记账", description: "记一笔" }], checks: ["fresh", "financeWrite"] });
    assert.deepEqual(turn?.skill, { id: "finance-operations", probability: 0.97, none: 0.02 });
    assert.equal(turn?.financeWrite, 0.98);
    assert.equal(turn?.fresh, 0.1);
    assert.equal(turn?.knowledge, undefined, "only requested checks are read");
    assert.equal(await ok.instance.judgeTurn({ turnId: "turn-1", text: "咖啡钱 18，微信付的" }), turn, "one /turn per turnId");
    assert.equal(await ok.instance.latestTurn("c1", "咖啡钱 18，微信付的"), turn, "the expert prompt reuses this turn");
    assert.equal(await ok.instance.latestTurn("c1", "别的话"), null);
    const memory = await ok.instance.judgeMemory({ turnId: "turn-1", text: "要吃阿莫西林吗", memories: [{ id: "m01", title: "对青霉素过敏", recallWhen: "用药", summary: "🙂".repeat(301), kind: "fact", date: "2026-11-14" }, { id: "m02", title: "喜欢猫", recallWhen: "喜欢猫" }] });
    assert.deepEqual(memory?.selected, ["m01"]);
    assert.equal(ok.instance.memoryDiagnostic("turn-1")?.orderEnsemble, "full");
    const sentMemories = server.seen.find(item => item.path === "/api/decisions/memory")?.body?.memories as Record<string, unknown>[];
    assert.equal((sentMemories[0].summary as string).length, 300);
    assert.equal(Array.from(sentMemories[0].summary as string).length, 150);
    assert.equal(sentMemories[0].kind, "fact"); assert.equal(sentMemories[0].date, "2026-11-14");
    assert.equal(sentMemories[0].recallWhen, "用药"); assert.equal(sentMemories[1].recallWhen, "");
    const turnRequests = server.seen.filter(item => item.path === "/api/decisions/turn");
    assert.equal(turnRequests.length, 1);
    assert.equal(turnRequests[0].auth, "Bearer token-1");
    assert.equal(turnRequests[0].body?.turnId, "turn-1");
    assert.equal((turnRequests[0].body?.recent as string[]).length, 3, "at most three recent lines");
    assert.equal("conversationId" in (turnRequests[0].body ?? {}), false, "local conversation id never leaves the device");
    assert.equal(server.seen.find(item => item.path === "/api/decisions/memory")?.body?.turnId, "turn-1", "/memory carries the same turnId");
    assert.equal(ok.instance.status()?.quota?.used, 186, "quota follows the latest response");
    assert.deepEqual((await ok.instance.judgeFinanceImport({ rows: [{ id: "r1", counterparty: "拉扎斯", product: "外卖", method: "花呗", amount: 32.5, direction: "expense", time: "2026-11-08 12:31" }], categories: [{ id: "餐饮", name: "餐饮", description: "" }], merchants: [], accounts: [], icons: [] }))?.[0].category, { id: "餐饮", probability: 0.99 });
    assert.equal((await ok.instance.judgeDiary({ todos: [{ id: "t1", a: "给妈妈打电话", b: "周末打电话问候老妈" }] }))?.todos[0].same, 0.97);

    // 2 超时：1.2 秒（测试里缩到 0.25 秒）拿不到就 null。
    server.setMode("slow");
    const started = Date.now();
    assert.equal(await ok.instance.judgeTurn({ turnId: "turn-slow", text: "你好啊", checks: ["fresh"] }), null);
    assert.ok(Date.now() - started < 550, "turn timeout does not wait for the server");

    // 3 401 / 403：走老逻辑；403 记住本账号不可用，之后不再请求。
    server.setMode("401");
    assert.equal(await ok.instance.judgeTurn({ turnId: "turn-401", text: "记一笔", checks: ["financeWrite"] }), null);
    const forbidden = client(server.fetcher);
    server.setMode("ok"); await forbidden.instance.refreshStatus();
    server.setMode("403");
    assert.equal(await forbidden.instance.judgeTurn({ turnId: "turn-403", text: "记一笔", checks: ["financeWrite"] }), null);
    assert.equal(forbidden.instance.status()?.available, false);
    const before403 = server.seen.length;
    assert.equal(await forbidden.instance.judgeTurn({ turnId: "turn-403b", text: "记一笔", checks: ["financeWrite"] }), null);
    assert.equal(server.seen.length, before403, "an unavailable account sends nothing");
    server.setMode("busy");
    assert.equal(await ok.instance.judgeTurn({ turnId: "turn-503", text: "记一笔", checks: ["financeWrite"] }), null);

    // 4 QUOTA_EXHAUSTED：记住状态，对话里只提示一次，之后不再请求。
    server.setMode("quota");
    const quota = client(server.fetcher);
    assert.equal(await quota.instance.judgeTurn({ turnId: "turn-q", text: "记一笔", checks: ["financeWrite"] }), null);
    assert.equal(quota.instance.exhausted(), "2099-12-01T00:00:00+08:00");
    assert.equal(quota.instance.takeExhaustedNotice(), "2099-12-01T00:00:00+08:00");
    assert.equal(quota.instance.takeExhaustedNotice(), null, "the notice is said once");
    assert.equal(quota.state().exhaustedNoticeResetAt, "2099-12-01T00:00:00+08:00", "once survives restarts");
    const beforeQuota = server.seen.length;
    assert.equal(await quota.instance.judgeMemory({ turnId: "turn-q2", text: "x", memories: [{ id: "m01", title: "t", recallWhen: "" }] }), null);
    assert.equal(server.seen.length, beforeQuota, "no request after the quota is used up");
    const restarted = client(server.fetcher, quota.state());
    await restarted.instance.judgeTurn({ turnId: "turn-q3", text: "记一笔", checks: ["financeWrite"] });
    assert.equal(restarted.instance.takeExhaustedNotice(), null, "a restart does not repeat this period's notice");

    // 5 断网：服务器关掉后 null。
    server.setMode("ok");
    const offline = await fakeServer(); await offline.close();
    assert.equal(await client(offline.fetcher).instance.judgeTurn({ turnId: "turn-off", text: "记一笔", checks: ["financeWrite"] }), null);

    // 6 关开关 / 没登录：不发请求。
    const beforeOff = server.seen.length;
    const off = client(server.fetcher, { enabled: false, introSeen: false });
    assert.equal(await off.instance.judgeTurn({ turnId: "turn-x", text: "记一笔", checks: ["financeWrite"] }), null);
    assert.equal(await client(server.fetcher, { enabled: true, introSeen: false }, null).instance.judgeTurn({ turnId: "turn-y", text: "记一笔", checks: ["financeWrite"] }), null);
    assert.equal(server.seen.length, beforeOff, "switched off or signed out sends nothing");
    await off.instance.setEnabled(true);
    assert.equal(off.state().enabled, true);
    await ok.instance.dismissIntro();
    assert.equal(ok.instance.shouldShowIntro(), false);
  } finally { await server.close(); }
}

function ruleScenarios() {
  const create: FinanceToolRequest = { action: "create", record: { amountCents: 1800 } };
  assert.equal(financeIntentWithJudgment("finance_record", create, "咖啡钱十八，微信付的", 0.99), true);
  for (const [tool, request, text] of [
    ["finance_record", { action: "delete", targets: [{ id: "old", expectedVersion: "v" }] }, "记一笔早餐"],
    ["finance_record", { action: "update", targets: [{ id: "old", expectedVersion: "v" }], patch: { amountCents: 1 } }, "记一笔早餐"],
    ["finance_record", create, "不要记一笔早餐"],
    ["finance_record", create, "咖啡十八，先不记录"],
    ["finance_record", create, "这两条早餐和午餐添加到账本"],
    ["finance_record", create, "咖啡十八、午饭三十，批量记两笔"],
    ["finance_budget", { action: "update" }, "记一笔早餐"],
    ["finance_record", { action: "delete", targets: [{ id: "old", expectedVersion: "v" }] }, "删除这笔早餐"]
  ] as [PiFinanceToolId, FinanceToolRequest, string][]) {
    for (const score of [0, 0.99]) assert.equal(financeIntentWithJudgment(tool, request, text, score), hasDirectFinanceIntent(tool, request, text), "non-create, batch and negative instructions keep the original gate");
  }
  // 记账把关：只做第二道。
  assert.equal(financeWriteAllowed(false, undefined), false);
  assert.equal(financeWriteAllowed(true, undefined), true);
  assert.equal(financeWriteAllowed(false, 0.85), true, "regex missed but the judgment is sure");
  assert.equal(financeWriteAllowed(false, 0.63), false, "0.63 is not enough to write");
  assert.equal(financeWriteAllowed(true, 0.15), false, "regex said yes but the judgment is sure it is not: ask the user");
  assert.equal(financeWriteAllowed(true, 0.5), true);
  // 知识库预检。
  assert.equal(shouldPreflightPersonalKnowledgeWithJudgment("你好", undefined, 0.9, 0.5), true);
  assert.equal(shouldPreflightPersonalKnowledgeWithJudgment("帮我想想周末去哪", undefined, 0.1, 0.5), false);
  assert.equal(shouldPreflightPersonalKnowledgeWithJudgment("帮我想想周末去哪", undefined, undefined, 0.5), true, "no judgment keeps the regex");
  assert.equal(shouldPreflightPersonalKnowledgeWithJudgment("写今天的日记", "daily-journal", 0.95, 0.5), false, "journal template rule still wins");
  // 维护范围。
  const sure = { continue: 0.92, new: 0.03, stop: 0.02, discuss: 0.03 };
  assert.equal(maintenanceConfirmationWithJudgment("那就照这个整理下去", sure), true, "regex missed a continuation");
  assert.equal(maintenanceConfirmationWithJudgment("那就照这个整理下去"), false);
  assert.equal(maintenanceConfirmationWithJudgment("改成维护 raw/新资料.md", sure), false, "an explicit new source never continues");
  assert.equal(maintenanceConfirmationWithJudgment("继续", { continue: 0.05, new: 0.05, stop: 0.85, discuss: 0.05 }), false);
  assert.equal(maintenanceConfirmationWithJudgment("继续", { continue: 0.6, new: 0.1, stop: 0.2, discuss: 0.1 }), true);
  // 专家技能。
  const skills = [{ id: "a", name: "写作", description: "", content: "A" }, { id: "b", name: "复盘", description: "", content: "B" }];
  assert.deepEqual(selectExpertSkills(skills, { text: "写作", decidedSkillId: "b" }).map(skill => skill.id), ["b"]);
  assert.deepEqual(selectExpertSkills(skills, { text: "写作", decidedSkillId: null }), []);
  assert.deepEqual(selectExpertSkills(skills, { text: "写作", decidedSkillId: "missing" }).map(skill => skill.id), ["a"], "unknown pick falls back to keywords");
  assert.deepEqual(selectExpertSkills(skills, { text: "写作" }).map(skill => skill.id), ["a"]);
}

async function financeImportScenarios(fallbackClient?: DecisionClient) {
  const header = "交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注";
  const rows = await readFinanceBill(new TextEncoder().encode(`${header}\n2026-11-08 12:31:00,商户消费,拉扎斯网络科技（上海）有限公司,外卖订单,支出,32.50,花呗,支付成功,W-1,M-1,\n2026-11-08 18:00:00,商户消费,某某书店,图书,支出,58.00,零钱,支付成功,W-2,M-2,\n`), "wechat.csv", "wechat");
  const settings = structuredClone(DEFAULT_LIFESTYLE_SETTINGS.finance);
  settings.merchants.push({ name: "饿了么", aliases: ["拉扎斯"], iconId: "auto", defaultCategory: "", active: true });
  settings.accounts.push({ name: "花呗", aliases: [], active: true });
  settings.merchants.push({ name: "饿了么", aliases: ["重复"], iconId: "auto", defaultCategory: "", active: true });
  const original = rows[0].entry!.description;
  const prompts: string[] = [];
  let decideInput: unknown;
  const result = await organizeFinanceRows(rows, settings, [], {
    signal: new AbortController().signal, skillContent: "skill",
    decide: async input => { decideInput = input; return [{ id: "r0", category: { id: "餐饮", probability: 0.99 }, merchant: { id: "m0", probability: 0.97 }, account: { id: "a0", probability: 0.99 }, icon: { id: "meituan", probability: 0.6 } }]; },
    generate: async (_system, prompt) => { prompts.push(prompt); return JSON.stringify({ rows: [{ ref: 1, category: "购物" }] }); }
  });
  const sent = decideInput as { rows: { id: string; counterparty: string }[]; icons: { id: string; name: string }[] };
  assert.equal(sent.rows.length, 2, "one request covers up to 50 rows");
  assert.ok(sent.icons.every(icon => icon.id && icon.name), "icons carry names");
  assert.ok(sent.icons.some(icon => icon.id === "alipay" && icon.name === "支付宝"), "supplement brands are included");
  const sentAll = decideInput as { merchants: { name: string }[]; icons: { name: string }[] };
  assert.equal(sentAll.merchants.filter(item => item.name === "饿了么").length, 1, "names are unique within a list");
  assert.equal(new Set(sentAll.icons.map(icon => icon.name)).size, sentAll.icons.length);
  assert.equal(result.rows[0].entry?.category, "餐饮");
  assert.equal(result.rows[0].entry?.account, "花呗");
  assert.equal(result.rows[0].entry?.description, original, "the bill's original text is kept");
  assert.equal(prompts.length, 1, "only the undecided row goes to the model");
  assert.equal((JSON.parse(prompts[0]) as { rows: { ref: number }[] }).rows.map(row => row.ref).join(), "1");
  assert.equal(result.rows[1].entry?.category, "购物");
  let modelCalls = 0;
  const fallback = await organizeFinanceRows(rows, settings, [], { signal: new AbortController().signal, skillContent: "skill",
    decide: async input => await fallbackClient?.judgeFinanceImport(input) ?? null, generate: async () => { modelCalls++; return JSON.stringify({ rows: [{ ref: 0, category: "餐饮" }, { ref: 1, category: "购物" }] }); } });
  assert.equal(modelCalls, 1, "a failed judgment batch goes to the model");
  assert.equal(fallback.rows[1].entry?.category, "购物");
  return fallback.rows.map(row => { if (!row.entry) return null; const { id: _id, ...entry } = row.entry; return entry; });
}

async function diaryScenarios(fallbackClient?: DecisionClient) {
  let fallbackResult: unknown;
  const finance: DiaryCandidate = { type: "finance", quote: "看中了一台899元的咖啡机，下个月再说。", confidence: "high", occurred: true, ownership: "self", concerns: [], kind: "expense", amountCents: 89900, currency: "CNY", date: "2026-11-08", merchant: "咖啡机", category: "餐饮" };
  const categories = { entries: [], categories: [{ name: "餐饮" }] };
  assert.equal(validateDiaryCandidate(finance, finance.quote, categories).reasons.length, 0, "the regex misses this plan");
  assert.ok(validateDiaryCandidate(finance, finance.quote, categories, { self: 0.95, happened: 0.05, amountClear: 1 }).reasons.some(reason => reason.includes("计划")), "the judgment sends it to review");
  const todo: DiaryCandidate = { type: "todo", quote: "周末要给妈妈打电话。", confidence: "high", occurred: true, ownership: "self", concerns: [], text: "给妈妈打电话" };
  for (const judged of [true, false]) {
    let now = new Date("2026-11-08T12:00:00").getTime(), state: DiaryOrganizerState | null = null, dedupeCalls = 0, decideCalls = 0;
    const text = `${finance.quote}\n${todo.quote}`;
    const written = new Map<string, DiaryWrittenRecord>();
    const ports: DiaryOrganizerPorts = {
      loadState: async () => structuredClone(state), saveState: async value => { state = structuredClone(value); },
      listDiaries: async () => [{ path: "journal/2026-11-08.md", date: "2026-11-08", mtime: 0 }], readDiary: async () => text,
      isEnabled: () => true, hasFinanceAccess: () => true, isBusy: () => false, now: () => now,
      generateText: async request => {
        if (request.purpose === "extract") return JSON.stringify({ candidates: [finance, todo] });
        dedupeCalls++;
        const rows = JSON.parse(request.prompt.slice(request.prompt.indexOf("候选与程序筛出的有效近似记录JSON：") + "候选与程序筛出的有效近似记录JSON：".length)) as { id: string }[];
        return JSON.stringify({ decisions: rows.map(row => ({ id: row.id, decision: "distinct", matchedIds: [], reason: "different" })) });
      },
      decideDiary: async input => {
        decideCalls++;
        if (!judged) return await fallbackClient?.judgeDiary(input) ?? null;
        assert.equal(input.todos?.length, 1);
        assert.deepEqual([input.entries?.[0].date, input.entries?.[0].candidate], ["2026-11-08", "咖啡机 899 元 · 2026-11-08"], "diary date and the extracted item go along");
        return { expenses: [], todos: input.todos!.map(pair => ({ id: pair.id, same: 0.97 })), entries: input.entries!.map(entry => ({ id: entry.id, self: 0.95, happened: 0.05, amountClear: 1 })) };
      },
      readFinanceSnapshot: async () => categories, readTodoSnapshot: async () => [{ id: "todo-1", text: "周末打电话问候老妈", completed: false }],
      writeFinance: async input => { const row = { id: input.extractionId, version: "v1", summary: "f" }; written.set(input.extractionId, row); return row; },
      writeTodo: async input => { const row = { id: input.extractionId, version: "v1", summary: "t" }; written.set(input.extractionId, row); return row; },
      findFinance: async id => written.get(id) ?? null, findTodo: async id => written.get(id) ?? null,
      undoFinance: async id => ({ deleted: written.delete(id) }), undoTodo: async id => ({ deleted: written.delete(id) })
    };
    const engine = new DiaryOrganizerEngine(ports);
    await engine.enable(); await engine.runOnce(); now += 3_600_001; await engine.runOnce();
    const items = engine.getState().items;
    const todoItem = items.find(item => item.candidate.type === "todo")!, financeItem = items.find(item => item.candidate.type === "finance")!;
    assert.equal(decideCalls, 1, "one diary request per pass");
    if (judged) {
      assert.equal(dedupeCalls, 0, "the judgment replaces the dedupe model call");
      assert.equal(todoItem.status, "ignored");
      assert.ok(todoItem.reasons.some(reason => reason.includes("周末打电话问候老妈")), "fixed reason names the existing record");
      assert.equal(financeItem.status, "review", "planned purchase waits for review");
      assert.equal(written.size, 0);
    } else {
      assert.equal(dedupeCalls, 1, "without a judgment the model still dedupes");
      assert.equal(todoItem.status, "written", "old logic: model said distinct");
      assert.equal(financeItem.status, "written", "old logic: regex passed it");
      fallbackResult = items.map(item => ({ candidate: item.candidate, status: item.status, reasons: item.reasons }));
    }
  }
  return fallbackResult;
}

async function memoryScenarios(fallbackClient?: DecisionClient) {
  let fallbackResult: unknown;
  await withPersonalMemoryFixture(async fixture => {
    const create = async (title: string) => (await fixture.repository.write({ operation: "create", kind: "fact", title, content: `${title}。`, recallWhen: title, basis: "explicit" },
      fixture.runtime({ explicitlyAuthorized: true }))).record!;
    const allergy = await create("对青霉素过敏");
    await create("喜欢猫");
    let llmCalls = 0, judged: unknown;
    const llm = { call: async () => { llmCalls++; return { text: JSON.stringify([allergy.id]) }; } };
    const withJudgment = new PersonalMemoryRecallHarness(fixture.repository, { directory: { llm, modelInputBudget: 32_000 },
      decisions: { diagnostic: () => ({ orderEnsemble: "partial" }), judgeMemory: async input => { judged = input; return { selected: [allergy.id], probabilities: Object.fromEntries(input.memories.map(entry => [entry.id, entry.id === allergy.id ? 1 : 0])) }; } } });
    const turn = { ...fixture.runtime(), query: "要吃阿莫西林吗", tokenBudget: 2_000, decisionTurnId: "turn-1" };
    const prepared = await withJudgment.prepareTurnContext(turn);
    assert.equal(prepared.selectionReceipt!.attempts[0].orderEnsemble, "partial");
    assert.equal(llmCalls, 0, "the judgment skips the user's model");
    assert.equal((judged as { turnId: string }).turnId, "turn-1");
    assert.equal((judged as { memories: unknown[] }).memories.length, 2, "no keyword prefilter: the whole rule-filtered catalog");
    assert.deepEqual(prepared.directorySelection?.ids, [allergy.id]);
    assert.ok(prepared.recall?.candidates.some(candidate => candidate.id === allergy.id), "a semantic match with no shared words is recalled");
    const failed = new PersonalMemoryRecallHarness(fixture.repository, { directory: { llm, modelInputBudget: 32_000 }, decisions: { judgeMemory: async input => await fallbackClient?.judgeMemory(input) ?? null } });
    const fallback = await failed.prepareTurnContext(turn);
    fallbackResult = { status: fallback.directorySelection?.status, selected: fallback.directorySelection?.ids.map(id => id === allergy.id ? "青霉素过敏" : "other") };
    assert.equal(llmCalls, 1, "a failed judgment falls back to the user's model");
    llmCalls = 0;
    await withJudgment.prepareTurnContext({ ...turn, decisionTurnId: undefined });
    assert.equal(llmCalls, 1, "no turnId (switch off) keeps the old path");
  });
  return fallbackResult;
}

async function skillScenarios(fallbackClient?: DecisionClient) {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "echoink-smart-judgment-"));
  try {
    await initializeVaultResourceStore({ vaultPath });
    const coordinator = new SkillRuntimeCoordinator(vaultPath, { content: routingFixtureResolver(vaultPath) });
    await coordinator.initialize();
    const options = await coordinator.listDecisionOptions();
    assert.ok(options.some(option => option.id === "finance-operations" && option.name && option.description), "builtin skills carry their title and description");
    assert.equal((await coordinator.listDecisionOptions({ isSkillAllowed: id => id !== "finance-operations" })).some(option => option.id === "finance-operations"), false, "same allow check as selection");
    const text = "咖啡钱十八，微信付的";
    assert.equal(await coordinator.selectForTask({ text }), null, "the regex misses this phrasing");
    assert.equal((await coordinator.selectForTask({ text, decision: { skillId: "finance-operations" } }))?.id, "finance-operations");
    assert.equal(await coordinator.selectForTask({ text: "记一下早餐12块", decision: { skillId: null } }), null, "the judgment can choose no skill");
    assert.equal((await coordinator.selectForTask({ text: "记一下早餐12块", decision: { skillId: "two-layer-explanation" }, isSkillAllowed: id => id !== "two-layer-explanation" }))?.id,
      "finance-operations", "a disallowed pick falls back to the old rules");
    const fresh = await coordinator.selectForTask({ text: "今天上海天气怎么样", decision: { skillId: null, fresh: true } });
    assert.equal(fresh?.id, "evidence-freshness-audit");
    assert.equal(fresh?.requiresFreshnessVerification, true);
    const judgment = await fallbackClient?.judgeTurn({ turnId: "404-skill", text: "记一下早餐12块", skills: options });
    const selected = await coordinator.selectForTask({ text: "记一下早餐12块", ...(judgment?.skill ? { decision: { skillId: judgment.skill.id } } : {}) });
    return selected?.id;
  } finally { await rm(vaultPath, { recursive: true, force: true }); }
}

/* ——— 手机端 ——— */
function fakeClient(routes: Record<string, unknown | null>, state: DecisionPersistentState = { enabled: true, introSeen: false }) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const fetcher: DecisionFetch = async (endpoint, _method, body) => {
    calls.push({ path: endpoint, body: (body ?? {}) as Record<string, unknown> });
    const json = routes[endpoint];
    return json === null || json === undefined ? { status: 503, json: { error: "DECISIONS_BUSY" } } : { status: 200, json };
  };
  return { client: new DecisionClient({ fetch: fetcher, token: () => "t", state: () => state, saveState: next => { state = next; } }), calls };
}

async function mobileScenarios() {
  assert.deepEqual(loadMobileSettings({}).smartJudgment, { enabled: true, introSeen: false }, "mobile defaults on, like desktop");
  assert.deepEqual(recentMessageTexts([{ role: "user", content: "a" }, { role: "toolResult", content: "x" }, { role: "assistant", content: [{ type: "text", text: "b" }] }, { role: "user", content: "c" }, { role: "user", content: "d" }]), ["b", "c", "d"]);

  // 选技能：判断结果优先，仍过“启用 / 本 Agent 允许 / 远程可用”；不可用时回到正则。
  const root = await mkdtemp(path.join(tmpdir(), "echoink-smart-judgment-mobile-"));
  try {
    const files = nodeSkillFiles(root), settings = loadMobileSettings({});
    const adapter = { read: async (p: string) => (await files.read(p))!, exists: async (p: string) => stat(path.join(root, p)).then(() => true, () => false),
      write: files.write, mkdir: async (p: string) => { await mkdir(path.join(root, p), { recursive: true }); }, list: files.list,
      rename: async (from: string, to: string) => { await rename(path.join(root, from), path.join(root, to)); },
      remove: async (p: string) => { await rm(path.join(root, p), { force: true }); } } as unknown as DataAdapter;
    const policy = { assertSkill(id: string) { if (id === "obsidian-cli") throw new Error("desktop only"); } } as MobileCapabilityPolicy;
    const skills = new MobileSkillsService(adapter, () => settings, async () => {}, () => policy);
    const options = await skills.decisionOptions("sol");
    assert.ok(options.some(option => option.id === "finance-operations"));
    assert.equal(options.some(option => option.id === "obsidian-cli"), false, "agent policy filters the list");
    assert.equal(options.some(option => option.id === "two-layer-explanation"), false, "remote-only skills need PRO delivery");
    const ids = async (text: string, decision?: { skillId: string | null; fresh?: boolean }) => (await skills.resolveRunSkills("task", "sol", text, undefined, false, decision)).map(item => item.id);
    assert.deepEqual(await ids("咖啡钱十八，微信付的"), [], "the regex misses it");
    assert.deepEqual(await ids("咖啡钱十八，微信付的", { skillId: "finance-operations" }), ["finance-operations"]);
    assert.deepEqual(await ids("记一下早餐12块", { skillId: null }), [], "the judgment can choose no skill");
    assert.deepEqual(await ids("记一下早餐12块", { skillId: "obsidian-cli" }), ["finance-operations"], "a disallowed pick falls back to the regex");
    assert.deepEqual(await ids("记一下早餐12块"), ["finance-operations"], "no judgment keeps the regex");
  } finally { await rm(root, { recursive: true, force: true }); }

  // /turn 与 /memory 同一个 turnId；记账把关读本轮缓存；失败什么都不加。
  const ok = fakeClient({
    "/api/decisions/turn": { skill: { id: "finance-operations", probability: 0.9, none: 0.05 }, fresh: 0.7, financeWrite: 0.93 },
    "/api/decisions/memory": { probabilities: { m1: 0.97, m3: 0.99 }, selected: ["m1", "m3"], threshold: 0.9 }
  });
  setDecisionClient(ok.client);
  try {
    const judged = await judgeMobileTurn({ turnId: "queued-1", sessionId: "s1", text: "咖啡钱十八", recent: [], skills: [{ id: "finance-operations", name: "记账", description: "" }] });
    assert.deepEqual(mobileSkillDecision(judged), { skillId: "finance-operations", fresh: true });
    assert.deepEqual(ok.calls[0].body.checks, ["fresh", "financeWrite"]);
    assert.equal((await mobileTurnJudgment("queued-1"))?.financeWrite, 0.93, "the finance tool reads this turn's judgment");
    assert.equal(await mobileTurnJudgment("other"), null);
    await judgeMobileTurn({ turnId: "queued-2", sessionId: "s1", text: "记一笔", recent: [], skills: [] });
    assert.deepEqual(ok.calls[1].body.checks, ["financeWrite"], "a chosen skill still asks the finance gate");
    // Mobile memory selection is exercised through the shared Harness and real repository adapters.
  } finally { setDecisionClient(null); }
  const failed = fakeClient({});
  setDecisionClient(failed.client);
  try {
    assert.equal(await judgeMobileTurn({ turnId: "q", sessionId: "s", text: "记一笔", recent: [], skills: [] }), null);
    assert.equal(mobileSkillDecision(null), undefined, "no judgment keeps the regex");
  } finally { setDecisionClient(null); }
  const off = fakeClient({ "/api/decisions/turn": { financeWrite: 0.9 } }, { enabled: false, introSeen: false });
  setDecisionClient(off.client);
  try {
    assert.equal(await judgeMobileTurn({ turnId: "q", sessionId: "s", text: "记一笔", recent: [], skills: [] }), null);
    assert.equal(off.calls.length, 0, "switched off sends nothing");
  } finally { setDecisionClient(null); }
  assert.equal(await judgeMobileTurn({ turnId: "q", sessionId: "s", text: "记一笔", recent: [], skills: [] }), null, "no client (signed out / no service) is the old path");
}

async function settingsViewScenarios() {
  assert.equal(SMART_JUDGMENT_HELP.zh, "开启后，EchoInk 召回和查阅笔记、记忆、技能，记账分类等都会更准，需要 PRO。");
  assert.equal(SMART_JUDGMENT_HELP.en, "When on, EchoInk recalls and looks up notes, memories and skills, and categorizes bills more accurately. Requires PRO.");
  const status = (body: Record<string, unknown>) => fakeClient({ "/api/decisions/status": { thresholds: {}, reason: null, ...body } }).client;
  const beta = status({ available: true, tier: "beta", quota: { used: 280, limit: 300, remaining: 20, resetAt: "2099-12-01T00:00:00+08:00", showCount: true } });
  await beta.refreshStatus();
  const betaView = smartJudgmentView(beta, true);
  assert.equal(betaView.status, "本月剩 20 次");
  assert.equal(betaView.warning, true, "30 or fewer left turns the warning color");
  assert.deepEqual([betaView.usage?.text, betaView.usage?.percent], ["280 / 300 · 12 月 1 日重置", 93]);
  const paid = status({ available: true, tier: "pro", quota: { used: 1200, limit: 3000, remaining: 1800, resetAt: "2099-12-01T00:00:00+08:00", showCount: false } });
  await paid.refreshStatus();
  assert.deepEqual([smartJudgmentView(paid, true).status, smartJudgmentView(paid, true).usage], ["已开启", null], "paid tiers do not show counts");
  const capped = status({ available: true, tier: "max", quota: { used: 3000, limit: 3000, remaining: 0, resetAt: "2099-12-01T00:00:00+08:00", showCount: false } });
  await capped.refreshStatus();
  assert.equal(smartJudgmentView(capped, false).status, "Limit reached · resumes Dec 1");
  assert.equal(smartJudgmentView(capped, true).usage?.percent, null, "the paid cap shows text, no bar");
  const free = status({ available: false, tier: "free", reason: "NOT_ENTITLED", quota: null });
  await free.refreshStatus();
  assert.deepEqual([smartJudgmentView(free, true).free, smartJudgmentView(free, true).on, smartJudgmentView(free, true).hidden], [true, false, false]);
  const rollout = status({ available: false, tier: "pro", reason: "NOT_IN_ROLLOUT", quota: null });
  await rollout.refreshStatus();
  assert.equal(smartJudgmentView(rollout, true).hidden, true, "outside the rollout the group is hidden");

  // 用完卡片：内测档引导升级（升级在前、主按钮），付费档已达上限不推销；桌面和手机共用这一份。
  const pick = (beta: boolean, en: boolean) => smartJudgmentExhaustedActions(beta, en).map(item => [item.action, item.text, item.primary]);
  assert.deepEqual(pick(true, false), [["upgrade", "升级 PRO", true], ["usage", "查看次数", false]], "beta exhausted: upgrade first and primary");
  assert.deepEqual(pick(true, true), [["upgrade", "Upgrade to PRO", true], ["usage", "View usage", false]]);
  assert.deepEqual(pick(false, false), [["usage", "查看次数", false], ["dismiss", "知道了", true]], "paid cap: no upgrade");
  assert.deepEqual(pick(false, true), [["usage", "View usage", false], ["dismiss", "Got it", true]]);
  assert.match(smartJudgmentExhaustedText("2099-12-01T00:00:00+08:00", true, false), /^本月智能判断次数用完了/, "the beta line is the one that gets the upgrade");
}

async function fallback404Scenarios(): Promise<void> {
  const server = await fakeServer(); server.setMode("404");
  const enabled = client(server.fetcher).instance;
  const off = client(server.fetcher, { enabled: false, introSeen: true }).instance;
  try {
    assert.equal(await skillScenarios(enabled), await skillScenarios(off), "404 skill selection matches the disabled path");
    const small = async (instance: DecisionClient) => {
      const judged = await instance.judgeTurn({ turnId: "404-small", text: "继续", checks: ["fresh", "knowledge", "maintenance"] });
      return { knowledge: shouldPreflightPersonalKnowledgeWithJudgment("帮我想想周末去哪", undefined, judged?.knowledge, instance.thresholds().knowledge),
        maintenance: maintenanceConfirmationWithJudgment("继续", judged?.maintenance) };
    };
    assert.deepEqual(await small(enabled), await small(off), "404 small checks keep the original rules");
    assert.deepEqual(await memoryScenarios(enabled), await memoryScenarios(off), "404 memory uses the original model path");
    assert.deepEqual(await financeImportScenarios(enabled), await financeImportScenarios(off), "404 import uses the original model result");
    assert.deepEqual(await diaryScenarios(enabled), await diaryScenarios(off), "404 diary dedupe and written items match the disabled path");
    const write = async (instance: DecisionClient) => {
      const judged = await instance.judgeTurn({ turnId: "404-finance-write", text: "记一笔早餐", checks: ["financeWrite"] });
      return financeIntentWithJudgment("finance_record", { action: "create", record: { amountCents: 1200 } }, "记一笔早餐", judged?.financeWrite, instance.thresholds());
    };
    assert.equal(await write(enabled), await write(off), "404 finance gate matches the disabled path");
    for (const endpoint of ["turn", "memory", "finance-import", "diary"]) {
      const visits = server.seen.filter(item => item.path === `/api/decisions/${endpoint}`);
      assert.ok(visits.length > 0, `${endpoint} was actually requested`);
      assert.ok(visits.every(item => item.status === 404), `${endpoint} actually returned 404`);
    }
    assert.equal(server.seen.filter(item => item.path === "/api/decisions/turn").length, 3, "skills, small checks and finance gate each reached the server; disabled controls sent nothing");
  } finally { await server.close(); }
}

export async function runSmartJudgmentTests(): Promise<void> {
  for (const probabilities of [{}, { a: 0.99 }, { a: 0.99, b: "invalid" }, { a: NaN, b: 0.1 }]) {
    let calls = 0;
    const client = new DecisionClient({ token: () => "fixture", state: () => ({ enabled: true }),
      fetch: async () => { calls++; return { status: 200, json: { probabilities, selected: [] } }; } });
    assert.equal(await client.judgeMemory({ turnId: "bad", text: "用药", memories: [
      { id: "a", title: "过敏", recallWhen: "" }, { id: "b", title: "猫", recallWhen: "" }
    ] }), null, "incomplete or invalid probabilities are a failed judgment, never a valid empty selection");
    assert.equal(calls, 1, "validation must not retry or charge another request");
  }
  await clientScenarios();
  await fallback404Scenarios();
  ruleScenarios();
  await financeImportScenarios();
  await diaryScenarios();
  await memoryScenarios();
  await skillScenarios();
  await mobileScenarios();
  await settingsViewScenarios();
  console.log("smart judgment tests: PASS");
}
