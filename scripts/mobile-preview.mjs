import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import esbuild from "esbuild";
import { mobileBuildOptions } from "./mobile-build.mjs";

const build = await esbuild.build({ ...mobileBuildOptions("tests/mobile/browser.ts"), format: "esm", external: [], plugins: [
  ...mobileBuildOptions().plugins,
  { name: "fixture-obsidian", setup(build) { build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.resolve("tests/mobile/browser-obsidian.ts") })); } }
] });
const hostCssPath = process.env.ECHOINK_HOST_CSS;
const baselineCssPath = process.env.ECHOINK_BASELINE_CSS;
const lucidePath = process.env.ECHOINK_LUCIDE_JS;
const port = Number(process.env.ECHOINK_PREVIEW_PORT ?? 5179);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("ECHOINK_PREVIEW_PORT must be a valid TCP port.");
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EchoInk 正式移动组件验收</title>__HOST_STYLE__<link rel="stylesheet" href="/styles.css"><style>
:root{--font-interface:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;--font-monospace:monospace;--font-text-size:16px;--background-primary:#fff;--background-secondary:#f7f8f6;--text-normal:#303b38;--text-muted:#788079;--background-modifier-border:#e8ebe7}*{box-sizing:border-box}body{margin:0;font-family:var(--font-interface)}body.theme-dark{--background-primary:#222422;--background-secondary:#2b2e2b;--text-normal:#e2e6e0;--text-muted:#b1b7af;--background-modifier-border:#3c423b;background:#222422;color:#e2e6e0}#app{height:calc(100dvh - 48px);width:100%;margin:auto;--view-bottom-spacing:68px}#fixture-workspace{display:flex;height:calc(100dvh - 48px)}#home{min-width:0;flex:1;height:100%;overflow:auto}body.fixture-tablet #app{width:340px;flex:none;border-left:1px solid var(--background-modifier-border);--view-bottom-spacing:0px}body.fixture-tablet .fixture-navbar{display:none}.fixture-top{height:48px;display:flex;align-items:center;gap:12px;padding:0 14px;background:var(--background-secondary);font-size:12px}.fixture-navbar{position:fixed;bottom:0;left:0;right:0;height:68px;background:var(--background-secondary);border-top:1px solid var(--background-modifier-border);display:flex;align-items:center;justify-content:space-around;color:var(--text-muted);font-size:14px}#fixture-label{position:fixed;right:0;bottom:0;z-index:3;font-size:9px;opacity:.4;pointer-events:none}.modal-container{position:fixed;inset:0;background:#0006;display:flex;align-items:center;justify-content:center;z-index:8}.modal{background:var(--background-primary);color:var(--text-normal);padding:18px;border-radius:14px;max-width:calc(100vw - 24px);display:flex;flex-direction:column}.modal-content{overflow:auto;min-height:0}.modal h2{margin:0 0 14px}.fixture-tablet #home{--view-bottom-spacing:0px}#opened:not(:empty){position:fixed;top:0;left:0;right:0;background:#eaf3ed;color:#303b38;z-index:4;padding:20px;white-space:pre-wrap}button,input,textarea,select{font-family:inherit}button{cursor:pointer}

#app[hidden],#home[hidden],#settings[hidden]{display:none}#fixture-center{display:flex;flex-direction:column;flex:1;min-width:0;height:100%}#settings{min-height:0;flex:1}#fixture-drawer{display:contents}body.fixture-tablet #fixture-drawer{display:flex;flex-direction:column;flex:0 0 var(--fixture-sidebar-width,340px);width:var(--fixture-sidebar-width,340px);max-width:100%;min-height:0}body.fixture-tablet #app{width:100%;height:auto;min-height:0;flex:1;--view-bottom-spacing:initial}body.fixture-phone #app,body.fixture-phone #home,body.fixture-phone #settings{--view-bottom-spacing:68px}

body.fixture-tablet #fixture-workspace{position:relative}
.fixture-side-tabs{display:none;flex:none;height:44px;align-items:center;gap:2px;padding:0 6px;border-bottom:1px solid var(--background-modifier-border);color:var(--text-muted);background:var(--background-primary)}
body.fixture-tablet .fixture-side-tabs{display:flex}
.fixture-side-tabs button{width:44px;height:44px;padding:0;border:0;border-radius:8px;background:transparent;box-shadow:none;display:grid;place-items:center;color:inherit}
.fixture-side-tabs button.is-active{background:var(--background-modifier-hover)}
.fixture-side-tabs svg{width:18px;height:18px}
#fixture-workspace > button.fixture-backdrop{display:none;position:absolute;inset:0;width:100%;height:100%;min-height:0;max-height:none;margin:0;padding:0;background:#0004;z-index:4;border:0;border-radius:0;box-shadow:none}#fixture-workspace > button.fixture-backdrop:hover,#fixture-workspace > button.fixture-backdrop:focus{background:#0004;box-shadow:none}.fixture-backdrop::after{content:none}
.fixture-native-view{padding:14px;flex:1;min-height:0;overflow:auto;background:var(--background-primary)}
.fixture-note{flex:1;min-height:0;padding:32px;overflow:auto}
.fixture-top #fixture-sidebar-toggle{margin-left:auto}
@media(max-width:960px){body.fixture-tablet #fixture-drawer{position:absolute;right:0;top:0;bottom:0;z-index:5;width:min(var(--fixture-sidebar-width,360px),100%);box-shadow:-8px 0 24px #0002}body.fixture-tablet:not(.fixture-sidebar-open) #fixture-drawer{display:none}body.fixture-tablet.fixture-sidebar-open #fixture-workspace > button.fixture-backdrop{display:block}}
body.fixture-still *,body.fixture-still *::before,body.fixture-still *::after{animation:none!important;transition:none!important}
body.fixture-host #fixture-workspace{height:calc(100dvh - 48px - var(--fixture-external,0px))}
body.fixture-host #fixture-drawer{--view-bottom-spacing:var(--fixture-required,0px)}
body.fixture-host #app,body.fixture-host #home,body.fixture-host #settings{--view-bottom-spacing:var(--fixture-required,0px)}
body.fixture-host #fixture-drawer{padding-bottom:0}
.fixture-host-footer{display:none;flex:none;height:var(--fixture-footer,56px);align-items:center;justify-content:space-around;border-top:1px solid var(--background-modifier-border);color:var(--text-muted)}
body.fixture-host.fixture-tablet .fixture-host-footer{display:flex}
body.fixture-host .fixture-navbar{height:var(--fixture-required,68px)}
body.fixture-host.fixture-tablet #fixture-workspace{height:calc(100dvh - 48px - var(--fixture-safe,0px) - var(--fixture-extra,0px))}
</style><body class="theme-light"><div class="fixture-top">Obsidian 宿主外壳替身 · 正式组件 <button id="fixture-home-tab">首页标签</button> <button id="fixture-close-settings">关闭设置标签</button><button id="fixture-sidebar-toggle" aria-label="切换原生右侧栏">侧栏</button></div><div id="fixture-workspace"><section id="fixture-center"><div id="home" hidden></div><div id="settings" hidden></div></section><button class="fixture-backdrop" aria-label="收起原生右侧栏"></button><aside id="fixture-drawer"><nav class="fixture-side-tabs" aria-label="宿主右栏视图"><button data-host-view="agent" aria-label="EchoInk" class="is-active"></button><button data-host-view="outline" aria-label="大纲"></button><button data-host-view="backlink" aria-label="反向链接"></button></nav><div class="fixture-native-view" hidden></div><div id="app"></div><footer class="fixture-host-footer">⚙　　‹　　›</footer></aside></div><nav class="fixture-navbar" aria-label="宿主导航">‹　　＋　　⌕　　☰</nav><div id="opened" role="status"></div><span id="fixture-label">正式组件 · 模型与宿主替身</span><script>const p=new URLSearchParams(location.search);if(p.has('tablet')||(p.has('desktop')&&p.has('home')))document.body.classList.add('fixture-tablet');if(p.has('still'))document.body.classList.add('fixture-still');if(p.has('desktop'))document.body.classList.add('is-desktop','is-macos');else document.body.classList.add('is-mobile','is-ios',p.has('tablet')?'is-tablet':'is-phone','fixture-phone');if(p.has('tablet'))document.body.classList.remove('fixture-phone');if(p.has('host')){document.body.classList.add('fixture-host');if(p.has('tablet'))document.querySelector('#fixture-drawer').classList.add('workspace-drawer-inner');}if(p.has('host')){const safe=Number(p.get('safe')??20),footer=Number(p.get('footer')??56),extra=Number(p.get('external')??(p.has('tablet')?safe+footer:68));document.body.style.setProperty('--fixture-safe',safe+'px');document.body.style.setProperty('--safe-area-inset-bottom',safe+'px');document.body.style.setProperty('--fixture-footer',footer+'px');document.body.style.setProperty('--fixture-extra',(p.has('tablet')?Math.max(0,extra-safe-footer):0)+'px');document.body.style.setProperty('--fixture-external',extra+'px');document.body.style.setProperty('--fixture-required',(p.has('tablet')?safe:68)+'px');if(p.has('noexternal')){document.body.style.setProperty('--fixture-safe','0px');document.body.style.setProperty('--fixture-footer','0px');document.body.style.setProperty('--fixture-external','0px');document.querySelector('.fixture-host-footer').style.display='none';}document.querySelector('#fixture-label').textContent='1.14.4 CSS · footer/safe 为已解析模拟值';}const sw=Number(p.get('sidebar'));if(sw>0)document.body.style.setProperty('--fixture-sidebar-width',sw+'px');if(p.has('dark'))document.body.classList.remove('theme-light'),document.body.classList.add('theme-dark');if(p.has('large'))document.body.style.setProperty('--font-text-size','20px');</script><script type="module" src="/app.js"></script></body></html>`;
const server = http.createServer(async (request, response) => {
  const { pathname, searchParams: params } = new URL(request.url ?? "/", "http://localhost");
  try {
    if (pathname === "/app.js") { response.setHeader("content-type", "text/javascript"); response.end(build.outputFiles[0].text); }
    else if (pathname === "/styles.css") { response.setHeader("content-type", "text/css"); response.end(await fs.readFile(params.has("baseline") && baselineCssPath ? baselineCssPath : "styles.css")); }
    else if (pathname === "/host.css" && hostCssPath) { response.setHeader("content-type", "text/css"); response.end(await fs.readFile(hostCssPath)); }
    else if (pathname === "/lucide.js" && lucidePath) { response.setHeader("content-type", "text/javascript"); response.end(await fs.readFile(lucidePath)); }
    else if (pathname === "/") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(html.replace("__HOST_STYLE__", params.has("host") && hostCssPath ? '<link rel="stylesheet" href="/host.css">' : "")
        .replace('href="/styles.css"', params.has("baseline") ? 'href="/styles.css?baseline"' : 'href="/styles.css"')
        .replace('<script type="module" src="/app.js">', `${lucidePath ? '<script src="/lucide.js"></script>' : ""}<script type="module" src="/app.js">`)
        .replace("const p=new URLSearchParams(location.search);", "const p=new URLSearchParams(location.search);const theme=p.get('theme');if(theme==='green'||theme==='violet')document.body.dataset.echoinkTheme=theme;"));
    } else { response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); response.end("Not found"); }
  } catch (error) { response.writeHead(500, { "content-type": "text/plain; charset=utf-8" }); response.end(String(error)); }
});
server.listen(port, "127.0.0.1", () => console.log(`Mobile component fixture: http://127.0.0.1:${port}`));
