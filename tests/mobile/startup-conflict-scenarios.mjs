import { createRequire } from "node:module";
const editorRequire = createRequire(import.meta.url);
import assert from "node:assert/strict";
import vm from "node:vm";
import { createHash, webcrypto } from "node:crypto";
import { createHost, FixtureTFile } from "./host.mjs";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const shared = "plugin/pi-agent-product-v1/.echoink/shared-user/";
const hash = value => createHash("sha256").update(value).digest("hex");

/** Current production bootstrap, not a handcrafted Store-only startup substitute. */
export async function mobileStartupConflictScenarios({ code, dom, test }) {
  function fixture(tablet) {
    const host = createHost(), commands = [], views = [], notices = [];
    host.app.workspace.containerEl = dom.window.document.body;
    let saved = { autoOpenHome: false };
    class Plugin {
      constructor() { this.app = host.app; this.manifest = { id: "codex-echoink", dir: "plugin" }; }
      async loadData() { return structuredClone(saved); }
      async saveData(value) { saved = structuredClone(value); }
      registerEditorExtension() {} registerMarkdownPostProcessor() {} registerEvent() {} register() {} registerDomEvent() {}
      registerInterval(id) { this.interval = id; }
      registerView(type) { views.push(type); }
      addRibbonIcon() { return dom.window.document.createElement("button"); } addCommand(command) { commands.push(command.id); }
    }
    const module = { exports: {} };
    const context = vm.createContext({ module, exports: module.exports, window: dom.window, document: dom.window.document,
      URL, TextEncoder, TextDecoder, AbortController, structuredClone, crypto: webcrypto, btoa, atob, Blob, FormData, Response, console, setTimeout, clearTimeout,
      require(id) {
        if (["@codemirror/state", "@codemirror/view", "@codemirror/commands"].includes(id)) return editorRequire(id);
        assert.equal(id, "obsidian");
        return { Platform: { isMobileApp: true, isMobile: !tablet, isTablet: tablet }, Plugin,
          ItemView: class {}, Component: class {}, Modal: class {}, TFile: FixtureTFile,
          Notice: class { constructor(message) { notices.push(String(message)); } }, requestUrl() { throw new Error("unexpected startup Provider request"); } };
      }
    });
    vm.runInContext(code, context);
    const MobilePlugin = module.exports.default ?? module.exports;
    const create = () => new MobilePlugin();
    return { ...host, create, commands, views, notices, get saved() { return saved; }, set saved(value) { saved = value; } };
  }
  async function close(plugin) {
    try { await plugin.runtime?.shutdown("plugin_disabled"); }
    finally {
      plugin.onunload(); dom.window.clearInterval(plugin.interval);
      await plugin.services?.dispose();
    }
  }
  async function seed(tablet) {
    const f = fixture(tablet), first = f.create();
    await first.onload(); await close(first);
    f.commands.length = 0; f.views.length = 0; f.notices.length = 0; f.mutations.length = 0;
    return { f, path: first.store.statePath };
  }
  for (const tablet of [false,true]) for (const legacy of ["green","violet",undefined,"unknown"]) {
    await test(`production appearance migration and unload: ${tablet ? "iPad" : "iPhone"}/${legacy ?? "missing"}`, async () => {
      const { f } = await seed(tablet);
      f.saved = { ...f.saved, colorTheme:legacy, settingsLanguage:"en" };
      const plugin = f.create();
      try {
        await plugin.onload();
        assert.equal(plugin.settings.colorTheme,"minimal");
        assert.equal(f.saved.colorTheme,"minimal","startup persists migration even when folder bindings already exist");
        assert.equal(f.saved.settingsLanguage,"en","migration preserves unrelated settings");
        assert.equal(dom.window.document.body.dataset.echoinkTheme,"host","host appearance is applied before any view opens");
      } finally { await close(plugin); }
      assert.equal(dom.window.document.body.hasAttribute("data-echoink-theme"),false,"unload restores the standalone theme default");
    });
  }
  for (const tablet of [false,true]) for (const theme of ["highlighter","manifesto"]) {
    await test(`production PRO appearance preference survives fallback and entitlement restoration: ${tablet ? "iPad" : "iPhone"}/${theme}`, async () => {
      const { f } = await seed(tablet); f.saved = { ...f.saved, colorTheme: theme };
      dom.window.document.documentElement.style.setProperty("--echoink-companion-theme", "1");
      const plugin = f.create();
      try {
        await plugin.onload();
        assert.equal(plugin.settings.colorTheme,theme); assert.equal(dom.window.document.body.dataset.echoinkTheme,"minimal");
        const account = plugin.accountService, original = account.checkCapability;
        try {
          account.checkCapability = () => true; account.emit(); assert.equal(dom.window.document.body.dataset.echoinkTheme,theme);
          account.checkCapability = () => false; account.emit(); assert.equal(dom.window.document.body.dataset.echoinkTheme,"minimal");
          assert.equal(plugin.settings.colorTheme,theme); assert.equal(f.saved.colorTheme,theme);
          account.checkCapability = () => true; account.emit(); assert.equal(dom.window.document.body.dataset.echoinkTheme,theme);
          dom.window.document.documentElement.style.removeProperty("--echoink-companion-theme");
          dom.window.dispatchEvent(new dom.window.Event("pageshow"));
          await new Promise(resolve => setTimeout(resolve, 0));
          assert.equal(dom.window.document.body.dataset.echoinkTheme,"host");
          assert.equal(plugin.settings.colorTheme,theme); assert.equal(f.saved.colorTheme,theme);
        } finally { account.checkCapability = original; dom.window.document.documentElement.style.removeProperty("--echoink-companion-theme"); }
      } finally { await close(plugin); }
    });
  }
  async function assertAvailableShell(f, plugin) {
    assert.ok(f.commands.includes("open-echoink-mobile")); assert.ok(f.views.length >= 4);
    assert.ok(plugin.services.lifestyle); assert.ok(plugin.accountService);
    assert.match(plugin.store.unavailableReason, /资料|记忆|账本|Agent/u);
    const before = f.mutations.length;
    await assert.rejects(plugin.store.createSession(), /暂不可用/u);
    await assert.rejects(plugin.runtime.sendNew("sol", "must stay disabled"), /暂不可用/u);
    await assert.rejects(plugin.services.memory.repository.updateAuxiliary("shared-user/.runtime/blocked.json", () => ({ content: "blocked", value: null })), /暂不可用/u);
    assert.equal(f.mutations.length, before, "disabled task/Memory entry points never mutate files");
    assert.equal(plugin.runtime.error, plugin.store.unavailableReason);
    const workbench = await plugin.workbench.load();
    assert.ok(workbench.issues.includes(plugin.store.unavailableReason)); assert.equal(workbench.signals.length, 0);
    assert.ok(await plugin.services.modules.journal.read());
    await plugin.services.modules.todos.read();
    plugin.settings.lifestyle.finance.enabled = true;
    await plugin.services.modules.finance.readData();
    await plugin.services.knowledgePage.read();
    await plugin.services.englishPage.readPage();
    await plugin.services.getTodoStore().addTodo({ title: "冲突后独立待办仍可保存" });
    plugin.settings.mobileUi.largeText = true; await plugin.saveSettings();
    assert.equal(f.saved.mobileUi.largeText, true);
    assert.equal(f.notices.some(message => message.startsWith("EchoInk 无法加载")), false);
  }
  const modes = ["store-json", "store-schema", "store-runtime", "store-recovery", "legacy-version", "m2-backup", "m3-backup",
    "memory-manifest", "memory-user", "memory-profile", "memory-record", "memory-recovery-conflict", "desktop-transaction", "foreign-transaction", "dream-ledger", "dream-ledger-race", "agent-registry", "legacy-agent"];
  for (const tablet of [false, true]) {
    for (const mode of modes) await test(`production startup preserves ${mode} conflict and independent modules: ${tablet ? "iPad" : "iPhone"}`, async () => {
      const { f, path } = await seed(tablet), state = JSON.parse(f.files.get(path));
      const changeState = change => { change(state); f.files.set(path, JSON.stringify(state)); };
      if (mode === "store-json") f.files.set(path, "{incomplete");
      if (mode === "store-schema") changeState(value => { value.version = 99; });
      if (mode === "store-runtime") changeState(value => { value.taskRuntimeVersion = 99; });
      if (mode === "store-recovery") { f.files.delete(path); f.files.set(`${path}.task-replace-backup.json`, "{incomplete"); }
      if (mode === "legacy-version") { f.files.delete(path); f.files.set("plugin/mobile/state.json", JSON.stringify({ ...state, version: 99 })); }
      if (mode === "m2-backup") { changeState(value => { delete value.taskRuntimeVersion; }); f.files.set(`${path}.m2-backup.json`, JSON.stringify({ ...state, taskRuntimeVersion: 2 })); }
      if (mode === "m3-backup") { changeState(value => { value.taskRuntimeVersion = 1; }); f.files.set(`${path}.m3-backup.json`, JSON.stringify({ ...state, taskRuntimeVersion: 2 })); }
      if (mode === "memory-manifest") f.files.set(`${shared}.runtime/manifest.json`, JSON.stringify({ schemaVersion: 99 }));
      if (mode === "memory-user") f.files.set(`${shared}USER.md`, "# USER\n外部更新仍待核对\n");
      if (mode === "memory-profile") f.files.set(`${shared}user-profile-state.json`, JSON.stringify({ schema: "future" }));
      if (mode === "memory-record") {
        const manifest = JSON.parse(f.files.get(`${shared}.runtime/manifest.json`));
        manifest.records.push({ id: "memory_corrupt", file: "shared-user/memory/facts/memory_corrupt.md", revision: 1 });
        f.files.set(`${shared}.runtime/manifest.json`, JSON.stringify(manifest)); f.files.set(`${shared}memory/facts/memory_corrupt.md`, "malformed frontmatter");
      }
      if (mode === "memory-recovery-conflict") {
        const directory = `${shared}.runtime/mobile-transactions/txn_mobile_own`;
        const user = f.files.get(`${shared}USER.md`), profile = f.files.get(`${shared}user-profile-state.json`);
        f.files.set(`${directory}/plan.json`, JSON.stringify({ schemaVersion: 1, owner: state.instanceId, entries: [
          { relativePath: "shared-user/USER.md", existed: true, backupFile: "backup/0.bak", installedHash: hash("installed user") },
          { relativePath: "shared-user/user-profile-state.json", existed: true, backupFile: "backup/1.bak", installedHash: hash("installed profile") }
        ] }));
        f.files.set(`${directory}/state`, "applying\n"); f.files.set(`${directory}/backup/0.bak`, user); f.files.set(`${directory}/backup/1.bak`, profile);
        f.files.set(`${shared}USER.md`, "external user change"); f.files.set(`${shared}user-profile-state.json`, "installed profile");
      }
      if (mode === "desktop-transaction") f.files.set(`${shared}.runtime/transactions/txn_desktop/state`, "applying\n");
      if (mode === "foreign-transaction") {
        const directory = `${shared}.runtime/mobile-transactions/txn_mobile_own_committed`;
        f.files.set(`${directory}/plan.json`, JSON.stringify({ schemaVersion: 1, owner: state.instanceId, entries: [] })); f.files.set(`${directory}/state`, "committed\n");
        f.files.set(`${shared}.runtime/mobile-transactions/txn_mobile_foreign/plan.json`, JSON.stringify({ schemaVersion: 1, owner: "another-instance", entries: [] }));
      }
      if (mode === "dream-ledger") f.files.set(`${shared}.runtime/mobile-dream-ledger.json`, JSON.stringify({ schema: "future" }));
      if (mode === "dream-ledger-race") f.files.set(`${shared}.runtime/mobile-dream-ledger.json`, JSON.stringify({ schema: "echoink.mobile-dream.v1", dayKey: "2026-10-20", attempts: 1, owner: state.instanceId,
        status: { phase: "running", dayKey: "2026-10-20", attemptsToday: 1, dailyLimit: 1, startedAt: 42, finishedAt: null, error: "" } }));
      if (mode === "agent-registry") f.saved = { ...f.saved, agentRegistry: { schemaVersion: 99, preserved: "future Agent data" } };
      if (mode === "legacy-agent") { const settings = { ...f.saved }; delete settings.agentRegistry; f.saved = settings; f.files.set("plugin/pi-agent-product-v1/.echoink/agents/echoink/agent-identity.json", "{malformed legacy identity"); }
      const protectedFiles = new Map(f.files), rawRegistry = JSON.stringify(f.saved.agentRegistry), registryPresent = Object.hasOwn(f.saved, "agentRegistry");
      if (mode === "dream-ledger-race") {
        const read = f.adapter.read.bind(f.adapter); let changed = false;
        f.adapter.read = async file => {
          const bytes = await read(file);
          if (!changed && file === `${shared}.runtime/mobile-dream-ledger.json`) {
            changed = true; const foreign = JSON.stringify({ ...JSON.parse(bytes), owner: "another-live-instance" });
            f.files.set(file, foreign); protectedFiles.set(file, foreign);
          }
          return bytes;
        };
      }
      f.mutations.length = 0;
      const plugin = f.create();
      try {
        await plugin.onload();
        for (const [file, bytes] of protectedFiles) assert.equal(f.files.get(file), bytes, `startup preserves ${file}`);
        assert.equal(f.mutations.some(item => protectedFiles.has(item.path) || protectedFiles.has(item.to)), false, "startup neither overwrites nor renames/removes existing files");
        await assertAvailableShell(f, plugin);
        if (mode === "agent-registry" || mode === "legacy-agent") {
          assert.equal(Object.hasOwn(f.saved, "agentRegistry"), registryPresent); assert.equal(JSON.stringify(f.saved.agentRegistry), rawRegistry, "independent settings saves preserve unrecognized Registry data");
        }
        for (const [file, bytes] of protectedFiles) assert.equal(f.files.get(file), bytes, `independent module use preserves ${file}`);
      } finally { await close(plugin); }
    });
    await test(`production reload contains an old instance's late shutdown commit: ${tablet ? "iPad" : "iPhone"}`, async () => {
      const f = fixture(tablet), old = f.create(); await old.onload();
      const path = old.store.statePath, original = f.files.get(path), entered = deferred(), release = deferred();
      const write = f.adapter.write.bind(f.adapter); let held = false;
      f.adapter.write = async (file, bytes) => {
        if (!held && file.startsWith(`${path}.`) && file.endsWith(".tmp")) { held = true; entered.resolve(); await release.promise; }
        return write(file, bytes);
      };
      const stopped = old.runtime.shutdown("plugin_disabled"); old.onunload(); dom.window.clearInterval(old.interval);
      await entered.promise;
      const read = f.adapter.read.bind(f.adapter); let loaded = false, latest;
      f.adapter.read = async file => {
        if (!loaded && file === path) {
          loaded = true; const bytes = await read(file); release.resolve(); await stopped; latest = f.files.get(path); return bytes;
        }
        return read(file);
      };
      const plugin = f.create();
      try {
        await plugin.onload();
        assert.notEqual(latest, original, "the real old shutdown committed after the new Store read");
        assert.equal(f.files.get(path), latest, "cold recovery never overwrites the late commit");
        assert.match(plugin.store.unavailableReason, /资料已变化/u);
        await assertAvailableShell(f, plugin);
        await plugin.runtime.shutdown("plugin_disabled"); await tick();
        assert.equal(f.files.get(path), latest, "disabled shutdown never retries the stale snapshot");
      } finally { release.resolve(); await stopped; await close(plugin); await old.services.dispose(); }
    });
  }
  for (const stage of ["store", "memory", "cold-recovery"]) await test(`production startup still rejects unexpected ${stage} I/O failures`, async () => {
    const { f, path } = await seed(false), plugin = f.create();
    const read = f.adapter.read.bind(f.adapter), write = f.adapter.write.bind(f.adapter);
    f.adapter.read = async file => {
      if (stage === "store" && file === path || stage === "memory" && file === `${shared}.runtime/manifest.json`) throw new Error("UNEXPECTED_IO_FAILURE");
      return read(file);
    };
    f.adapter.write = async (file, bytes) => {
      if (stage === "cold-recovery" && file.startsWith(`${path}.`) && file.endsWith(".tmp")) throw new Error("UNEXPECTED_IO_FAILURE");
      return write(file, bytes);
    };
    try {
      await assert.rejects(plugin.onload(), /UNEXPECTED_IO_FAILURE/u);
      assert.equal(plugin.store.unavailableReason, undefined, "unrecognized failures must not masquerade as safe data conflicts");
      assert.ok(f.notices.some(message => message.startsWith("EchoInk 无法加载")));
    } finally {
      f.adapter.read = read; f.adapter.write = write;
      plugin.onunload(); dom.window.clearInterval(plugin.interval); await plugin.services?.dispose();
    }
  });
}
