import { desktopNodeTestBanner } from "./desktop-node-test-host.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = await mkdtemp(path.join(root, ".tmp-mcp-settings-"));
try {
  const output = path.join(fixture, "tests.mjs");
  await esbuild.build({
    stdin: { contents: 'import {runMcpServerSettingsTests} from "./src/tests/mcp-server-settings"; await runMcpServerSettingsTests();', resolveDir: root, loader: "ts" },
    banner: desktopNodeTestBanner, outfile: output, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent",
    external: ["jsdom"], alias: { obsidian: path.join(root, "src/tests/obsidian-shim.ts") }
  });
  const result = spawnSync(process.execPath, [output], { cwd: root, stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally { await rm(fixture, { recursive: true, force: true }); }
