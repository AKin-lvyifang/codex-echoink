import { fileURLToPath } from "node:url";
import path from "node:path";
import esbuild from "esbuild";
const root = fileURLToPath(new URL("../", import.meta.url));
const result = await esbuild.build({ stdin: { contents: 'import {runGenerationMessageTests} from "./src/tests/generation-messages"; await runGenerationMessageTests();', resolveDir: root, loader: "ts" }, bundle: true, write: false, platform: "node", format: "esm", target: "node22", logLevel: "silent",
  banner: { js: `import {createRequire} from "node:module"; const require = createRequire(${JSON.stringify(path.join(root, "package.json"))});` }, loader: { ".md": "text", ".svg": "dataurl", ".webp": "dataurl" },
  plugins: [{ name: "generation-message-host", setup(build) {
    build.onResolve({ filter: /^(?:@earendil-works\/pi-(?:agent-core|ai|coding-agent)(?:\/.*)?|yaml|jsdom)$/ }, args => ({ path: import.meta.resolve(args.path), external: true }));
    build.onResolve({ filter: /provider-brand-icons$/ }, () => ({ path: path.join(root, "src/tests/composer-provider-brand-shim.ts") }));
    build.onResolve({ filter: /(?:^|\/)origin-controls$/ }, () => ({ path: path.join(root, "src/tests/origin-controls-shim.ts") }));
    build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(root, "src/tests/obsidian-shim.ts") }));
  } }]
});
try {
  await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
} catch (error) {
  console.error(String(error?.stack ?? error).replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/gu, "<compiled generation messages>"));
  process.exitCode = 1;
}
