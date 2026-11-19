import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";
import { desktopNodeTestAliases, desktopNodeTestBanner } from "./desktop-node-test-host.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(path.join(tmpdir(), "echoink-user-facing-error-"));
try {
  const outfile = path.join(directory, "tests.mjs");
  await esbuild.build({
    stdin: { contents: 'export { runUserFacingErrorTests } from "./src/tests/user-facing-error";', resolveDir: root, loader: "ts" },
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    alias: desktopNodeTestAliases,
    banner: desktopNodeTestBanner,
    loader: { ".md": "text", ".svg": "dataurl", ".webp": "dataurl" },
    logLevel: "silent"
  });
  const { runUserFacingErrorTests } = await import(pathToFileURL(outfile).href);
  runUserFacingErrorTests();
} finally {
  await rm(directory, { recursive: true, force: true });
}
