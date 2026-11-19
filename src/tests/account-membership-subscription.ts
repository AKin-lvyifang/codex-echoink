import { installObsidianDom } from "./obsidian-dom";
import { runMembershipWebsiteLinksTests } from "./membership-website-links";
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { App, TFile, openTestModals } from "obsidian";
import { JournalTemplateModal } from "../home/journal-template-modal";
import { mountAccountMembership } from "../settings/account-membership";
import { getProPluginAccess } from "../membership/access";
import { ProPluginControls } from "../ui/pro-plugin-controls";
import type { CapabilityAccess } from "../membership/types";
import { createUnavailableAccountAdapter, type AccountActions, type AccountMembershipViewModel, type MembershipState } from "../settings/account-membership-model";
import { lifetimeMaxQuote, pricingProducts } from "./account-membership-pricing";
import { createPluginEditionBadge } from "../settings/plugin-edition-badge";

export async function runAccountMembershipSubscriptionTests(win: Window & typeof globalThis): Promise<void> {
  installObsidianDom(win);
  runMembershipWebsiteLinksTests();
  const css = readFileSync("src/styles/workspace-settings.css", "utf8");
  const declarations = (selector: string) => {
    const start = css.indexOf(`${selector}{`); assert.ok(start >= 0, selector);
    return css.slice(start + selector.length + 1, css.indexOf("}", start));
  };
  assert.match(declarations(".echoink-account.echoink-account .activation-feedback"), /color:var\(--secondary\)/);
  assert.match(declarations('.echoink-account.echoink-account .activation-feedback[data-feedback-state="success"]'), /color:var\(--text\)/);
  assert.match(declarations('.echoink-account.echoink-account .activation-feedback[data-feedback-state="error"]'), /color:var\(--danger\)/);
  for (const state of ["spinner", "check"]) assert.match(declarations(`.echoink-account .account-action-${state} svg`), /color:inherit/, "feedback icons inherit the primary or quiet button foreground");
  const parent = win.document.createElement("div"); win.document.body.appendChild(parent);
  let page: ReturnType<typeof mountAccountMembership> | undefined;
  const base = createUnavailableAccountAdapter().read();
  const identity = { name: "订阅测试", email: "subscription@example.invalid", joinedAt: null, avatar: "initial" as const, passwordSet: false };
  const model = (state: MembershipState, signedIn = true): AccountMembershipViewModel => ({
    ...base, maxSalesOpen: true, products: pricingProducts, identity: signedIn ? identity : null, provider: "configured", serviceAvailable: true,
    membership: { ...base.membership, state, planId: ["active", "device-required", "device-limit"].includes(state) ? "beta" : null }
  });
  const find = (label: string, root = parent) => [...root.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === label);
  const modal = () => openTestModals.at(-1)!;
  const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const waitFeedback = () => new Promise(resolve => setTimeout(resolve, 700));
  const mount = (vm: AccountMembershipViewModel, actions: AccountActions = {}) => {
    page?.dispose(); page = mountAccountMembership(parent, { app: new App(), language: "zh-CN", viewModel: vm, actions, openProviders() {} });
  };
  try {
    let ordersOpened = 0;
    const selections: string[] = [];
    const entryActions: AccountActions = { openOrders: async () => { ordersOpened++; }, selectPlan: async input => { selections.push(input.planId); } };
    // Entitlements from the server: points, sync quota and the one-time Max coupon render as plain facts; the coupon opens the Max checkout.
    const entitlements = { tier: "lifetime" as const, lifetime: true, isPro: true, subscription: null, next: null,
      sync: { status: "none" as const, plan: null, quotaBytes: 0, readOnly: true, graceUntil: null, deviceLimit: 3 },
      devices: { limit: 3, active: 1, remaining: 2 }, points: { balanceMilli: 1_987_600, balance: "1987.6", nextExpiry: { at: Date.UTC(2027, 4, 5), milli: 1_987_600, points: "1987.6" }, monthly: 0 },
      maxCoupon: true, serverTime: Date.now() };
    mount({ ...model("lifetime"), entitlements }, entryActions);
    const lines = [...parent.querySelectorAll<HTMLElement>(".membership-entitlement-line")].map(line => line.textContent);
    assert.equal(lines.length, 2); assert.match(lines[0]!, /AI 点数1987\.6/); assert.ok(!/到期/.test(lines[0]!), "batch expiry lives in the hover tip, not the line");
    assert.match(parent.querySelector<HTMLElement>(".membership-entitlement-line")!.dataset.pointsNote!, /1987\.6 AI 点数 .*到期/); assert.match(lines[1]!, /云同步未开通/);
    mount({ ...model("lifetime"), salesOpen: true, maxSalesOpen: false, entitlements }, entryActions);
    assert.equal(find("Max 首次 5 折"), undefined, "stale coupon entitlements do not expose a shortcut before Max opens");
    mount({ ...model("lifetime"), salesOpen: false, maxSalesOpen: true, entitlements }, entryActions);
    find("Max 首次 5 折")!.click(); await settle(); assert.deepEqual(selections, ["max-year"]); selections.length = 0;
    // 方哥 11-08 定（Demo d7353ff8）：头部只留事实、主按钮是动作、购买卡片区分 PRO / Max 两个系列，四种身份各不相同。
    const quoted = pricingProducts.map(product => product.kind === "max" ? lifetimeMaxQuote(product) : product);
    const series = (key: string) => parent.querySelector<HTMLButtonElement>(`.plan-series-button[data-series="${key}"]`)!;
    const card = (id: string) => parent.querySelector<HTMLElement>(`[data-plan-id="${id}"]`);
    const primaryOf = () => parent.querySelector<HTMLButtonElement>(".membership-actions button.primary");
    for (const tier of ["lifetime", "max"] as const) {
      mount({ ...model("lifetime"), products: pricingProducts.filter(p => !p.id.startsWith("max-")), entitlements: { ...entitlements, tier, maxCoupon: false } }, entryActions);
      assert.equal(find("Max 首次 5 折"), undefined);
      assert.equal(parent.querySelector<HTMLElement>(".plan-series")!.hidden, true);
      assert.ok(card("month") && !card("max-year"), "closed Max falls back to populated PRO cards");
      assert.equal(parent.querySelector(".profile-section .badge")!.textContent, tier === "max" ? "✧ Max" : "✧ PRO", "badge follows entitlements even when Max sales are closed");
    }
    for (const language of ["zh-CN", "en"] as const) {
      const host = win.document.createElement("div");
      const maxBadge = createPluginEditionBadge(host, "max", language);
      assert.equal(maxBadge.textContent, "Max");
      assert.equal(maxBadge.dataset.pluginEdition, "max");
      assert.equal(maxBadge.classList.contains("is-pro"), true, "reuse the approved paid badge appearance");
      assert.equal(createPluginEditionBadge(host, "pro", language).textContent, "PRO");
    }
    // 买断：没有主按钮，只有「Max 首次 5 折」和（需要时）刷新验证；Max 系列显示折后价 + 划掉原价 + 折标。
    mount({ ...model("lifetime"), salesOpen: true, products: quoted, membership: { ...model("lifetime").membership, verifiedAt: "09:30" }, entitlements }, entryActions);
    assert.equal(primaryOf(), null, "lifetime owners get no primary button");
    assert.ok(find("Max 首次 5 折"));
    assert.match(parent.querySelector(".membership-copy p")?.textContent ?? "", /^早鸟终生买断 · 09:30 已验证$/);
    assert.equal(series("pro").getAttribute("aria-pressed"), "true"); assert.ok(card("month") && !card("max-year"));
    series("max").click(); assert.equal(series("max").getAttribute("aria-pressed"), "true"); assert.ok(card("max-year") && !card("month"));
    assert.match(card("max-year")!.querySelector(".price")!.textContent!, /¥199\.5.*¥399/); assert.equal(card("max-year")!.querySelector(".plan-offer")!.textContent, "5 折");
    assert.equal(card("max-quarter")!.querySelector(".plan-offer")!.textContent, "6 折"); assert.equal(card("max-month")!.querySelector(".plan-offer")!.textContent, "7 折");
    assert.equal(card("max-year")!.querySelector("button")!.textContent, "用首次优惠"); assert.match(card("max-year")!.textContent!, /PRO 全部 · 每30天 3000 AI 点数 · 云同步 5 GB/);
    card("max-year")!.querySelector("button")!.click(); await settle(); assert.deepEqual(selections, ["max-year"]); selections.length = 0;
    // 内测 PRO：主按钮「升级 PRO」，停在 PRO 系列；点主按钮打开购买方案。
    mount({ ...model("active"), salesOpen: true, products: pricingProducts, membership: { ...model("active").membership, planId: "beta", expiresAt: "2027-01-15" } }, entryActions);
    assert.equal(primaryOf()!.textContent, "升级 PRO"); assert.match(parent.querySelector(".membership-copy p")!.textContent!, /^内测 · 至 2027-01-15$/);
    assert.equal(series("pro").getAttribute("aria-pressed"), "true"); assert.equal(card("year")!.querySelector("button")!.textContent, "立即订阅");
    // 订阅 PRO 年卡：主按钮「续费」直接走 selectPlan(year)；年卡卡片标使用中。
    mount({ ...model("active"), salesOpen: true, products: pricingProducts, membership: { ...model("active").membership, planId: "year", expiresAt: "2027-11-07" } }, entryActions);
    assert.equal(primaryOf()!.textContent, "续费"); assert.match(parent.querySelector(".membership-copy p")!.textContent!, /^PRO 年卡 · 至 2027-11-07$/);
    assert.equal(card("year")!.querySelector("button")!.textContent, "续费"); assert.equal(card("year")!.querySelector("button")!.getAttribute("aria-current"), "true");
    primaryOf()!.click(); await settle(); assert.deepEqual(selections, ["year"]); selections.length = 0;
    // Max 年卡：默认停在 Max 系列，年付卡「使用中」+ 到期日 + 续费；主按钮「续费」走 selectPlan(max-year)。
    const maxEntitlements = { ...entitlements, tier: "max" as const, lifetime: false, maxCoupon: false, subscription: { plan: "max" as const, planId: "max-year", startsAt: "2026-11-30T00:00:00.000Z", endsAt: "2027-11-30T00:00:00.000Z" },
      sync: { status: "active" as const, plan: "max" as const, quotaBytes: 5 * 1024 ** 3, readOnly: false, graceUntil: null, deviceLimit: 3 }, points: { ...entitlements.points, monthly: 3000 } };
    mount({ ...model("active"), salesOpen: true, products: pricingProducts, entitlements: maxEntitlements, membership: { ...model("active").membership, planId: "max-year", expiresAt: "2027-11-30" } }, entryActions);
    assert.equal(primaryOf()!.textContent, "续费"); assert.match(parent.querySelector(".membership-copy p")!.textContent!, /^Max 年卡 · 至 2027-11-30$/);
    assert.equal(series("max").getAttribute("aria-pressed"), "true"); assert.ok(card("max-year")!.classList.contains("is-current"));
    assert.equal(card("max-year")!.querySelector(".plan-offer")!.textContent, "使用中"); assert.match(card("max-year")!.textContent!, /到期/);
    assert.equal(card("max-year")!.querySelector("button")!.textContent, "续费"); assert.equal(card("max-month")!.querySelector("button")!.textContent, "立即订阅");
    primaryOf()!.click(); await settle(); assert.deepEqual(selections, ["max-year"]); selections.length = 0;
    // 免费：主按钮「开通 PRO」。
    mount({ ...model("free"), salesOpen: true, products: pricingProducts }, entryActions);
    assert.equal(primaryOf()!.textContent, "开通 PRO");
    console.log("PASS plan series PRO/Max, action-only primary button and fact-only header for four identities");
    mount({ ...model("active"), entitlements: { ...entitlements, tier: "max", lifetime: false, maxCoupon: false,
      sync: { status: "active", plan: "max", quotaBytes: 5 * 1024 ** 3, readOnly: false, graceUntil: null, deviceLimit: 3 }, points: { ...entitlements.points, monthly: 3000 } } }, entryActions);
    assert.equal(find("Max 首次 5 折"), undefined);
    assert.match(parent.querySelector(".membership-entitlements")!.textContent!, /每30天 3000/);
    assert.match([...parent.querySelectorAll<HTMLElement>(".membership-entitlement-line")][1]!.textContent!, /云同步5 GB1 \/ 3 台设备/);
    mount({ ...model("anonymous", false), entitlements }, entryActions);
    assert.equal(parent.querySelector(".membership-entitlements"), null, "signed-out never shows another account's numbers");
    mount({ ...model("anonymous", false), salesOpen: false }, entryActions);
    assert.equal(find("我的订单")!.disabled, false);
    find("我的订单")!.click(); await settle(); assert.equal(ordersOpened, 1);
    assert.ok([...parent.querySelectorAll<HTMLButtonElement>(".plan button")].every(button => button.textContent === "购买待开放" && button.disabled));
    mount({ ...model("active"), salesOpen: true, membership: { ...model("active").membership, planId: "quarter" } }, entryActions);
    const planButton = (id: string) => parent.querySelector<HTMLButtonElement>(`[data-plan-id="${id}"] button`)!;
    assert.equal(planButton("month").textContent, "立即订阅"); assert.equal(planButton("quarter").textContent, "续费");
    assert.equal(planButton("early").disabled, false);
    planButton("month").click(); await settle(); assert.deepEqual(selections, ["month"]);
    const early = { id: "early" as const, prices: { CNY: 2370, USD: 999 }, days: null, available: true, availability: "available" as const, currencies: ["CNY" as const] };
    mount({ ...model("free"), salesOpen: true, products: [early] }, entryActions);
    assert.equal(planButton("early").textContent, "立即购买"); assert.equal(planButton("early").disabled, false);
    assert.match(parent.querySelector('[data-plan-id="early"] .price')!.textContent!, /¥23[.,]7/);
    planButton("early").click(); await settle(); assert.deepEqual(selections, ["month", "early"]);
    for (const availability of ["owned", "paused", "sold_out"] as const) {
      mount({ ...model("free"), salesOpen: true, products: [{ ...early, available: false, availability }] }, entryActions);
      assert.equal(planButton("early").textContent, availability === "owned" ? "已拥有" : "售罄");
      assert.equal(planButton("early").disabled, true); planButton("early").click(); await settle();
      assert.deepEqual(selections, ["month", "early"]);
    }
    mount({ ...model("anonymous", false), betaOffer: { status: "stopped", visible: false } });
    assert.equal(parent.querySelector(".registration-gift-tag"), null);
    mount({ ...model("anonymous", false), betaOffer: { status: "paused", visible: true } });
    assert.equal(parent.querySelector(".registration-gift-tag")!.textContent, "内测领码已暂停");
    console.log("PASS round12 early server price, purchase/owned/sold-out and beta stopped/paused");
    mount(model("free")); assert.equal(find("我的订单")!.disabled, true, "unavailable adapter cannot open orders");
    console.log("PASS account orders entry and sale-open/closed subscription labels");
    const gift = { id: "beta-test", name: "内测活动", product: "beta", endedAt: null, gift: { code: "ECHO-history-secret", codeAvailability: "readable", state: "issued" } };
    mount({ ...model("free"), activityGifts: [gift], betaOffer: { status: "exhausted" } }, { redeem: async () => {} });
    assert.ok(find("使用兑换码"));
    assert.equal(parent.querySelector(".activity-gift"), null);
    assert.equal(parent.querySelector(".beta-offer-status"), null);
    assert.ok(!parent.textContent!.includes(gift.gift.code));
    assert.equal(parent.querySelector(".activation-form"), null, "code input lives only in modal");
    for (const state of ["anonymous", "free", "expired", "active", "lifetime", "offline-valid", "verification-required", "device-required", "device-limit", "revoked", "scheduled"] as MembershipState[]) {
      mount(model(state, state !== "anonymous"), { redeem: async () => {}, verify: async () => {} });
      assert.equal(!!find("使用兑换码"), ["free", "expired"].includes(state));
      assert.equal(!!find("刷新验证"), ["offline-valid", "verification-required", "device-required", "device-limit", "revoked", "scheduled"].includes(state));
      assert.ok([...parent.querySelectorAll<HTMLButtonElement>(".plan button")].every(button => button.disabled));
    }
    mount(model("expired"));
    assert.equal(parent.querySelector(".membership-copy h3")!.textContent, "EchoInk 基础版");
    assert.match(parent.textContent!, /订阅已到期，已有资料仍可查看/);
    mount(model("anonymous", false));
    assert.equal(parent.querySelector(".registration-gift-tag")!.textContent, "注册送激活码");
    find("登录 / 注册")!.click();
    assert.equal(modal().contentEl.querySelector<HTMLInputElement>('input[inputmode="numeric"]')!.maxLength, 6);
    modal().close();

    // Exercise the actual subscription wrapper while redemption emits intermediate and final states.
    page?.dispose();
    let current = model("free"), redeemCalls = 0;
    const listeners = new Set<() => void>();
    const emit = () => listeners.forEach(listener => listener());
    let finishRedeem!: () => void;
    page = mountAccountMembership(parent, { app: new App(), language: "zh-CN", viewModel: current, read: () => current,
      subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      actions: { redeem: async code => {
        assert.equal(code, "synthetic-code"); redeemCalls++;
        current = model("device-required"); emit();
        await new Promise<void>(resolve => { finishRedeem = resolve; });
        current = model("active"); emit();
      } }, openProviders() {} });
    find("使用兑换码")!.click();
    const redeemModal = modal(), form = redeemModal.contentEl.querySelector<HTMLFormElement>("form")!;
    const code = form.querySelector<HTMLInputElement>("input")!; code.value = "synthetic-code";
    const submit = () => form.dispatchEvent(new win.Event("submit", { cancelable: true }));
    submit(); submit(); await settle();
    assert.equal(redeemCalls, 1);
    assert.equal(openTestModals.at(-1), redeemModal);
    assert.equal(form.querySelector<HTMLButtonElement>('button[type="submit"]')!.getAttribute("aria-busy"), "true");
    assert.ok(form.querySelector(".account-action-spinner"));
    assert.equal(form.querySelector<HTMLElement>(".activation-feedback")!.dataset.feedbackState, "loading");
    assert.equal(form.querySelector(".activation-feedback")!.getAttribute("role"), "status");
    finishRedeem(); await settle();
    assert.ok(form.isConnected, "PRO subscription update retains success feedback modal");
    assert.ok(form.querySelector(".account-action-check"));
    assert.match(form.textContent!, /兑换码使用成功/);
    assert.equal(form.querySelector<HTMLElement>(".activation-feedback")!.dataset.feedbackState, "success");
    assert.equal(form.querySelector(".activation-feedback")!.getAttribute("role"), "status");
    await waitFeedback();
    assert.equal(openTestModals.includes(redeemModal), false);
    assert.equal(parent.querySelector(".membership-copy h3")!.textContent, "EchoInk PRO");
    assert.equal(find("使用兑换码"), undefined);
    page.dispose(); assert.equal(listeners.size, 0);

    // Account replacement and logout bypass membership-only holds immediately.
    for (const nextIdentity of [{ ...identity, email: "other@example.invalid", name: "另一个账号" }, null]) {
      current = model("free");
      let staleRedemptions = 0;
      page = mountAccountMembership(parent, { app: new App(), language: "zh-CN", viewModel: current, read: () => current,
        subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        actions: { redeem: async () => { staleRedemptions++; } }, openProviders() {} });
      find("使用兑换码")!.click();
      const staleModal = modal(), staleForm = staleModal.contentEl.querySelector<HTMLFormElement>("form")!;
      staleForm.querySelector<HTMLInputElement>("input")!.value = "account-a-code";
      current = { ...model("free"), identity: nextIdentity }; emit();
      assert.equal(openTestModals.includes(staleModal), false);
      assert.equal(parent.querySelector(".activation-form"), null);
      assert.match(parent.querySelector(".profile-section")!.textContent!, nextIdentity ? /另一个账号/ : /未登录/);
      staleForm.dispatchEvent(new win.Event("submit", { cancelable: true })); await settle();
      assert.equal(staleRedemptions, 0, "old account form never redeems for the new account");
      page.dispose();
    }

    // A POST success without effective device access must not become UI success.
    current = model("free");
    page = mountAccountMembership(parent, { app: new App(), language: "zh-CN", viewModel: current, read: () => current,
      subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      actions: { activateDevice: async () => {}, redeem: async () => { current = model("device-limit"); emit(); throw new Error("设备名额已满，请先解绑旧设备。"); } }, openProviders() {} });
    find("使用兑换码")!.click(); const failedModal = modal();
    const failedForm = failedModal.contentEl.querySelector<HTMLFormElement>("form")!;
    const failedCode = failedForm.querySelector<HTMLInputElement>("input")!; failedCode.value = "retry-code";
    failedForm.dispatchEvent(new win.Event("submit", { cancelable: true })); await settle();
    assert.equal(failedCode.value, "retry-code"); assert.ok(failedForm.isConnected);
    assert.match(failedForm.textContent!, /设备名额已满/);
    assert.equal(failedForm.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled, false);
    assert.equal(failedForm.querySelector(".account-action-check"), null);
    assert.equal(failedForm.querySelector<HTMLElement>(".activation-feedback")!.dataset.feedbackState, "error");
    assert.equal(failedForm.querySelector(".activation-feedback")!.getAttribute("role"), "alert");
    failedModal.close(); assert.ok(find("在此设备启用"));
    page.dispose();
    mount(model("free"), { redeem: async () => {} }); find("使用兑换码")!.click();
    const falseSuccessForm = modal().contentEl.querySelector<HTMLFormElement>("form")!;
    falseSuccessForm.querySelector<HTMLInputElement>("input")!.value = "no-device-access";
    falseSuccessForm.dispatchEvent(new win.Event("submit", { cancelable: true })); await settle();
    assert.match(falseSuccessForm.textContent!, /本机授权尚未生效/); assert.equal(falseSuccessForm.querySelector(".account-action-check"), null);
    page?.dispose();

    current = model("free"); let attempts = 0, finishRetry!: () => void;
    page = mountAccountMembership(parent, { app: new App(), language: "zh-CN", viewModel: current, read: () => current,
      subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      actions: { redeem: async () => { if (++attempts === 1) throw new Error("retryable error"); await new Promise<void>(resolve => { finishRetry = resolve; }); current = model("active"); emit(); } }, openProviders() {} });
    find("使用兑换码")!.click(); const retryModal = modal(), retryForm = retryModal.contentEl.querySelector<HTMLFormElement>("form")!;
    retryForm.querySelector<HTMLInputElement>("input")!.value = "retry-code";
    const retry = () => retryForm.dispatchEvent(new win.Event("submit", { cancelable: true }));
    retry(); await settle();
    const retryFeedback = retryForm.querySelector<HTMLElement>(".activation-feedback")!;
    assert.equal(retryFeedback.dataset.feedbackState, "error"); assert.equal(retryFeedback.getAttribute("role"), "alert");
    retry(); await settle();
    assert.equal(retryFeedback.dataset.feedbackState, "loading"); assert.equal(retryFeedback.getAttribute("role"), "status");
    finishRetry(); await settle();
    assert.equal(retryFeedback.dataset.feedbackState, "success"); assert.equal(retryFeedback.getAttribute("role"), "status");
    assert.ok(retryForm.querySelector(".account-action-check")); await waitFeedback(); page.dispose();

    let verifyCalls = 0, finishVerify!: () => void;
    mount(model("verification-required"), { verify: async () => { verifyCalls++; await new Promise<void>(resolve => { finishVerify = resolve; }); if (verifyCalls === 1) throw new Error("network unavailable"); } });
    const count = openTestModals.length; find("刷新验证")!.click(); find("验证中")!.click();
    assert.equal(verifyCalls, 1); assert.equal(openTestModals.length, count, "one click starts online request without confirmation");
    assert.ok(parent.querySelector(".account-action-spinner")); finishVerify(); await settle();
    assert.match(parent.textContent!, /会员状态未能验证。请检查网络后重试。/); assert.doesNotMatch(parent.textContent!, /network unavailable/); assert.equal(find("刷新验证")!.disabled, false);
    const verifyFeedback = parent.querySelector<HTMLElement>(".membership-actions .activation-feedback")!;
    assert.equal(verifyFeedback.dataset.feedbackState, "error"); assert.equal(verifyFeedback.getAttribute("role"), "alert");
    find("刷新验证")!.click(); await settle();
    assert.equal(verifyFeedback.dataset.feedbackState, "loading"); assert.equal(verifyFeedback.getAttribute("role"), "status");
    finishVerify(); await settle();
    assert.equal(verifyFeedback.dataset.feedbackState, "success"); assert.equal(verifyFeedback.getAttribute("role"), "status");
    assert.ok(parent.querySelector(".account-action-check")); await waitFeedback();
    let successes = 0;
    mount(model("offline-valid"), { verify: async () => { successes++; } }); find("刷新验证")!.click(); await settle();
    assert.ok(parent.querySelector(".account-action-check")); assert.equal(successes, 1); await waitFeedback();

    // Open write controls retain the current business disabled state, including a pending action that completes while expired.
    page?.dispose(); parent.replaceChildren(); let paid = true;
    const access: CapabilityAccess = { checkCapability: () => paid, requireCapability: () => { if (!paid) throw new Error("PRO_REQUIRED"); }, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
    const control = parent.appendChild(win.document.createElement("button")); control.setAttribute("data-pro-write", ""); control.disabled = true;
    const navigation = parent.appendChild(win.document.createElement("button"));
    let pending = true;
    const binding = new ProPluginControls(access, () => getProPluginAccess(access, true));
    binding.bind(control, { businessDisabled: () => pending });
    paid = false; emit(); pending = false; binding.refresh(); await settle(); assert.equal(control.disabled, true); assert.equal(navigation.disabled, false);
    paid = true; emit(); await settle(); assert.equal(control.disabled, false, "recovery uses completed operation state");
    paid = false; emit(); await settle(); assert.equal(control.disabled, true);
    await new Promise(resolve => setTimeout(resolve, 0));
    pending = true; binding.refresh(); assert.equal(control.disabled, true); paid = true; emit(); assert.equal(control.disabled, true, "pending remains disabled after authorization recovery");
    pending = false; binding.refresh(); assert.equal(control.disabled, false);
    binding.dispose(); assert.equal(listeners.size, 0);

    let created = 0, englishOpened = 0, ordinaryOpened = 0;
    const app = new App();
    Object.assign(app, { workspace: { getLeaf: () => ({ openFile: async () => { ordinaryOpened++; } }) } });
    const template = new JournalTemplateModal(app, { language: "zh-CN", date: new Date(), customTemplates: [],
      service: { createOrOpenJournal: async () => { created++; return { file: new TFile("synthetic.md"), created: true }; } } as never,
      onEnglish: async () => { englishOpened++; }, englishAccess: access, englishEnabled: () => true });
    template.open();
    const englishButton = () => [...template.contentEl.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "写英文日记")!;
    assert.equal(englishButton().disabled, false);
    paid = false; emit(); assert.equal(englishButton().disabled, true);
    await (template as any).createJournal(true);
    assert.equal(created, 0, "an already-open template cannot create an English source after expiry");
    paid = true; emit(); assert.equal(englishButton().disabled, false);
    paid = false; emit();
    await (template as any).createJournal(false);
    assert.equal(created, 1); assert.equal(ordinaryOpened, 1); assert.equal(englishOpened, 0, "ordinary journal flow remains basic");
    assert.equal(listeners.size, 0, "template closes and disposes authorization subscription");
  } finally { page?.dispose(); parent.remove(); }
  console.log("PASS account subscription: single private redemption, subscription spinner/check lifecycle, truthful errors, one-click verification and dynamic read-only controls");
}
