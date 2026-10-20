import assert from "node:assert/strict";
import vm from "node:vm";
import esbuild from "esbuild";
import { JSDOM } from "jsdom";
import { mobileBuildOptions } from "./mobile-build.mjs";

const built = await esbuild.build({ ...mobileBuildOptions("src/ui/iphone/account-pages.ts"), metafile: true });
assert.equal(Object.keys(built.metafile.inputs).some(path => /(?:^|\/)account-membership\.ts$/.test(path)), false, "The independent page does not bundle the old account DOM or Modals");
const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true, url: "https://iphone-account.invalid" });
const { document, Event } = dom.window; dom.window.HTMLElement.prototype.scrollIntoView = function () {};
dom.window.HTMLElement.prototype.createSpan = function (options = {}) { const node = document.createElement("span"); node.className = options.cls ?? ""; node.textContent = options.text ?? ""; for (const [name, value] of Object.entries(options.attr ?? {})) node.setAttribute(name, value); this.append(node); return node; };
const compiled = { exports: {} }, icon = (parent, name) => { const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("data-icon", name); parent.replaceChildren(svg); };
let now = 1_700_000_000_000;
class ClockDate extends Date { static now() { return now; } }
vm.runInNewContext(built.outputFiles[0].text, {
  module: compiled, exports: compiled.exports, document, window: dom.window, console, structuredClone, AbortController, setTimeout, clearTimeout, atob, btoa, TextEncoder, TextDecoder, Date: ClockDate,
  Intl: { NumberFormat: Intl.NumberFormat, DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: "Asia/Shanghai" }) }) },
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, SVGElement: dom.window.SVGElement,
  require: name => { assert.equal(name, "obsidian"); return { setIcon: icon, getIcon: name => { const parent = document.createElement("span"); icon(parent, name); return parent.firstChild; } }; }
});
const { IPhoneAccountPages } = compiled.exports, clone = value => structuredClone(value), tick = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const accountA = { name: "测试用户", email: "account-a@example.invalid", joinedAt: null, avatar: "initial", passwordSet: true }, accountB = { ...accountA, name: "另一账号", email: "account-b@example.invalid" };
const stats = { totalTokens: null, totalTurns: null, currentStreak: null, bestStreak: null, coverage: null, days: [], rankings: {}, assets: {} };
let model = { identity: null, statistics: stats, membership: { state: "anonymous", planId: null, planName: null, expiresAt: null, verifiedAt: null, offlineUntil: null, devices: [{ id: "current", name: "本机手机", description: "iPhone · 当前设备", current: true }, { id: "other", name: "另一台电脑", description: "macOS · 最近使用", current: false }], deviceLimit: 3 }, provider: "configured", serviceAvailable: true,
  products: [{ id: "early", prices: { CNY: 1999, USD: 999 }, days: null }, { id: "month", prices: { CNY: 1234, USD: 299 }, days: 31 }, { id: "quarter", prices: { CNY: 2987, USD: 699 }, days: 93 }, { id: "year", prices: { CNY: 4000, USD: 1999 }, days: 366 }] };
