import { disposableTestRoot } from "./disposable-test-root.mjs";
import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const outputDir = process.env.ECHOINK_TEST_ROOT ? path.join(disposableTestRoot(process.env.ECHOINK_TEST_ROOT), "mcp-vault-output") : path.join(rootDir, ".tmp");
const outputFile = path.join(outputDir, "mcp-vault-tests.mjs");
const obsidianShimPath = path.join(rootDir, "src", "tests", "obsidian-shim.ts");

await mkdir(outputDir, { recursive: true });
await esbuild.build({
  stdin: {
    contents: [
      'import { runMcpToolSecurityTests } from "./src/tests/mcp-tool-security";',
      'import { runToolAuthorizationAndReceiptTests } from "./src/tests/pi-native/tool-authorization-and-receipt";',
      'import { runVaultDomainServiceTests } from "./src/tests/pi-native/vault-domain-service";',
      'import { runEchoInkMcpServerTests } from "./src/tests/echoink-mcp-server";',
      "await runEchoInkMcpServerTests();",
      "await runMcpToolSecurityTests();",
      "await runToolAuthorizationAndReceiptTests();",
      "await runVaultDomainServiceTests();",
      'console.log("Current MCP and Vault Tool acceptance: PASS");'
    ].join("\n"),
    resolveDir: rootDir,
    sourcefile: "mcp-vault-test-entry.ts",
    loader: "ts"
  },
  bundle: true,
  loader: {
    ".md": "text",
    ".webp": "dataurl"
  },
  platform: "node",
  target: "node22",
  format: "esm",
  banner: { js: `import { createRequire as createMcpTestRequire } from "node:module"; const require = createMcpTestRequire(${JSON.stringify(path.join(rootDir, "package.json"))});` },
  external: [
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "yaml"
  ],
  plugins: [{
    name: "mcp-vault-test-shims",
    setup(build) {
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
