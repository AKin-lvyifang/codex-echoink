import assert from "node:assert/strict";
import { App, openTestModals } from "./obsidian-shim";
import { installProviderBrowserHost } from "./provider-discovery-dom-host";
import { mountDesktopAccountMembership } from "../settings/desktop-account-membership";
import { mountAccountMembership } from "../settings/account-membership";
import { createUnavailableAccountAdapter, type AccountActions, type AccountMembershipViewModel, type MembershipState } from "../settings/account-membership-model";

const tick = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
async function until(condition: () => boolean) { for (let i = 0; i < 180; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail("Account UI did not settle"); }
function deferred() { let resolve!: () => void, reject!: (error: Error) => void; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function button(root: ParentNode, text: string) { const found = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(node => node.textContent?.trim() === text); assert(found, `Missing button: ${text}`); return found; }
function fill(input: HTMLInputElement, value: string) { input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); }
function submit(form: HTMLFormElement) { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }
function initial(state: MembershipState = "free"): AccountMembershipViewModel {
  const empty = createUnavailableAccountAdapter().read();
  return { ...empty, identity: { name: "测试账号", email: "fixture@example.invalid", joinedAt: "2026-10-01", avatar: "initial", passwordSet: false }, serviceAvailable: true,
    membership: { ...empty.membership, state, devices: [{ id: "device-a", name: "测试设备", description: "本地测试", current: true }], deviceLimit: 2 } };
}
function fixture(value = initial(), actions: AccountActions = {}) {
  let vm = value; const listeners = new Set<() => void>();
  const host = document.body.createDiv();
  const controller = mountDesktopAccountMembership(host, { app: new App(), viewModel: vm, read: () => vm, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }, actions, language: "zh-CN", openProviders() {} });
  return { host, controller, get vm() { return vm; }, set(next: AccountMembershipViewModel) { vm = next; listeners.forEach(listener => listener()); }, detail() { const detail = host.querySelector<HTMLElement>(".desktop-account-detail")!; assert(!detail.hidden); return detail; }, dispose() { controller.dispose(); host.remove(); assert.equal(listeners.size, 0); } };
}

export async function runDesktopAccountMembershipTests() {
  installProviderBrowserHost(); HTMLElement.prototype.scrollIntoView = () => {};
  await structure(); await anonymousOverview(); await sourceFocus(); await forms(); await accountSwitch(); await redemption(); await confirmations(); await mobileDefault();
  console.log("P14 desktop account real controls: structure, states, drafts, suspend, identity, redemption and confirmation PASS");
}

async function anonymousOverview() {
  const f = fixture({ ...initial("anonymous"), identity: null }, { requestCode: async () => {}, signIn: async () => {} });
  try {
    const header = f.host.querySelector<HTMLElement>(".desktop-account-header")!;
    assert.equal((header.textContent!.match(/未登录/g) ?? []).length, 1);
    assert.equal(header.querySelector(".profile-copy h2")?.textContent, "未登录");
    assert.match(header.querySelector(".profile-copy .membership-copy p")!.textContent!, /财务和英文日记需要 PRO/);
    assert.equal(header.querySelector(".desktop-account-plan-status"), null);
    assert.equal(header.querySelectorAll(".profile-actions button").length, 1);
    const login = button(header, "登录 / 注册");
    assert.equal(login.dataset.echoinkFocusKey, "account:login");
    assert.equal(login.parentElement?.lastElementChild, login, "the only primary action stays last in reading order");
    assert.equal(login.previousElementSibling?.textContent, "注册送激活码");
    assert.equal(f.host.querySelector("input, form"), null, "the overview does not contain a login form");
    login.click();
    assert.equal(openTestModals.length, 0);
    assert.equal(f.detail().querySelectorAll('input[type="email"]').length, 1);
    assert.equal(button(f.detail(), "登录").disabled, false);
    assert.equal(f.detail().querySelector(".desktop-account-header"), null, "the login subpage remains the real form");
  } finally { f.dispose(); }
}

