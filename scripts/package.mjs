import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";

const projectRoot = path.resolve(new URL("..", import.meta.url).pathname);
const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "manifest.json"), "utf8"));
const releaseRoot = path.join(projectRoot, "release");
const pluginDir = path.join(releaseRoot, manifest.id);
const zipName = `${manifest.id}-${manifest.version}.zip`;
const zipPath = path.join(releaseRoot, zipName);

fs.rmSync(releaseRoot, { recursive: true, force: true });
fs.mkdirSync(pluginDir, { recursive: true });

copy("dist/main.js", "main.js");
copy("manifest.json", "manifest.json");
copy("styles.css", "styles.css");
copy("LICENSE", "LICENSE");
copy("THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md");
fs.mkdirSync(path.join(pluginDir, "licenses"), { recursive: true });
copy("licenses/MIT.txt", "licenses/MIT.txt");
copy("licenses/PRO-LICENSE.txt", "licenses/PRO-LICENSE.txt");

if (fs.existsSync(zipPath)) fs.rmSync(zipPath);
const result = spawnSync("zip", ["-qr", zipName, manifest.id], {
  cwd: releaseRoot,
  stdio: "inherit"
});

if (result.status !== 0) {
  console.error("Failed to create zip. Please install the zip command and retry.");
  process.exit(result.status ?? 1);
}

console.log(`Packaged ${path.relative(projectRoot, zipPath)}`);

function copy(from, to) {
  fs.copyFileSync(path.join(projectRoot, from), path.join(pluginDir, to));
}
