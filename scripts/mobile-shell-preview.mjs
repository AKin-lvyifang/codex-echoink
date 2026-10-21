// Browser-only shell fixture. No production entry imports this file or its assets.
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import esbuild from "esbuild";

const [hostCss, icons, portArg = "8773"] = process.argv.slice(2);
if (!hostCss || !icons) throw new Error("Usage: node scripts/mobile-shell-preview.mjs <extracted-host.css> <lucide-umd.js> [port]");
const bundle = await esbuild.build({ entryPoints: ["tests/mobile-shell/browser.ts"], bundle: true,
  platform: "browser", format: "iife", write: false, logLevel: "silent",
  alias: { obsidian: path.resolve("tests/mobile-shell/obsidian.ts") } });
const assets = new Map([
  ["/", ["text/html; charset=utf-8", Buffer.from(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EchoInk M1 shell fixture</title><link rel="stylesheet" href="/host.css"><link rel="stylesheet" href="/product.css"><link rel="stylesheet" href="/iphone.css"><link rel="stylesheet" href="/ipad.css"><link rel="stylesheet" href="/fixture.css"></head><body><main id="fixture"></main><script src="/lucide.js"></script><script src="/fixture.js"></script></body></html>`) ]],
  ["/fixture.js", ["text/javascript", bundle.outputFiles[0].contents]],
]);
for (const [url, file, type] of [
  ["/host.css", hostCss, "text/css"], ["/lucide.js", icons, "text/javascript"],
  ["/product.css", "styles.css", "text/css"], ["/iphone.css", "src/ui/iphone/shell.css", "text/css"],
  ["/ipad.css", "src/ui/ipad/shell.css", "text/css"], ["/fixture.css", "tests/mobile-shell/browser.css", "text/css"]
]) assets.set(url, [type, await fs.readFile(file)]);
for (const name of ["sol", "nova", "rio", "lin", "aya", "han"]) {
  const file = `assets/avatars/monochrome-round-set-01/${name}.svg`;
  assets.set(`/${file}`, ["image/svg+xml", await fs.readFile(file)]);
}
const server = http.createServer((req, res) => {
  const asset = assets.get(new URL(req.url, "http://localhost").pathname);
  if (req.method !== "GET" || !asset) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": asset[0], "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(asset[1]);
});
server.listen(Number(portArg), "127.0.0.1", () => console.log(`M1 fixture http://127.0.0.1:${portArg}/ (explicit asset allowlist)`));
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));