async function sourceFocus() {
  const f = fixture();
  const edit = button(f.host, "编辑资料"); edit.focus(); edit.click();
  f.detail().querySelector<HTMLButtonElement>(".settings-back")!.click();
  assert.equal(document.activeElement, edit, "clean Back preserves the original account entry and restores focus");
  edit.blur(); edit.click();
  const detail = f.detail(), profilePage = detail.firstElementChild;
  const name = detail.querySelector<HTMLInputElement>('input[type="text"]')!; fill(name, "保留的资料草稿");
  const password = button(detail, "设置密码"); password.blur(); password.click();
  f.detail().querySelector<HTMLButtonElement>(".settings-back")!.click();
  assert.equal(detail.firstElementChild, profilePage); assert.equal(name.value, "保留的资料草稿");
  assert.equal(document.activeElement, password, "nested Back restores its actual mouse trigger without relying on browser click focus");
  password.click(); button(f.detail(), "返回").click(); assert.equal(document.activeElement, password, "in-form return also restores the password action");
  f.set({ ...f.vm, statistics: { ...f.vm.statistics, totalTurns: 12 } });
  detail.querySelector<HTMLButtonElement>(".settings-back")!.click(); button(detail, "放弃修改").click(); await tick();
  const replacement = button(f.host, "编辑资料"); assert.notEqual(replacement, edit, "updated account overview is redrawn");
  assert.equal(document.activeElement, replacement, "redraw restores the matching source entry");
  f.dispose();
}

async function structure() {
  const f = fixture();
  assert.deepEqual(Array.from(f.host.querySelectorAll<HTMLElement>("[data-account-section]")).map(node => node.dataset.accountSection), ["identity", "usage", "benefits", "plans"]);
  assert.equal(f.host.querySelectorAll(".metrics strong").length, 4);
  assert.equal(f.host.querySelector(".metrics strong")?.textContent, "—");
  assert.match(f.host.textContent!, /当前 Vault · 本地统计/);
  assert.equal(f.host.querySelector(".heat-cell, .assets-panel, .plugin-feature-card, .desktop-account-more-usage"), null);
  assert.equal(f.host.querySelector(".desktop-account-header")?.textContent?.includes("2026-10-01"), false);
  assert.equal(f.host.querySelectorAll(".benefits-table button").length, 0);
  const benefits = f.host.querySelector<HTMLElement>('[data-echoink-focus-key="account:benefits"]')!;
  assert.equal(benefits.dataset.accountSection, "benefits"); assert.equal(benefits.tabIndex, -1);
  benefits.focus(); assert.equal(document.activeElement, benefits, "benefits can receive route focus without opening a form");
  assert.equal(f.host.querySelectorAll(".plan").length, 4);
  assert(f.host.querySelector<HTMLDetailsElement>(".plan-scope") && !f.host.querySelector<HTMLDetailsElement>(".plan-scope")!.open);
  assert(Array.from(f.host.querySelectorAll<HTMLButtonElement>(".plan button")).every(node => node.disabled));
  button(f.host, "查看统计口径").click();
  assert.match(f.host.querySelector(".desktop-account-statistics-notes")!.textContent!, /不代表厂商计费账单/);
  const models = { models: [{ name: "真实模型 A", count: 4 }], skills: [{ name: "不应出现的 Skill", count: 7 }] };
  f.set({ ...f.vm, products: [{ id: "month", prices: { CNY: 1200, USD: 450 }, days: 40 }], statistics: { ...f.vm.statistics, totalTokens: 0, rankings: { 30: models, 90: { ...models, models: [{ name: "真实模型 B", count: 9 }] }, all: models } } });
  assert.equal(f.host.querySelector(".metrics strong")?.textContent, "0");
  assert.equal(f.host.querySelectorAll(".plan").length, 4, "partial server pricing retains all fallback plans");
  const more = f.host.querySelector<HTMLDetailsElement>(".desktop-account-more-usage")!; assert(more); assert.equal(more.open, false);
  assert.equal(Array.from(more.querySelectorAll("h2, h3")).filter(node => node.textContent === "常用模型").length, 1);
  assert.equal(more.textContent?.includes("不应出现的 Skill"), false);
  more.open = true; button(more, "近 90 天").click(); assert.match(more.textContent!, /真实模型 B/);
  f.controller.suspend(); f.controller.mount(f.host); assert.equal(f.host.querySelector(".desktop-account-more-usage"), more);
  f.set({ ...f.vm, statistics: { ...f.vm.statistics, totalTurns: 1 } });
  assert.equal(f.host.querySelector<HTMLDetailsElement>(".desktop-account-more-usage")!.open, true);
  assert.equal(f.host.querySelector('[data-usage-range="90"]')?.getAttribute("aria-pressed"), "true");
  assert.equal(f.host.querySelector<HTMLElement>(".desktop-account-statistics-notes")!.hidden, false);
  f.dispose();
  const unavailable = fixture({ ...initial("unavailable"), identity: null, serviceAvailable: false });
  assert.match(unavailable.host.querySelector('[role="alert"]')!.textContent!, /账号服务暂时不可用/);
  button(unavailable.host, "登录 / 注册").click();
  assert.equal(button(unavailable.detail(), "服务暂不可用").disabled, true);
  unavailable.dispose();
  for (const state of ["anonymous", "unavailable", "free", "active", "lifetime", "offline-valid", "verification-required", "expired", "revoked", "scheduled", "device-limit", "device-required"] as const) {
    const g = fixture({ ...initial(state), membership: { ...initial(state).membership, startsAt: "2026-11-01" } }, { verify: async () => {}, activateDevice: async () => {} });
    assert.equal(!!g.host.querySelector('.desktop-account-header [data-plugin-edition="pro"]'), ["active", "lifetime", "offline-valid"].includes(state), state);
    if (state === "verification-required") assert.match(g.host.textContent!, /账号权益仍保留，请联网刷新验证/);
    if (state === "revoked") assert.match(g.host.textContent!, /授权已撤销/);
    if (state === "scheduled") assert.match(g.host.textContent!, /2026-11-01/);
    if (state === "device-limit") assert.match(g.host.textContent!, /账号权益仍保留，请先管理旧设备名额/);
    if (state === "device-required") assert(button(g.host, "在此设备启用"));
    g.dispose();
  }
}

