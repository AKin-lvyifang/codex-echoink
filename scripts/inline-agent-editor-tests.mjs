import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { disposableTestRoot } from "./disposable-test-root.mjs";

const root = process.cwd();
const base = disposableTestRoot(path.join(homedir(), "EchoInk-TestVaults/90-任务临时/正文管家第4轮-20261026-tests"));
await mkdir(base, { recursive: true });
const temporary = await mkdtemp(path.join(base, ".inline-editor-"));
try {
  const output = path.join(temporary, "tests.mjs");
  await build({ entryPoints: ["src/tests/inline-agent-editor.ts"], outfile: output, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent",
    loader: { ".svg": "dataurl", ".md": "text", ".txt": "text", ".webp": "dataurl" },
    banner: { js: `import { createRequire as createInlineEditorRequire } from "node:module"; const require = createInlineEditorRequire(${JSON.stringify(path.join(root, "package.json"))});` },
    plugins: [{ name: "inline-editor-host", setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "inline-editor-fixture" }));
      // Runtime/model execution belongs to the separate service/orchestrator tests.
      build.onResolve({ filter: /^\.\/orchestrator$/ }, args => args.importer.endsWith("/inline-agent/controller.ts") ? { path: "orchestrator", namespace: "inline-editor-fixture" } : undefined);
      build.onLoad({ filter: /.*/, namespace: "inline-editor-fixture" }, args => ({ resolveDir: root, loader: "ts", contents: args.path === "orchestrator" ? "export class InlineAgentRuntimeController {}" : `
        import { StateField } from "@codemirror/state";
        export const editorInfoField = StateField.define({create: () => ({file: {path: "合成正文.md"}}), update: value => value});
        export const editorLivePreviewField = StateField.define({create: () => true, update: value => value});
        export const Platform = {isDesktop: true, isMobile: false, isDesktopApp: true};
        export class Notice { constructor(message) { this.message = message; } }
        export class Component { load() {} unload() {} }
        export class Scope { register() {} }
        export class MarkdownView {}
        export class WorkspaceLeaf {}
        export class TFile { constructor(path) { this.path = path; this.extension = path.split(".").at(-1); } }
        export class MarkdownRenderer { static async render(_app, text, element) { const p = element.ownerDocument.createElement("p"); p.textContent = text; element.append(p); } }
        export function setIcon(element, icon) { const svg = element.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("data-icon", icon); element.append(svg); }
      ` }));
      build.onResolve({ filter: /^[^./]/ }, args => {
        if (args.path === "electron") return { path: args.path, external: true };
        const resolved = import.meta.resolve(args.path);
        return { path: resolved.startsWith("node:") ? resolved : fileURLToPath(resolved), external: true };
      });
    } }]
  });
  const result = spawnSync(process.execPath, [output], { stdio: "inherit", env: { ...process.env, PI_OFFLINE: "1" } });
  process.exitCode = result.status ?? 1;
} finally { await rm(temporary, { recursive: true, force: true }); }
