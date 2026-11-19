// Local real-component fixture. Synthetic catalogue/account only; no Vault or account API.
// ECHOINK_LUCIDE_JS=/path/to/lucide/dist/umd/lucide.js node scripts/account-membership-preview.mjs [port]
// /?device=desktop&series=pro| /?device=desktop&series=max | /?device=iphone
// Optional: &language=en &state=<membership state> &error=<verification error> &used=<sync GB used> &shell=settings
import esbuild from "esbuild";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const port = Number(process.argv[2] || 8786);
if (!process.env.ECHOINK_LUCIDE_JS) throw new Error("Explicit ECHOINK_LUCIDE_JS is required; reuse an installed Lucide UMD");
const shim = `
export { App, Modal, Notice, installProviderBrowserHost } from "./src/tests/provider-discovery-dom-host";
export { Setting, Scope } from "./src/tests/origin-obsidian-dom-shim";
export const Platform = { isDesktopApp: true, isMobile: false };
export function setIcon(node, name) {
 const key = name.replace(/(^|-)([a-z])/g, (_, __, letter) => letter.toUpperCase());
 const icon = window.lucide.icons[key]; node.replaceChildren(); if (icon) node.append(window.lucide.createElement(icon));
}
export function getIcon(name) { const node = document.createElement("span"); setIcon(node, name); return node.firstChild; }
export function displayTooltip() {}
`;
const entry = `
import { App, installProviderBrowserHost } from "obsidian";
import { installObsidianDom } from "./src/tests/obsidian-dom";
import { mountDesktopAccountMembership } from "./src/settings/desktop-account-membership";
import { createUnavailableAccountAdapter } from "./src/settings/account-membership-model";
import { IPhoneAccountPages } from "./src/ui/iphone/account-pages";
installObsidianDom(window); installProviderBrowserHost();
const params = new URLSearchParams(location.search), language = params.get("language") || "zh-CN";
const max = params.get("series") === "max", state = params.get("state") || "active", scheduled = state === "scheduled";
const products = [
  ["early", 2990, null], ["month", 900, 30], ["quarter", 1900, 90], ["year", 4900, 365],
  ["max-month", 3900, 30], ["max-quarter", 10900, 90], ["max-year", 39900, 365]
].map(([id, amount, days]) => ({ id, days, prices: { CNY: amount, USD: amount }, available: false, availability: "paused", currencies: ["CNY"], months: 99 }));
const base = createUnavailableAccountAdapter().read();
const model = { ...base, products, serviceAvailable: true, salesOpen: false, maxSalesOpen: false, proMonthlyPoints: 500,
 identity: { name: "按天计费 · 合成账号", email: "day-billing@example.invalid", avatar: "initial", joinedAt: null, passwordSet: true },
 statistics: { ...base.statistics, totalTokens: 12345, totalTurns: 18, currentStreak: 2, bestStreak: 7 },
 membership: { ...base.membership, state, planId: max ? "max-year" : "year", planName: null,
   startsAt: "2027-01-15", expiresAt: "2028-01-15", verifiedAt: "2026-11-09", devices: [], deviceLimit: 3 },
 entitlements: { tier: max ? "max" : "pro", lifetime: false, isPro: true, subscription: null, next: null,
   sync: { status: "active", plan: max ? "max" : "pro", quotaBytes: (max ? 5 : 1) * 1024 ** 3, readOnly: false, graceUntil: null, deviceLimit: 3 },
   devices: { limit: 3, active: 1, remaining: 2 }, serverTime: Date.UTC(2026, 10, 9),
   points: { balance: "2380", balanceMilli: 2380000, monthly: max ? 3000 : 500, nextExpiry: null }, maxCoupon: false },
 verificationError: params.get("error") || undefined
};
const used = params.get("used");
const syncUsage = used == null ? undefined : { read: () => ({ usedBytes: Number(used) * 1024 ** 3, quotaBytes: model.entitlements.sync.quotaBytes }), subscribe: () => () => {} };
if (params.get("shell") === "settings") document.querySelector("#content").classList.add("echoink-settings-demo", "echoink-settings-aligned");
window.fetch = () => Promise.reject(new Error("External requests are disabled in this fixture"));
const host = document.querySelector("#content");
const adapter = { read: () => model, actions: {}, subscribe: () => () => {} };
if (params.get("device") === "iphone") {
 document.body.classList.add("is-mobile"); host.className = "echoink-iphone";
 const header = document.createElement("h1"); header.textContent = language === "en" ? "Account & membership" : "账号与会员";
 header.style.cssText = "font-size:17px;padding:16px;margin:0;border-bottom:1px solid var(--background-modifier-border)";
 const shell = { hasPage: () => false, async push(page) { host.replaceChildren(header, page.content); return true; } };
 await new IPhoneAccountPages({ document, shell, host: { accountService: adapter, settings: () => ({ settingsLanguage: language }) }, error: console.error }).open();
} else {
 mountDesktopAccountMembership(host, { app: new App(), viewModel: model, actions: { verify: async () => {} }, language, openProviders() {}, syncUsage });
 if (max) host.querySelector('[data-series="max"]')?.click();
}
document.documentElement.dataset.previewReady = "true";
`;
const built = await esbuild.build({
  absWorkingDir: root, stdin: { contents: entry, resolveDir: root, loader: "ts" },
  bundle: true, write: false, platform: "browser", format: "esm", target: "es2022",
  define: { "process.env.NODE_ENV": '"production"' },
  loader: { ".svg": "dataurl", ".webp": "dataurl", ".md": "text" },
  plugins: [{ name: "synthetic-obsidian-host", setup(build) {
    build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "host", namespace: "synthetic" }));
    build.onLoad({ filter: /.*/, namespace: "synthetic" }, () => ({ contents: shim, resolveDir: root, loader: "ts" }));
  } }], logLevel: "silent"
});
const fixtureCss = `
:root { --font-interface:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--font-text-size:16px;
--background-primary:#fff;--background-secondary:#f6f6f6;--background-modifier-border:#e5e5e5;--background-modifier-hover:#eee;
--text-normal:#252525;--text-muted:#777;--text-faint:#999;--text-accent:#252525;--text-on-accent:#fff;--interactive-accent:#252525;
--bg:#fff;--soft:#f6f6f6;--text:#252525;--secondary:#666;--muted:#888;--line:#e5e5e5;--accent:#252525;--accent-bg:#ededed;
--font-ui-small:13px;--font-ui-smaller:12px;--font-ui-medium:14px;--input-height:32px;--radius-s:4px;--radius-m:8px; }
*{box-sizing:border-box}body{margin:0;background:var(--background-primary);color:var(--text-normal);font-family:var(--font-interface)}
button,input,select{font:inherit}button{color:inherit}button:disabled{opacity:.45}h1,h2,h3,p{margin-top:0}svg{width:16px;height:16px;flex-shrink:0}
#fixture-note{padding:12px 20px;color:#777;font-size:12px;border-bottom:1px dashed #ddd}
#content{max-width:1080px;margin:24px auto;padding:0 24px;container:settings / inline-size}
#content.echoink-iphone{max-width:430px;margin:0 auto;padding:0;height:auto;overflow:visible}
#content.echoink-iphone .ip-settings{overflow:visible}.setting-item{display:flex;align-items:center;justify-content:space-between}
[hidden]{display:none!important}
`;
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EchoInk 按天计费 · 合成组件预览</title><link rel="stylesheet" href="/product.css"><link rel="stylesheet" href="/iphone.css"><style>${fixtureCss}</style><body class="theme-light"><aside id="fixture-note">合成账号 · 当前工作树真实组件 · 宿主模拟 · 无账号请求／Vault 读写</aside><main id="content" class="codex-settings-body echoink-settings-aligned"></main><script src="/icons.js"></script><script type="module" src="/preview.js"></script></body></html>`;
const assets = new Map([
  ["/", ["text/html; charset=utf-8", html]], ["/preview.js", ["text/javascript", built.outputFiles[0].contents]],
  ["/product.css", ["text/css", await fs.readFile(path.join(root, "styles.css"))]],
  ["/iphone.css", ["text/css", await fs.readFile(path.join(root, "src/ui/iphone/shell.css"))]],
  ["/icons.js", ["text/javascript", await fs.readFile(process.env.ECHOINK_LUCIDE_JS)]]
]);
const server = http.createServer((request, response) => {
  const asset = assets.get(new URL(request.url, "http://127.0.0.1").pathname);
  if (request.method !== "GET" || !asset) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { "Content-Type": asset[0], "Cache-Control": "no-store" }); response.end(asset[1]);
});
server.listen(port, "127.0.0.1", () => console.log(`Synthetic account component preview: http://127.0.0.1:${port}/?device=desktop`));
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));
