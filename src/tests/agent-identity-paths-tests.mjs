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
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setWindowsPaths } from "echoink-test-repository-path";
import { CognitiveSystem } from "./src/harness/memory/cognitive-system";
import { PersonalMemoryRepository } from "./src/harness/memory/personal-memory-repository";

for (const windowsPaths of [false, true]) {
  const vaultPath = await mkdtemp(path.join(os.tmpdir(), "echoink-identity-paths-vault-"));
  const repository = new PersonalMemoryRepository({
    vaultPath, vaultId: "identity-path-regression", watchExternalChanges: false
  });
  let system;
  try {
    system = await CognitiveSystem.create({
      repository, llm: () => null,
      getDreamConfig: () => ({ enabled: false, runsPerDay: 3 }),
      isForegroundBusy: () => false, registerInterval: () => {}
    });
    system.scheduler.stop();
    await system.selectPersonalityTemplate("advisor", {
      initialIdentity: { displayName: "小墨", avatar: { kind: "preset", presetId: "nova" } }
    });
    // Start from an existing user's committed identity. Only this Repository's
    // relative paths use Windows separators; filesystem I/O remains native.
    setWindowsPaths(windowsPaths);
    const initialRevision = (await repository.inspect()).revision;
    for (const presetId of ["sol", "mica"]) {
      const saved = await system.updateAgentIdentity({
        displayName: "小墨", avatar: { kind: "preset", presetId }
      });
      const disk = JSON.parse(await readFile(repository.layout.manifest, "utf8"));
      assert.equal((await repository.inspect()).revision, saved.revision);
      assert.equal(disk.revision, saved.revision, "cache must advance with each saved avatar");
      assert.equal(JSON.parse(await readFile(repository.layout.agentIdentity, "utf8")).avatar.presetId, presetId);
    }
    const renamed = await system.updateAgentIdentity({
      displayName: "墨墨", avatar: { kind: "preset", presetId: "mica" }
    });
    assert.equal(renamed.revision, initialRevision + 3);
    const context = await repository.loadFixedContext({ memoryMode: "normal" });
    assert.equal(context.revision, renamed.revision);
    assert.match(context.agent, /墨墨/u, "renaming must refresh the cached AGENT.md projection");
    assert.ok(repository.internalWatchExpectations.has("agents/echoink/AGENT.md"),
      "the canonical watcher key must be registered before the write");
    assert.equal(await repository.isExpectedInternalWatchEcho("agents/echoink/AGENT.md"), true,
      "the native watcher callback must recognize our own committed rename");
    await assert.rejects(repository.applyCognitiveUpdate({
      secondaryRecords: [], extraChanges: [], detail: "stale-revision-test",
      expectedMemoryRevision: initialRevision
    }), (error) => error.code === "revision_conflict", "stale writes must remain blocked");
    console.log("PASS identity persistence: " + (windowsPaths ? "Windows separator simulation" : "native paths")
      + "; consecutive avatars, rename, cache, watcher echo, revision conflict");
  } finally {
    setWindowsPaths(false);
    if (system) await system.dispose();
    else await repository.dispose();
    await rm(vaultPath, { recursive: true, force: true });
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
    outfile: outputFile,
    logLevel: "silent",
    plugins: [{
      name: "repository-relative-path-simulation",
      setup(build) {
        build.onResolve({ filter: /^echoink-test-repository-path$/ }, () => ({
          path: "repository-path", namespace: "identity-path-test"
        }));
        build.onResolve({ filter: /^node:path$/ }, (args) =>
          args.importer.replaceAll("\\", "/").endsWith("/harness/memory/personal-memory-repository.ts")
            ? { path: "repository-path", namespace: "identity-path-test" }
            : undefined);
        build.onLoad({ filter: /.*/, namespace: "identity-path-test" }, () => ({
          contents: String.raw`
import native from "node:path";
let windows = false;
export function setWindowsPaths(value) { windows = value; }
export default {
  ...native,
  get sep() { return windows ? "\\" : native.sep; },
  relative(from, to) {
    const relative = native.relative(from, to);
    return windows ? relative.split(native.sep).join("\\") : relative;
  },
  resolve(...parts) {
    return native.resolve(...(windows ? parts.map((part) => part.replaceAll("\\", native.sep)) : parts));
  }
};`,
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