async function forms() {
  let fail = true, savedName = "", saveGate: ReturnType<typeof deferred> | null = null, f!: ReturnType<typeof fixture>;
  f = fixture(initial(), { saveProfile: async input => { savedName = input.name; if (saveGate) await saveGate.promise; if (fail) throw new Error("资料保存失败"); }, setPassword: async () => { f.set({ ...f.vm, identity: { ...f.vm.identity!, passwordSet: true } }); }, requestCode: async () => {} });
  button(f.host, "编辑资料").click(); assert.equal(openTestModals.length, 0);
  let detail = f.detail(); const name = detail.querySelector<HTMLInputElement>('input[type="text"]')!; fill(name, "未保存昵称");
  assert.match(detail.textContent!, /注册时间：2026-10-01/);
  const originalCreate = window.URL.createObjectURL, originalRevoke = window.URL.revokeObjectURL;
  const revoked: string[] = []; window.URL.createObjectURL = () => "blob:account-draft"; window.URL.revokeObjectURL = url => { revoked.push(url); };
  try {
    const picker = detail.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(picker, "files", { configurable: true, value: [new window.File(["image"], "avatar.png", { type: "image/png" })] }); picker.dispatchEvent(new Event("change"));
    const profilePage = detail.firstElementChild;
    button(detail, "设置密码").click(); detail = f.detail();
    fill(detail.querySelector<HTMLInputElement>('input[inputmode="numeric"]')!, "123456");
    detail.querySelectorAll<HTMLInputElement>('input[type="password"]').forEach(input => fill(input, "fixture-password"));
    button(detail, "确认").click(); await tick();
    assert.equal(detail.querySelectorAll("form").length, 1, "password save returns to the retained profile form");
    // Reopen profile is unnecessary: the previous page is retained by the frame stack.
    assert.equal(detail.firstElementChild, profilePage);
    assert.equal(name.value, "未保存昵称"); assert.equal(detail.querySelector("img")?.getAttribute("src"), "blob:account-draft"); assert.deepEqual(revoked, []);
    assert.match(detail.querySelector(".password-setting")!.textContent!, /已设置/);
    assert(button(detail, "修改密码"));
    f.controller.suspend(); const nextHost = document.body.createDiv(); f.controller.mount(nextHost);
    assert.equal(nextHost.querySelector('input[type="text"]'), name); assert.equal(name.value, "未保存昵称");
    f.controller.suspend(); f.controller.mount(f.host); nextHost.remove();
    const form = detail.querySelector("form")!; button(detail, "保存资料").click(); await tick();
    assert.equal(savedName, "未保存昵称"); assert.equal(name.value, "未保存昵称"); assert.match(detail.textContent!, /资料保存失败/);
    assert.equal(button(detail, "保存资料").disabled, false);
    saveGate = deferred(); button(detail, "保存资料").click(); assert.equal(f.controller.submitting, true);
    let leave = 0; f.controller.requestLeave(() => { leave++; }); assert.equal(leave, 0);
    f.controller.suspend(); saveGate.reject(new Error("后台保存失败")); await tick(); f.controller.mount(f.host);
    assert.equal(button(detail, "保存资料").disabled, false, "suspended rejection restores retry"); assert.match(detail.textContent!, /后台保存失败/);
    assert.equal(name.value, "未保存昵称"); assert.equal(form, detail.querySelector("form"));
    f.controller.requestLeave(() => { leave++; }); button(detail, "继续编辑").click(); assert.equal(leave, 0); assert.equal(f.controller.hasDraft, true);
    f.controller.requestLeave(() => { leave++; }); button(detail, "放弃修改").click(); await tick(); assert.equal(leave, 1); assert.equal(name.value, ""); assert.deepEqual(revoked, ["blob:account-draft"]);
    assert.equal(f.controller.hasDraft, false); f.controller.requestLeave(() => { leave++; }); assert.equal(leave, 2);
    button(f.host, "编辑资料").click(); fail = false; saveGate = null; button(f.detail(), "保存资料").click(); await tick(); assert.equal(f.host.querySelector<HTMLElement>(".desktop-account-detail")!.hidden, true);
    assert.equal(document.activeElement, button(f.host, "编辑资料"), "successful submit restores source after action release and overview refresh");
  } finally { f.dispose(); window.URL.createObjectURL = originalCreate; window.URL.revokeObjectURL = originalRevoke; }

  const authCalls: unknown[] = [], codeGate = deferred();
  const a = fixture({ ...initial("anonymous"), identity: null }, { requestCode: async input => { authCalls.push(input); await codeGate.promise; }, signIn: async input => { authCalls.push(input); throw new Error("登录失败"); }, resetPassword: async input => { authCalls.push(input); throw new Error("重置失败"); } });
  button(a.host, "登录 / 注册").click(); detail = a.detail();
  fill(detail.querySelector<HTMLInputElement>('input[type="email"]')!, "login@example.invalid");
  const send = button(detail, "获取验证码"); send.click(); send.click(); assert.equal(authCalls.length, 1); codeGate.resolve(); await tick();
  fill(detail.querySelector<HTMLInputElement>('input[inputmode="numeric"]')!, "123456"); button(detail, "登录").click(); await tick();
  assert.deepEqual(authCalls[1], { email: "login@example.invalid", method: "code", credential: "123456" });
  button(detail, "密码登录").click(); const secret = detail.querySelector<HTMLInputElement>('input[type="password"]')!; fill(secret, "fixture-login-password"); button(detail, "登录").click(); await tick();
  assert.equal(secret.value, "fixture-login-password", "failed desktop password action retains draft");
  button(detail, "忘记密码").click(); detail = a.detail(); assert.equal(openTestModals.length, 0); assert.equal(detail.querySelectorAll('input[type="password"]').length, 2);
  fill(detail.querySelector<HTMLInputElement>('input[inputmode="numeric"]')!, "123456"); detail.querySelectorAll<HTMLInputElement>('input[type="password"]').forEach(input => fill(input, "fixture-new-password")); button(detail, "确认").click(); await tick();
  assert.match(detail.textContent!, /重置失败/); assert.equal(detail.querySelector<HTMLInputElement>('input[type="password"]')!.value, "fixture-new-password");
  a.dispose(); assert.equal(secret.value, "");
}

