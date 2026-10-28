import esbuild from "esbuild";
import { desktopNodeTestAliases } from "./desktop-node-test-host.mjs";
import { JSDOM } from "jsdom";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const directory = await mkdtemp(path.join(tmpdir(), "echoink-report-tests-"));
const file = path.join(directory, "tests.mjs");
const dom = new JSDOM("<!doctype html><body></body>", { url: "http://127.0.0.1", pretendToBeVisual: true });
try {
  await esbuild.build({ entryPoints: ["src/tests/run-reports.ts"], outfile: file, bundle: true, platform: "node", format: "esm", target: "node22",
    alias: desktopNodeTestAliases,
    banner: { js: `import {createRequire} from "node:module";const require=createRequire(${JSON.stringify(path.resolve("package.json"))});` },
    plugins: [{ name: "sdk-location", setup(build) { build.onResolve({ filter: /^@earendil-works\/pi-coding-agent$/ }, args => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true })); } }],
    logLevel: "silent" });
  await (await import(pathToFileURL(file).href)).runReportTests(dom.window.document);
} finally { dom.window.close(); await rm(directory, { recursive: true, force: true }); }
