import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
await mkdir(path.join(root, ".tmp"), { recursive: true });
const temporary = await mkdtemp(path.join(root, ".tmp/inline-agent-mention-"));
try {
  const output = path.join(temporary, "tests.mjs");
  await build({
    entryPoints: ["src/tests/inline-agent-mention.ts"], outfile: output,
    bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent",
    loader: { ".svg": "dataurl" }, external: ["jsdom"],
    plugins: [{ name: "inline-mention-obsidian", setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "inline-mention-fixture" }));
      build.onLoad({ filter: /.*/, namespace: "inline-mention-fixture" }, () => ({
        resolveDir: root, loader: "ts", contents: `
          import { StateField } from "@codemirror/state";
          export const editorInfoField = StateField.define({create: () => ({file: {path: "合成正文.md"}}), update: value => value});
          export const editorLivePreviewField = StateField.define({create: () => true, update: value => value});
          export const Platform = {isMobile: false};
          export const mentionTestNotices = [];
          export class Notice { constructor(message) { mentionTestNotices.push(message); } }
          export function setIcon(element, icon) { const svg = element.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("data-icon", icon); element.append(svg); }
        `
      }));
    } }]
  });
  const result = spawnSync(process.execPath, [output], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