async function accountSwitch() {
  const gate = deferred(); const f = fixture(initial(), { saveProfile: async () => gate.promise });
  button(f.host, "编辑资料").click(); const name = f.detail().querySelector<HTMLInputElement>('input[type="text"]')!; fill(name, "旧账号私有草稿"); button(f.detail(), "保存资料").click();
  f.set({ ...initial(), identity: { ...initial().identity!, email: "next@example.invalid", name: "新账号" } }); assert.equal(name.value, ""); assert.equal(f.controller.submitting, false); assert.equal(f.controller.hasDraft, false);
  gate.reject(new Error("旧账号请求失败")); await tick(); assert.match(f.host.textContent!, /新账号/); assert.equal(f.host.textContent?.includes("旧账号请求失败"), false); f.dispose();
}

async function redemption() {
  let gate = deferred(), calls = 0, mode: "pending" | "no-rights" | "success" = "pending", f!: ReturnType<typeof fixture>;
  f = fixture(initial(), { redeem: async () => { calls++; if (mode === "pending") await gate.promise; if (mode === "success") f.set({ ...f.vm, membership: { ...f.vm.membership, state: "active", planId: "month" } }); } });
  const open = () => { button(f.host, "使用兑换码").click(); return f.host.querySelector<HTMLFormElement>(".activation-form")!; };
  let form = open(); open(); assert.equal(f.host.querySelectorAll(".activation-form").length, 1);
  submit(form); assert.match(form.textContent!, /请输入兑换码/); assert.equal(calls, 0);
  const code = form.querySelector("input")!; fill(code, "FIXTURE-CODE"); submit(form); assert.equal(calls, 1); assert.equal(code.readOnly, true); assert.equal(button(form, "取消").disabled, true);
  button(form, "取消").click(); open(); submit(form); assert.equal(calls, 1, "pending cancel and reentry cannot submit again");
  f.controller.suspend(); gate.reject(new Error("兑换服务失败")); await tick(); f.controller.mount(f.host);
  assert.equal(code.value, "FIXTURE-CODE"); assert.equal(code.readOnly, false); assert.equal(button(form, "兑换").disabled, false); assert.match(form.textContent!, /兑换服务失败/);
  mode = "no-rights"; submit(form); await tick(); assert.match(form.textContent!, /本机授权尚未生效/); assert.equal(code.value, "FIXTURE-CODE");
  mode = "success"; submit(form); await tick(); assert.match(form.textContent!, /兑换码使用成功/); assert.equal(f.controller.submitting, true); assert.equal(code.readOnly, true);
  f.controller.suspend(); await until(() => !f.controller.submitting); f.controller.mount(f.host); assert.equal(f.host.querySelector(".activation-form"), null); assert.equal(code.value, ""); assert(f.host.querySelector('.desktop-account-header [data-plugin-edition="pro"]')); f.dispose();

  gate = deferred(); const g = fixture(initial(), { redeem: async () => gate.promise }); button(g.host, "使用兑换码").click(); form = g.host.querySelector(".activation-form")!;
  const oldCode = form.querySelector("input")!; fill(oldCode, "OLD-ACCOUNT-CODE"); submit(form);
  g.set({ ...initial(), identity: { ...initial().identity!, email: "new@example.invalid" } }); assert.equal(oldCode.value, ""); gate.resolve(); await tick();
  assert.equal(g.host.textContent?.includes("兑换码使用成功"), false); assert.equal(g.host.querySelector(".activation-form"), null); g.dispose();
}

