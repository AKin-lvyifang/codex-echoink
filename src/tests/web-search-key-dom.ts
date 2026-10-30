import assert from "node:assert/strict";
import { renderTavilySettings } from "../settings/tavily-settings";
import { disposeOriginControls } from "../settings/origin-controls";
import { IPhoneCapabilityPages } from "../ui/iphone/capability-pages";
import { createCapabilityPage } from "../ui/ipad/capability-pages";
import { createApiProviderConfig } from "../settings/settings";
import { loadMobileSettings } from "../mobile/settings";
import { normalizeWebSearchSettings, webSearchApiKey, type WebSearchSettings, type searchWeb } from "../tools/web-search";
import type { MobileShellPage } from "../ui/mobile/shell-types";
import { installObsidianDom } from "./obsidian-dom";

export async function runWebSearchKeyDomTests(win: Window & typeof globalThis): Promise<void> {
  installObsidianDom(win);
  function create(this: HTMLElement, tag: string, options: any = {}) {
    const element = this.ownerDocument.createElement(tag);
    if (options.cls) element.className = options.cls;
    if (options.text !== undefined) element.textContent = options.text;
    if (options.href) element.setAttribute("href", options.href);
    for (const [name, value] of Object.entries(options.attr ?? {})) element.setAttribute(name, String(value));
    this.append(element); return element;
  }
  Object.assign(win.Element.prototype, {
    empty() { this.replaceChildren(); }, addClass(...tokens: string[]) { this.classList.add(...tokens); },
    setAttr(name: string, value: string) { this.setAttribute(name, value); }, createEl: create,
    createDiv(options: unknown) { return create.call(this, "div", options); }, createSpan(options: unknown) { return create.call(this, "span", options); }
  });
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) as any;
  const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
  const visible = (node: Element | null): node is HTMLElement => !!node && !node.closest("[hidden]");
  const button = (root: HTMLElement, text: string) => [...root.querySelectorAll<HTMLButtonElement>("button")].find(node => visible(node) && (node.textContent?.trim() === text || node.querySelector(".ip-settings-name,.pd-settings-name")?.textContent === text));
  const modelKey = "synthetic-dom-model-key", legacyKey = "synthetic-dom-legacy-key";
  const model = { ...createApiProviderConfig("deepseek", "fixture-deepseek"), apiKey: modelKey };
  for (const language of ["zh-CN", "en"]) {
    const english = language === "en", testLabel = english ? "Test connection" : "测试连接", readyText = english ? "Using the DeepSeek key from Models" : "使用模型里的 DeepSeek Key", missingText = english ? "Add DeepSeek in Models first" : "先在模型里添加 DeepSeek";
    for (const scenario of ["model", "missing", "legacy", "custom"] as const) {
      const providers = scenario === "model" ? [model] : scenario === "custom" ? [{ ...model, providerId: "custom" as const, name: "DeepSeek" }] : [];
      const searchSettings: WebSearchSettings = { enabled: true, provider: "deepseek", apiKey: "", deepseekApiKey: scenario === "legacy" || scenario === "model" ? legacyKey : "" };
      for (const platform of ["desktop", "iphone", "ipad"] as const) {
        const root = win.document.createElement("div"); root.className = "echoink-settings-aligned"; win.document.body.append(root);
        const settings = loadMobileSettings({ tavily: structuredClone(searchSettings), apiProviders: structuredClone(providers), settingsLanguage: language });
        const pages: MobileShellPage[] = [], failures: unknown[] = []; let calls = 0, opened = "";
        const service = {
          listSkills: async () => [], listMcp: async () => [], readTavily: () => ({ ...normalizeWebSearchSettings(settings.tavily), version: "fixture" }),
          testTavily: async (draft: WebSearchSettings) => { calls++; assert.equal(webSearchApiKey(draft, settings.apiProviders), scenario === "model" ? modelKey : legacyKey); return { results: [] }; }
        };
        const push = async (page: MobileShellPage) => { pages.push(page); root.replaceChildren(page.content); if (page.footer) root.append(page.footer); return true; };
        let dispose = () => {};
        if (platform === "desktop") {
          const search: typeof searchWeb = async (draft, _input, currentProviders) => { calls++; assert.equal(webSearchApiKey(draft, currentProviders), scenario === "model" ? modelKey : legacyKey); return { source: "web", provider: "DeepSeek", results: [] }; };
          renderTavilySettings(root, { settings, saveSettings: async () => {} }, search, () => { opened = "model"; });
          dispose = () => disposeOriginControls(root);
        } else if (platform === "iphone") {
          const shell = { hasPage: () => false, push, backTo: async (id: string) => { opened = id; }, back: async () => true };
          const ctx = { document: win.document, host: { settings: () => settings, services: { capabilities: service } }, shell, error: (error: unknown) => failures.push(error) } as any;
          const capabilityPages = new IPhoneCapabilityPages(ctx, async () => {});
          await capabilityPages.open(); await flush(); button(root, english ? "Web search" : "联网搜索")!.click(); await flush();
          const actualPush = shell.push; shell.push = async page => { if (page.id === "iphone-settings-model") opened = "model"; return actualPush(page); };
          dispose = () => pages.forEach(page => page.dispose?.());
        } else {
          const ctx = { document: win.document, root, host: { settings: () => settings, services: { capabilities: service } }, shell: { selectCategory: async (id: string) => { opened = id; return true; } }, push, back: async () => true, refresh() {}, error: (error: unknown) => failures.push(error) } as any;
          await push(createCapabilityPage(ctx, async () => {})); await flush(); button(root, english ? "Web search" : "联网搜索")!.click(); await flush();
          dispose = () => pages.forEach(page => page.dispose?.());
        }
        try {
          assert.deepEqual(failures, [], `${platform} mounted without error`);
          const input = root.querySelector<HTMLInputElement>('input[type="password"]')!;
          assert.ok(input, `${platform} contains the existing key control`);
          assert.equal(visible(input), scenario === "legacy", `${platform}: key field visible only for historical independent key`);
          assert.equal(input.value, scenario === "legacy" ? legacyKey : "", `${platform}: model key never copied into the hidden input`);
          const test = button(root, testLabel)!; assert.ok(test, `${platform}: test action exists`);
          assert.equal(test.disabled, scenario === "missing" || scenario === "custom");
          assert.equal(settings.tavily.enabled, true, `${platform}: mounting does not erase the saved enabled state`);
          assert.equal(visible(root.querySelector('a[href="https://platform.deepseek.com/api_keys"]')), scenario !== "model", `${platform}: only the model-key state omits the key acquisition link`);
          assert.ok(visible(root.querySelector('a[href="https://api-docs.deepseek.com/zh-cn/guides/search/"]')), `${platform}: official pricing remains available in every credential state`);
          if (scenario === "model") {
            assert.ok([...root.querySelectorAll("span, div")].some(node => node.textContent === readyText && visible(node)), `${platform}: model-key source is displayed`);
            test.click(); await flush(); assert.equal(calls, 1); assert.equal(settings.tavily.deepseekApiKey, legacyKey);
          } else if (scenario === "legacy") {
            input.value = "edited-synthetic-key"; input.dispatchEvent(new win.Event("input", { bubbles: true }));
            if (platform === "desktop") assert.equal(settings.tavily.deepseekApiKey, "edited-synthetic-key");
            else assert.equal(input.value, "edited-synthetic-key");
          } else {
            if (platform === "desktop") {
              const toggle = root.querySelector<HTMLButtonElement>('[role="switch"]')!;
              toggle.click(); await flush(); toggle.click(); await flush();
              assert.equal(settings.tavily.enabled, false, "missing credentials cannot be newly enabled");
              assert.equal(test.disabled, true, "an unsuccessful enable attempt keeps the test disabled");
            }
            const link = platform === "desktop" ? button(root, english ? "Open Models" : "前往模型") : button(root, missingText);
            assert.ok(link, `${platform}: missing credential has a model-settings link`);
            link.click(); await flush(); assert.equal(opened, "model", `${platform}: model navigation works`);
          }
          assert.deepEqual(failures, [], `${platform} actions completed without error`);
        } finally { dispose(); root.remove(); }
      }
    }
  }
  console.log("PASS web-search credential DOM: desktop/iPhone/iPad, Chinese/English, model key hidden input + actual test, missing/custom model navigation, historical key editing and enabled preservation (synthetic settings only).");
}
