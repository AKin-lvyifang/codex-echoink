import esbuild from "esbuild";
import { desktopNodeTestAliases } from "./desktop-node-test-host.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
const directory = await mkdtemp(path.join(tmpdir(), "echoink-company-tests-"));
const file = path.join(directory, "tests.mjs"), uiFile = path.join(directory, "ui-tests.mjs");
const schedulerFile = path.join(directory, "scheduler-tests.mjs"), runtimeFile = path.join(directory, "runtime-tests.mjs");
const interactionsFile = path.join(directory, "interaction-tests.mjs"), approvalFile = path.join(directory, "approval-tests.mjs");
const groupsFile = path.join(directory, "agent-group-tests.mjs");
const dom = new JSDOM("<!doctype html><body></body>", { url: "http://127.0.0.1", pretendToBeVisual: true });
try {
  const options = { bundle: true, platform: "node", format: "esm", target: "node22",
    alias: desktopNodeTestAliases,
    banner: { js: `import {createRequire as createCompanyFixtureRequire} from "node:module";const require=createCompanyFixtureRequire(${JSON.stringify(path.resolve("package.json"))});` },
    plugins: [{ name: "sdk-location", setup(build) {
      build.onResolve({ filter: /^@earendil-works\/pi-(coding-agent|ai)$/ }, args => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true }));
      // Origin buttons are React islands in production; DOM tests use the plain-button shim like the other UI suites.
      build.onResolve({ filter: /(?:^|\/)settings\/origin-controls$/ }, () => ({ path: path.resolve("src/tests/origin-controls-shim.ts") }));
    } }],
    logLevel: "silent", loader: { ".md": "text", ".txt": "text", ".svg": "dataurl" } };
  await esbuild.build({ ...options, entryPoints: ["src/tests/company.ts"], outfile: file });
  await esbuild.build({ ...options, entryPoints: ["src/tests/company-scheduler.ts"], outfile: schedulerFile });
  await esbuild.build({ ...options, entryPoints: ["src/tests/company-ui.ts"], outfile: uiFile, loader: { ".md": "text", ".svg": "text", ".txt": "text", ".webp": "dataurl" } });
  await esbuild.build({ ...options, entryPoints: ["src/tests/company-runtime.ts"], outfile: runtimeFile, loader: { ".md": "text", ".svg": "text", ".txt": "text", ".webp": "dataurl" } });
  await esbuild.build({ ...options, entryPoints: ["src/tests/company-interactions.ts"], outfile: interactionsFile, loader: { ".md": "text", ".svg": "text", ".txt": "text", ".webp": "dataurl" } });
  await esbuild.build({ ...options, entryPoints: ["src/tests/company-approval.ts"], outfile: approvalFile, loader: { ".md": "text", ".svg": "text", ".txt": "text", ".webp": "dataurl" } });
  await esbuild.build({ ...options, entryPoints: ["src/tests/company-agent-groups.ts"], outfile: groupsFile, loader: { ".md": "text", ".svg": "text", ".txt": "text", ".webp": "dataurl" } });
  await (await import(pathToFileURL(file).href)).runCompanyTests();
  await (await import(pathToFileURL(schedulerFile).href)).runCompanySchedulerTests();
  await (await import(pathToFileURL(uiFile).href)).runCompanyUiTests(dom.window.document);
  await (await import(pathToFileURL(runtimeFile).href)).runCompanyRuntimeTests();
  await (await import(pathToFileURL(interactionsFile).href)).runCompanyInteractionTests(dom.window.document);
  await (await import(pathToFileURL(approvalFile).href)).runCompanyApprovalTests();
  await (await import(pathToFileURL(groupsFile).href)).runCompanyAgentGroupTests(dom.window.document);
} finally { dom.window.close(); await rm(directory, { recursive: true, force: true }); }
