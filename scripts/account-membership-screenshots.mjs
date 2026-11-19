// Run account-membership-preview.mjs first. No dependency installation or account requests.
// PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs node scripts/account-membership-screenshots.mjs <output-directory> [port]
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

if (!process.env.PLAYWRIGHT_MODULE || !process.argv[2]) throw new Error("Explicit PLAYWRIGHT_MODULE and output directory required");
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const directory = path.resolve(process.argv[2]), port = Number(process.argv[3] || 8786);
await fs.mkdir(directory, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  for (const [name, query, width, height] of [
    ["desktop-pro", "device=desktop", 1440, 1000],
    ["desktop-max", "device=desktop&series=max", 1440, 1000],
    ["iphone", "device=iphone", 390, 844],
    ["iphone-scheduled", "device=iphone&state=scheduled", 390, 844]
  ]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(10000);
    const failures = [];
    page.on("pageerror", error => failures.push(error.message));
    await page.route("**/*", route => new URL(route.request().url()).origin === `http://127.0.0.1:${port}` ? route.continue() : route.abort());
    await page.goto(`http://127.0.0.1:${port}/?${query}`, { waitUntil: "networkidle" });
    await page.locator('html[data-preview-ready="true"]').waitFor();
    assert.deepEqual(failures, [], `${name} has no runtime errors`);
    const content = await page.locator("#content").innerText();
    assert.match(content, /365 天/);
    assert.doesNotMatch(content, /月底清零|每月 3000|Max 年付/);
    if (name === "desktop-max") assert.match(content, /Max 年卡/);
    if (name === "iphone-scheduled") assert.match(content, /将于 2027-01-15 生效/);
    const file = path.join(directory, `plugin-${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log(`${name}: ${file}`);
    await page.close();
  }
} finally { await browser.close(); }
