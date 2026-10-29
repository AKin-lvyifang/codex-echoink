import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const base = path.join(root, ".tmp/community-review-group-zero-20261028");
await mkdir(base, { recursive: true });
const temporary = await mkdtemp(path.join(base, "owned-dom-ime-"));
try {
  const output = path.join(temporary, "tests.mjs");
  await build({
    entryPoints: ["src/tests/owned-dom-ime.ts"], outfile: output,
    bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent",
    external: ["jsdom", "unpdf", "moment"],
    plugins: [{ name: "owned-dom-ime-host", setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(root, "src/tests/obsidian-shim.ts") }));
    } }]
  });
  const result = spawnSync(process.execPath, [output], { stdio: "inherit", env: { ...process.env, PI_OFFLINE: "1" } });
  process.exitCode = result.status ?? 1;
} finally { await rm(temporary, { recursive: true, force: true }); }
