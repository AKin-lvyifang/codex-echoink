import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = await mkdtemp(path.join(os.tmpdir(), "echoink-workspace-tests-"));
try {
  const entry = path.join(output, "workspace-tests.mjs");
  await esbuild.build({ entryPoints: [path.join(root, "tests/workspace/entry.ts")], bundle: true, platform: "node", format: "esm", target: "node22", outfile: entry,
    packages: "external", logLevel: "silent", banner: { js: `import {createRequire} from 'node:module'; const require=createRequire(${JSON.stringify(path.join(root, "package.json"))});` },
    plugins: [{ name: "workspace-test-packages", setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "workspace-obsidian", namespace: "workspace-test-host" }));
      build.onLoad({ filter: /.*/, namespace: "workspace-test-host" }, () => ({ contents: `
        export const Platform={isDesktop:true};
        export class ItemView { constructor(leaf){this.leaf=leaf;this.contentEl=leaf.contentEl;} async onClose(){} }
        export class FileView extends ItemView {
          file=null;
          getState(){return this.file?{file:this.file.path}:{};}
          async setState(state){if(!state.file)return;const file=this.leaf.fileByPath(state.file);if(!file)throw new Error('fixture file missing');if(this.file)await this.onUnloadFile(this.file);this.file=file;await this.onLoadFile(file);}
        }
      ` }));
      build.onResolve({ filter: /^(?:jsdom|typebox)$/ }, args => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true }));
    } }]
  });
  await import(pathToFileURL(entry).href);
  const browser = await esbuild.build({ entryPoints: [path.join(root, "src/workspace/service.ts"), path.join(root, "src/workspace/preview.ts"), path.join(root, "src/workspace/tools.ts")],
    bundle: true, write: false, outdir: output, platform: "browser", format: "esm", target: "es2022", metafile: true, logLevel: "silent" });
  if (Object.keys(browser.metafile.inputs).some(file => /(?:^|\/)(?:desktop-fs|desktop-paths|node:)/u.test(file))) throw new Error("Workspace browser bundle includes desktop-only code");
  console.log("workspace browser bundle: passed");
} finally { await rm(output, { recursive: true, force: true }); }
