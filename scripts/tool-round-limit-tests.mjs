import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import esbuild from "esbuild";
import { desktopNodeTestBanner, desktopNodeTestAliases } from "./desktop-node-test-host.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const temp = await mkdtemp(path.join(tmpdir(), "tool-round-test-"));
try {
  const outfile = path.join(temp, "desktop.mjs");
  await esbuild.build({ stdin: { contents: 'import {runToolRoundLimitTests} from "./src/tests/tool-round-limit"; await runToolRoundLimitTests();', resolveDir: root, loader: "ts" },
    loader: { ".md": "text", ".svg": "text", ".html": "text", ".css": "text", ".png": "dataurl" }, bundle: true, platform: "node", format: "esm", target: "node22", outfile, banner: desktopNodeTestBanner, alias: desktopNodeTestAliases, plugins: [{ name: "real-pi", setup(build) { build.onResolve({ filter: /^(?:@earendil-works\/pi-(?:agent-core|ai|coding-agent)(?:\/.*)?|yaml)$/ }, args => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true })); } }], logLevel: "silent" });
  const result = spawnSync(process.execPath, [outfile], { cwd: root, stdio: "inherit", env: { ...process.env, PI_OFFLINE: "1" } });
  if (result.status !== 0) throw new Error(`Desktop tool-round scenarios failed (${result.status})`);
  await import("../tests/mobile-tasks/tool-round-limit.mjs");
} finally { await rm(temp, { recursive: true, force: true }); }
