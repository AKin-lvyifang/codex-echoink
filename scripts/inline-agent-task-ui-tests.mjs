import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.cwd();
await mkdir(path.join(root, ".tmp"), { recursive: true });
const temporary = await mkdtemp(path.join(root, ".tmp/inline-agent-task-ui-"));
try {
  const output = path.join(temporary, "tests.mjs");
  await build({ entryPoints: ["src/tests/inline-agent-task-ui.ts"], outfile: output, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent",
    loader: { ".svg": "dataurl", ".md": "text", ".txt": "text", ".webp": "dataurl" },
    banner: { js: `import { createRequire as createInlineUiRequire } from "node:module"; const require = createInlineUiRequire(${JSON.stringify(path.join(root, "package.json"))});` },
    plugins: [{ name: "inline-task-ui-host", setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(root, "src/tests/obsidian-shim.ts") }));
      build.onResolve({ filter: /provider-brand-icons$/ }, () => ({ path: path.join(root, "src/tests/composer-provider-brand-shim.ts") }));
      build.onResolve({ filter: /^[^./]/ }, args => {
        if (args.path === "electron") return { path: args.path, external: true };
        const resolved = import.meta.resolve(args.path);
        return { path: resolved.startsWith("node:") ? resolved : fileURLToPath(resolved), external: true };
      });
    } }]
  });
  const result = spawnSync(process.execPath, [output], { stdio: "inherit", env: { ...process.env, PI_OFFLINE: "1" } });
  process.exitCode = result.status ?? 1;
} finally { await rm(temporary, { recursive: true, force: true }); }
