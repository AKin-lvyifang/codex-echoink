import { spawnSync } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import vm from "node:vm";
import { originalAgentAvatarAssets, agentAvatarAssetsSource, agentAvatarAssetsPlugin, profileStringsPlugin, profileModulesPlugin, profileSharedModules, sharedAssetsBundle } from "../../scripts/bundle-shared-assets.mjs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const rootDir = fileURLToPath(new URL("../../", import.meta.url));
const outputDir = await mkdtemp(path.join(os.tmpdir(), "echoink-identity-paths-test-"));

try {
  const original = await originalAgentAvatarAssets();
  const packed = await esbuild.build({ stdin: { contents: await agentAvatarAssetsSource(), resolveDir: rootDir }, bundle: true, write: false, format: "cjs", platform: "browser", logLevel: "silent" });
  const shared = { exports: {} };
  vm.runInNewContext(packed.outputFiles[0].text, { module: shared, exports: shared.exports, atob, TextDecoder });
  const restored = shared.exports.agentAvatarAssets();
  assert.deepEqual(Array.from(restored), Array.from(original.assets));
  for (let i = 0; i < restored.length; i++) {
    const url = restored[i];
    const svg = url.startsWith("data:image/svg+xml;base64,") ? Buffer.from(url.split(",")[1], "base64") : Buffer.from(decodeURIComponent(url.slice(url.indexOf(",") + 1)));
    assert.deepEqual(svg, await readFile(original.paths[i]), "SVG source bytes must remain exact");
  }
  for (const sharedMode of [false, true]) {
    const built = await esbuild.build({ entryPoints: [path.join(rootDir, "src/ui/agent-avatar-presets.ts")], bundle: true, write: false, format: "cjs", platform: "browser", plugins: [agentAvatarAssetsPlugin(sharedMode)], logLevel: "silent" });
    const catalog = { exports: {} };
    vm.runInNewContext(built.outputFiles[0].text, { module: catalog, exports: catalog.exports, atob, TextDecoder, __echoinkSharedAssets: shared.exports });
    assert.equal(catalog.exports.AGENT_AVATAR_PRESETS.length, 15);
    for (const preset of catalog.exports.AGENT_AVATAR_PRESETS) {
      const index = original.paths.findIndex(file => path.basename(file) === preset.id + ".svg");
      assert.equal(preset.assetPath, original.assets[index]);
      assert.equal(catalog.exports.resolveAgentAvatarUrl({ kind: "preset", presetId: preset.id }), preset.assetPath);
    }
    assert.equal(catalog.exports.resolveAgentAvatarUrl({ kind: "default" }), null);
    assert.equal(catalog.exports.resolveAgentAvatarUrl({ kind: "preset", presetId: "missing" }), null);
    assert.equal(catalog.exports.resolveAgentAvatarUrl({ kind: "custom", dataUrl: "data:image/png;base64,YQ==" }), "data:image/png;base64,YQ==");
  }
  console.log("PASS all 15 avatar URLs and SVG bytes: original loader, standalone mobile and shared desktop/mobile");
  const profileEntry = [...profileSharedModules].map(([file, names], index) =>
    `import {${names.join(",")}} from ${JSON.stringify(path.join(rootDir, file))};export const m${index}={${names.join(",")}};`).join("\n");
  const profileOptions = { stdin: { contents: profileEntry, resolveDir: rootDir }, bundle: true, write: false, format: "cjs", platform: "browser", external: ["obsidian"], logLevel: "silent" };
  let obsidianReads = 0;
  const profileGlobals = { TextEncoder, TextDecoder, atob, btoa, require(id) { assert.equal(id, "obsidian"); obsidianReads++; return { Modal: class {}, Notice: class {}, setIcon() {} }; } };
  const packedContext = vm.createContext({ ...profileGlobals });
  vm.runInContext(await sharedAssetsBundle(true), packedContext);
  assert.equal(obsidianReads, 0, "shared profile must stay lazy before platform load");
  const packedProfile = packedContext.__echoinkSharedAssets.profileModules();
  assert.equal(packedContext.__echoinkSharedAssets.profileModules(), packedProfile, "one cached implementation");
  const reference = { exports: {} };
  const referenceBuild = await esbuild.build({ ...profileOptions, plugins: [agentAvatarAssetsPlugin(), profileStringsPlugin()] });
  vm.runInNewContext(referenceBuild.outputFiles[0].text, { ...profileGlobals, module: reference, exports: reference.exports });
  const proxy = { exports: {} };
  const proxyBuild = await esbuild.build({ ...profileOptions, plugins: [profileModulesPlugin()] });
  vm.runInNewContext(proxyBuild.outputFiles[0].text, { ...profileGlobals, module: proxy, exports: proxy.exports, __echoinkSharedAssets: packedContext.__echoinkSharedAssets });
  for (const [index, [, names]] of [...profileSharedModules].entries()) {
    for (const name of names) {
      const actual = packedProfile[`m${index}`][name], expected = reference.exports[`m${index}`][name];
      assert.equal(typeof actual, typeof expected, name);
      assert.equal(proxy.exports[`m${index}`][name], actual, `${name}: both platform proxies use the same export`);
      if (typeof actual !== "function") assert.equal(JSON.stringify(actual), JSON.stringify(expected), name);
    }
  }
  const packedTemplate = packedProfile.m1.getAgentTemplate("executor"), sourceTemplate = reference.exports.m1.getAgentTemplate("executor");
  const habit = [{ key: "preserved", text: "先解释因果😀" }];
  const markdown = api => api.m2.renderAgentMarkdown({ identity: api.m0.defaultAgentIdentityState(42), styleName: "执行者", self: api.m2.agentSelfFromTemplate(api.m1.getAgentTemplate("executor"), habit) });
  assert.equal(JSON.stringify(packedTemplate), JSON.stringify(sourceTemplate));
  assert.equal(markdown(packedProfile), markdown(reference.exports));
  assert.equal(JSON.stringify(packedProfile.m2.parseAgentCurrentSelf(markdown(packedProfile))), JSON.stringify(reference.exports.m2.parseAgentCurrentSelf(markdown(reference.exports))));
  assert.equal(packedProfile.m3.agentSelfMetadataJson(packedProfile.m3.emptyAgentSelfMetadata(42)), reference.exports.m3.agentSelfMetadataJson(reference.exports.m3.emptyAgentSelfMetadata(42)));
  assert.equal(packedProfile.m9.sha256Hex("头像与人格😀"), reference.exports.m9.sha256Hex("头像与人格😀"));
  assert.throws(() => packedProfile.m5.validateAgentAvatarSvg('<svg viewBox="0 0 256 256"><script/></svg>'), error => error instanceof packedProfile.m5.AvatarProcessingError);
  console.log("PASS shared Profile: lazy initialization, exact constants/assets, proxy references, current-self/metadata/Unicode hash and avatar rejection");
  const outputFile = path.join(outputDir, "identity-paths.mjs");
  await esbuild.build({
    stdin: {
      contents: String.raw`
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, readdir, stat, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setWindowsPaths } from "echoink-test-repository-path";
import { PersonalMemoryRepository } from "./src/harness/memory/personal-memory-repository";
import { MobileProfileProtocol, renderPersonalMemoryOverview } from "./src/harness/memory/mobile-profile-protocol";
import { defaultAgentRegistry, normalizeAgentRegistry } from "./src/agents/registry";
import { migrateLegacyAgentRegistry } from "./src/agents/migration";
import { sha256Hex } from "./src/utils/sha256";

function adapterFor(root) {
  const file = relative => path.join(root, relative);
  return {
    async exists(relative) { try { await stat(file(relative)); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } },
    read: relative => readFile(file(relative), "utf8"),
    write: (relative, text) => writeFile(file(relative), text),
    mkdir: relative => mkdir(file(relative), { recursive: true }),
    rename: (from, to) => rename(file(from), file(to)),
    remove: relative => rm(file(relative)),
    rmdir: relative => rm(file(relative), { recursive: true }),
    async list(relative) { const entries = await readdir(file(relative), { withFileTypes: true }); return {
      files: entries.filter(entry => entry.isFile()).map(entry => relative + "/" + entry.name),
      folders: entries.filter(entry => entry.isDirectory()).map(entry => relative + "/" + entry.name)
    }; }
  };
}
function mobileFor(root) {
  return new MobileProfileProtocol(adapterFor(root), () => Date.now(), { read: () => "identity_paths", create: () => "identity_paths" });
}

for (const windowsPaths of [false, true]) {
  for (const existingLegacyProfile of [true, false]) {
    const vaultPath = await mkdtemp(path.join(os.tmpdir(), "echoink-identity-paths-vault-"));
    const repository = new PersonalMemoryRepository({ vaultPath, vaultId: "identity-path-regression", watchExternalChanges: false });
    const mobile = mobileFor(vaultPath);
    try {
      // An old installed vault has the manifest and profile produced by the
      // mobile/shared control protocol; desktop must retain its Agent hash.
      if (existingLegacyProfile) {
        const initial = await mobile.profile();
        await mobile.save({ templateId: "advisor", identity: { displayName: "小墨", avatar: { kind: "preset", presetId: "nova" } } }, initial.version);
        const user = "# User\n\nExisting user profile.\n";
        await mkdir(path.dirname(repository.layout.manifest), { recursive: true });
        await writeFile(repository.layout.user, user);
        const manifest = { schemaVersion: 1, vaultId: "identity-path-regression", revision: 0, records: [], tombstones: [], updatedAt: 1,
          fixedFileHashes: { agent: sha256Hex(await readFile(repository.layout.agent, "utf8")), user: sha256Hex(user) } };
        await writeFile(repository.layout.manifest, JSON.stringify(manifest));
        await writeFile(repository.layout.audit, "");
        await writeFile(repository.layout.memory, renderPersonalMemoryOverview(manifest, []));
      }
      await repository.initialize();
      if (!existingLegacyProfile) {
        await assert.rejects(readFile(repository.layout.agent), { code: "ENOENT" }, "desktop does not create a retired Agent file");
        const initial = await mobile.profile();
        await mobile.save({ templateId: "advisor", identity: { displayName: "小墨", avatar: { kind: "preset", presetId: "nova" } } }, initial.version);
      }
      let profile = await mobile.profile();
      const beforeAgent = await readFile(repository.layout.agent);
      const beforeMeta = await readFile(repository.layout.agentSelfMetadata);
      const registry = await migrateLegacyAgentRegistry(defaultAgentRegistry(), repository.layout.root);
      assert.equal(registry.agents[0].name, "小墨");
      assert.equal(registry.agents[0].styleId, "analysis");
      assert.deepEqual(await readFile(repository.layout.agent), beforeAgent);
      assert.deepEqual(await readFile(repository.layout.agentSelfMetadata), beforeMeta, "registry migration never rewrites legacy files");
      const registryFile = path.join(vaultPath, "registry.json");
      let currentRegistry = registry;
      for (const presetId of ["sol", "mica"]) {
        currentRegistry = normalizeAgentRegistry({ ...currentRegistry, agents: currentRegistry.agents.map(agent => ({ ...agent, avatar: { kind: "preset", presetId } })) });
        await writeFile(registryFile, JSON.stringify(currentRegistry));
        assert.equal(normalizeAgentRegistry(JSON.parse(await readFile(registryFile, "utf8"))).agents[0].avatar.presetId, presetId);
        profile = await mobile.save({ identity: { displayName: "小墨", avatar: { kind: "preset", presetId } } }, profile.version);
        assert.equal(JSON.parse(await readFile(repository.layout.agentIdentity, "utf8")).avatar.presetId, presetId);
      }
      const staleMobileVersion = profile.version;
      profile = await mobile.save({ identity: { displayName: "墨墨", avatar: { kind: "preset", presetId: "mica" } } }, profile.version);
      assert.match(await readFile(repository.layout.agent, "utf8"), /墨墨/u);
      await assert.rejects(mobile.save({ identity: { displayName: "过期覆盖", avatar: { kind: "default" } } }, staleMobileVersion), /已变化/u);
      assert.equal(await migrateLegacyAgentRegistry(currentRegistry, repository.layout.root), currentRegistry, "completed registry migration cannot be overwritten by later mobile identity edits");

      // Preserve the path/watch/cache regression on the active USER transaction.
      // Only the Repository's relative paths use Windows separators.
      setWindowsPaths(windowsPaths);
      await repository.dispose();
      const desktop = new PersonalMemoryRepository({ vaultPath, vaultId: "identity-path-regression", watchExternalChanges: false });
      try {
        await desktop.initialize();
        const initialRevision = (await desktop.inspect()).revision;
        const user = "# User\n\nCurrent desktop user profile.\n";
        const saved = await desktop.updateIdentityFile("user", user, initialRevision);
        assert.equal((await desktop.inspect()).revision, saved.revision);
        assert.equal(JSON.parse(await readFile(desktop.layout.manifest, "utf8")).revision, saved.revision);
        assert.equal((await desktop.readUserControlState()).user, user, "saved user text refreshes the fixed-context cache");
        assert.ok(desktop.internalWatchExpectations.has("shared-user/USER.md"), "the watcher key is canonical on both path styles");
        assert.equal(await desktop.isExpectedInternalWatchEcho("shared-user/USER.md"), true);
        for (const memoryMode of ["normal", "no_memory"]) {
          const context = await desktop.loadFixedContext({ memoryMode });
          assert.equal(context.agent, "");
          assert.equal(context.injectionKeys.includes("echoink.agent"), false);
        }
        const mobileAfterUserSave = await mobile.profile();
        assert.equal(mobileAfterUserSave.identity.displayName, "墨墨");
        assert.equal(mobileAfterUserSave.templateId, "advisor");
        assert.match(await mobile.context(true), /Current desktop user profile/u, "mobile still reads desktop user Memory updates");
        await assert.rejects(desktop.applyCognitiveUpdate({ secondaryRecords: [], extraChanges: [], detail: "stale-revision-test", expectedMemoryRevision: initialRevision }), error => error.code === "revision_conflict");
      } finally { await desktop.dispose(); }
      console.log("PASS registry/mobile/user persistence: " + (windowsPaths ? "Windows separator simulation" : "native paths")
        + "; " + (existingLegacyProfile ? "existing legacy profile" : "fresh desktop vault")
        + "; one-time migration, avatars, rename, cache, watcher echo, revision conflict");
    } finally {
      setWindowsPaths(false); await repository.dispose(); await rm(vaultPath, { recursive: true, force: true });
    }
  }
}

`,
      resolveDir: rootDir,
      sourcefile: "agent-identity-paths-test-entry.js",
      loader: "js"
    },
    bundle: true,
    loader: { ".md": "text" },
    platform: "node",
    target: "node22",
    format: "esm",
    banner: { js: `import { createRequire as createIdentityTestRequire } from "node:module"; const require = createIdentityTestRequire(${JSON.stringify(path.join(rootDir, "package.json"))});` },
    alias: { obsidian: path.join(rootDir, "src/tests/obsidian-shim.ts") },
    outfile: outputFile,
    logLevel: "silent",
    plugins: [{
      name: "repository-relative-path-simulation",
      setup(build) {
        build.onResolve({ filter: /^echoink-test-repository-path$/ }, () => ({
          path: "repository-path", namespace: "identity-path-test"
        }));
        build.onResolve({ filter: /^node:path$/ }, (args) =>
          args.importer.replaceAll("\\", "/").endsWith("/platform/desktop-paths.ts")
            ? { path: "repository-path", namespace: "identity-path-test" }
            : undefined);
        build.onLoad({ filter: /.*/, namespace: "identity-path-test" }, () => ({
          contents: String.raw`
import native from "node:path";
export * from "node:path";
let windows = false;
export let sep = native.sep;
export function setWindowsPaths(value) { windows = value; sep = windows ? "\\" : native.sep; }
export function relative(from, to) {
    const relative = native.relative(from, to);
    return windows ? relative.split(native.sep).join("\\") : relative;
}
export function resolve(...parts) {
    return native.resolve(...(windows ? parts.map((part) => part.replaceAll("\\", native.sep)) : parts));
}`,
          loader: "js"
        }));
      }
    }]
  });
  const result = spawnSync(process.execPath, [outputFile], {
    cwd: rootDir,
    env: { ...process.env, PI_OFFLINE: "1" },
    stdio: "inherit"
  });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(outputDir, { recursive: true, force: true });
}
