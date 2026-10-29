import { fileURLToPath } from "node:url";

// ESM fixtures emulate the CommonJS require supplied to desktop plugins.
const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
export const desktopNodeTestBanner = {
  js: `import { createRequire as createDesktopFixtureRequire } from "node:module"; const require = createDesktopFixtureRequire(${JSON.stringify(packagePath)});`
};
export const desktopNodeTestAliases = {
  obsidian: fileURLToPath(new URL("../src/tests/obsidian-shim.ts", import.meta.url))
};
