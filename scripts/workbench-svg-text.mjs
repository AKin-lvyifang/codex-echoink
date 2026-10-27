import { readFile } from "node:fs/promises";

/** The layered workbench artwork alone needs DOM text; all other SVGs stay URLs. */
export function workbenchSvgTextPlugin() {
  return { name: "workbench-svg-text", setup(build) {
    build.onLoad({ filter: /[/\\]assets[/\\]workbench[/\\][^/\\]+\.svg$/ }, async args => ({ contents: await readFile(args.path, "utf8"), loader: "text" }));
  } };
}
