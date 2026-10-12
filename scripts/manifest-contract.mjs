import { parseDocument } from "yaml";

// https://docs.obsidian.md/Reference/Manifest
// Keep this independent of the ESLint JSON AST adapter; retain the official rule too.
const requiredTypes = {
  id: "string", name: "string", version: "string", minAppVersion: "string",
  description: "string", author: "string", isDesktopOnly: "boolean"
};
const optionalKeys = ["authorUrl", "fundingUrl"];
const allowedKeys = new Set([...Object.keys(requiredTypes), ...optionalKeys]);
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);

/** Return all contract failures, or [] for an accepted manifest source. */
export function validateManifestSource(source) {
  if (typeof source !== "string") return ["manifest.json source must be a string."];
  let value;
  try { value = JSON.parse(source); }
  catch { return ["manifest.json must use strict JSON syntax."]; }

  // JSON.parse accepts duplicate keys. The existing YAML parser checks them,
  // including escaped spellings and nested funding keys, only after strict JSON.
  const document = parseDocument(source, { schema: "json", uniqueKeys: true, prettyErrors: false });
  const errors = [...document.errors, ...document.warnings].map(issue => `manifest.json ${issue.code}: ${issue.message}`);
  if (!isRecord(value)) return [...errors, "manifest.json must be a single JSON object."];
  const check = (condition, message) => { if (!condition) errors.push(message); };
  for (const [key, type] of Object.entries(requiredTypes)) {
    check(Object.hasOwn(value, key), `manifest.json is missing ${key}.`);
    if (Object.hasOwn(value, key)) check(typeof value[key] === type, `manifest ${key} must be a ${type}.`);
    if (typeof value[key] === "string") check(value[key].trim().length > 0, `manifest ${key} must not be empty.`);
  }
  for (const key of Object.keys(value)) check(allowedKeys.has(key), `manifest field ${key} is not allowed.`);
  if (typeof value.id === "string") {
    check(/^[a-z]+(?:-[a-z]+)*$/u.test(value.id), "manifest id must use lowercase hyphenated words.");
    check(!value.id.includes("obsidian") && !value.id.endsWith("plugin"), "manifest id must not contain obsidian or end with plugin.");
  }
  for (const key of ["version", "minAppVersion"]) {
    if (typeof value[key] === "string") check(semver.test(value[key]), `manifest ${key} must use x.y.z SemVer.`);
  }
  if (typeof value.name === "string") {
    check(/^[A-Za-z0-9 +()-]+$/u.test(value.name), "manifest name must use Basic Latin letters, numbers, spaces, hyphens, plus signs or parentheses.");
    check(!/obsidian|plugin|obsi-|-sidian/iu.test(value.name), "manifest name must not contain Obsidian, Plugin or Obsidian name variations.");
    check(!/^(?:bases|live preview)$/iu.test(value.name.trim()), "manifest name must not use an Obsidian core feature name on its own.");
  }
  if (typeof value.description === "string") {
    // The official validate-manifest rule's deterministic description checks.
    check(value.description.length >= 10 && value.description.length <= 250
      && /^[A-Z]/u.test(value.description) && value.description.endsWith(".")
      && /^[A-Za-z0-9\s.,!?'"-]+$/u.test(value.description),
    "manifest description must be 10-250 characters, start with a capital letter, end with a period and contain no emoji or special characters.");
    check(!/obsidian|plugin/iu.test(value.description), "manifest description must not contain Obsidian or Plugin.");
  }
  if (Object.hasOwn(value, "authorUrl")) check(isWebUrl(value.authorUrl), "manifest authorUrl must be an HTTP(S) website URL string.");
  if (Object.hasOwn(value, "fundingUrl")) {
    const funding = value.fundingUrl;
    if (typeof funding === "string") check(isWebUrl(funding), "manifest fundingUrl must be an HTTP(S) support URL.");
    else if (isRecord(funding)) {
      check(Object.keys(funding).length > 0, "manifest fundingUrl must not be an empty object.");
      for (const [label, url] of Object.entries(funding)) {
        check(label.trim().length > 0, "manifest fundingUrl labels must not be empty.");
        check(isWebUrl(url), `manifest fundingUrl.${label} must be an HTTP(S) support URL string.`);
      }
    } else check(false, "manifest fundingUrl must be a URL string or an object of URL strings.");
  }
  // EchoInk's approved release contract is mobile-capable, beyond the schema's boolean type.
  check(value.isDesktopOnly === false, "manifest must allow mobile with EchoInk's isolated platform entries.");
  return errors;
}

function isWebUrl(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !!url.hostname; }
  catch { return false; }
}
