import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, access, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { CognitiveSystem } from "../harness/memory/cognitive-system";
import { MobileProfileProtocol } from "../harness/memory/mobile-profile-protocol";
import { MemoryDeveloperBackups } from "../plugin/developer-mode/memory-backups";
import type { DataAdapter } from "obsidian";
import { createPiKnowledgeInlineExtension } from "../plugin/pi-production-runtime-composition";
import { buildEchoInkRuntimeSystemPrompt } from "../harness/memory/personal-memory-contracts";
import { withPersonalMemoryFixture } from "./personal-memory-fixture";

/** P16 replaces the retired desktop Self migration acceptance with its real boundary. */
export async function runAgentSelfMigrationScenarios(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    await assert.rejects(access(fixture.repository.layout.agent), /ENOENT/u);
    const agentDirectory = path.dirname(fixture.repository.layout.agent);
    await mkdir(agentDirectory, { recursive: true });
    // Oversized AGENT and invalid metadata would fail the old read/migration path.
    const oldAgent = `# RETIRED_SELF_SENTINEL\n${"old-learned-habit".repeat(30_000)}`;
    const oldMetadata = "not-json:RETIRED_META_SENTINEL";
    const oldPersonality = "not-json:RETIRED_PERSONALITY_SENTINEL";
    await writeFile(fixture.repository.layout.agent, oldAgent);
    await writeFile(fixture.repository.layout.agentSelfMetadata, oldMetadata);
    await writeFile(fixture.repository.layout.personalityState, oldPersonality);
    const repository = await fixture.reopen();
    const system = await CognitiveSystem.create({ repository, llm: () => null,
      getDreamConfig: () => ({ enabled: true, runsPerDay: 1 }),
      isForegroundBusy: () => false, registerInterval: () => undefined, now: fixture.now });
    try {
      for (const memoryMode of ["normal", "no_memory"] as const) {
        const fixed = await repository.loadFixedContext({ memoryMode });
        assert.equal(fixed.agent, "");
        assert.equal(fixed.injectionKeys.includes("echoink.agent"), false);
        const handlers = new Map<string, (...args: any[]) => any>();
        const extension = createPiKnowledgeInlineExtension({ vaultSecurity: () => {},
          currentTurn: () => null,
          currentMemoryTurn: () => ({ ...fixture.runtime(), query: "fixture", memoryMode }),
          personalMemory: repository });
        await (typeof extension === "function" ? extension : extension.factory)({
          on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler)
        } as never);
        const base = buildEchoInkRuntimeSystemPrompt();
        const result = await handlers.get("before_agent_start")!({ systemPrompt: base });
        assert.doesNotMatch(result?.systemPrompt ?? base, /RETIRED_SELF_SENTINEL|old-learned-habit|echoink_agent_self|current-self|人格、价值观/u);
      }
      const written = await repository.write({ operation: "create", kind: "fact", title: "用户事实",
        content: "用户本人明确陈述的长期事实。", basis: "explicit" }, fixture.runtime());
      await repository.forgetFromUserControl(written.record!.id, "用户忘记", written.revision);
      assert.equal(await readFile(repository.layout.agent, "utf8"), oldAgent);
      assert.equal(await readFile(repository.layout.agentSelfMetadata, "utf8"), oldMetadata);
      assert.equal(await readFile(repository.layout.personalityState, "utf8"), oldPersonality);
      assert.equal((await repository.readUserControlState()).records.length, 0);
      assert.equal(Object.hasOwn(await system.engine.runOnce(), "agentUpdated"), false);
    } finally { await system.dispose(); }
    // Compatibility callers cannot reintroduce Self through a supplied fixed DTO.
    const handlers = new Map<string, (...args: any[]) => any>();
    const extension = createPiKnowledgeInlineExtension({ vaultSecurity: () => {}, currentTurn: () => null,
      personalMemory: { loadFixedContext: async () => ({ revision: 0, agent: "RETIRED_SELF_SENTINEL",
        user: null, memory: null, injectionKeys: [] }) } });
    await (typeof extension === "function" ? extension : extension.factory)({ on: (n: string, h: (...args: any[]) => any) => handlers.set(n, h) } as never);
    const result = await handlers.get("before_agent_start")!({ systemPrompt: "product" });
    assert.doesNotMatch(result?.systemPrompt ?? "product", /RETIRED_SELF_SENTINEL/u);
  });
  await scenarioFreshDesktopKeepsMobileCompatible();
  console.log("PASS desktop Self retirement: real startup, normal/no-memory prompt, forget and original bytes");
}

