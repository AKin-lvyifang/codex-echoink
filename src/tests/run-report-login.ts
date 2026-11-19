import assert from "node:assert/strict";
import { AccountService, MembershipApiError } from "../membership/account-service";
import { createRunReportForm } from "../run-reports/form";
import { RunReportAuthError, RunReportLogin, REPORT_LOGIN_TTL, reportExportMessage } from "../run-reports/login";
import { uploadRunReport } from "../run-reports/upload";
import { freezeReport, reportWithoutConversation, type ReportSnapshot } from "../run-reports/report";
import { openMobileRunReport } from "../run-reports/mobile-ui";
import { IPhoneShell } from "../ui/iphone/shell";
import { IPadShell } from "../ui/ipad/shell";
import { newSession } from "../mobile/store";

type Test = (name: string, run: () => void | Promise<void>) => Promise<void>;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
export async function runReportLoginTests(document: Document, test: Test): Promise<void> {
  const snapshot = freezeReport(reportWithoutConversation({ pluginVersion: "2.9.0", obsidianVersion: "fixture", platform: "macos", surface: "desktop", language: "zh", membership: "free" }, []));
  const button = (parent: HTMLElement, text: string, action: () => void) => { const node = document.createElement("button"); node.textContent = text; node.onclick = action; parent.append(node); return node; };
  const find = (root: HTMLElement, text: string) => { const node = Array.from(root.querySelectorAll("button")).find(node => node.textContent === text); assert.ok(node, text); return node; };
  const input = (node: HTMLInputElement | HTMLTextAreaElement, value: string) => { node.value = value; node.dispatchEvent(new document.defaultView!.Event("input")); };
  await test("signed-out guide has no form and can export with support instructions in both languages", async () => {
    for (const english of [false, true]) {
      let uploads = 0, exported = false, login = false;
      const form = createRunReportForm({ document, snapshot, button, english, signedIn: () => false,
        login: async value => { assert.equal(value, snapshot); login = true; }, upload: async () => { uploads++; return "R-ABC123"; },
        export: async (value, support) => { assert.equal(value, snapshot); assert.equal(support, true); exported = true; } });
      assert.equal(form.content.querySelector("textarea,input,details"), null);
      assert.match(form.content.textContent!, english ? /Sign in to report/ : /登录后才能上报/);
      assert.equal(form.footer.querySelectorAll("button").length, 2);
      find(form.footer, english ? "Export file instead" : "改为导出文件").click(); await tick(); assert.equal(exported, true);
      find(form.footer, english ? "Sign in / Sign up" : "登录 / 注册").click(); await tick(); assert.equal(login, true); assert.equal(uploads, 0);
      assert.match(reportExportMessage("EchoInk/report.json", english, true), /support@echoink.cn/); form.dispose();
    }
  });
  await test("sign-out between open and submit makes zero requests and retains all input", async () => {
    let signedIn = true, uploads = 0;
    const form = createRunReportForm({ document, snapshot, button, signedIn: () => signedIn, login: async () => {}, upload: async () => { uploads++; return "R-ABC123"; }, export: async () => {} });
    input(form.content.querySelector("textarea")!, "运行过程中出现了问题"); input(form.content.querySelector("input")!, "contact@example.test");
    signedIn = false; find(form.footer, "上报").click(); await tick(); assert.equal(uploads, 0);
    assert.match(form.footer.textContent!, /登录已过期/); assert.equal(form.content.querySelector("input")!.value, "contact@example.test"); form.dispose();
  });
  await test("auth rejection preserves edits, sticky expiry, export bytes and restored form before explicit resubmit", async () => {
    let draft: ReportSnapshot | undefined, exported: ReportSnapshot | undefined, uploads = 0;
    const form = createRunReportForm({ document, snapshot, button, signedIn: () => true, login: async value => { draft = value; },
      upload: async () => { uploads++; throw new RunReportAuthError(); }, export: async (value, support) => { assert.equal(support, true); exported = value; } });
    input(form.content.querySelector("textarea")!, "执行失败请协助排查"); input(form.content.querySelector("input")!, "原来的联系方式");
    find(form.footer, "上报").click(); await tick();
    input(form.content.querySelector("textarea")!, "执行失败请协助排查，补充内容");
    assert.match(form.footer.querySelector('[role="status"]')!.textContent!, /登录已过期/);
    assert.equal(find(form.footer, "上报").hidden, true);
    find(form.footer, "改为导出文件").click(); await tick(); assert.equal(exported!.report.contact, "原来的联系方式");
    find(form.footer, "重新登录").click(); await tick(); assert.equal(draft!.json, exported!.json);
    const restored = createRunReportForm({ document, snapshot: draft!, button, signedIn: () => true, upload: async value => { uploads++; assert.equal(value.report.contact, "原来的联系方式"); return "R-ABC123"; }, export: async () => {} });
    assert.equal(restored.content.querySelector("textarea")!.value, "执行失败请协助排查，补充内容"); assert.equal(uploads, 1);
    find(restored.footer, "上报").click(); await tick(); assert.match(restored.footer.textContent!, /上报成功.*R-ABC123/); assert.equal(uploads, 2);
    form.dispose(); restored.dispose();
  });
  await test("continuation is single-use, replaces older requests, expires and is cleared on unload", async () => {
    let now = 0, calls = 0; const login = new RunReportLogin(() => now), source = {};
    await login.returned(); assert.equal(calls, 0);
    const cancelOld = login.request(snapshot, source, () => { throw new Error("old request"); });
    login.request(snapshot, source, async value => { assert.equal(value, snapshot); calls++; await login.returned(); }); cancelOld();
    await login.returned(); await login.returned(); assert.equal(calls, 1);
    login.request(snapshot, source, () => { calls++; }); now += REPORT_LOGIN_TTL; await login.returned(); assert.equal(calls, 1);
    login.request(snapshot, source, () => { calls++; }); login.dispose(); await login.returned(); assert.equal(calls, 1);
    login.request(snapshot, source, () => { calls++; }); await login.returned(); assert.equal(calls, 1);
  });
  await test("upload blocks missing identity and account service invalidates expired credentials without anonymous retry", async () => {
    let uploads = 0, reject = false;
    const saved = { token: "fixture-token", account: { id: "fixture", email: "fixture@example.test", name: "Fixture", joinedAt: "2026-11-16", avatar: null, passwordSet: false } };
    const service = new AccountService({ persistent: true, read: async () => saved, write: async () => {}, identity: async () => { throw new Error("not needed"); } }, async path => {
      if (path === "/api/products") return { products: [] };
      if (path === "/api/account") return saved.account;
      if (path === "/api/membership") return { state: "free", serverTime: Date.now(), devices: [] };
      if (path === "/api/run-reports") { uploads++; if (reject) throw new MembershipApiError("AUTH_REQUIRED"); return { id: "R-ABC123" }; }
      throw new Error(`unexpected request ${path}`);
    }, "https://fixture.invalid", () => {}, "https://fixture.invalid", () => "missing");
    try {
      await assert.rejects(uploadRunReport(snapshot), { code: "AUTH_REQUIRED" });
      await assert.rejects(uploadRunReport(snapshot, service), { code: "AUTH_REQUIRED" }); assert.equal(uploads, 0);
      await service.initialize(); assert.ok(service.read().identity);
      let returns = 0; service.onSignInReturned(async () => { returns++; }); await service.refresh(); assert.equal(returns, 0);
      assert.equal(await uploadRunReport(snapshot, service), "R-ABC123"); reject = true;
      await assert.rejects(uploadRunReport(snapshot, service), { code: "AUTH_REQUIRED" }); assert.equal(service.read().identity, null); assert.equal(service.apiToken(), null);
      await assert.rejects(uploadRunReport(snapshot, service), { code: "AUTH_REQUIRED" }); assert.equal(uploads, 2);
      await service.signInReturned(); assert.equal(returns, 0);
    } finally { service.dispose(); }
  });
  for (const surface of ["iphone", "ipad"] as const) await test(`${surface} unified entry restores the original snapshot after login return, with localized form and export`, async () => {
    const root = document.createElement("main"); document.body.append(root);
    const shell = surface === "iphone" ? new IPhoneShell(root) : new IPadShell(root);
    const task = newSession(); task.title = "原始任务";
    const login = new RunReportLogin(); let signedIn = false, revealed = 0;
    const page = { id: `task:${task.id}`, title: "任务", content: document.createElement("div") }; shell.mount(page);
    const source = { view: { containerEl: root } };
    const host = { app: { vault: { adapter: {} }, workspace: { containerEl: root, iterateAllLeaves: (visit: (leaf: unknown) => void) => visit(source), revealLeaf: async (leaf: unknown) => { assert.equal(leaf, source); revealed++; } } },
      store: { getSession: () => task }, runtime: { stateFor: () => ({}) }, version: "2.9.0", settings: () => ({ settingsLanguage: "en" }),
      accountService: { read: () => ({ identity: signedIn ? { email: "fixture@example.test" } : null, membership: { planId: "free" } }) }, reportLogin: login,
      openLegacy: async () => { await shell.push({ id: "account", title: "账号", content: document.createElement("div") }); await shell.push({ id: "login", title: "登录", content: document.createElement("div") }); } };
    try {
      openMobileRunReport(host as never, task.id, surface, { document, open: config => shell.openSheet(config), close: () => { shell.closeSheet(); }, restore: () => shell.backTo(page.id) });
      assert.match(root.textContent!, /Sign in to report/); assert.equal(root.querySelector("textarea"), null);
      find(root, "Sign in / Sign up").click(); await tick(); assert.equal(shell.activePageId, "login");
      task.title = "已变动的任务"; signedIn = true;
      assert.equal(await shell.back(), true); await login.returned(); await login.returned();
      assert.equal(shell.activePageId, page.id); assert.ok(root.querySelector("textarea")); assert.equal(revealed, 1);
      assert.match(root.textContent!, /Problem description/);
      const details = root.querySelector("details")!; details.open = true; details.dispatchEvent(new document.defaultView!.Event("toggle"));
      const report = JSON.parse(root.querySelector("pre")!.textContent!); assert.equal(report.conversation.title, "原始任务"); assert.equal(report.environment.language, "en");
      assert.equal(root.querySelectorAll('[role="dialog"]').length, 1);
    } finally { login.dispose(); shell.dispose(); root.remove(); }
  });
}
