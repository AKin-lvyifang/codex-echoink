import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
if (process.argv.includes("--dom")) {
  const directory = path.join(rootDir, ".tmp/origin-dom/composer-menus");
  await mkdir(directory, { recursive: true });
  const ts = await import("typescript");
  const source = await readFile(path.join(rootDir, "src/ui/codex-view/composer.ts"), "utf8");
  const ast = ts.createSourceFile("composer.ts", source, ts.ScriptTarget.Latest, true);
  const labelFor = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "labelFor");
  if (!labelFor) throw new Error("Production labelFor missing");
  await esbuild.build({
    entryPoints: ["src/tests/composer-menu-dom.ts"], absWorkingDir: rootDir,
    bundle: true, platform: "browser", format: "esm", outfile: path.join(directory, "regression.js"),
    alias: { obsidian: path.join(rootDir, "src/tests/composer-menu-dom-host.ts") },
    plugins: [{ name: "production-menu-label-only", setup(build) {
      // Keep the whole production menus module; its composer dependency only
      // needs this pure label function, extracted unchanged from current source.
      build.onResolve({ filter: /^\.\/composer$/ }, ({ importer }) => importer.endsWith("/codex-view/menus.ts") ? { path: "label", namespace: "menu-label" } : undefined);
      build.onLoad({ filter: /.*/, namespace: "menu-label" }, () => ({ contents: labelFor.getText(ast), loader: "ts" }));
    } }], logLevel: "silent"
  });
  await writeFile(path.join(directory, "styles.css"), await readFile(path.join(rootDir, "styles.css")));
  await writeFile(path.join(directory, "index.html"), '<!doctype html><meta charset="utf-8"><title>Production composer menu regression</title><link rel="stylesheet" href="styles.css"><style>body{padding:24px;font:14px sans-serif}h2{font-size:16px}button{margin:8px}output{display:block}iframe{width:100%;height:440px;border:1px solid #ddd}#report{white-space:pre-wrap;line-height:1.6}</style><h2>主文档</h2><main id="fixture"></main><h2>独立 ownerDocument</h2><iframe id="independent" title="独立窗口菜单"></iframe><pre id="report">Running…</pre><script type="module" src="regression.js"></script>');
  console.log(`Open ${directory}/index.html; #report[data-result=passed] is the browser result.`);
} else {
  const outfile = path.join(rootDir, ".tmp/composer-actions-tests.mjs");
  await esbuild.build({
    stdin: { contents: 'import {runComposerActionTests} from "./src/tests/composer-actions"; await runComposerActionTests(); console.log("Composer actions: PASS");', resolveDir: rootDir, loader: "ts" },
    bundle: true, platform: "node", target: "node22", format: "esm", outfile,
    loader: { ".md": "text", ".svg": "dataurl", ".webp": "dataurl" },
    external: ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "yaml"],
    plugins: [{ name: "composer-host-services", setup(build) {
      build.onResolve({ filter: /provider-brand-icons$/ }, () => ({ path: path.join(rootDir, "src/tests/composer-provider-brand-shim.ts") }));
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(rootDir, "src/tests/obsidian-shim.ts") }));
    } }], logLevel: "silent"
  });
  const result = spawnSync(process.execPath, [outfile], { cwd: rootDir, env: { ...process.env, PI_OFFLINE: "1" }, stdio: "inherit" });
  process.exit(result.status ?? 1);
}
