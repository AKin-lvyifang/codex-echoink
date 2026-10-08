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

export async function runAccountMembershipSubscriptionTests(win: Window & typeof globalThis): Promise<void> {
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
    ...base, identity: signedIn ? identity : null, provider: "configured", serviceAvailable: true,
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
    assert.match(parent.textContent!, /network unavailable/); assert.equal(find("刷新验证")!.disabled, false);
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
