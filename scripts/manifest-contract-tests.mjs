import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateManifestSource } from "./manifest-contract.mjs";

export function runManifestContractTests() {
  const valid = { id: "echoink-example", name: "EchoInk Agent", version: "2.7.0", minAppVersion: "1.11.4",
    description: "A personal knowledge agent that helps you manage your notes.", author: "Example Author", isDesktopOnly: false };
  let probes = 0;
  const accept = (label, value) => { assert.deepEqual(validateManifestSource(JSON.stringify(value)), [], label); probes++; };
  const rejectSource = (label, source, pattern) => {
    const errors = validateManifestSource(source);
    assert.ok(errors.length > 0, `${label} must be rejected`);
    if (pattern) assert.match(errors.join("\n"), pattern, label);
    probes++;
  };
  const reject = (label, value, pattern) => rejectSource(label, JSON.stringify(value), pattern);
  accept("required fields", valid);
  accept("author URL and single support URL", { ...valid, authorUrl: "https://example.com", fundingUrl: "https://github.com/sponsors/example" });
  accept("multiple support URLs", { ...valid, fundingUrl: { Sponsor: "https://github.com/sponsors/example", Support: "https://buymeacoffee.com/example" } });
  accept("allowed name punctuation", { ...valid, name: "EchoInk + Notes (Mobile)-Beta" });
  for (const [key, value] of Object.entries(valid)) {
    const missing = { ...valid }; delete missing[key];
    reject(`missing ${key}`, missing, new RegExp(`missing ${key}`));
    reject(`wrong type ${key}`, { ...valid, [key]: typeof value === "string" ? 123 : "false" }, new RegExp(`${key} must be a`));
    if (typeof value === "string") reject(`empty ${key}`, { ...valid, [key]: "   " }, new RegExp(`${key} must not be empty`));
  }
  for (const key of ["main", "dir", "__proto__", "constructor"]) reject(`unknown ${key}`, { ...valid, [key]: "unexpected" }, /is not allowed/u);
  for (const value of [null, [], true, 123, "manifest"]) reject("non-object root", value, /single JSON object/u);
  for (const source of ['{"id":}', '{"id":"example",}', "{id: 'example'}", "// comment\n{}", "{} {}"])
    rejectSource("invalid JSON syntax", source, /strict JSON/u);
  const json = JSON.stringify(valid);
  rejectSource("duplicate author", json.replace('"author":', '"author":"Other","author":'), /DUPLICATE_KEY/u);
  rejectSource("escaped duplicate author", json.replace('"author":', '"auth\\u006fr":"Other","author":'), /DUPLICATE_KEY/u);
  rejectSource("nested duplicate funding key", json.slice(0, -1) + ',"fundingUrl":{"Support":"https://example.com","Support":"https://example.org"}}', /DUPLICATE_KEY/u);
  for (const id of ["EchoInk", "echoink_plugin", "echoink2", "-echoink", "echoink-", "echoink--notes", "obsidian-notes", "echoink-plugin"])
    reject(`invalid id ${id}`, { ...valid, id }, /manifest id/u);
  for (const key of ["version", "minAppVersion"]) for (const version of ["v2.7.0", "2.7", "02.7.0", "2.7.0-beta.1", "2.7.0+build"])
    reject(`invalid ${key} ${version}`, { ...valid, [key]: version }, /SemVer/u);
  for (const name of ["EchoInk!", "EchoInk ✨", "墨迹", "Obsidian Notes", "Notes Plugin", "Obsi-Notes", "Notes-sidian", "Bases", "Live Preview"])
    reject(`invalid name ${name}`, { ...valid, name }, /manifest name/u);
  for (const description of ["Short.", "A".repeat(250) + ".", "a lowercase sentence.", "A sentence with no ending", "A sentence with an emoji ✨.", "A plugin for notes."])
    reject("invalid description", { ...valid, description }, /manifest description/u);
  reject("desktop-only EchoInk", { ...valid, isDesktopOnly: true }, /must allow mobile/u);
  for (const authorUrl of [123, null, {}, [], "", "not-a-url", "javascript:alert(1)"])
    reject("invalid author URL", { ...valid, authorUrl }, /authorUrl/u);
  for (const fundingUrl of [123, null, [], {}, "", "not-a-url", { Support: 123 }, { Support: "" }, { "": "https://example.com" }])
    reject("invalid support URL", { ...valid, fundingUrl }, /fundingUrl/u);
  return probes;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Manifest contract probes passed (${runManifestContractTests()} cases).`);
}
