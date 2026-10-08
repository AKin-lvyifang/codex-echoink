import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import esbuild from "esbuild";
import { createRequire } from "node:module";
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.join(root, ".tmp/membership-gate-tests");
await mkdir(directory, { recursive: true });
try {
  const target = path.join(directory, "test.mjs");
  await esbuild.build({
    stdin: {
      contents:
        'export { runMembershipGateTests } from "./src/tests/membership-gates";',
      resolveDir: root,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    outfile: target,
    external: [
      "read-excel-file/node",
      "yaml",
      "@earendil-works/pi-agent-core",
      "@earendil-works/pi-ai",
      "@earendil-works/pi-coding-agent",
    ],
    loader: { ".md": "text", ".svg": "dataurl", ".webp": "dataurl" },
    banner: {
      js: 'import {createRequire} from "node:module"; const require = createRequire(import.meta.url);',
    },
    alias: { obsidian: path.join(root, "src/tests/obsidian-shim.ts") },
  });
  const test = await import(pathToFileURL(target).href);
  await test.runMembershipGateTests();
} finally {
  await rm(directory, { recursive: true, force: true });
}
