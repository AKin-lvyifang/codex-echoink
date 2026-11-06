import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const result = await esbuild.build({
  stdin: {
    contents: 'import { runMemoryDirectorySelectorTests } from "./src/tests/memory-directory-selector"; await runMemoryDirectorySelectorTests();',
    resolveDir: root,
    loader: "ts"
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "silent"
});
try {
  await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
} catch (error) {
  console.error(`${error?.name ?? "Error"}: ${error?.message ?? String(error)}`);
  process.exitCode = 1;
}
