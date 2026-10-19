import assert from "node:assert/strict";
import { createHost, answer } from "./host.mjs";

/** Exercises the production MobileUI and FinanceCatalogPanel with an in-memory Vault. */
export async function financeSettingsNavigationScenarios(api, test, settings, dom) {
  const { MobileStore, MobileRuntime, MobileServices, MobileUI } = api;
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const button = (root, label) => {
    const target = [...root.querySelectorAll("button")].find(item => item.getAttribute("aria-label") === label
      || item.querySelector(".em-row-label strong")?.textContent === label || item.textContent.trim() === label);
    assert.ok(target, `Missing action: ${label}`);
    return target;
  };
  const click = (root, label) => button(root, label).click();
  const title = root => root.querySelector(".em-header .em-title").textContent;
  const touch = (target, type, x, y, identifier = 1) => {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
    const point = { identifier, clientX: x, clientY: y };
    Object.defineProperties(event, {
      touches: { value: type === "touchend" || type === "touchcancel" ? [] : [point] },
      changedTouches: { value: [point] }
    });
    target.dispatchEvent(event);
    return event;
  };
  const swipe = (target, x = 8, y = 80, endX = 112, endY = y) => {
    touch(target, "touchstart", x, y);
    const move = touch(target, "touchmove", endX, endY);
    touch(target, "touchend", endX, endY);
    return move;
  };
  async function fixture(isTablet = false, width = 390) {
    const host = createHost();
    const store = new MobileStore(host.adapter, "plugin/mobile"); await store.load();
    const config = settings(); config.lifestyle.finance.enabled = true;
    Object.assign(config.lifestyle.finance, {
      merchants: [{ name: "导航测试商户", aliases: [], iconId: "store", defaultCategory: "导航测试分类", active: true }],
      accounts: [{ name: "导航测试账户", aliases: [], active: true }],
      categories: [{ name: "导航测试分类", icon: "coffee", color: "#5c8977", active: true }]
    });
    const runtime = new MobileRuntime(host.app, store, () => config, async () => answer("openai-completions", "ok"));
    const accessListeners = new Set();
    const access = { checkCapability: () => true, requireCapability() {}, subscribe(listener) {
      accessListeners.add(listener); return () => accessListeners.delete(listener);
    } };
    let ui, chatOpens = 0, settingsOpens = 0;
    const services = new MobileServices({ app: host.app, settings: config, store, runtime, accountService: access,
      navigation: {}, registerEvent() {}, saveSettings: async () => {}, showPage: async page => ui.showPage(page) }, "plugin/mobile");
    await services.initialize(); await services.initializeFinance();
    const root = dom.window.document.body.appendChild(dom.window.document.createElement("div"));
    Object.defineProperty(root, "clientWidth", { value: width, configurable: true });
    ui = new MobileUI(root, { app: host.app, services, isTablet, settingsOnly: isTablet, store, runtime,
      settings: () => config, saveSettings: async () => {}, openNote: async () => {}, beginRender() {}, renderMarkdown() {},
      openChat: async () => { chatOpens++; }, openSettings: async () => { settingsOpens++; } });
    ui.mount(); ui.showPage("settings"); ui.showPage("resources");
    return { root, ui, services, accessListeners, runtime, get chatOpens() { return chatOpens; }, get settingsOpens() { return settingsOpens; },
      async dispose() { ui.destroy(); await services.dispose(); await settle(); root.remove(); } };
  }

  for (const [name, isTablet, width] of [["iPhone", false, 390], ["iPad wide", true, 1000], ["iPad narrow split", true, 460]]) {
    await test(`${name}: finance catalog replaces the parent, titles and all return levels restore scroll`, async () => {
      const state = await fixture(isTablet, width), { root, ui } = state;
      const listener = state.runtime.onChange;
      try {
        root.querySelector(".em-body").scrollTop = 91;
        click(root, "财务");
        assert.equal(root.dataset.page, "finance-settings"); assert.equal(title(root), "财务设置");
        for (const [kind, noun] of [["merchants", "商户"], ["accounts", "账户"], ["categories", "分类"]]) {
          const parent = root.querySelector(".em-body"); parent.scrollTop = 163;
          click(root, `管理${noun}`);
          assert.equal(root.dataset.page, `finance-${kind}`); assert.equal(title(root), `管理${noun}`);
          assert.equal(parent.isConnected, false, "The entire finance parent must leave the detail pane");
          assert.ok(!root.querySelector('.em-body [aria-label="启用财务"]'));
          assert.ok(root.querySelector(".em-body .echoink-finance-catalog-page"));
          assert.equal(state.accessListeners.size, 1);
          if (isTablet) {
            assert.equal(root.querySelectorAll(".em-sidebar .em-row").length, 8);
            assert.equal(root.querySelector('.em-sidebar .em-row[aria-current="page"] strong').textContent, "Skills & MCP");
            assert.ok(!root.querySelector(".em-input,.em-navigation"));
          }
          root.querySelector(".em-body").scrollTop = 239;
          click(root, `编辑导航测试${noun}`);
          assert.equal(title(root), `编辑${noun}`);
          assert.ok(root.querySelector(".echoink-finance-catalog-form"));
          assert.equal(root.querySelector(".em-body").scrollTop, 0);
          root.querySelector(".em-body").scrollTop = 87;
          click(root, `返回${noun}列表`);
          assert.equal(title(root), `管理${noun}`); assert.ok(!root.querySelector(".echoink-finance-catalog-form"));
          assert.equal(root.querySelector(".em-body").scrollTop, 239);
          click(root, "返回财务设置");
          assert.equal(root.dataset.page, "finance-settings"); assert.equal(title(root), "财务设置");
          assert.equal(root.querySelector(".em-body").scrollTop, 163); assert.equal(state.accessListeners.size, 0);
        }
        click(root, "返回");
        assert.equal(root.dataset.page, "resources"); assert.equal(root.querySelector(".em-body").scrollTop, 91);
        click(root, "返回");
        if (isTablet && width >= 760) {
          assert.equal(root.dataset.page, "basic", "Wide settings return to the retained initial detail");
          assert.equal(title(root), "基础设置"); click(root, "返回");
        }
        assert.equal(root.dataset.page, "settings");
        assert.equal(state.chatOpens, 0); assert.equal(state.settingsOpens, 0);
        if (isTablet) { assert.ok(!root.querySelector('[aria-label="返回"]')); assert.equal(state.runtime.onChange, listener); }
      } finally { await state.dispose(); }
    });
  }

  await test("finance catalog: right edge-swipe returns one level; vertical/input/cancelled gestures do not navigate", async () => {
    const state = await fixture(), { root } = state;
    const previousMatchMedia = dom.window.matchMedia;
    dom.window.matchMedia = query => ({ matches: query === "(prefers-reduced-motion: reduce)", addEventListener() {}, removeEventListener() {} });
    try {
      click(root, "财务"); root.querySelector(".em-body").scrollTop = 155; click(root, "管理商户");
      let content = root.querySelector(".em-content");
      assert.equal(swipe(content, 90).defaultPrevented, false); assert.equal(root.dataset.page, "finance-merchants", "Swipes away from the edge are ordinary content gestures");
      assert.equal(swipe(content, 8, 80, 112, 250).defaultPrevented, false); assert.equal(root.dataset.page, "finance-merchants", "Vertical scrolling must be inert");
      touch(content, "touchstart", 8, 80); touch(content, "touchcancel", 100, 80); touch(content, "touchend", 112, 80);
      assert.equal(root.dataset.page, "finance-merchants");
      root.querySelector(".em-body").scrollTop = 226; click(root, "编辑导航测试商户");
      const input = root.querySelector(".echoink-finance-catalog-form input");
      input.value = "未提交草稿"; swipe(input);
      assert.equal(title(root), "编辑商户"); assert.equal(input.value, "未提交草稿");
      assert.equal(swipe(content).defaultPrevented, true); assert.equal(title(root), "管理商户"); assert.equal(root.querySelector(".em-body").scrollTop, 226);
      swipe(content); assert.equal(root.dataset.page, "finance-settings"); assert.equal(root.querySelector(".em-body").scrollTop, 155);
      content = root.querySelector(".em-content"); swipe(content); assert.equal(root.dataset.page, "finance-settings", "The gesture is limited to catalog pages");
      assert.equal(root.getAnimations?.().length ?? 0, 0);
    } finally { dom.window.matchMedia = previousMatchMedia; await state.dispose(); }
  });

  await test("iPad catalog: pending back is inert; category switch and destroy dispose subscriptions and ignore late redraw", async () => {
    const state = await fixture(true, 1000), { root, ui, services, accessListeners } = state;
    try {
      click(root, "财务"); click(root, "管理账户");
      let resolveSave;
      services.lifestyle.finance.saveCatalog = () => new Promise(resolve => { resolveSave = resolve; });
      root.querySelector('.echoink-finance-catalog-item [role="switch"]').click();
      assert.equal(typeof resolveSave, "function");
      click(root, "返回财务设置"); assert.equal(root.dataset.page, "finance-accounts"); assert.equal(title(root), "管理账户");
      click(root.querySelector(".em-sidebar"), "基础设置");
      assert.equal(root.dataset.page, "basic"); assert.equal(accessListeners.size, 0);
      resolveSave(); await settle();
      assert.equal(title(root), "基础设置"); assert.ok(!root.querySelector(".echoink-finance-catalog-page"));
      assert.equal(state.chatOpens, 0);
      ui.showPage("finance-settings"); click(root, "管理商户");
      const staleContent = root.querySelector(".em-content");
      touch(staleContent, "touchstart", 8, 80);
      root.querySelector('.echoink-finance-catalog-item [role="switch"]').click();
      assert.equal(accessListeners.size, 1); ui.destroy(); assert.equal(accessListeners.size, 0);
      resolveSave(); touch(staleContent, "touchend", 112, 80); await settle();
      assert.equal(root.children.length, 0, "Disposing the view must prevent delayed catalog redraw/navigation");
      assert.equal(state.chatOpens, 0);
    } finally { await state.dispose(); }
  });

  await test("mobile catalog keeps its switch and modal confirmation instead of desktop inline deletion", async () => {
    const state = await fixture(), { root, services } = state;
    try {
      click(root, "财务"); click(root, "管理商户");
      assert.ok(root.querySelector('.echoink-finance-catalog-item [role="switch"]'));
      assert.ok(!root.querySelector('.echoink-finance-catalog-item [role="checkbox"]'));
      let saves = 0;
      const save = services.lifestyle.finance.saveCatalog.bind(services.lifestyle.finance);
      services.lifestyle.finance.saveCatalog = async (...args) => { saves++; return await save(...args); };
      click(root, "删除");
      let modal = dom.window.document.querySelector(".modal-container");
      assert.ok(modal); assert.equal(root.querySelector(".echoink-settings-inline-confirm"), null);
      assert.equal(saves, 0); assert.equal(root.querySelectorAll(".echoink-finance-catalog-item").length, 1);
      click(modal, "取消"); await settle();
      assert.equal(saves, 0); assert.equal(dom.window.document.querySelector(".modal-container"), null);
      click(root, "删除"); modal = dom.window.document.querySelector(".modal-container"); assert.ok(modal);
      click(modal, "删除"); await settle(); await settle();
      assert.equal(saves, 1); assert.equal(root.querySelectorAll(".echoink-finance-catalog-item").length, 0);
      assert.equal(dom.window.document.querySelector(".modal-container"), null);
    } finally { dom.window.document.querySelector(".modal-container")?.remove(); await state.dispose(); }
  });
}
