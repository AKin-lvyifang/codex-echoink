import { desktopNodeTestBanner, desktopNodeTestAliases } from "./desktop-node-test-host.mjs";
import { disposableTestOutputRoot } from "./disposable-test-root.mjs";
import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import esbuild from "esbuild";

const output = disposableTestOutputRoot(path.join(process.cwd(), ".tmp"));
await mkdir(output, { recursive: true });
const file = path.join(output, "skill-remote-delivery-tests.mjs");
await esbuild.build({ banner: desktopNodeTestBanner, alias: desktopNodeTestAliases,
  stdin: { contents: 'import { runRemoteSkillDeliveryTests } from "./src/tests/skill-remote-delivery"; await runRemoteSkillDeliveryTests();', resolveDir: process.cwd(), sourcefile: "skill-remote-tests.ts", loader: "ts" },
  bundle: true, loader: { ".md": "text" }, platform: "node", target: "node22", format: "esm", outfile: file,
  external: ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "yaml"], logLevel: "silent" });
const result = spawnSync(process.execPath, [file], { stdio: "inherit", env: { ...process.env, PI_OFFLINE: "1" } });
process.exit(result.status ?? 1);
