import { disposableTestOutputRoot } from "./disposable-test-root.mjs";
import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(disposableTestOutputRoot(path.join(root, ".tmp")), "private-boundary-20261018/private-note-boundary-tests.mjs");
await mkdir(path.dirname(output), { recursive: true });
await esbuild.build({
  stdin: { contents: `import { runVaultBodySearchPrivateBoundaryTests } from './src/tests/vault-body-search';
import { runVaultPrivateBoundaryTests, runVaultDomainServiceTests, runVaultBodySearchCanonicalBoundaryTests, runVaultBodySearchCanonicalPerformanceTests } from './src/tests/pi-native/vault-domain-service';
import { runObsidianCliPrivateBoundaryTests, runOfficialCliTests } from './src/tests/obsidian-cli';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
let failed = false;
const cliRoot = await mkdtemp(path.join(tmpdir(), 'private-cli-'));
try {
for (const test of [${process.argv.includes('--canonical-perf') ? 'runVaultBodySearchCanonicalPerformanceTests' : `${process.argv.includes('--cli-only') ? '' : 'runVaultBodySearchPrivateBoundaryTests, runVaultPrivateBoundaryTests, runVaultBodySearchCanonicalBoundaryTests,'} () => runObsidianCliPrivateBoundaryTests(path.join(cliRoot, 'boundary'))${process.argv.includes('--full-vault') ? ', runVaultDomainServiceTests' : ''}${process.argv.includes('--full-cli') ? ", () => runOfficialCliTests(path.join(cliRoot, 'official'))" : ''}`}]) {
  try { await test(); } catch (error) { console.error(test.name, error); failed = true; }
}
} finally { await rm(cliRoot, { recursive: true, force: true }); }
if (failed) process.exitCode = 1;`, resolveDir: root, loader: 'ts' },
  bundle: true, platform: 'node', target: 'node22', format: 'esm', outfile: output,
  loader: { '.md': 'text', '.webp': 'dataurl', '.svg': 'text' },
  external: ['@earendil-works/pi-ai', '@earendil-works/pi-agent-core', '@earendil-works/pi-coding-agent', 'yaml', 'jsdom'],
  plugins: [{ name: 'obsidian-test-host', setup(build) { build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(root, 'src/tests/obsidian-shim.ts') })); } }], logLevel: 'silent'
});
const result = spawnSync(process.execPath, [output], { cwd: root, env: { ...process.env, PI_OFFLINE: '1' }, stdio: 'inherit' });
process.exit(result.status ?? 1);
