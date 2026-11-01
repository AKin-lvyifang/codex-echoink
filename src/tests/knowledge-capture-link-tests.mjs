import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { desktopNodeTestBanner } from "../../scripts/desktop-node-test-host.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = path.join(root, ".tmp/capture-link/acceptance.mjs");
await mkdir(path.dirname(output), { recursive: true });
await esbuild.build({
  absWorkingDir: root,
  stdin: { contents: 'import { runKnowledgeCaptureLinkTests } from "./src/tests/knowledge-capture-link"; globalThis.DOMParser = window.DOMParser; await runKnowledgeCaptureLinkTests();', resolveDir: root, loader: "ts" },
  loader: { ".svg": "dataurl", ".webp": "dataurl", ".md": "text" },
  bundle: true, platform: "node", format: "esm", target: "node22", packages: "external",
  banner: desktopNodeTestBanner,
  alias: { obsidian: path.join(root, "src/tests/obsidian-shim.ts") },
  outfile: output, logLevel: "silent"
});
const result = spawnSync(process.execPath, ["--import", path.join(root, "scripts/desktop-dom-test-preload.mjs"), output], { cwd: root, env: { ...process.env, PI_OFFLINE: "1" }, stdio: "inherit" });
process.exit(result.status ?? 1);
