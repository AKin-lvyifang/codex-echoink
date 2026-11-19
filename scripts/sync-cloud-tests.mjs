import esbuild from "esbuild";
import { desktopNodeTestAliases } from "./desktop-node-test-host.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const directory = await mkdtemp(path.join(tmpdir(), "echoink-sync-cloud-tests-"));
const file = path.join(directory, "sync-cloud-tests.mjs");
try {
  await esbuild.build({ bundle: true, platform: "node", format: "esm", target: "node22", alias: desktopNodeTestAliases,
    banner: { js: `import {createRequire as createSyncFixtureRequire} from "node:module";const require=createSyncFixtureRequire(${JSON.stringify(path.resolve("package.json"))});` },
    logLevel: "silent", loader: { ".md": "text", ".txt": "text", ".svg": "dataurl" }, entryPoints: ["src/tests/sync-cloud.ts"], outfile: file });
  await (await import(pathToFileURL(file).href)).runSyncCloudTests();
  await esbuild.build({ bundle: true, platform: "node", format: "esm", target: "node22", alias: desktopNodeTestAliases,
    logLevel: "silent", entryPoints: ["src/tests/sync-cloud-whole-vault.ts"], outfile: `${file}.whole.mjs` });
  await (await import(pathToFileURL(`${file}.whole.mjs`).href)).runWholeVaultTests();
} finally { await rm(directory, { recursive: true, force: true }); }
