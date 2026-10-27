import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const output = path.resolve(".tmp/inline-agent-ranges-tests.mjs");
await mkdir(path.dirname(output), { recursive: true });
await build({ entryPoints: ["src/tests/inline-agent-ranges.ts"], outfile: output, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent" });
const result = spawnSync(process.execPath, [output], { stdio: "inherit" });
process.exit(result.status ?? 1);
