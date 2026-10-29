import { desktopNodeTestBanner, desktopNodeTestAliases } from "./desktop-node-test-host.mjs";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import esbuild from "esbuild";

const output = await mkdtemp(path.join(os.tmpdir(), "echoink-expert-tests-"));
try {
  const file = path.join(output, "expert-content-tests.mjs");
  await esbuild.build({ banner: { js: `${desktopNodeTestBanner.js}\nglobalThis.window = globalThis;` }, alias: desktopNodeTestAliases,
    stdin: { contents: 'import { runExpertContentTests } from "./src/tests/expert-content"; await runExpertContentTests();', resolveDir: process.cwd(), sourcefile: "expert-tests.ts", loader: "ts" },
    bundle: true, loader: { ".md": "text" }, platform: "node", target: "node22", format: "esm", outfile: file,
    external: ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "yaml"], logLevel: "silent" });
  const result = spawnSync(process.execPath, [file], { stdio: "inherit", env: { ...process.env, PI_OFFLINE: "1" } });
  process.exitCode = result.status ?? 1;
} finally { await rm(output, { recursive: true, force: true }); }
