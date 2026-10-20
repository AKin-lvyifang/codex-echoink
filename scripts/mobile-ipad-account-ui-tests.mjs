import assert from "node:assert/strict";
import vm from "node:vm";
import esbuild from "esbuild";
import { JSDOM } from "jsdom";
import { mobileBuildOptions } from "./mobile-build.mjs";

const build = await esbuild.build(mobileBuildOptions("src/ui/ipad/account-pages.ts"));
const dom = new JSDOM("<!doctype html><body><aside><textarea>right Agent draft</textarea></aside><main></main></body>", { pretendToBeVisual: true, url: "https://ipad-account.invalid" });
dom.window.HTMLElement.prototype.createSpan = function (options = {}) { const element = dom.window.document.createElement("span"); element.className = options.cls ?? ""; if (options.text) element.textContent = options.text; for (const [key, value] of Object.entries(options.attr ?? {})) element.setAttribute(key, value); this.append(element); return element; };
let time = Date.now(); class TestDate extends Date { static now() { return time; } }
const timers = new Set(), timerSet = (callback, delay) => { const token = setTimeout(() => { timers.delete(token); callback(); }, delay); timers.add(token); return token; }, timerClear = token => { timers.delete(token); clearTimeout(token); };
dom.window.setTimeout = timerSet; dom.window.clearTimeout = timerClear;
const notices = [], module = { exports: {} };
vm.runInNewContext(build.outputFiles[0].text, { module, exports: module.exports, document: dom.window.document, window: dom.window,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, AbortController, structuredClone, URL, setTimeout: timerSet, clearTimeout: timerClear, console, atob, btoa, TextEncoder, TextDecoder, Date: TestDate,
  require(id) { assert.equal(id, "obsidian"); return { setIcon: (node, icon) => { node.dataset.icon = icon; }, Notice: class { constructor(value) { notices.push(value); } } }; } });
const tick = async () => { for (let index = 0; index < 5; index++) await new Promise(resolve => setTimeout(resolve, 0)); };
const root = dom.window.document.querySelector("main"), right = dom.window.document.querySelector("aside textarea"), listeners = new Set(), stack = [], calls = { code: [], login: [], redeem: [], profile: [], removed: [], logout: 0, purchase: 0, verify: 0, activate: 0 };
let codeFailure = false, loginFailure = false, profileFailure = false, deviceFailure = false, redeemFailure = false, signInDeferred;
let state = {
  identity: null,
  statistics: { totalTokens: 12_345, totalTurns: 7, currentStreak: 2, bestStreak: 4, coverage: null, days: [], rankings: {}, assets: {} },
  membership: { state: "anonymous", planId: null, planName: null, expiresAt: null, startsAt: null, verifiedAt: null, offlineUntil: null, devices: null, deviceLimit: null },
  serviceAvailable: true, provider: "missing", storageNotice: null, verificationError: null,
  products: [{ id: "early", prices: { CNY: 2880, USD: 1499 }, days: null }, { id: "month", prices: { CNY: 1000, USD: 399 }, days: 30 }, { id: "quarter", prices: { CNY: 2500, USD: 899 }, days: 90 }, { id: "year", prices: { CNY: 6000, USD: 2499 }, days: 365 }]
};
const emit = () => [...listeners].forEach(listener => listener());
const signedIn = email => { state = { ...state, identity: { name: "本地账号", email, joinedAt: "2026-10-19", avatar: "initial", passwordSet: true }, membership: { ...state.membership, state: "free", devices: [{ id: "this", name: "这台 iPad", description: "iPadOS · 今天", current: true }, { id: "old", name: "旧电脑", description: "macOS · 昨天", current: false }], deviceLimit: 3 } }; emit(); };
const api = {
  read() { assert.equal(this, api, "read preserves AccountService method binding"); return structuredClone(state); },
  subscribe(listener) { assert.equal(this, api, "subscribe preserves AccountService method binding"); listeners.add(listener); return () => listeners.delete(listener); },
  actions: {
    requestCode: async input => { calls.code.push(input); if (codeFailure) throw new Error("验证码发送失败"); },
    signIn: async input => { calls.login.push(input); if (loginFailure) throw new Error("登录失败，输入已保留"); if (signInDeferred) return new Promise(resolve => { signInDeferred = resolve; }); signedIn(input.email); },
    redeem: async code => { calls.redeem.push(code); if (redeemFailure) throw new Error(`兑换无效: ${code}`); state.membership = { ...state.membership, state: "active", planId: "quarter", planName: "实际季卡", expiresAt: "2027-01-19", verifiedAt: "2026-10-19 10:30" }; emit(); },
    saveProfile: async input => { calls.profile.push(input); if (profileFailure) throw new Error("资料保存失败"); state.identity.name = input.name; emit(); },
    removeDevice: async id => { calls.removed.push(id); if (deviceFailure) throw new Error("移除失败"); state.membership.devices = state.membership.devices.filter(device => device.id !== id); emit(); },
    signOut: async () => { calls.logout++; state.identity = null; state.membership = { ...state.membership, state: "anonymous", planId: null, planName: null, devices: null, expiresAt: null }; emit(); },
    verify: async () => { calls.verify++; emit(); },
    activateDevice: async () => { calls.activate++; state.membership.state = "active"; emit(); },
    selectPlan: async () => { calls.purchase++; throw new Error("purchase must remain unavailable"); }
  }
};
const mount = page => { const panel = dom.window.document.createElement("section"); panel.className = "echoink-ipad-page"; panel.append(page.content); if (page.footer) panel.append(page.footer); root.append(panel); page.panel = panel; stack.push(page); };
const ctx = { root, document: dom.window.document, host: { accountService: api, settings: () => ({ settingsLanguage: "zh-CN" }) }, shell: {}, error: error => notices.push(String(error)), refresh: () => root.dispatchEvent(new dom.window.Event("pd-settings-refresh")),
  async push(page) { const previous = stack.at(-1); if (previous?.canLeave && !await previous.canLeave()) { page.dispose?.(); return false; } if (previous) previous.panel.hidden = true; mount(page); return true; },
  async back() { const page = stack.at(-1); if (page?.canLeave && !await page.canLeave()) return false; stack.pop(); page.dispose?.(); page.panel.remove(); if (stack.at(-1)) stack.at(-1).panel.hidden = false; return true; } };