async function scenarioFreshDesktopKeepsMobileCompatible(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const resolve = (file: string) => path.join(fixture.vaultPath, file);
    const adapter = {
      exists: async (file: string) => { try { await access(resolve(file)); return true; } catch { return false; } },
      read: (file: string) => readFile(resolve(file), "utf8"),
      write: (file: string, text: string) => writeFile(resolve(file), text),
      rename: (from: string, to: string) => rename(resolve(from), resolve(to)),
      remove: (file: string) => rm(resolve(file)),
      rmdir: (file: string) => rm(resolve(file), { recursive: true }),
      mkdir: (file: string) => mkdir(resolve(file), { recursive: true }).then(() => undefined),
      list: async (file: string) => { const entries = await readdir(resolve(file), { withFileTypes: true }); return {
        files: entries.filter((entry) => entry.isFile()).map((entry) => `${file}/${entry.name}`),
        folders: entries.filter((entry) => entry.isDirectory()).map((entry) => `${file}/${entry.name}`)
      }; }
    } as DataAdapter;
    const mobile = new MobileProfileProtocol(adapter, fixture.now, { read: () => "fixture-device", create: () => "fixture-device" });
    const initial = await mobile.profile();
    assert.equal(initial.templateId, null);
    await assert.rejects(access(fixture.repository.layout.agent), /ENOENT/u);
    const named = await mobile.save({ identity: { displayName: "手机墨墨", avatar: { kind: "default" } } }, initial.version);
    const selected = await mobile.save({ templateId: "executor" }, named.version);
    assert.equal(selected.templateId, "executor");
    const legacyAgent = await readFile(fixture.repository.layout.agent, "utf8");
    const reopened = await fixture.reopen();
    const written = await reopened.write({ operation: "create", kind: "fact", title: "手机互通事实",
      content: "保留手机身份协议时桌面用户记忆继续可写。", basis: "explicit" }, fixture.runtime());
    assert.ok(written.record);
    assert.equal((await mobile.profile()).identity.displayName, "手机墨墨");
    assert.equal((await reopened.loadFixedContext({ memoryMode: "normal" })).agent, "");
    await writeFile(fixture.repository.layout.agent, `${legacyAgent}\nExternal identity tamper.\n`);
    await assert.rejects(mobile.profile(), /资料|无法|invalid|不一致|保存/u);
    await writeFile(fixture.repository.layout.agent, legacyAgent);
    const metadata = await readFile(fixture.repository.layout.agentSelfMetadata, "utf8");
    await writeFile(fixture.repository.layout.agentSelfMetadata, "invalid metadata");
    await assert.rejects(mobile.profile());
    await writeFile(fixture.repository.layout.agentSelfMetadata, metadata);
    assert.equal((await mobile.profile()).templateId, "executor");
    await reopened.dispose();
    await fixture.repository.dispose();
    const backups = new MemoryDeveloperBackups(fixture.repository.layout.root);
    const validateReopen = async () => { const checked = await fixture.reopen(); await checked.dispose(); };
    const reset = await backups.change("reset", validateReopen);
    const originalBackup = await readFile(reset.backup);
    const afterReset = await mobile.profile();
    await mobile.save({ identity: { displayName: "后来手机改名", avatar: { kind: "preset", presetId: "sol" } } }, afterReset.version);
    await backups.change("restore", validateReopen);
    assert.ok(originalBackup.equals(await readFile(reset.backup)), "historical backup bytes stay immutable");
    assert.equal((await mobile.profile()).identity.displayName, "后来手机改名");
    const restored = await fixture.reopen();
    assert.ok((await restored.readUserControlState()).records.some((record) => record.id === written.record!.id));
  }, { watchExternalChanges: false });
}
