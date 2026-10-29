import { desktopNodeTestBanner, desktopNodeTestAliases } from "./desktop-node-test-host.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const output = await mkdtemp(path.join(os.tmpdir(), "echoink-pi-workspace-tools-"));
try {
  const file = path.join(output, "pi-workspace-tools.mjs");
  await esbuild.build({ banner: desktopNodeTestBanner, alias: desktopNodeTestAliases,
    stdin: { contents: 'export { runPiWorkspaceToolTests } from "./src/tests/pi-native/pi-workspace-tools";', resolveDir: process.cwd(), loader: "ts" },
    bundle: true, loader: { ".md": "text" }, platform: "node", target: "node22", format: "esm", outfile: file,
    external: ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "yaml"], logLevel: "silent",
    plugins: [{ name: "workspace-security-test-packages", setup(build) {
      build.onResolve({ filter: /^@earendil-works\/pi-(?:agent-core|ai|coding-agent)(?:\/.*)?$/ }, args => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true }));
    } }]
  });
  await (await import(pathToFileURL(file).href)).runPiWorkspaceToolTests();
} finally { await rm(output, { recursive: true, force: true }); }
