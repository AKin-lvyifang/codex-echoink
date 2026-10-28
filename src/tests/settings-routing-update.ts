import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Platform } from "obsidian";
import { DESKTOP_SETTINGS_TABS, normalizeDesktopSettingsRoute, resolveDesktopSettingsRoute, resolveDesktopSettingsSearchRoute } from "../settings/desktop-settings-route";
import { desktopSettingsCategoryDefinitions } from "../settings/settings-search";
import { compareReleaseVersions, ReleaseUpdateController } from "../settings/release-update";
import { renderCompactAbout } from "../settings/about-section";
import { disposeOriginControls } from "../settings/origin-controls";
import { installProviderBrowserHost } from "./provider-discovery-dom-host";

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
for (const [query, focus] of [["生成模板", "knowledge:generation-templates"], ["Generation templates", "knowledge:generation-templates"],
  ["收藏保存位置", "knowledge:collections"], ["Agent 权限与维护", "knowledge:permissions"], ["目录管理", "knowledge:management"], ["PDF 精读", "pdf-reading:settings"]]) {
  assert.deepEqual(resolveDesktopSettingsSearchRoute("modules", query), { tab: "modules", focus });
}
console.log("PASS module search targets the template list, knowledge details and PDF form");
const moduleDefinition = desktopSettingsCategoryDefinitions("zh-CN", () => () => {})[0].items.find(item => item.name === "模块")!;
for (const alias of ["生成模板", "Generation templates", "收藏保存位置", "Agent 权限与维护", "目录管理"]) assert.ok(moduleDefinition.aliases?.includes(alias), `native search indexes ${alias}`);


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

export async function runCompactAboutTests(repo: string): Promise<void> {
  installProviderBrowserHost();
  const previousDesktop = Platform.isDesktopApp;
  const owner = window as Window & { require?: (name: string) => unknown };
  const previousRequire = owner.require;
  const opened: string[] = [];
  Platform.isDesktopApp = true;
  owner.require = name => {
    assert.equal(name, "electron");
    return { shell: { openExternal: async (url: string) => { opened.push(url); } } };
  };
  const source = await readFile(path.join(repo, "src/settings/about-section.ts"), "utf8");
  const originalGitHubPath = source.match(/"(M12 2C6\.477[^"\n]+)"/u)?.[1];
  assert.ok(originalGitHubPath, "the existing About SVG remains the GitHub reference");
  const tick = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
  try {
    for (const language of ["zh-CN", "en"]) {
      const parent = document.body.createDiv();
      let checks = 0, release!: (value: unknown) => void;
      const update = new ReleaseUpdateController(() => { checks++; return new Promise(resolve => { release = resolve; }); });
      const logos: boolean[] = [];
      const cleanup = renderCompactAbout(parent, { version: "2.7.0", language, websiteUrl: "https://echoink.cn/?entry=plugin.about", update, onLogoClick: alt => { logos.push(alt); } });
      try {
        const actions = parent.querySelector<HTMLElement>(".echoink-about-compact-actions")!;
        const buttons = Array.from(actions.querySelectorAll<HTMLButtonElement>("button"));
        const icons = buttons.slice(0, 3), check = buttons[3];
        const labels = language === "zh-CN" ? ["访问官网", "Star on GitHub", "反馈问题"] : ["Visit website", "Star on GitHub", "Report an issue"];
        assert.equal(buttons.length, 4);
        assert.deepEqual(icons.map(button => button.getAttribute("aria-label")), labels);
        assert.deepEqual(icons.map(button => button.dataset.testTooltip), labels, "host tooltips match the accessible names");
        assert.equal(actions.querySelectorAll(".is-primary").length, 1); assert.equal(check.classList.contains("is-primary"), true);
        assert.equal(actions.lastElementChild, check, "check update remains the only primary action at the end");
        assert.equal(checks, 0, "rendering the real component never starts an update request");
        for (const button of icons) {
          assert.equal(button.textContent, "", "external actions remain icon-only");
          assert.ok(button.querySelector('[aria-hidden="true"]'));
          button.focus(); assert.equal(document.activeElement, button);
        }
        const iconNames = (button: HTMLElement) => Array.from(button.querySelectorAll<HTMLElement>("[data-test-icon]")).map(icon => icon.dataset.testIcon);
        assert.deepEqual(iconNames(icons[0]), ["globe", "send"], "the website goes directly from globe to send without a link layer");
        assert.deepEqual(iconNames(icons[1]), ["star", "star", "star"]);
        assert.equal(icons[1].querySelector(".echoink-sparkle-icon-default path")?.getAttribute("d"), originalGitHubPath);
        assert.equal(icons[1].querySelectorAll(".echoink-sparkle-particle").length, 2);
        assert.deepEqual(iconNames(icons[2]), ["message-circle", "check"]);
        const start = opened.length;
        icons.forEach(button => button.click()); await tick();
        assert.deepEqual(opened.slice(start), ["https://echoink.cn/?entry=plugin.about", "https://github.com/AKin-lvyifang/codex-echoink", "https://github.com/AKin-lvyifang/codex-echoink/issues"], "real external callbacks retain the existing destinations");
        const logo = parent.querySelector<HTMLButtonElement>(".echoink-about-compact-icon")!;
        logo.click(); logo.dispatchEvent(new MouseEvent("click", { bubbles: true, altKey: true }));
        assert.deepEqual(logos, [false, true], "the existing hidden logo action retains Alt state");
        check.click(); check.click(); await tick();
        assert.equal(checks, 1); assert.equal(check.disabled, true); assert.equal(check.getAttribute("aria-busy"), "true");
        release({ tag_name: "v2.8.0", html_url: "https://github.com/AKin-lvyifang/codex-echoink/releases/tag/v2.8.0" });
        await tick();
        assert.equal(check.disabled, false);
        const status = parent.querySelector<HTMLElement>(".echoink-about-compact-status")!;
        assert.equal(status.hidden, false); assert.match(status.textContent ?? "", /v2\.8\.0/u);
        const link = status.querySelector<HTMLAnchorElement>("a")!; link.click(); await tick();
        assert.equal(opened.at(-1), "https://github.com/AKin-lvyifang/codex-echoink/releases/tag/v2.8.0");
        cleanup(); const priorStatus = status.textContent;
        const late = update.check("2.8.0"); await tick(); release({ tag_name: "v2.8.0" }); await late;
        assert.equal(status.textContent, priorStatus, "unsubscribed views are not changed by later checks");
      } finally { cleanup(); disposeOriginControls(parent); parent.remove(); }
    }
  } finally { Platform.isDesktopApp = previousDesktop; owner.require = previousRequire; }
  console.log("PASS compact About real Origin controls: icon pairs, original GitHub path, labels/tooltips, external callbacks, hidden logo, single update action and cleanup");
}
