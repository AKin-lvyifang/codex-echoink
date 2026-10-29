import { desktopNodeTestBanner, desktopNodeTestAliases } from "./desktop-node-test-host.mjs";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import esbuild from "esbuild";

const backend = process.env.ECHOINK_EXPERT_BACKEND_ROOT;
if (!backend || process.env.NODE_ENV === "production") throw new Error("Set ECHOINK_EXPERT_BACKEND_ROOT to the explicitly authorized local backend checkout.");
const output = await mkdtemp(path.join(os.tmpdir(), "echoink-expert-http-tests-"));
try {
  const file = path.join(output, "expert-integration-tests.mjs");
  await esbuild.build({ banner: { js: `${desktopNodeTestBanner.js}\nglobalThis.window = globalThis;` }, alias: desktopNodeTestAliases,
    entryPoints: ["tests/experts/integration.ts"], bundle: true, loader: { ".md": "text" }, platform: "node", target: "node22", format: "esm", outfile: file,
    external: ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "yaml"], logLevel: "silent" });
  const result = spawnSync(process.execPath, ["--import", path.join(backend, "node_modules/tsx/dist/loader.mjs"), file], { stdio: "inherit", env: { ...process.env, PI_OFFLINE: "1", NODE_ENV: "test" } });
  process.exitCode = result.status ?? 1;
} finally { await rm(output, { recursive: true, force: true }); }