const listeners = new Set(), emit = () => { for (const listener of listeners) listener(); };
const calls = { code: [], signIn: [], redeem: [], saveProfile: [], removeDevice: [], signOut: 0, purchase: 0 };
let failCode = true, failLogin = true, failRedeem = true, failProfile = true, failDevice = true, pendingRedeem, pendingProfile, pendingLogin, deferRedeem = false, deferProfile = false, deferLogin = false;
const adapter = {
  read: () => clone(model), subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }, actions: {
    async requestCode(input) { calls.code.push(clone(input)); if (failCode) throw new Error("邮件发送失败"); },
    async signIn(input) { calls.signIn.push(clone(input)); if (deferLogin) return new Promise(resolve => { pendingLogin = resolve; }); if (failLogin) throw new Error("邮箱或登录凭据无效"); model.identity = { ...accountA, email: input.email }; model.membership.state = "free"; emit(); },
    async redeem(code) { calls.redeem.push(code); if (deferRedeem) return new Promise((resolve, reject) => { pendingRedeem = { resolve, reject }; }); if (failRedeem) throw new Error(`兑换码无效 ${code}`); model.membership = { ...model.membership, state: "active", planId: "quarter", planName: "真实季卡", expiresAt: "2027-01-20", verifiedAt: "2026-10-19 10:30" }; emit(); },
    async saveProfile(input) { calls.saveProfile.push(clone(input)); if (deferProfile) return new Promise(resolve => { pendingProfile = resolve; }); if (failProfile) throw new Error("资料保存失败"); model.identity = { ...model.identity, name: input.name }; emit(); },
    async removeDevice(id) { calls.removeDevice.push(id); if (failDevice) throw new Error("设备移除失败"); model.membership.devices = model.membership.devices.filter(device => device.id !== id); emit(); },
    async signOut() { calls.signOut++; model.identity = null; model.membership = { ...model.membership, state: "anonymous", planId: null, planName: null, expiresAt: null }; emit(); },
    async selectPlan() { calls.purchase++; throw new Error("Purchases must never be sent"); }, async verify() {}, async activateDevice() {}
  }
};
const pages = [{ id: "base", content: document.createElement("div") }];
const mount = page => document.body.replaceChildren(page.content, ...(page.footer ? [page.footer] : []));
const shell = {
  hasPage: id => pages.some(page => page.id === id), get activePageId() { return pages.at(-1).id; },
  async push(page) { if (pages.at(-1).canLeave && !await pages.at(-1).canLeave()) return false; pages.push(page); mount(page); return true; },
  async back() { if (pages.at(-1).canLeave && !await pages.at(-1).canLeave()) return false; pages.pop().dispose?.(); mount(pages.at(-1)); return true; },
  async backTo(id) { while (pages.at(-1).id !== id) if (!await this.back()) return false; return true; }
};
const ctx = { document, shell, host: { accountService: adapter, settings: () => ({ settingsLanguage: "zh-CN" }) }, error: error => { throw error; } }, ui = new IPhoneAccountPages(ctx);
const body = () => pages.at(-1).content, buttons = text => [...document.querySelectorAll("button")].filter(button => button.textContent.trim() === text);
const click = async (text, index = 0) => { const button = buttons(text)[index]; assert.ok(button, `Button ${text} exists`); assert.equal(button.disabled, false, `Button ${text} is enabled`); button.click(); await tick(); };
const input = (label, value) => { const node = body().querySelector(`[aria-label="${label}"]`); assert.ok(node, `Input ${label} exists`); node.value = value; node.dispatchEvent(new Event("input", { bubbles: true })); return node; };
const clickConfirm = async text => { const confirmation = body().querySelector(".ip-settings-confirm"); assert.ok(confirmation); const button = [...confirmation.querySelectorAll("button")].find(button => button.textContent === text); assert.ok(button); button.click(); await tick(); };
try {
  await ui.open(); assert.match(body().textContent, /未登录/); assert.match(body().textContent, /注册送激活码/); assert.equal(body().querySelectorAll(".ip-account-stat").length, 4); assert.equal([...body().querySelectorAll(".ip-account-stat strong")].every(node => node.textContent === "—"), true); assert.equal(body().querySelectorAll(".ip-account-plan").length, 4); assert.match(body().querySelector('[data-plan-id="month"]').textContent, /12.34/); assert.match(body().querySelector('[data-plan-id="month"]').textContent, /31 天/); assert.equal([...body().querySelectorAll(".ip-account-plan button")].every(button => button.disabled), true); assert.equal(body().querySelector(".heatmap,.account-activity-grid"), null);
  model.statistics = { ...stats, totalTokens: 0, totalTurns: 0, currentStreak: 0, bestStreak: 0 }; emit(); assert.equal([...body().querySelectorAll(".ip-account-stat strong")].every(node => node.textContent.startsWith("0")), true);
  await click("登录 / 注册"); assert.equal(shell.activePageId, "iphone-settings-account-login"); assert.equal(buttons("获取验证码")[0].disabled, true); input("邮箱", "invalid-email"); assert.equal(buttons("获取验证码")[0].disabled, true); input("邮箱", accountA.email);
  await click("获取验证码"); assert.equal(calls.code.length, 1); assert.equal(buttons("获取验证码")[0].disabled, false); assert.match(body().textContent, /邮件发送失败/); assert.doesNotMatch(body().textContent, /秒后重发/);
  failCode = false; await click("获取验证码"); assert.match(body().textContent, /60 秒后重发/); assert.equal(calls.code[1].purpose, "login"); input("邮箱验证码", "123456");
  await click("密码登录"); assert.equal(body().querySelector('[aria-label="邮箱"]').value, accountA.email); input("密码", "abc"); assert.equal(buttons("登录")[0].disabled, false, "Password login has no invented six-character minimum"); await click("登录"); assert.equal(calls.signIn[0].method, "password"); assert.equal(body().querySelector('[aria-label="密码"]').value, "abc");
  await click("邮箱验证码"); assert.equal(body().querySelector('[aria-label="邮箱验证码"]').value, "123456"); assert.equal(body().querySelectorAll(".ip-account-segment-slider").length, 1); now += 61_000; await new Promise(resolve => setTimeout(resolve, 280)); assert.equal(buttons("获取验证码")[0].disabled, false, "Countdown is based on its expiry, not timer ticks");
  failLogin = false; await click("登录"); assert.equal(shell.activePageId, "iphone-settings-account"); assert.match(body().textContent, /免费版/); assert.equal(document.querySelector('[aria-label="密码"]'), null); assert.equal(document.querySelector('[aria-label="邮箱验证码"]'), null);
  await click("编辑资料"); input("名字", "discarded fixture name"); const savesBeforeCancel = calls.saveProfile.length, originalName = model.identity.name; await click("取消"); assert.equal(shell.activePageId, "iphone-settings-account"); assert.equal(calls.saveProfile.length, savesBeforeCancel); assert.equal(model.identity.name, originalName);
  await click("编辑资料"); const nameInput = input("名字", "保留的姓名草稿"); await click("保存"); assert.equal(nameInput.value, "保留的姓名草稿"); assert.match(body().textContent, /资料保存失败/); model.statistics.totalTurns = 5; emit(); assert.equal(body().querySelector('[aria-label="名字"]'), nameInput); assert.equal(nameInput.value, "保留的姓名草稿"); failProfile = false; await click("保存"); assert.equal(shell.activePageId, "iphone-settings-account"); assert.match(body().textContent, /保留的姓名草稿/); assert.deepEqual(calls.saveProfile.at(-1), { name: "保留的姓名草稿" }, "Saving the name leaves the avatar untouched");
  await click("设备管理2 / 3"); assert.equal(buttons("移除").length, 1, "The current device has no remove action"); await click("移除"); assert.equal(calls.removeDevice.length, 0); await clickConfirm("移除"); assert.equal(calls.removeDevice.length, 1); assert.match(body().textContent, /设备移除失败/); assert.match(body().textContent, /另一台电脑/); failDevice = false; await clickConfirm("移除"); assert.equal(body().querySelectorAll(".ip-account-device").length, 1); await shell.back(); await tick();
  await click("使用兑换码"); const redeemInput = input("兑换码", "fixture-invalid-code"); await click("兑换"); assert.equal(redeemInput.value, "fixture-invalid-code"); assert.match(body().textContent, /兑换码无效/); assert.doesNotMatch(body().textContent, /fixture-invalid-code/); assert.equal(shell.activePageId, "iphone-settings-account"); failRedeem = false; await click("兑换"); assert.match(body().textContent, /真实季卡/); assert.match(body().textContent, /2027-01-20/); assert.ok(body().querySelector('[data-plan-id="quarter"] [aria-current="true"]')); assert.equal(body().querySelector('[data-plan-id="year"] [aria-current="true"]'), null);
  model.membership = { ...model.membership, state: "lifetime", planId: "early", planName: "2.x 买断", expiresAt: null }; emit(); assert.ok(body().querySelector('[data-plan-id="early"] [aria-current="true"]')); assert.doesNotMatch(body().querySelector(".ip-account-sub").textContent, /到期/);
  model.membership = { ...model.membership, state: "offline-valid", offlineUntil: "2026-10-21" }; emit(); assert.match(body().textContent, /离线可用至 2026-10-21/); model.membership = { ...model.membership, state: "device-limit" }; emit(); assert.match(body().textContent, /设备名额已满/);
  const beforeStats = [...body().querySelectorAll(".ip-account-stat strong")].map(node => node.textContent); await click("退出登录"); assert.equal(calls.signOut, 0); await clickConfirm("退出登录"); assert.equal(calls.signOut, 1); assert.deepEqual([...body().querySelectorAll(".ip-account-stat strong")].map(node => node.textContent), beforeStats); assert.equal(calls.purchase, 0);
  model.identity = clone(accountA); model.membership.state = "free"; emit(); input("兑换码", "pending-private-code"); deferRedeem = true; await click("兑换"); model.identity = clone(accountB); emit(); assert.equal(body().querySelector('[aria-label="兑换码"]').value, ""); pendingRedeem.reject(new Error("old redemption error")); await tick(); assert.doesNotMatch(body().textContent, /old redemption error/); assert.match(body().textContent, /另一账号/);
  await click("编辑资料"); input("名字", "account B draft"); deferProfile = true; await click("保存"); model.identity = clone(accountA); emit(); assert.match(body().textContent, /账号已变化/); assert.equal(body().querySelector('[aria-label="名字"]').value, ""); pendingProfile(); await tick(); assert.equal(shell.activePageId, "iphone-settings-account-profile"); await shell.back();
  model.identity = null; model.membership.state = "anonymous"; emit(); await click("登录 / 注册"); assert.equal(body().querySelector('[aria-label="邮箱"]').value, accountA.email, "Only the email survives leaving and reopening login"); assert.equal(body().querySelector('[aria-label="密码"]').value, ""); input("邮箱验证码", "654321"); deferLogin = true; await click("登录"); model.identity = clone(accountB); model.membership.state = "free"; emit(); pendingLogin(); await tick(); assert.match(body().textContent, /账号已变化/); assert.equal(body().querySelector('[aria-label="邮箱验证码"]').value, ""); await shell.back(); await shell.back();
  assert.equal(listeners.size, 0); assert.equal(document.querySelector(".modal-container"), null); assert.equal(dom.window.localStorage.length, 0);
  const unavailable = new IPhoneAccountPages({ ...ctx, host: { settings: ctx.host.settings } }); await unavailable.open(); assert.equal(buttons("登录 / 注册")[0].disabled, true); assert.match(body().textContent, /账号服务暂不可用/); assert.equal(body().querySelectorAll(".ip-account-stat").length, 4); await shell.back();
  console.log("PASS iPhone account UI: unavailable/anonymous/free/PRO, formal pricing, code deadlines, failed drafts, inline redemption, profile/device controls, local statistics, identity races and secret disposal");
} finally { for (const page of pages) page.dispose?.(); dom.window.close(); }
