/** Evaluate the actual single-file plugin, without calling onload or using a Vault. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as url from "node:url";
import { compileFunction } from "node:vm";

const scriptPath = url.fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
const caseIndex = args.indexOf("--case");
const nativeOnly = args.includes("--native-only");
const caseName = caseIndex < 0 ? null : args[caseIndex + 1];
const bundlePath = path.resolve(args.at(-1)?.endsWith(".js") ? args.at(-1) : "dist/main.js");

// These exercise Node's real path/URL implementations, not a whole OS or Obsidian.
const cases = {
  macos: { platform: "darwin", execPath: "/Applications/Obsidian.app/Contents/MacOS/Obsidian" },
  linux: { platform: "linux", execPath: "/opt/Obsidian/obsidian" },
  "windows-drive": { platform: "win32", execPath: "D:\\Program Files\\Obsidian\\Obsidian.exe" }
};

if (!caseName) {
  const names = nativeOnly ? ["native"] : ["native", ...Object.keys(cases)];
  let failed = false;
  for (const name of names) {
    const result = spawnSync(process.execPath, [scriptPath, "--case", name, bundlePath], {
      stdio: "inherit",
      timeout: 30_000
    });
    if (result.error) console.error(result.error.message);
    if (result.status !== 0) failed = true;
  }
  process.exitCode = failed ? 1 : 0;
} else {
  assert.ok(caseName === "native" || Object.hasOwn(cases, caseName), `unknown case: ${caseName}`);
  const scenario = cases[caseName];
  const windows = scenario?.platform === "win32";
  const targetPath = scenario ? (windows ? path.win32 : path.posix) : path;
  const targetUrl = scenario ? {
    ...url,
    fileURLToPath: (value) => url.fileURLToPath(value, { windows }),
    pathToFileURL: (value) => url.pathToFileURL(value, { windows })
  } : url;
  const targetProcess = scenario ? new Proxy(process, {
    get(target, property) {
      if (property === "platform") return scenario.platform;
      if (property === "execPath") return scenario.execPath;
      if (property === "cwd") return () => targetPath.dirname(scenario.execPath);
      return Reflect.get(target, property);
    }
  }) : process;
  const external = /^(?:obsidian$|electron$|@codemirror\/|@lezer\/)/;
  const shim = new Proxy({}, {
    get(_target, property) {
      if (property === "__esModule") return true;
      if (property === "default") return shim;
      if (property === "Platform") return { isMobileApp: false, isMobile: false, isTablet: false };
      return class {};
    }
  });
  const require = createRequire(bundlePath);
  const pluginRequire = (request) => {
    if (external.test(request)) return shim;
    // Community installs have no node_modules beside the published main.js.
    assert.ok(isBuiltin(request), `production bundle escaped to external module: ${request}`);
    if (request === "path" || request === "node:path") return targetPath;
    if (request === "url" || request === "node:url") return targetUrl;
    if (request === "process" || request === "node:process") return targetProcess;
    return require(request);
  };
  pluginRequire.resolve = require.resolve;
  const pluginModule = { exports: {} };
  try {
    // Obsidian provides require/module/exports, not Node's __filename/__dirname.
    compileFunction(readFileSync(bundlePath, "utf8"), ["require", "module", "exports", "process"], {
      filename: bundlePath
    })(pluginRequire, pluginModule, pluginModule.exports, targetProcess);
    assert.equal(typeof pluginModule.exports.default, "function", "plugin class must be exported");
    console.log(`bundle module load: OK (${caseName === "native" ? `native ${process.platform}` : `${caseName} path/URL semantics`})`);
  } catch (error) {
    console.error(`bundle module load: FAIL (${caseName}): ${error.stack ?? error}`);
    process.exitCode = 1;
  }
}
