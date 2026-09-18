import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const piMinimatchImporter = /\/node_modules\/@earendil-works\/pi-coding-agent\/node_modules\/minimatch\/dist\/(?:esm|commonjs)\/index\.js$/;

// Pi's published shrinkwrap retains 5.0.7 despite root overrides. Redirect
// only its minimatch import; the 1.x/2.x consumers keep their own API versions.
export const piBraceExpansionPlugin = {
  name: "echoink-pi-brace-expansion",
  setup(build) {
    build.onResolve({ filter: /^brace-expansion$/ }, async (args) => {
      if (!piMinimatchImporter.test(args.importer.replaceAll("\\", "/"))) return;
      const packagePath = path.join(projectRoot, "node_modules/brace-expansion/package.json");
      const installed = JSON.parse(await fs.promises.readFile(packagePath, "utf8"));
      if (installed.version !== "5.0.9") {
        throw new Error(`EchoInk requires root brace-expansion 5.0.9; found ${installed.version}`);
      }
      // No original importer: re-enter normal resolution at the project root,
      // preserving ESM/CJS export conditions without re-triggering this rule.
      return await build.resolve(args.path, { resolveDir: projectRoot, kind: args.kind });
    });
  }
};
