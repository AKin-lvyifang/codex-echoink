import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";
import { desktopNodeTestAliases, desktopNodeTestBanner } from "./desktop-node-test-host.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const knowledgePick = process.argv.includes("--knowledge-pick");
const directory = await mkdtemp(path.join(tmpdir(), "echoink-smart-judgment-"));
try {
  const outfile = path.join(directory, "test.mjs");
  await esbuild.build({
    stdin: { contents: knowledgePick
      ? 'import {runChatKnowledgePickTests} from "./src/tests/chat-knowledge-pick"; import {runPiKnowledgePickRuntimeTests} from "./src/tests/pi-native/pi-native-conversation-runtime"; await runChatKnowledgePickTests(); await runPiKnowledgePickRuntimeTests();'
      : 'import {runSmartJudgmentTests} from "./src/tests/smart-judgment"; await runSmartJudgmentTests();', resolveDir: root, loader: "ts" },
    bundle: true, platform: "node", format: "esm", target: "node22", outfile,
    alias: desktopNodeTestAliases, banner: { js: `${desktopNodeTestBanner.js}\nglobalThis.window = globalThis;` }, logLevel: "silent",
    loader: { ".md": "text", ".svg": "dataurl", ".webp": "dataurl" },
    plugins: [{ name: "pi-externals", setup(build) {
      build.onResolve({ filter: /^(?:@earendil-works\/pi-(agent-core|ai|coding-agent)(\/|$)|jsdom$)/ }, args => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true }));
    } }]
  });
  await import(pathToFileURL(outfile).href);
} finally { await rm(directory, { recursive: true, force: true }); }