async function confirmations() {
  let signouts = 0, removals = 0, renames = 0;
  const f = fixture(initial(), { signOut: async () => { signouts++; throw new Error("退出失败"); }, removeDevice: async id => { assert.equal(id, "device-a"); removals++; throw new Error("解绑失败"); }, renameDevice: async (id, name) => { assert.equal(id, "device-a"); assert.equal(name, "改名设备"); renames++; throw new Error("改名失败"); } });
  assert(!button(f.host, "退出登录").classList.contains("echoink-delete-button"));
  button(f.host, "退出登录").click();
  assert(!button(f.host.querySelector(".echoink-settings-inline-confirm")!, "退出登录").classList.contains("echoink-delete-button"));
  button(f.host.querySelector(".echoink-settings-inline-confirm")!, "取消").click(); assert.equal(signouts, 0);
  button(f.host, "退出登录").click(); button(f.host.querySelector(".echoink-settings-inline-confirm")!, "退出登录").click(); await tick(); assert.equal(signouts, 1); assert.match(f.host.textContent!, /退出失败/);
  f.host.querySelector<HTMLButtonElement>('.membership-footer [aria-label^="设备管理"]')!.click(); const detail = f.detail();
  assert(button(detail, "解绑本机").classList.contains("echoink-delete-button"));
  button(detail, "解绑本机").click();
  assert(button(detail, "确认解绑").classList.contains("echoink-delete-button"));
  assert(!button(detail.querySelector(".echoink-settings-inline-confirm")!, "取消").classList.contains("echoink-delete-button"));
  button(detail.querySelector(".echoink-settings-inline-confirm")!, "取消").click(); assert.equal(removals, 0);
  button(detail, "解绑本机").click(); button(detail, "确认解绑").click(); await tick(); assert.equal(removals, 1); assert.match(detail.textContent!, /解绑失败/);
  button(detail, "改名").click(); fill(detail.querySelector<HTMLInputElement>('input[type="text"]')!, "改名设备"); button(detail, "保存名称").click(); await tick(); assert.equal(renames, 1); assert.match(detail.textContent!, /改名失败/); assert.equal(f.controller.hasDraft, true); f.dispose();
}

async function mobileDefault() {
  const host = document.body.createDiv(); const handle = mountAccountMembership(host, { app: new App(), viewModel: { ...initial("anonymous"), identity: null }, language: "zh-CN", openProviders() {} });
  assert.equal(host.querySelector('[data-echoink-focus-key="account:login"], [data-echoink-focus-key="account:benefits"]'), null, "desktop route anchors do not change mobile DOM");
  assert.equal(host.querySelectorAll(".heat-cell").length, 365); assert.equal(host.querySelector(".echoink-desktop-account-settings"), null); button(host, "登录 / 注册").click(); assert.equal(openTestModals.length, 1); handle.dispose(); assert.equal(openTestModals.length, 0); host.remove();
}
