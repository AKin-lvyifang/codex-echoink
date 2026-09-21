import esbuild from "esbuild";
import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
await mkdir('.tmp', { recursive: true });
await esbuild.build({ entryPoints: ['src/tests/tavily-auto-archive.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external', outfile: '.tmp/tavily-auto-archive-tests.mjs', alias: { obsidian: path.resolve('src/tests/obsidian-shim.ts') }, loader: { '.md': 'text' } });
const result = spawnSync(process.execPath, ['.tmp/tavily-auto-archive-tests.mjs'], { stdio: 'inherit', env: { ...process.env, PI_OFFLINE: '1' } });
process.exit(result.status ?? 1);
