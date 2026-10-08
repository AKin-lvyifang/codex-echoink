import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "assets/finance-brands");
const manifest = JSON.parse(readFileSync(join(source, "sources.json"), "utf8"));
if (manifest.schemaVersion !== 1 || manifest.count !== manifest.assets.length) throw new Error("Invalid finance brand manifest");
const ids = new Set();
const assets = manifest.assets.map((item) => {
  if (ids.has(item.id) || !/^[a-z0-9-]+$/u.test(item.id) || !/^svg\/[a-z0-9-]+\.svg$/u.test(item.file)) throw new Error("Invalid brand id or path");
  ids.add(item.id);
  let svg = readFileSync(join(source, item.file), "utf8").trim();
  if (!/<svg\b[^>]*viewBox=/u.test(svg) || /<script\b|<image\b|<foreignObject\b|@import|(?:href|src)\s*=\s*["'](?:https?:|data:)|url\(/iu.test(svg)) throw new Error("Unsupported SVG: " + item.id);
  if (item.rendering === "monochrome-brand-color") {
    if (!/^#[0-9a-f]{6}$/iu.test(item.brandHex)) throw new Error("Missing brand color: " + item.id);
    svg = svg.replace("<svg ", '<svg fill="' + item.brandHex + '" ');
  }
  return {
    id: item.id,
    displayName: item.displayName,
    aliases: item.aliases,
    group: ({ "餐饮": "餐饮与购物", "购物": "餐饮与购物", "交通出行": "出行与住宿", "旅行住宿": "出行与住宿" })[item.group] || item.group,
    dataUri: "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64"),
    lightBackdrop: ["nike", "adidas", "zara", "starbucks", "ikea", "carrefour", "chinaeasternairlines", "bookingdotcom"].includes(item.id)
  };
});
const output = 'import type { FinanceBrandAsset } from "./finance-brand-assets";\n\n'
  + "/** Generated from assets/finance-brands/sources.json; do not edit by hand. */\n"
  + "export const FINANCE_BRAND_SUPPLEMENT: readonly FinanceBrandAsset[] = "
  + JSON.stringify(assets, null, 2) + ";\n";
writeFileSync(join(root, "src/lifestyle/finance-brand-supplement.ts"), output);
console.log("Built " + assets.length + " finance brand SVG assets");
