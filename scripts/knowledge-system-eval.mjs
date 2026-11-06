// Opt-in, real configured Provider experiment. Never called by npm test or CI.
import esbuild from "esbuild";
import { mkdir, realpath } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDisposableTestRoot } from "./disposable-test-root.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const [vaultArg, wikiRoot, evidenceArg, domainOnly] = process.argv.slice(2);
if (!vaultArg || !wikiRoot || !evidenceArg || ![5, 6].includes(process.argv.length))
  throw new Error(
    "Usage: node scripts/knowledge-system-eval.mjs <disposable-vault> <wiki-relative-root> <evidence" +
      "-directory> [domain-only]",
  );
const vault = await realpath(vaultArg);
if (!isDisposableTestRoot(vault))
  throw new Error("Only an explicitly disposable test Vault is supported.");
if (
  path.isAbsolute(wikiRoot) ||
  wikiRoot.split(/[\\/]/u).some((part) => !part || part === "." || part === "..")
)
  throw new Error("Wiki root must be Vault relative.");
const wiki = await realpath(path.join(vault, wikiRoot));
if (!wiki.startsWith(vault + path.sep)) throw new Error("Wiki root escapes the test Vault.");
const evidence = path.resolve(evidenceArg);
await mkdir(evidence, { recursive: true });
const temporary = path.join(vault, ".knowledge-system-eval");
await mkdir(temporary, { recursive: true });
const entry = path.join(temporary, "runner.mjs");
await esbuild.build({
  entryPoints: [path.join(root, "scripts/knowledge-system-eval/runner.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: entry,
  alias: { obsidian: path.join(root, "src/tests/obsidian-shim.ts") },
  loader: { ".md": "text", ".svg": "text", ".webp": "dataurl" },
  external: ["electron"],
  banner: {
    js: `import { createRequire } from 'node:module';const require=createRequire(${JSON.stringify(path.join(root, "package.json"))});`,
  },
  plugins: [
    {
      name: "external-provider",
      setup(build) {
        build.onResolve(
          {
            filter: /^(?:@earendil-works\/pi-(?:ai|agent-core|coding-agent)(?:\/.*)?|yaml|jsdom)$/,
          },
          (args) => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true }),
        );
      },
    },
  ],
});
const result = spawnSync(
  process.execPath,
  [entry, vault, wikiRoot, evidence, ...(domainOnly ? [domainOnly] : [])],
  { cwd: root, stdio: "inherit" },
);
process.exitCode = result.status ?? 1;
