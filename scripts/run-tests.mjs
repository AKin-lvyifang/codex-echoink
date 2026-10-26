import { spawnSync } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const suites = [
  "test:inline-agent",
  "test:inline-agent-runtime",
  "test:inline-agent-concurrency",
  "test:inline-agent-mention",
  "test:inline-agent-task-ui",
  "test:vault-identity",
  "test:vault-memory-ui",
  "test:react-dom-resources",
  "test:provider-settings",
  "test:conversation-ui",
  "test:answer-markdown",
  "test:personal-memory",
  "test:knowledge",
  "test:knowledge-linking",
  "test:mcp-vault"
];

for (const suite of suites) {
  const result = spawnSync(npm, ["run", suite], {
    env: {
      ...process.env,
      PI_OFFLINE: "1"
    },
    stdio: "inherit"
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const desktopDataResult = spawnSync(process.execPath, ["scripts/desktop-string-pool-tests.mjs"], {
  stdio: "inherit"
});
if (desktopDataResult.status !== 0) process.exit(desktopDataResult.status ?? 1);

const codexTransportResult = spawnSync(process.execPath, ["scripts/codex-desktop-transport-tests.mjs"], {
  stdio: "inherit"
});
if (codexTransportResult.status !== 0) process.exit(codexTransportResult.status ?? 1);

const providerTransportResult = spawnSync(process.execPath, ["scripts/desktop-provider-transport-tests.mjs"], { stdio: "inherit" });
if (providerTransportResult.status !== 0) process.exit(providerTransportResult.status ?? 1);

const codexOAuthResult = spawnSync(process.execPath, ["scripts/codex-oauth-compat-tests.mjs"], {
  stdio: "inherit"
});
if (codexOAuthResult.status !== 0) process.exit(codexOAuthResult.status ?? 1);

const financeCatalogResult = spawnSync(process.execPath, ["scripts/finance-catalog-tests.mjs"], {
  stdio: "inherit"
});
if (financeCatalogResult.status !== 0) process.exit(financeCatalogResult.status ?? 1);
