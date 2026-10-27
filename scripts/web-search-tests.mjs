import esbuild from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
const directory = await mkdtemp(path.resolve(".tmp-web-search-"));
try {
  const output = path.join(directory, "test.mjs");
  await esbuild.build({ entryPoints: ["src/tests/web-search.ts"], bundle: true, platform: "node", format: "esm", target: "node22", packages: "external", outfile: output, alias: { obsidian: path.resolve("src/tests/obsidian-shim.ts") }, loader: { ".md": "text" } });
  const result = spawnSync(process.execPath, [output], { stdio: "inherit", env: { ...process.env, PI_OFFLINE: "1" } });
  if (result.status !== 0) process.exitCode = result.status ?? 1;
} finally { await rm(directory, { recursive: true, force: true }); }
