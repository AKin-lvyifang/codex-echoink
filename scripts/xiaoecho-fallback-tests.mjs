import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";
import { desktopNodeTestAliases, desktopNodeTestBanner } from "./desktop-node-test-host.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(path.join(tmpdir(), "echoink-xiaoecho-fallback-"));
try {
  const outfile = path.join(directory, "tests.mjs");
  await esbuild.build({
    stdin: {
      contents: 'export { runXiaoechoFallbackTests } from "./src/tests/xiaoecho-fallback";',
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
      name: "xiaoecho-fallback-pi-runtime",
      setup(build) {
        build.onResolve({ filter: /^@earendil-works\/pi-(ai|agent-core|coding-agent)(\/|$)/ },
          (args) => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true }));
      }
    }]
  });
  const { runXiaoechoFallbackTests } = await import(pathToFileURL(outfile).href);
  await runXiaoechoFallbackTests();
} finally {
  await rm(directory, { recursive: true, force: true });
}
