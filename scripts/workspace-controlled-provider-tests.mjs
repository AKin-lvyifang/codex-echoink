import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";
import { desktopNodeTestBanner, desktopNodeTestAliases } from "./desktop-node-test-host.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = await mkdtemp(path.join(os.tmpdir(), "echoink-controlled-provider-tests-"));
try {
  const entry = path.join(output, "controlled-provider.mjs");
  await esbuild.build({ stdin: { contents: 'export {runPiNativeControlledProviderTests,runPiNativeControlledProviderPersistenceTests} from "./src/tests/pi-native/pi-native-controlled-provider";', resolveDir: root, loader: "ts" },
    bundle: true, platform: "node", format: "esm", target: "node22", outfile: entry, banner: desktopNodeTestBanner, alias: desktopNodeTestAliases, logLevel: "silent",
    plugins: [{ name: "controlled-provider-test-packages", setup(build) {
      build.onResolve({ filter: /^(?:@earendil-works\/pi-(?:ai|coding-agent)(?:\/.*)?|typebox)$/ }, args => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true }));
    } }]
  });
  const tests = await import(pathToFileURL(entry).href);
  await tests.runPiNativeControlledProviderTests();
  await tests.runPiNativeControlledProviderPersistenceTests(output);
  console.log("controlled provider tests: existing cases, per-event revocation, final boundary, unchanged unguarded stream, AgentSession persistence passed");
} finally { await rm(output, { recursive: true, force: true }); }
