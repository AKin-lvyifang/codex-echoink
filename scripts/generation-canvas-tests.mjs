import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const repo = fileURLToPath(new URL("../", import.meta.url));
// This pure Canvas suite needs no Vault, DOM or on-disk fixtures.
const result = await esbuild.build({
  entryPoints: ["src/tests/generation-canvas.ts"], absWorkingDir: repo,
  bundle: true, platform: "node", target: "node22", format: "esm", write: false, logLevel: "silent"
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`;
const { runGenerationCanvasTests } = await import(moduleUrl);
runGenerationCanvasTests();
