import { disposableTestOutputRoot } from "./disposable-test-root.mjs";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(disposableTestOutputRoot(path.join(root, ".tmp")), "developer-mode-tests.mjs");
await mkdir(path.dirname(output), { recursive: true });
try {
  await esbuild.build({
    entryPoints: ["src/tests/developer-mode.ts"], absWorkingDir: root,
    bundle: true, platform: "node", target: "node22", format: "esm",
    banner: { js: 'import { createRequire as createDeveloperTestRequire } from "node:module"; const require = createDeveloperTestRequire(import.meta.url);' },
    loader: { ".md": "text", ".svg": "dataurl", ".webp": "dataurl" },
    external: ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "yaml"],
    plugins: [{ name: "obsidian-fixture", setup(build) {
      build.onResolve({ filter: /(?:^|\/)origin-controls$/ }, () => ({ path: path.join(root, "src/tests/origin-controls-shim.ts") }));
      build.onResolve({ filter: /(?:^|\/)origin-setting$/ }, () => ({ path: path.join(root, "src/tests/origin-setting-shim.ts") }));
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(root, "src/tests/obsidian-shim.ts") }));
      build.onResolve({ filter: /^echoink:test-settings-dom$/ }, () => ({ path: "settings-dom", namespace: "fixture" }));
      build.onLoad({ filter: /.*/, namespace: "fixture" }, async () => {
        // Reuse the existing DOM fixture without importing its unrelated test runner.
        const source = await readFile(path.join(root, "src/tests/provider-settings-behavior.ts"), "utf8");
        const start = source.indexOf("function installProviderModalDomFixture(): void {");
        const end = source.indexOf("function withSettingsTabDefaults<", start);
        if (start < 0 || end < 0) throw new Error("Settings DOM fixture boundaries were not found");
        return { loader: "ts", contents: [
          "let providerModalTestDocument: ProviderModalTestDocument;",
          source.slice(start, end),
          "export { installProviderModalDomFixture, ProviderModalTestElement };"
        ].join("\n") };
      });
    } }], outfile: output, logLevel: "silent"
  });
  const result = spawnSync(process.execPath, [output], {
    cwd: root, env: { ...process.env, PI_OFFLINE: "1", ECHOINK_DISABLE_ACP: "1" }, stdio: "inherit"
  });
  process.exitCode = result.status ?? 1;
} finally { await rm(output, { force: true }); }
