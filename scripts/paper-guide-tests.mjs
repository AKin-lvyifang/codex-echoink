import { mkdtemp, realpath, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
if (!process.env.ECHOINK_PAPER_GUIDE_TEST_ROOT?.trim()) throw new Error("Set ECHOINK_PAPER_GUIDE_TEST_ROOT to an existing disposable task directory");
const allowed = await realpath(path.join(os.homedir(), "EchoInk-TestVaults", "90-任务临时"));
const requested = path.resolve(process.env.ECHOINK_PAPER_GUIDE_TEST_ROOT);
if (!requested.startsWith(allowed + path.sep)) throw new Error("Paper Guide fixtures must stay in disposable test Vaults");
const fixtureRoot = await realpath(requested);
if (!fixtureRoot.startsWith(allowed + path.sep)) throw new Error("Paper Guide fixture symlink leaves disposable test Vaults");
const source = await readFile(path.join(root, "src/settings/settings-tab.ts"), "utf8");
const ast = ts.createSourceFile("settings-tab.ts", source, ts.ScriptTarget.Latest, true);
const declaration = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "CodexSettingTab");
const completion = declaration?.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(ast) === "showOnboardingCompletion");
if (!completion) throw new Error("Production onboarding completion method is missing");

const directory = await mkdtemp(path.join(fixtureRoot, "paper-guide-"));
try {
  const output = path.join(directory, "test.mjs");
  await esbuild.build({
    stdin: {
      contents: `
        import { runPaperGuideTests, runPaperGuideCompletionTests } from "./src/tests/paper-guide";
        import { onboardingCompletionCopy } from "./src/settings/onboarding";
        let completionOptions;
        function mountEchoInkOnboardingCoachmark(options) { completionOptions = options; return {destroy(){}}; }
        class Notice { constructor(message) { throw new Error(message); } }
        class CompletionFixture { ${completion.getText(ast)} }
        export async function run() {
          await runPaperGuideTests();
          await runPaperGuideCompletionTests(CompletionFixture, () => completionOptions);
        }
      `,
      resolveDir: root,
      loader: "ts"
    },
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    outfile: output,
    loader: { ".md": "text", ".svg": "dataurl", ".webp": "dataurl" },
    banner: { js: `import {createRequire} from "node:module"; const require = createRequire(${JSON.stringify(path.join(root, "package.json"))});` },
    alias: { obsidian: path.join(root, "src/tests/obsidian-shim.ts") },
    plugins: [{
      name: "paper-guide-modal-test-port",
      setup(build) {
        build.onResolve({ filter: /^(?:yaml$|@earendil-works\/pi-(?:ai|agent-core|coding-agent)(?:\/|$))/ }, args => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true }));
        // Replace only the native dialog; execute the production controller and settings normalization.
        build.onResolve({ filter: /(?:^|\/)paper-guide-modal$/ }, () => ({ path: path.join(root, "src/tests/paper-guide-modal-shim.ts") }));
      }
    }]
  });
  await (await import(pathToFileURL(output).href)).run();
} finally {
  await rm(directory, { recursive: true, force: true });
}
