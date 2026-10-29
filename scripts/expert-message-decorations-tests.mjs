import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";
import { desktopNodeTestBanner } from "./desktop-node-test-host.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = await mkdtemp(path.join(os.tmpdir(), "echoink-expert-decoration-tests-"));
try {
  const entry = path.join(output, "expert-decorations.mjs");
  await esbuild.build({ stdin: { contents: 'export {runExpertMessageDecorationsTests} from "./src/tests/expert-message-decorations";', resolveDir: root, loader: "ts" },
    bundle: true, platform: "node", format: "esm", target: "node22", outfile: entry, banner: desktopNodeTestBanner, logLevel: "silent", loader: { ".md": "text", ".svg": "dataurl", ".webp": "dataurl" },
    plugins: [{ name: "expert-decoration-test-host", setup(build) {
      build.onResolve({ filter: /^(?:@earendil-works\/pi-(?:agent-core|ai|coding-agent)(?:\/.*)?|yaml|jsdom)$/ }, args => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true }));
      build.onResolve({ filter: /provider-brand-icons$/ }, () => ({ path: path.join(root, "src/tests/composer-provider-brand-shim.ts") }));
      build.onResolve({ filter: /(?:^|\/)origin-controls$/ }, () => ({ path: path.join(root, "src/tests/origin-controls-shim.ts") }));
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(root, "src/tests/obsidian-shim.ts") }));
    } }]
  });
  const tests = await import(pathToFileURL(entry).href); await tests.runExpertMessageDecorationsTests();
} finally { await rm(output, { recursive: true, force: true }); }
