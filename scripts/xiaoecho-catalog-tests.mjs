import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";
import { desktopNodeTestAliases, desktopNodeTestBanner } from "./desktop-node-test-host.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(path.join(tmpdir(), "echoink-xiaoecho-catalog-"));
try {
  const outfile = path.join(directory, "tests.mjs");
  await esbuild.build({
    stdin: {
      contents: 'export { runXiaoechoCatalogTests } from "./src/tests/xiaoecho-catalog";',
      resolveDir: root,
      loader: "ts"
    },
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    alias: desktopNodeTestAliases,
    banner: desktopNodeTestBanner,
    loader: { ".md": "text", ".svg": "dataurl", ".webp": "dataurl" },
    logLevel: "silent",
    plugins: [{
      name: "xiaoecho-catalog-pi-runtime",
      setup(build) {
        build.onResolve({ filter: /^@earendil-works\/pi-(ai|agent-core|coding-agent)(\/|$)/ },
          (args) => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true }));
      }
    }]
  });
  const { runXiaoechoCatalogTests } = await import(pathToFileURL(outfile).href);
  await runXiaoechoCatalogTests();
} finally {
  await rm(directory, { recursive: true, force: true });
}
