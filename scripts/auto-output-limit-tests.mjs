import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";
import { desktopNodeTestAliases, desktopNodeTestBanner } from "./desktop-node-test-host.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(path.join(tmpdir(), "echoink-auto-output-"));
try {
  const outfile = path.join(directory, "test.mjs");
  await esbuild.build({
    stdin: { contents: 'import {runAutoOutputLimitTests} from "./src/tests/auto-output-limit"; await runAutoOutputLimitTests();', resolveDir: root, loader: "ts" },
    bundle: true, platform: "node", format: "esm", target: "node22", outfile,
    alias: desktopNodeTestAliases, banner: desktopNodeTestBanner, logLevel: "silent",
    loader: { ".md": "text", ".svg": "dataurl", ".webp": "dataurl" },
    plugins: [{ name: "pi-externals", setup(build) {
      build.onResolve({ filter: /^@earendil-works\/pi-(agent-core|ai|coding-agent)(\/|$)/ }, args => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true }));
    } }]
  });
  await import(pathToFileURL(outfile).href);
} finally { await rm(directory, { recursive: true, force: true }); }
