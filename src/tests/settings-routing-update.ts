import assert from "node:assert/strict";
import { DESKTOP_SETTINGS_TABS, normalizeDesktopSettingsRoute, resolveDesktopSettingsRoute } from "../settings/desktop-settings-route";
import { compareReleaseVersions, ReleaseUpdateController } from "../settings/release-update";

assert.deepEqual(DESKTOP_SETTINGS_TABS, ["general", "models", "agent", "capabilities", "modules", "account"]);
for (const [legacy, options, expected] of [
  ["agents", {}, { tab: "models" }],
  ["providers", {}, { tab: "models" }],
  ["providers", { focus: "providers/tools" }, { tab: "capabilities", capabilityTab: "tools", focus: "providers/tools" }],
  ["layout", {}, { tab: "general" }],
  ["resources", { resourceTab: "plugins" }, { tab: "modules" }],
  ["resources", { resourceTab: "mcp", resourceId: "service-1" }, { tab: "capabilities", capabilityTab: "mcp", resourceId: "service-1" }],
  ["resources", { resourceTab: "skills" }, { tab: "capabilities", capabilityTab: "skills" }],
  ["knowledgeBase", { focus: "knowledge:preferences:editor" }, { tab: "modules", section: "knowledgeBase", focus: "knowledge:preferences:editor" }],
  ["todos", {}, { tab: "modules", section: "todos" }],
  ["review", {}, { tab: "modules", section: "review" }],
  ["review", { focus: "review-archives" }, { tab: "agent", focus: "review-archives" }],
  ["general", { focus: "general:memory" }, { tab: "agent", focus: "general:memory" }],
  ["general", { focus: "general:journal" }, { tab: "modules", section: "journal", focus: "general:journal" }],
  ["agent", {}, { tab: "agent" }],
  ["account", {}, { tab: "account" }]
] as const) assert.deepEqual(resolveDesktopSettingsRoute(legacy, options), expected);
console.log("PASS desktop routes preserve legacy aliases, resource identity and focus");
assert.deepEqual(normalizeDesktopSettingsRoute({ tab: "capabilities" }, "plugins"), { tab: "capabilities", capabilityTab: "skills" });
assert.deepEqual(normalizeDesktopSettingsRoute({ tab: "capabilities" }, "mcp"), { tab: "capabilities", capabilityTab: "mcp" });
assert.deepEqual(normalizeDesktopSettingsRoute({ tab: "capabilities" }, "plugins", "tools"), { tab: "capabilities", capabilityTab: "tools" });
assert.deepEqual(normalizeDesktopSettingsRoute({ tab: "capabilities", capabilityTab: "mcp" }, "plugins", "tools"), { tab: "capabilities", capabilityTab: "mcp" });
assert.deepEqual(normalizeDesktopSettingsRoute({ tab: "modules" }, "plugins", "skills"), { tab: "modules" });
console.log("PASS capability routes normalize explicit, remembered and initial selections before rendering");


for (const [a, b, expected] of [["v2.10.0", "2.9.0", 1], ["2.7.0", "v2.7.0", 0], ["2.7.0-beta.2", "2.7.0-beta.10", -1], ["2.7.0", "2.7.0-rc.1", 1], ["2.7.0-alpha", "2.7.0-beta", -1], ["2.6.9", "2.7.0", -1]] as const) {
  assert.equal(compareReleaseVersions(a, b), expected);
}
assert.throws(() => compareReleaseVersions("unknown", "2.7.0"));
let calls = 0;
let finish!: (data: unknown) => void;
const controller = new ReleaseUpdateController(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
assert.equal(calls, 0, "mounting the controller never requests an update");
let observations = 0;
const unsubscribe = controller.subscribe(() => { observations++; });
const first = controller.check("2.7.0");
const repeated = controller.check("2.7.0");
assert.equal(first, repeated);
assert.equal(controller.state.status, "checking");
await Promise.resolve(); assert.equal(calls, 1);
finish({ tag_name: "v2.8.0", html_url: "https://github.com/AKin-lvyifang/codex-echoink/releases/tag/v2.8.0" });
await first;
assert.equal(controller.state.status, "available");
assert.equal(observations, 2);
unsubscribe();
const second = controller.check("2.8.0"); await Promise.resolve();
finish({ tag_name: "v2.7.0", html_url: "javascript:alert(1)" }); await second;
assert.equal(controller.state.status, "current");
assert.equal(observations, 2, "closed views are not updated by late responses");
assert.ok("url" in controller.state && controller.state.url.startsWith("https://github.com/"));
let fail = true;
const retry = new ReleaseUpdateController(async () => { if (fail) throw new Error("offline"); return { tag_name: "v2.7.0" }; });
await retry.check("2.7.0"); assert.equal(retry.state.status, "error");
fail = false; await retry.check("2.7.0"); assert.equal(retry.state.status, "current");
await new ReleaseUpdateController(async () => ({ tag_name: "not a version" })).check("2.7.0");
console.log("PASS release check is click-only, single-flight, numeric, safe on failure and retry");
