import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(path.join(tmpdir(), "echoink-output-locations-"));
try {
  const outfile = path.join(directory, "tests.mjs");
  await esbuild.build({
    stdin: { contents: `import { runConversationContentTests } from "./src/tests/conversation-content"; await runConversationContentTests(${JSON.stringify(path.join(directory, "vault"))});`, resolveDir: root, loader: "ts" },
    outfile, bundle: true, platform: "node", target: "node22", format: "esm"
  });
  await import(pathToFileURL(outfile).href);
} finally { await rm(directory, { recursive: true, force: true }); }
