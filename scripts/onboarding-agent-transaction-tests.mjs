import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const repo = fileURLToPath(new URL("../", import.meta.url));
if (!process.env.ECHOINK_ONBOARDING_AGENT_TRANSACTION_TEST_ROOT?.trim()) throw new Error("Explicit ECHOINK_ONBOARDING_AGENT_TRANSACTION_TEST_ROOT is required");
const allowed = await realpath(path.join(os.homedir(), "EchoInk-TestVaults", "90-任务临时"));
const fixture = await realpath(path.resolve(process.env.ECHOINK_ONBOARDING_AGENT_TRANSACTION_TEST_ROOT));
if (!fixture.startsWith(allowed + path.sep)) throw new Error("Onboarding Agent transaction fixtures must stay in the explicit disposable test root");
const run = await mkdtemp(path.join(fixture, ".onboarding-agent-transaction-run-"));
const originalFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error("No network or Provider calls are allowed in the onboarding transaction test"); };
try {
  const output = path.join(run, "onboarding-agent-transaction.mjs");
  await esbuild.build({ entryPoints: [path.join(repo, "src/tests/onboarding-agent-transaction.ts")], bundle: true, platform: "node", target: "node22", format: "esm", outfile: output, logLevel: "silent",
    loader: { ".md": "text", ".txt": "text", ".svg": "dataurl", ".webp": "dataurl" },
    banner: { js: `import { createRequire as createTransactionRequire } from "node:module"; const require = createTransactionRequire(${JSON.stringify(path.join(repo, "package.json"))});` },
    plugins: [{ name: "onboarding-agent-transaction-host", setup(build) {
      build.onResolve({ filter: /provider-brand-icons$/ }, () => ({ path: path.join(repo, "src/tests/composer-provider-brand-shim.ts") }));
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(repo, "src/tests/obsidian-shim.ts") }));
      build.onResolve({ filter: /^[^./]/ }, args => {
        if (args.path === "electron") return { path: args.path, external: true };
        const resolved = import.meta.resolve(args.path);
        return { path: resolved.startsWith("node:") ? resolved : fileURLToPath(resolved), external: true };
      });
    } }]
  });
  const tests = await import(pathToFileURL(output).href);
  await tests.runOnboardingAgentTransactionTests(run);
  if (networkCalls) throw new Error(`Unexpected network calls: ${networkCalls}`);
} finally {
  globalThis.fetch = originalFetch;
  await rm(run, { recursive: true, force: true });
}
