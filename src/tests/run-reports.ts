import { settingsReportNoticeContent } from "../run-reports/notice";
import { taskInterruptionExplanation } from "../agents/task-interruption-copy";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, appendFile, readdir, stat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { SessionManager, VERSION, CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import { FileConversationCatalog } from "../harness/pi-native/file-conversation-catalog";
import { FileProductRunStore } from "../harness/pi-native/file-product-run-store";
import { createDurablePiSession, persistPiActiveLeaf, assertPiSessionPreAssistantDurable } from "../harness/pi-native/pi-session-durability";
import { collectDesktopRunReport } from "../run-reports/desktop-collector";
import { collectMobileRunReport } from "../run-reports/mobile-collector";
import { configuredReportSecrets, describeSnapshot, reportWithoutConversation, freezeReport, redactReportValue, RUN_REPORT_LIMIT, type RunReport } from "../run-reports/report";
import { RunErrorRecorder } from "../run-reports/recent-errors";
import { saveRunReport } from "../run-reports/vault-export";
import { createRunReportForm } from "../run-reports/form";
import { newSession } from "../mobile/store";

const environment: RunReport["environment"] = { pluginVersion: "2.8.6", obsidianVersion: "1.13.4", platform: "macos", surface: "desktop", language: "zh", membership: "free" };
function report(): RunReport { return { format: "echoink-run-report", formatVersion: 1, createdAt: "2026-10-28T10:00:00.000Z", description: "", contact: "", environment,
  conversation: { id: "session", title: "测试/会话", agent: "sol", provider: "test", model: "test", catalogStatus: "active", activeLeafId: null }, runs: [], diagnostics: [], recentErrors: [], entries: [], missing: [], redaction: { applied: true, rules: "v1" } }; }
export async function runReportTests(document: Document): Promise<void> {
  let passed = 0;
  const test = async (name: string, run: () => void | Promise<void>) => { await run(); passed++; console.log(`OK run reports: ${name}`); };
  await test("persisted interruption facts select localized copy without inventing retry attempts", () => {
    assert.equal(taskInterruptionExplanation({ reason: "watchdog" }, "zh"), "Agent 已经 5 分钟没有任何进展，已停止。可以点继续重试。");
    assert.equal(taskInterruptionExplanation({ reason: "watchdog" }, "en"), "The agent made no progress for 5 minutes and was stopped. Tap Continue to retry.");
    assert.match(taskInterruptionExplanation({ reason: "run_failed", retryAttempts: 3, detail: "provider_service_failed" }, "zh")!, /重试 3 次.*Provider 服务暂时不可用/u);
    assert.match(taskInterruptionExplanation({ reason: "run_failed", retryAttempts: 3, detail: "provider_service_failed" }, "en")!, /3 retries.*temporarily unavailable/u);
    assert.doesNotMatch(taskInterruptionExplanation({ reason: "run_failed", detail: "provider_service_failed" }, "zh")!, /重试 3 次/u);
    assert.equal(taskInterruptionExplanation({ reason: "process_unknown" }, "zh"), undefined);
  });
  await test("no open conversation keeps a valid empty envelope and only error/environment data", () => {
    const errors = [{ source: "settings.save", message: "EBUSY fixture" }];
    const snapshot = freezeReport(reportWithoutConversation(environment, errors));
    for (const name of ["id", "title", "agent", "provider", "model"] as const) assert.equal(snapshot.report.conversation[name], "");
    assert.equal(snapshot.report.conversation.activeLeafId, null);
    for (const name of ["runs", "entries", "diagnostics"] as const) assert.deepEqual(snapshot.report[name], []);
    assert.deepEqual(snapshot.report.recentErrors, errors); assert.ok(snapshot.report.missing.includes("conversation_not_open"));
    assert.deepEqual(snapshot.report.environment, environment);
  });
  await test("settings Notice offers one review action and does not submit or open twice while pending", async () => {
    let opens = 0; const node = document.createElement("div");
    node.append(settingsReportNoticeContent(document, "设置多次保存失败", async () => { opens++; })); document.body.append(node);
    const button = node.querySelector("button")!; assert.equal(button.textContent, "上报问题"); assert.equal(opens, 0);
    button.click(); button.click(); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(opens, 1); assert.equal(button.disabled, false); assert.match(node.textContent!, /设置多次保存失败/u); node.remove();
  });
  await test("nested fields, encoded URLs, known Provider/MCP values and path variants are redacted", () => {
    const secret = "synthetic provider credential", envSecret = "synthetic-env-secret", header = "synthetic-header-value";
    const secrets = configuredReportSecrets({ apiProviders: [{ apiKey: secret }], resources: { mcpConnections: [{ env: { PRIVATE: envSecret }, headers: { "X-Auth": header } }] } });
    assert.ok(secrets.includes(envSecret)); assert.ok(secrets.includes(header));
    const value = { title: secret, nested: { Cookie: "abc=secret cookie; def=another", AUTHORIZATION: "Bearer nested bearer", apiKey: "plain-key-with spaces", clientSecret: "client-secret" },
      json: JSON.stringify({ logs: [JSON.stringify({ token: "unknown nested token", value: envSecret })] }),
      logs: [`Cookie: raw-cookie; spaces here\nAuthorization: Basic raw-auth`, `https://test.invalid/?api_key=url-key&access_token=token-with-space&other=ok`, header,
        "/Users/synthetic/Vault/Note.md", "/Users/synthetic/Desktop/file.md", "C:\\Users\\synthetic\\Vault\\Note.md", "C:\\Users\\synthetic\\Elsewhere"] };
    const cleaned = JSON.stringify(redactReportValue(value, { secrets, vaultPath: "/Users/synthetic/Vault", homePath: "/Users/synthetic" }));
    for (const value of [secret, envSecret, header, "secret cookie", "nested bearer", "plain-key-with spaces", "client-secret", "unknown nested token", "raw-cookie", "raw-auth", "url-key", "token-with-space", "/Users/synthetic", "synthetic\\\\Vault"]) assert.ok(!cleaned.includes(value), value);
    assert.match(cleaned, /<vault>/u); assert.match(cleaned, /other=ok/u);
  });
  await test("snapshot detaches session state, freezes nested data and preserves only user description/contact", () => {
    const raw = report(); raw.entries = [{ text: "sk-syntheticabcdefghijklmnop" }]; raw.description = "sk-explicit-user-input"; raw.contact = "/Users/synthetic/contact";
    const snapshot = freezeReport(raw); (raw.entries[0] as { text: string }).text = "changed";
    assert.ok(Object.isFrozen(snapshot.report.entries)); assert.ok(!snapshot.json.includes("changed")); assert.ok(!snapshot.json.includes("sk-synthetic"));
    assert.equal(snapshot.report.description, raw.description); assert.equal(snapshot.report.contact, raw.contact);
    const described = describeSnapshot(snapshot, "人工停止后没有结束", "synthetic@example.test");
    assert.equal(described.report.entries, snapshot.report.entries); assert.deepEqual(JSON.parse(described.body), { report: JSON.parse(described.json) });
    assert.equal(described.bytes, Buffer.byteLength(described.body)); assert.ok(!snapshot.filename.includes("/"));
  });
  await test("error recorder retains 200 entries, masks stored messages and bounds stack/cause bytes", () => {
    const recorder = new RunErrorRecorder(() => ({ secrets: ["test credential"] }));
    const error = new Error("failure test credential", { cause: "中".repeat(5000) }); error.stack = "中".repeat(5000);
    for (let i = 0; i < 205; i++) recorder.record(`source-${i}`, error, { conversationId: "session", runId: "run", code: "FAILED" });
    const snapshot = recorder.snapshot(); assert.equal(snapshot.length, 200); assert.equal(snapshot[0].source, "source-5");
    assert.ok(!snapshot[0].message.includes("test credential")); assert.ok(Buffer.byteLength(snapshot[0].stack!) <= 2048); assert.ok(Buffer.byteLength(snapshot[0].cause!) <= 2048);
    snapshot[0].message = "changed"; assert.notEqual(recorder.snapshot()[0].message, "changed"); recorder.reset(); assert.equal(recorder.snapshot().length, 0);
  });
  await test("desktop collection includes every branch and diagnostic without mutating source files, handles corrupt tail", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "echoink-run-report-")));
    try {
      const catalog = new FileConversationCatalog({ storageRootPath: root, vaultId: "test-vault" }); await catalog.initialize();
      const productRuns = new FileProductRunStore({ storageRootPath: root, vaultId: "test-vault", catalog }); await productRuns.initialize();
      const api = { codingAgentVersion: VERSION, currentSessionVersion: CURRENT_SESSION_VERSION, open: SessionManager.open };
      const opened = createDurablePiSession({ api, sessionRoot: catalog.sessionRootPath, cwd: root });
      const first = opened.sessionManager.appendMessage({ role: "user", content: "first branch", timestamp: Date.now() });
      assertPiSessionPreAssistantDurable({ sessionRoot: catalog.sessionRootPath, sessionManager: opened.sessionManager, userEntryId: first });
      const branchA = opened.sessionManager.appendCustomEntry("fixture", { branch: "A" });
      opened.sessionManager.branch(first); const branchB = opened.sessionManager.appendCustomEntry("fixture", { branch: "B" });
      assertPiSessionPreAssistantDurable({ sessionRoot: catalog.sessionRootPath, sessionManager: opened.sessionManager, userEntryId: first });
      persistPiActiveLeaf({ sessionRoot: catalog.sessionRootPath, sessionManager: opened.sessionManager });
      const now = Date.now();
      await catalog.upsert({ conversationId: "session", piSessionId: opened.sessionManager.getSessionId(), vaultId: catalog.vaultId, title: "测试会话", status: "active", defaultMemoryMode: "no_memory", createdAt: now, updatedAt: now, sessionFile: opened.sessionFile, taskStatus: "interrupted" });
      await productRuns.create({ productRunId: "run-1", conversationId: "session", piSessionId: opened.sessionManager.getSessionId(), userEntryId: first, toolCallIds: [], memoryMode: "no_memory", state: "product_run_settled", terminalState: "failed", activeLeafId: branchB, createdAt: now, updatedAt: now, agentSettledAt: now, settledAt: now, error: "NETWORK_REFUSED" });
      await catalog.diagnostics("session", Array.from({ length: 7 }, (_, i) => ({ diagnosticId: `d-${i}`, conversationId: "session", piSessionId: opened.sessionManager.getSessionId(), code: "runtime_interrupted" as const, message: `diagnostic-${i}`, createdAt: now + i })));
      const files = async (): Promise<Record<string, string>> => { const output: Record<string, string> = {}; const visit = async (dir: string) => { for (const name of await readdir(dir)) { const file = path.join(dir, name), info = await stat(file); if (info.isDirectory()) await visit(file); else output[file] = `${info.mtimeMs}:${await readFile(file, "utf8")}`; } }; await visit(root); return output; };
      const before = await files(), collected = await collectDesktopRunReport({ catalog, productRuns, conversationId: "session", environment, recentErrors: [] });
      assert.deepEqual(await files(), before); assert.equal(collected.diagnostics.length, 7); assert.equal(collected.runs.length, 1); assert.equal(collected.conversation.activeLeafId, branchB);
      assert.ok(collected.entries.some(entry => (entry as { id: string }).id === branchA)); assert.ok(collected.entries.some(entry => (entry as { id: string }).id === branchB));
      await appendFile(opened.sessionFile, '{"invalid":');
      const corrupted = await collectDesktopRunReport({ catalog, productRuns, conversationId: "session", environment, recentErrors: [] });
      assert.equal(corrupted.entries.length, collected.entries.length); assert.match(corrupted.missing.join(), /jsonl_corrupted_after_line_/u); assert.equal(corrupted.diagnostics.length, 8);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  await test("mobile collector includes runs, operations, interruption, tool results and restart evidence", () => {
    const task = newSession(); task.taskStatus = "interrupted"; task.interruption = { reason: "process_unknown", stage: "tool", at: Date.now() }; task.runs = [{ id: "run", startedAt: Date.now(), providerId: "test", modelId: "model" }];
    task.messages = [{ role: "user", content: "read note", timestamp: Date.now() }]; task.tools.call = { startedAt: Date.now() };
    const before = JSON.stringify(task), collected = collectMobileRunReport(task, { ...environment, platform: "ios", surface: "iphone" }, []);
    assert.equal(JSON.stringify(task), before); assert.equal(collected.runs.length, 2); assert.equal(collected.entries.length, 2); assert.ok(collected.missing.includes("error_text_not_persisted"));
    task.interruption.reason = "user_stopped";
    assert.ok(!collectMobileRunReport(task, environment, []).missing.includes("error_text_not_persisted"));
  });
  await test("concurrent exports choose distinct files and preserve frozen bytes", async () => {
    const files = new Map<string, string>(), folders = new Set<string>();
    const app = { vault: { adapter: { exists: async (path: string) => files.has(path) || folders.has(path) }, createFolder: async (path: string) => { folders.add(path); }, create: async (path: string, bytes: string) => { assert.ok(!files.has(path)); files.set(path, bytes); } } };
    const snapshot = freezeReport(report()); const paths = await Promise.all([saveRunReport(app as never, snapshot), saveRunReport(app as never, snapshot)]);
    assert.notEqual(paths[0], paths[1]); assert.ok(paths.every(path => path.startsWith("EchoInk/运行记录/"))); assert.deepEqual([...files.values()], [snapshot.json, snapshot.json]);
  });
  await test("form validates input, previews exactly the submitted snapshot, prevents duplicates and preserves failed inputs", async () => {
    let calls = 0, exported: string | undefined; const snapshot = freezeReport(report());
    const button = (parent: HTMLElement, text: string, action: () => void) => { const button = document.createElement("button"); button.textContent = text; button.onclick = action; parent.append(button); return button; };
    const form = createRunReportForm({ document, snapshot, button, upload: async value => { calls++; assert.equal(value.report.description, "工具执行后断开连接"); throw new Error("NETWORK_OFFLINE"); }, export: async value => { exported = value.json; } });
    document.body.append(form.content, form.footer);
    const input = form.content.querySelector("textarea")!, submit = form.footer.querySelectorAll("button")[1]; assert.ok(submit.disabled);
    input.value = "工具执行后断开连接"; input.dispatchEvent(new document.defaultView!.Event("input"));
    const details = form.content.querySelector("details")!; details.open = true; details.dispatchEvent(new document.defaultView!.Event("toggle"));
    const preview = form.content.querySelector("pre")!.textContent; submit.click(); submit.click(); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(calls, 1); assert.equal(input.value, "工具执行后断开连接"); assert.match(form.footer.textContent!, /NETWORK_OFFLINE/u);
    form.footer.querySelector("button")!.click(); await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(exported, preview);
    form.dispose(); form.content.remove(); form.footer.remove();
  });
  await test("8 MiB is measured against the entire UTF-8 request and offers export", () => {
    const raw = report(); raw.entries = ["中".repeat(Math.ceil(RUN_REPORT_LIMIT / 3))]; const snapshot = freezeReport(raw); assert.ok(snapshot.bytes > RUN_REPORT_LIMIT);
    const form = createRunReportForm({ document, snapshot, button: (parent, text, action) => { const button = document.createElement("button"); button.textContent = text; button.onclick = action; parent.append(button); return button; }, upload: async () => { throw new Error("must not upload"); }, export: async () => {} });
    assert.match(form.footer.textContent!, /8 MiB/u); assert.equal(form.footer.querySelector("button")!.hidden, false); assert.equal(form.footer.querySelectorAll("button")[1].disabled, true); form.dispose();
  });
  console.log(`Run report tests: ${passed} passed`);
}
