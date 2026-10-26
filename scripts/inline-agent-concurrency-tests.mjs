import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { disposableTestRoot } from "./disposable-test-root.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
if (!process.env.ECHOINK_TEST_ROOT) throw new Error("Set ECHOINK_TEST_ROOT to the assigned inline concurrency test root.");
const base = disposableTestRoot(process.env.ECHOINK_TEST_ROOT);
await mkdir(base, { recursive: true });
const temporary = await mkdtemp(path.join(base, ".inline-concurrency-"));
try {
  const memoryRoot = path.join(base, "memory"); await mkdir(memoryRoot, { recursive: true });
  await symlink(path.join(root, "node_modules"), path.join(temporary, "node_modules"), "dir");
  const output = path.join(temporary, "tests.mjs");
  await build({ entryPoints: [path.join(root, "src/tests/inline-agent-concurrency.ts")], outfile: output,
    bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent",
    external: ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "yaml", "jsdom"],
    loader: { ".md": "text", ".svg": "text", ".webp": "dataurl" },
    plugins: [{ name: "inline-concurrency-host-shim", setup(bundle) {
      bundle.onResolve({ filter: /(?:^|\/)origin-controls$/ }, () => ({ path: path.join(root, "src/tests/origin-controls-shim.ts") }));
      bundle.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(root, "src/tests/obsidian-shim.ts") }));
    } }] });
  const result = spawnSync(process.execPath, [output], { cwd: root,
    env: { ...process.env, PI_OFFLINE: "1", TMPDIR: memoryRoot }, stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally { await rm(temporary, { recursive: true, force: true }); }
