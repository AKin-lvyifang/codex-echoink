import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.join(root, ".tmp/paper-guide-tests");
const source = await readFile(path.join(root, "src/settings/settings-tab.ts"), "utf8");
const ast = ts.createSourceFile("settings-tab.ts", source, ts.ScriptTarget.Latest, true);
const declaration = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "CodexSettingTab");
const completion = declaration?.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(ast) === "showOnboardingCompletion");
if (!completion) throw new Error("Production onboarding completion method is missing");

await mkdir(directory, { recursive: true });
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
    external: ["yaml", "@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "@earendil-works/pi-coding-agent"],
    loader: { ".md": "text", ".svg": "dataurl", ".webp": "dataurl" },
    banner: { js: 'import {createRequire} from "node:module"; const require = createRequire(import.meta.url);' },
    alias: { obsidian: path.join(root, "src/tests/obsidian-shim.ts") },
    plugins: [{
      name: "paper-guide-modal-test-port",
      setup(build) {
        // Replace only the native dialog; execute the production controller and settings normalization.
        build.onResolve({ filter: /(?:^|\/)paper-guide-modal$/ }, () => ({ path: path.join(root, "src/tests/paper-guide-modal-shim.ts") }));
      }
    }]
  });
  await (await import(pathToFileURL(output).href)).run();
} finally {
  await rm(directory, { recursive: true, force: true });
}
