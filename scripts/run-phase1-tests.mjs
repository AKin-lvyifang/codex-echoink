import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const outputDir = path.join(rootDir, ".tmp");
const outputFile = path.join(outputDir, "pi-conversation-tests.mjs");
const obsidianShimPath = path.join(rootDir, "src", "tests", "obsidian-shim.ts");

await mkdir(outputDir, { recursive: true });
await esbuild.build({
  stdin: {
    contents: [
      'import { runPiNativeFileStoreTests } from "./src/tests/harness-v2/pi-native-file-stores";',
      'import { runPiChatUiProjectorTests } from "./src/tests/harness-v2/pi-chat-ui-projector";',
      'import { runPiSessionDurabilityTests } from "./src/tests/pi-native/pi-session-durability";',
      'import { runPiNativeConversationRuntimeTests } from "./src/tests/pi-native/pi-native-conversation-runtime";',
      'import { runPiPluginConversationBoundaryTests } from "./src/tests/pi-native/plugin-conversation-boundary";',
      'import { runPiConversationStartupTests } from "./src/tests/pi-native/conversation-startup";',
      'import { runPiConversationTabsTests } from "./src/tests/pi-native/conversation-tabs";',
      'import { runPiNativeTurnRunnerTests } from "./src/tests/pi-native/turn-runner";',
      'import { runDailyJournalPipelineTests } from "./src/tests/pi-native/daily-journal-pipeline";',
      'import { runPiImageInputTests } from "./src/tests/pi-native/pi-image-input";',
      'import { runPiDocumentInputTests } from "./src/tests/pi-native/pi-document-input";',
      'import { runMessageListIdentityTests } from "./src/tests/message-list-identity";',
      'import { runSmoothConversationUiTests } from "./src/tests/smooth-conversation-ui";',
      'import { runComposerActionTests } from "./src/tests/composer-actions";',
      'import { runNoteMentionTests } from "./src/tests/note-mentions";',
      'import { runTurnNavigatorTests } from "./src/tests/turn-navigator";',
      "await runPiNativeFileStoreTests();",
      "await runPiSessionDurabilityTests();",
      "await runPiNativeConversationRuntimeTests();",
      "await runPiPluginConversationBoundaryTests();",
      "await runPiConversationStartupTests();",
      "await runPiConversationTabsTests();",
      "await runPiChatUiProjectorTests();",
      "await runPiNativeTurnRunnerTests();",
      "await runDailyJournalPipelineTests();",
      "await runPiImageInputTests();",
      "await runPiDocumentInputTests();",
      "await runMessageListIdentityTests();",
      "await runSmoothConversationUiTests();",
      "await runComposerActionTests();",
      "await runNoteMentionTests();",
      "await runTurnNavigatorTests();",
      'console.log("Current Pi Conversation acceptance: PASS");'
    ].filter((line) => !process.argv.includes("--daily-journal") || line.startsWith("import ") || line.includes("runDailyJournalPipelineTests") || line.includes("console.log")).join("\n"),
    resolveDir: rootDir,
    sourcefile: "pi-conversation-test-entry.ts",
    loader: "ts"
  },
  bundle: true,
  loader: {
    ".md": "text",
    ".svg": "dataurl",
    ".webp": "dataurl"
  },
  platform: "node",
  target: "node22",
  format: "esm",
  external: [
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "yaml"
  ],
  plugins: [{
    name: "pi-conversation-test-shims",
    setup(build) {
      build.onResolve({ filter: /provider-brand-icons$/ }, () => ({
        path: path.join(rootDir, "src", "tests", "composer-provider-brand-shim.ts")
      }));
      build.onResolve({ filter: /^obsidian$/ }, () => ({
        path: obsidianShimPath
      }));
    }
  }],
  outfile: outputFile,
  logLevel: "silent"
});

const result = spawnSync(process.execPath, [outputFile], {
  cwd: rootDir,
  env: {
    ...process.env,
    PI_OFFLINE: "1"
  },
  stdio: "inherit"
});

process.exit(result.status ?? 1);
