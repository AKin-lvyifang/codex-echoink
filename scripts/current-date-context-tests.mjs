import assert from "node:assert/strict";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";
import { desktopNodeTestAliases, desktopNodeTestBanner } from "./desktop-node-test-host.mjs";
import { mobileBuildOptions } from "./mobile-build.mjs";
import { createHost, answer, FixtureTFile } from "../tests/mobile/host.mjs";

const directory = await mkdtemp(path.join(tmpdir(), "echoink-current-date-"));
const previousZone = process.env.TZ;
try {
  const entry = path.join(directory, "desktop.mjs");
  await esbuild.build({ entryPoints: ["src/tests/current-date-context.ts"], outfile: entry, bundle: true, platform: "node", format: "esm", target: "node22",
    alias: desktopNodeTestAliases, banner: desktopNodeTestBanner, logLevel: "silent", loader: { ".md": "text", ".txt": "text", ".svg": "text", ".webp": "dataurl" },
    plugins: [{ name: "sdk", setup(build) { build.onResolve({ filter: /^@earendil-works\/pi-(?:coding-agent|ai)(?:\/.*)?$/ }, args => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true })); } }] });
  const { runCurrentDateContextTests, assertDatePrompt } = await import(pathToFileURL(entry).href);
  const mobile = await esbuild.build(mobileBuildOptions("tests/mobile-company/entry.ts"));
  for (const zone of ["America/Los_Angeles", "Asia/Shanghai"]) {
    process.env.TZ = zone;
    await runCurrentDateContextTests(path.join(directory, zone));
    const module = { exports: {} };
    const context = vm.createContext({ module, exports: module.exports, Date, crypto: webcrypto, structuredClone, TextEncoder, TextDecoder,
      AbortController, URL, setTimeout, clearTimeout, console, require(id) { assert.equal(id, "obsidian"); return { TFile: FixtureTFile, TFolder: class {}, Notice: class {} }; } });
    context.self = context;
    vm.runInContext(mobile.outputFiles[0].text, context);
    const { MobileRuntime, MobileStore, loadMobileSettings, mobileProvider, mobileModel, startMobileCompany } = module.exports;
    for (const role of ["ordinary", "router", "worker"]) {
      const oldNow = Date.now;
      let now = new Date(2026, 10, 17, 23, 59).getTime();
      Date.now = () => now;
      const host = createHost(), requests = [];
      const store = new MobileStore(host.adapter, "plugin/mobile", "date-fixture"); await store.load();
      const provider = mobileProvider("custom");
      Object.assign(provider, { apiKey: "fake-key", baseUrl: "https://fixture.example/v1", models: [mobileModel("fixture-model", { toolCalling: true })], defaultModelId: "fixture-model" });
      const settings = loadMobileSettings({ apiProviders: [provider], activeApiProviderId: provider.id, defaultModel: "fixture-model" });
      await store.update(state => { state.permission = "workspace-write"; });
      const runtime = new MobileRuntime(host.app, store, () => settings, async raw => {
        const body = JSON.parse(raw.body); requests.push(body);
        if (requests.length === 1) { now = new Date(2026, 10, 18, 0, 1).getTime(); return answer("openai-completions", "", [["clock-read", "note_read", { path: "笔记/来源.md" }]]); }
        return answer("openai-completions", "offline done");
      });
      let company;
      try {
        await runtime.initialize();
        if (role === "ordinary") await store.createSession("generalist");
        else {
          company = await startMobileCompany({ runtime, store, settings: () => settings, adapter: host.adapter, file: "plugin/company.json",
            folders: { projectRoot: async () => "项目", ensureFolder: async () => {} }, changed() {} });
          assert.ok(company);
        }
        let id = store.session.id;
        if (role === "worker") {
          await company.service.dispatch(id, { agentId: "generalist", moduleId: "none", brief: "明天下午三点给小王回电话" });
          id = company.service.doc.dispatches[0].id;
          const deadline = oldNow() + 6000;
          while (runtime.isBusy(id) || company.service.doc.dispatches[0].status !== "done") {
            if (oldNow() > deadline) throw Error("mobile worker timed out");
            await new Promise(resolve => setTimeout(resolve, 0));
          }
        } else await runtime.send("明天下午三点给小王回电话", id);
        const roleRequests = () => role === "worker" ? requests.filter(body => body.messages[0].content.includes("<echoink_company_worker")) : requests;
        assert.equal(roleRequests().length, 2, `${role}: tool continuation`);
        assertDatePrompt(roleRequests()[0].messages[0].content, "2026-11-17", "星期二", zone);
        assertDatePrompt(roleRequests()[1].messages[0].content, "2026-11-18", "星期三", zone);
        await runtime.send("同会话继续", id);
        assertDatePrompt(roleRequests()[2].messages[0].content, "2026-11-18", "星期三", zone);
        if (role !== "ordinary") assert.ok(roleRequests()[0].messages[0].content.includes(`<echoink_company_${role}`));
        console.log(`PASS mobile ${role}: ${zone}, final wire requests, midnight tool continuation + next turn`);
      } finally { company?.dispose(); runtime.dispose(); Date.now = oldNow; }
    }
  }
} finally {
  if (previousZone === undefined) delete process.env.TZ; else process.env.TZ = previousZone;
  await rm(directory, { recursive: true, force: true });
}
