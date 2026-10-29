import { desktopNodeTestBanner } from "./desktop-node-test-host.mjs";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const base = await realpath(path.join(homedir(), "EchoInk-TestVaults"));
const selected = process.env.ECHOINK_TEST_ROOT;
if (!selected) throw new Error("ECHOINK_TEST_ROOT must name an isolated acceptance fixture directory");
const target = await realpath(selected), relative = path.relative(base, target);
if (relative.startsWith("..") || path.isAbsolute(relative) || !/^测试仓库-[^/]+验收(?:\/|$)/u.test(relative)) throw new Error("Use a disposable acceptance Vault copy");
const run = await mkdtemp(path.join(target, "journal-task-"));
try {
  const output = path.join(run, "tests.mjs");
  const suite = process.env.ECHOINK_RECOVERY_SUITE || "all";
  const imports = {
    journal: 'import { runJournalPageTests } from "./src/tests/journal-page"; await runJournalPageTests(process.env.ECHOINK_RECOVERY_FIXTURE);',
    tasks: 'import { runTaskManagementTests } from "./src/tests/task-management"; await runTaskManagementTests();',
    knowledge: 'import { runKnowledgePageDataTests } from "./src/tests/knowledge-page-data"; await runKnowledgePageDataTests(process.env.ECHOINK_RECOVERY_FIXTURE);',
    agents: 'import { runAgentTaskTests } from "./src/tests/agent-tasks"; await runAgentTaskTests(process.env.ECHOINK_RECOVERY_FIXTURE);',
    maintenance: 'import { runMaintenanceActivityTests } from "./src/tests/maintenance-activity"; await runMaintenanceActivityTests(process.env.ECHOINK_RECOVERY_FIXTURE);'
  };
  for (const name of suite === "all" ? Object.keys(imports) : [suite]) {
    if (!imports[name]) throw new Error("Unknown recovery test suite");
    const fixture = path.join(run, name); await mkdir(fixture);
    await esbuild.build({ banner: desktopNodeTestBanner, stdin: { contents: imports[name], resolveDir: root, loader: "ts" },
      bundle: true, platform: "node", target: "node22", format: "esm", outfile: output, logLevel: "silent",
      loader: { ".md": "text", ".txt": "text", ".svg": "text", ".webp": "dataurl" },
      plugins: [{ name: "recovery-host", setup(build) {
        build.onResolve({ filter: /(?:^|\/)origin-controls$/ }, () => ({ path: path.join(root, "src/tests/origin-controls-shim.ts") }));
        build.onResolve({ filter: /provider-brand-icons$/ }, () => ({ path: path.join(root, "src/tests/composer-provider-brand-shim.ts") }));
        build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(root, "src/tests/obsidian-shim.ts") }));
        build.onResolve({ filter: /^[^./]/ }, args => {
          if (args.path === "electron") return { path: args.path, external: true };
          const url = import.meta.resolve(args.path); return { path: url.startsWith("node:") ? url : fileURLToPath(url), external: true };
        });
      } }] });
    const result = spawnSync(process.execPath, [output], { cwd: root, stdio: "inherit", env: { ...process.env, PI_OFFLINE: "1", TMPDIR: run, ECHOINK_RECOVERY_FIXTURE: fixture } });
    if (result.status !== 0) { process.exitCode = result.status ?? 1; break; }
  }
} finally { await rm(run, { recursive: true, force: true }); }
