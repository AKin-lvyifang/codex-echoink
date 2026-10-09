import path from "node:path";
import fs from "node:fs/promises";
import esbuild from "esbuild";
import { poolDesktopStrings, assertDesktopMarkersPreserved } from "./desktop-string-pool.mjs";

// Keep Pi's real Agent, event stream and tool validation. Exclude the Node
// provider/auth catalog: mobile always injects its own requestUrl streamFn.
export const mobilePiPlugin = {
  name: "mobile-pi-browser-surface",
  setup(build) {
    const root = path.resolve("node_modules/@earendil-works");
    build.onResolve({ filter: /^@earendil-works\/pi-agent-core$/ }, () => ({ path: path.join(root, "pi-agent-core/dist/agent.js") }));
    build.onResolve({ filter: /^@earendil-works\/pi-ai$/ }, () => ({ path: "pi-mobile", namespace: "pi-mobile" }));
    build.onLoad({ filter: /.*/, namespace: "pi-mobile" }, () => ({
      contents: `export * from ${JSON.stringify(path.join(root, "pi-ai/dist/utils/event-stream.js"))}; export {validateToolArguments} from ${JSON.stringify(path.join(root, "pi-ai/dist/utils/validation.js"))};`,
      resolveDir: process.cwd(), loader: "js"
    }));
  }
};
export function mobileBuildOptions(entry = "src/mobile/plugin.ts") {
  return { entryPoints: [entry], bundle: true, write: false, format: "cjs", platform: "browser", target: "es2022", external: ["obsidian"], plugins: [mobilePiPlugin], logLevel: "silent" };
}
export async function assemblePlatformBundle(desktopCode, minify) {
  const mobile = await esbuild.build({ ...mobileBuildOptions(), minify });
  const selector = await esbuild.build({ ...mobileBuildOptions("src/platform-entry.ts"), minify });
  const wrap = (name, code) => `function ${name}(){var module={exports:{}};var exports=module.exports;\n${code}\nreturn module.exports;}\n`;
  const desktop = minify ? poolDesktopStrings(desktopCode).code : desktopCode;
  let code = selector.outputFiles[0].text + "\n" + wrap("loadMobile", mobile.outputFiles[0].text) + wrap("loadDesktop", desktop);
  if (minify) {
    code = (await esbuild.transform(code, { minify: true, charset: "utf8", target: "es2022", format: "cjs", legalComments: "inline" })).code;
    assertDesktopMarkersPreserved(desktopCode, code);
  }
  // Community installs fetch main.js, manifest.json and styles.css only.
  // Keep the complete component terms with the artifact, outside executable code.
  const licenseFiles = ["LICENSE", "licenses/MIT.txt", "licenses/PRO-LICENSE.txt", "THIRD_PARTY_NOTICES.md"];
  const notices = await Promise.all(licenseFiles.map(async file =>
    `--- ${file} ---\n${await fs.readFile(new URL(`../${file}`, import.meta.url), "utf8")}`));
  const notice = notices.join("\n\n");
  if (notice.includes("*/")) throw new Error("License notice contains a JavaScript comment terminator.");
  code = `/*! EchoInk component licenses and third-party notices\n${notice}\n*/\n${code}`;
  await fs.writeFile("dist/main.js", code);
  console.log(`Mobile browser bundle: ${mobile.outputFiles[0].contents.length} bytes; combined main.js: ${Buffer.byteLength(code)} bytes`);
}
