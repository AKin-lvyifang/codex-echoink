import { isDisposableTestRoot } from "./disposable-test-root.mjs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

if (!process.env.ECHOINK_ACCOUNT_PRICING_TEST_ROOT?.trim()) throw new Error("Set ECHOINK_ACCOUNT_PRICING_TEST_ROOT to the existing disposable pricing fixture directory");
const requested = path.resolve(process.env.ECHOINK_ACCOUNT_PRICING_TEST_ROOT);
if (!isDisposableTestRoot(requested)) throw new Error("Pricing fixtures must stay in disposable test Vaults");
const fixtureRoot = await realpath(requested);
if (!isDisposableTestRoot(fixtureRoot)) throw new Error("Pricing fixture symlink leaves disposable test Vaults");
const runRoot = await mkdtemp(path.join(fixtureRoot, "pricing-"));
try {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const output = path.join(runRoot, "pricing-tests.mjs");
  await esbuild.build({
    entryPoints: [path.join(root, "src/tests/account-desktop-pricing.ts")], outfile: output,
    bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent"
  });
  const test = await import(pathToFileURL(output).href);
  test.runAccountDesktopPricingTests();
} finally {
  await rm(runRoot, { recursive: true, force: true });
}