const current = () => stack.at(-1), buttons = scope => [...(scope ?? current().panel).querySelectorAll("button")];
const findButton = (label, scope) => buttons(scope).find(node => node.textContent.trim() === label);
const click = async (label, scope) => { const button = findButton(label, scope); assert.ok(button, `button exists: ${label}`); button.click(); await tick(); };
const fill = (label, value) => { const input = current().content.querySelector(`[aria-label="${label}"]`); assert.ok(input, `input exists: ${label}`); input.value = value; input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); return input; };
const unhandled = [], collect = error => unhandled.push(error); process.on("unhandledRejection", collect);
try {
  mount(module.exports.createAccountPage(ctx)); await tick(); const account = current();
  assert.match(account.content.textContent, /未登录/); assert.match(account.content.textContent, /12,345/); assert.equal(account.content.querySelectorAll(".pd-account-stat").length, 4); assert.equal(account.content.querySelectorAll("[data-plan-id]").length, 4);
  assert.ok([...account.content.querySelectorAll(".pd-account-plan button")].every(button => button.disabled)); assert.match(account.content.textContent, /仅电脑/); assert.equal(account.content.querySelector(".heat,.heatmap"), null);
  assert.match(account.content.querySelector('[data-plan-id="month"]').textContent, /3\.99|10/); assert.ok(!account.content.textContent.includes("限量"), "no fabricated stock");
  await click("登录 / 注册"); const login = current(); fill("邮箱", "test@example.invalid");
  codeFailure = true; await click("获取验证码"); assert.match(login.content.textContent, /验证码发送失败/); assert.ok(findButton("获取验证码")); assert.equal(timers.size, 0, "failed send starts no cooldown"); assert.equal(login.content.querySelector('[aria-label="邮箱"]').value, "test@example.invalid");
  codeFailure = false; await click("获取验证码"); assert.ok(findButton("60 秒后重发")); assert.equal(findButton("60 秒后重发").disabled, true);
  await click("密码登录"); assert.equal(login.content.querySelector('[aria-label="邮箱"]').value, "test@example.invalid"); const password = fill("密码", "x"); assert.equal(findButton("登录").disabled, false, "existing password login delegates non-empty short passwords to service");
  await click("邮箱验证码"); fill("邮箱验证码", "123456"); time += 61_000; dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange")); await tick(); assert.ok(findButton("获取验证码")); assert.equal(findButton("获取验证码").disabled, false, "resume recomputes deadline rather than decrementing hidden ticks");
  loginFailure = true; await click("登录"); assert.match(login.content.textContent, /登录失败/); assert.equal(login.content.querySelector('[aria-label="邮箱验证码"]').value, "123456");
  loginFailure = false; await click("登录"); assert.equal(current().id, "ipad-settings-account"); assert.match(account.content.textContent, /免费版/); assert.equal(calls.login.at(-1).method, "code"); assert.equal(password.value, "", "disposed login form clears detached password inputs");
  await click("使用兑换码"); const redemption = fill("兑换码", "synthetic-code"); const redemptionNode = redemption;
  state.statistics.totalTurns = 8; emit(); await tick(); assert.equal(account.content.querySelector('[aria-label="兑换码"]'), redemptionNode, "subscription update retains redemption input node"); assert.equal(redemption.value, "synthetic-code");
  redeemFailure = true; await click("兑换"); assert.match(account.content.textContent, /\[redacted\]/); assert.equal(redemption.value, "synthetic-code"); redeemFailure = false;
  await click("兑换"); assert.match(account.content.textContent, /实际季卡/); assert.equal(account.content.querySelector('[data-plan-id="quarter"] .pd-account-current-plan').textContent, "使用中"); assert.equal(account.content.querySelector('[data-plan-id="year"] .pd-account-current-plan'), null); assert.equal(redemption.value, ""); assert.equal(current(), account, "redemption remains in place");
  await click("编辑资料"); fill("名字", "discarded fixture name"); const savesBeforeCancel = calls.profile.length, originalName = state.identity.name; await click("取消"); assert.equal(current(), account); assert.equal(calls.profile.length, savesBeforeCancel); assert.equal(state.identity.name, originalName);
  await click("编辑资料"); const profile = current(); fill("名字", "新的名字"); profileFailure = true; await click("保存"); assert.equal(profile.content.querySelector('[aria-label="名字"]').value, "新的名字"); assert.match(profile.content.textContent, /资料保存失败/); profileFailure = false;
  await click("保存"); assert.equal(current(), account); assert.equal(state.identity.name, "新的名字"); assert.equal(Object.hasOwn(calls.profile.at(-1), "avatar"), false, "name edit preserves avatar");
  await click("设备管理2 / 3"); const devices = current(); assert.equal(devices.content.querySelectorAll("button").length, 1, "current device has no remove action"); await click("移除"); deviceFailure = true; await click("移除", devices.content.querySelector(".pd-account-inline-confirm:not(:empty)")); assert.match(devices.content.textContent, /移除失败/); assert.match(devices.content.textContent, /旧电脑/); deviceFailure = false;
  await click("移除", devices.content.querySelector(".pd-account-inline-confirm:not(:empty)")); assert.deepEqual(calls.removed, ["old", "old"]); assert.equal(devices.content.querySelectorAll("button").length, 0); await ctx.back();
  state.membership = { ...state.membership, state: "lifetime", planId: "early", planName: "真实买断", expiresAt: null }; emit(); await tick(); assert.match(account.content.textContent, /真实买断/); assert.equal(account.content.querySelector('[data-plan-id="early"] .pd-account-current-plan').textContent, "使用中");
  state.membership = { ...state.membership, state: "offline-valid", planId: "month", planName: "月卡", offlineUntil: "2026-10-22" }; emit(); await tick(); assert.match(account.content.textContent, /离线可用/);
  state.membership.state = "device-required"; emit(); await tick(); await click("重新验证"); assert.equal(calls.verify, 1); await click("启用本机"); assert.equal(calls.activate, 1); assert.equal(state.membership.state, "active");
  state.membership.state = "device-limit"; emit(); await tick(); assert.match(account.content.textContent, /设备名额已满/);
  await click("退出登录"); assert.equal(calls.logout, 0); await click("退出登录", account.content.querySelector(".pd-account-inline-confirm")); assert.equal(calls.logout, 1); assert.match(account.content.textContent, /未登录/); assert.match(account.content.textContent, /12,345/); assert.match(account.content.textContent, /完成的对话轮次8/);
  await click("登录 / 注册"); fill("邮箱", "first@example.invalid"); await click("密码登录"); fill("密码", "not-a-real-password"); signInDeferred = true; await click("登录"); assert.equal(current().content.getAttribute("aria-busy"), "true"); signedIn("second@example.invalid"); await tick(); const resolveLogin = signInDeferred; resolveLogin(); await tick();
  assert.equal(current().id, "ipad-account-login", "late completion cannot navigate a different account"); assert.equal(state.identity.email, "second@example.invalid"); assert.equal(current().content.querySelector('[aria-label="密码"]').value, "", "identity change clears sensitive draft");
  assert.equal(right, dom.window.document.querySelector("aside textarea")); assert.equal(right.value, "right Agent draft"); assert.equal(calls.purchase, 0); assert.equal(unhandled.length, 0, `Unhandled errors: ${unhandled.join("; ")}`);
  while (stack.length) { const page = stack.pop(); page.dispose?.(); page.panel.remove(); }
  const missing = { ...ctx, host: { ...ctx.host, accountService: undefined } }; mount(module.exports.createAccountPage(missing)); await tick(); assert.equal(findButton("登录 / 注册").disabled, true); assert.match(current().content.textContent, /账号服务暂不可用/); assert.match(current().content.textContent, /—/);
  console.log("iPad M10 account UI: anonymous/free/actual PRO, authoritative pricing/current plan, four local stats retained on logout, send failure/no cooldown/deadline resume, login methods/failure/late identity guard, inline redemption node retained, profile/device failure retention, readonly current device, disabled purchases, central/right draft isolation and unavailable adapter passed.");
} finally { while (stack.length) { const page = stack.pop(); page.dispose?.(); } assert.equal(listeners.size, 0, "dispose removes account subscriptions"); assert.equal(timers.size, 0, "dispose clears countdown timers"); process.off("unhandledRejection", collect); dom.window.close(); }
