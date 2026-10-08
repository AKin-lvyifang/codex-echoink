import * as assert from "node:assert/strict";
import { BUILTIN_SKILLS } from "../harness/resources/builtin-skills";
import { disposeOriginControls } from "../settings/origin-controls";
import type { EchoInkResource } from "../resources/types";
import { fixture, prepareDocument } from "./settings-search-dom";
import { paidTestAccess } from "./membership-access";
import { renderKnowledgeCommandMatches } from "../ui/codex-view/menus";
import { resourcePresentation } from "../resources/resource-presentation";

/** Exercise real settings rows and their DOM search index without opening a Vault. */
export async function runResourcePresentationDomTests(win: Window & typeof globalThis) {
  const scheduler = prepareDocument(win);
  globalThis.ResizeObserver = win.ResizeObserver;
  globalThis.requestAnimationFrame = win.requestAnimationFrame;
  globalThis.cancelAnimationFrame = win.cancelAnimationFrame;
  const snapshots: Record<string, string> = {};
  const f = fixture(win, "zh-CN");
  Object.assign(f.plugin, { accountService: paidTestAccess });
  const resources: EchoInkResource[] = BUILTIN_SKILLS.map((skill) => ({
    id: `echoink-local:skill:${skill.id}`, kind: "skill", source: "echoink-local",
    name: skill.id, description: skill.description, enabled: true, bridgeMode: "prompt-only",
    contentPath: `.echoink/resources/skills/${skill.id}/SKILL.md`,
    metadata: { resourceId: skill.id, builtin: true, fileStatus: "ready" }
  }));
  f.plugin.settings.settingsTab = "resources";
  f.plugin.settings.resources.catalog = resources;
  f.state.runtimeEchoInkResources = resources;
  f.state.loadWorkspaceResources = async () => undefined;
  f.state.loadBuiltinSkillEditor = () => undefined;
  const unchanged = JSON.stringify(resources);
  const render = () => {
    disposeOriginControls(f.tab.containerEl);
    f.tab.containerEl.empty();
    f.state.renderWorkspaceResourceManager(f.tab.containerEl);
    return f.tab.containerEl.querySelector<HTMLElement>(".codex-resource-body")!;
  };
  const filter = (query: string) => {
    const search = f.tab.containerEl.querySelector<HTMLInputElement>(".codex-resource-search-input")!;
    search.value = query;
    search.dispatchEvent(new win.Event("input", { bubbles: true }));
    f.state.clearResourceSearchDebounceTimer();
    f.state.applyResourceSearchFilter(f.plugin.settings.resourceManagementTab);
    return [...f.tab.containerEl.querySelectorAll<HTMLElement>(".codex-resource-row:not(.is-search-hidden)")];
  };
  try {
    for (const language of ["zh-CN", "en"] as const) {
      f.plugin.settings.settingsLanguage = language;
      f.plugin.settings.resourceManagementTab = "skills";
      f.state.resourceSearchQuery.skills = "";
      const body = render();
      assert.equal(body.querySelectorAll(".codex-resource-row").length, 16);
      const review = body.querySelector('[data-resource-key="echoink-local:skill:knowledge-review"]')!;
      assert.equal(review.querySelector(".codex-resource-row-name")?.textContent, language === "en" ? "Knowledge Review" : "知识复盘");
      assert.equal(body.querySelector('[data-resource-key="echoink-local:skill:obsidian-markdown"] .codex-resource-row-name')?.textContent, "Obsidian Markdown");
      if (language === "en") assert.doesNotMatch(review.querySelector(".codex-resource-row-desc")?.textContent ?? "", /[\u4e00-\u9fff]/u);
      snapshots[`${language}-skills`] = f.tab.containerEl.innerHTML;
      const input = win.document.createElement("textarea");
      input.value = "/知识";
      const menu = win.document.createElement("div");
      menu.id = "resource-name-slash-menu";
      win.document.body.append(input, menu);
      const selected: EchoInkResource[] = [];
      renderKnowledgeCommandMatches(menu, input, "知识复盘", { language, skills: resources, selectedSkill: null }, {
        onFillCommand: () => assert.fail("Skill selection must not execute a knowledge command"),
        onSelectSkill: skill => selected.push(skill)
      });
      assert.equal(menu.querySelector(".codex-command-text")?.textContent, language === "en" ? "Knowledge Review" : "知识复盘");
      menu.querySelector<HTMLButtonElement>(".codex-command-skill")!.click();
      assert.equal(selected[0], resources.find(item => item.name === "knowledge-review"), "slash choice returns the original resource used by runtime");
      assert.equal(input.value, "/知识", "rendering never changes the draft");
      input.remove(); menu.remove();
      for (const query of ["知识复盘", "Knowledge Review", "knowledge-review"]) {
        assert.deepEqual(filter(query).map(row => row.dataset.resourceKey), ["echoink-local:skill:knowledge-review"], `${language}: live search ${query}`);
      }
      f.state.resourceSearchQuery.skills = "双层说明";
      assert.equal(render().querySelector(".codex-resource-row:not(.is-search-hidden)")?.getAttribute("data-resource-key"), "echoink-local:skill:two-layer-explanation", "initial render and live search use the same aliases");
      f.state.resourceSearchQuery.skills = "";
      const detail = win.document.createElement("div");
      f.state.renderResourceDetail(detail, resources.find(item => item.name === "knowledge-review")!);
      assert.match(detail.textContent ?? "", language === "en" ? /Knowledge Review/u : /知识复盘/u);
      assert.match(detail.textContent ?? "", /knowledge-review\/SKILL\.md/u, "file path remains the stable original");
      disposeOriginControls(detail);

      f.plugin.settings.resourceManagementTab = "plugins";
      f.state.resourceSearchQuery.plugins = "";
      const plugins = render();
      assert.equal(plugins.querySelector('[data-resource-key="builtin-plugin:finance"] .codex-resource-row-name')?.textContent, language === "en" ? "Finance" : "财务");
      assert.equal(plugins.querySelector('[data-resource-key="echoink:english-diary"] .codex-resource-row-name')?.textContent, language === "en" ? "English Diary" : "英文日记");
      snapshots[`${language}-plugins`] = f.tab.containerEl.innerHTML;
      for (const query of ["财务", "Finance"]) assert.deepEqual(filter(query).map(row => row.dataset.resourceKey), ["builtin-plugin:finance"]);
      for (const query of ["英文日记", "English Diary"]) assert.deepEqual(filter(query).map(row => row.dataset.resourceKey), ["echoink:english-diary"]);
      console.log(`PASS ${language}: 16 Skill names, description, Obsidian name, initial/live bilingual search, detail and plugin rows`);
    }
    assert.equal(JSON.stringify(resources), unchanged, "language and search do not mutate IDs, names, descriptions, settings or paths");
    const original = resources[0];
    const custom = { ...original, source: "manual" as const, name: "My own skill" };
    assert.equal(resourcePresentation(custom, "zh-CN").name, custom.name, "same id with manual origin is not a builtin");
    assert.equal(resourcePresentation({ ...original, kind: "mcp-server" }, "zh-CN").name, original.name, "MCP names stay user owned");
    assert.equal(resourcePresentation({ ...original, description: "我的自定义说明" }, "en").description, "我的自定义说明");
    assert.equal(f.saved.length, 0, "presentation and filtering never save resource content");
    return snapshots;
  } finally {
    f.tab.hide();
    f.registrations.forEach(cleanup => cleanup());
    f.tab.containerEl.remove();
    await scheduler.flush();
  }
}
