import { spawnSync } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const suites = [
  "test:react-dom-resources",
  "test:provider-settings",
  "test:conversation-ui",
  "test:personal-memory",
  "test:knowledge",
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
