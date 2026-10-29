import { desktopNodeTestBanner, desktopNodeTestAliases } from "./desktop-node-test-host.mjs";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const output = await mkdtemp(path.join(os.tmpdir(), "echoink-expert-tests-"));
try {
  const file = path.join(output, "expert-content-tests.mjs");
  await esbuild.build({ banner: { js: `${desktopNodeTestBanner.js}\nglobalThis.window = globalThis;` },
    stdin: { contents: 'import { runExpertContentTests, runExpertHallTests } from "./src/tests/expert-content"; await runExpertContentTests(); await runExpertHallTests();', resolveDir: process.cwd(), sourcefile: "expert-tests.ts", loader: "ts" },
    bundle: true, loader: { ".md": "text" }, platform: "node", target: "node22", format: "esm", outfile: file,
    external: ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "yaml"], logLevel: "silent",
    plugins: [{ name: "expert-dom-test-host", setup(build) {
      build.onResolve({ filter: /^jsdom$/ }, args => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true }));
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "host", namespace: "expert-test-host" }));
      build.onLoad({ filter: /.*/, namespace: "expert-test-host" }, () => ({ resolveDir: process.cwd(), loader: "ts", contents: `
        export * from ${JSON.stringify(desktopNodeTestAliases.obsidian)};
        import {ItemView as Base} from ${JSON.stringify(desktopNodeTestAliases.obsidian)};
        export class ItemView extends Base {
          contentEl;
          constructor(leaf){super(leaf);this.contentEl=leaf.contentEl;}
          async setState(){}
        }
      ` }));
    } }] });
  const result = spawnSync(process.execPath, [file], { stdio: "inherit", env: { ...process.env, PI_OFFLINE: "1" } });
  process.exitCode = result.status ?? 1;
} finally { await rm(output, { recursive: true, force: true }); }
