import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import esbuild from "esbuild";
import { mobileBuildOptions } from "./mobile-build.mjs";

const build = await esbuild.build({ ...mobileBuildOptions("tests/mobile/browser.ts"), format: "esm", external: [], plugins: [
  ...mobileBuildOptions().plugins,
  { name: "fixture-obsidian", setup(build) { build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.resolve("tests/mobile/browser-obsidian.ts") })); } }
] });
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EchoInk 正式移动组件验收</title><link rel="stylesheet" href="/styles.css"><style>
:root{--font-interface:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;--font-monospace:monospace;--font-text-size:16px;--background-primary:#fff;--background-secondary:#f7f8f6;--text-normal:#303b38;--text-muted:#788079;--background-modifier-border:#e8ebe7}*{box-sizing:border-box}body{margin:0;font-family:var(--font-interface)}body.theme-dark{--background-primary:#222422;--background-secondary:#2b2e2b;--text-normal:#e2e6e0;--text-muted:#b1b7af;--background-modifier-border:#3c423b;background:#222422;color:#e2e6e0}#app{height:100dvh;width:100%;margin:auto}#fixture-label{position:fixed;right:0;bottom:0;z-index:3;font-size:9px;opacity:.4;pointer-events:none}#opened:not(:empty){position:fixed;top:0;left:0;right:0;background:#eaf3ed;color:#303b38;z-index:4;padding:20px;white-space:pre-wrap}button,input,textarea,select{font-family:inherit}button{cursor:pointer}
</style><body class="theme-light"><div id="app"></div><div id="opened" role="status"></div><span id="fixture-label">正式组件 · 模型与宿主替身</span><script>const p=new URLSearchParams(location.search);if(p.has('dark'))document.body.className='theme-dark';if(p.has('large'))document.documentElement.style.setProperty('--font-text-size','20px');</script><script type="module" src="/app.js"></script></body></html>`;
const server = http.createServer(async (request, response) => {
  if (request.url?.startsWith("/app.js")) { response.setHeader("content-type", "text/javascript"); response.end(build.outputFiles[0].text); }
  else if (request.url === "/styles.css") { response.setHeader("content-type", "text/css"); response.end(await fs.readFile("styles.css")); }
  else { response.setHeader("content-type", "text/html; charset=utf-8"); response.end(html); }
});
server.listen(5179, "127.0.0.1", () => console.log("Mobile component fixture: http://127.0.0.1:5179"));
