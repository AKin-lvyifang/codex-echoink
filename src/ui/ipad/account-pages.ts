import { formatMobileDate, formatMobileDateTime } from "../../mobile/date-display";
import { Notice } from "obsidian";
import { createUnavailableAccountAdapter, type AccountMembershipAdapter, type AccountMembershipViewModel, type MembershipState } from "../../settings/account-membership-model";
import { getMembershipPlanPricing, resolveMembershipCurrency, type MembershipCurrency, type MembershipPlanId } from "../../settings/account-membership-pricing";
import { createPluginEditionBadge } from "../../settings/plugin-edition-badge";
import type { MobileShellPage } from "../mobile/shell-types";
import { ipadIcon } from "./workbench-elements";
import { settingsText as t } from "./settings-i18n";
import { el, settingsContent, settingsRow, settingsAction, settingsField, settingsError, showSettingsError, liveSettingsPage, leaveSettingsConfirm, type IPadSettingsContext } from "./settings-elements";

const validPro = (vm: AccountMembershipViewModel): boolean => ["active", "lifetime", "offline-valid"].includes(vm.membership.state);
const accountKey = (api: AccountMembershipAdapter): string | null => api.read().identity?.email.trim().toLowerCase() ?? null;
const english = (ctx: IPadSettingsContext): boolean => ctx.host.settings().settingsLanguage === "en";
const planNames: Record<MembershipPlanId, string> = { early: "早鸟买断", month: "月卡", quarter: "季卡", year: "年卡" };
const stateNames: Record<MembershipState, string> = { unavailable: "服务暂不可用", anonymous: "未登录", free: "免费版", active: "有效", lifetime: "2.x 买断权益", "offline-valid": "离线可用", "verification-required": "需要联网验证", expired: "已到期", revoked: "已撤销", "device-limit": "设备名额已满", "device-required": "本机待激活", scheduled: "尚未生效" };
const emailValid = (email: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email.trim());
function cleanFailure(failure: unknown, secrets: string[]): string {
  let message = failure instanceof Error ? failure.message : String(failure);
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) message = message.split(secret).join("[redacted]"); return message;
}
function setLabel(button: HTMLButtonElement, label: string): void { button.firstElementChild!.textContent = label; }
function bar(ctx: IPadSettingsContext, parent: HTMLElement): HTMLElement { const row = el(ctx.document, "div", "pd-settings-actions"); parent.append(row); return row; }
function edition(ctx: IPadSettingsContext, parent: HTMLElement): void { createPluginEditionBadge(parent, "pro", english(ctx) ? "en" : "zh-CN"); }
function inlineConfirm(ctx: IPadSettingsContext, area: HTMLElement, message: string, label: string, apply: () => Promise<void>): void {
  const box = el(ctx.document, "div", "pd-settings-confirm"), actions = bar(ctx, box); box.prepend(el(ctx.document, "p", "", t(ctx, message)));
  actions.append(settingsAction(ctx, "取消", () => area.replaceChildren()), settingsAction(ctx, label, apply, true)); area.replaceChildren(box);
}

/** The adapter owns account generations; this guard also rejects stale UI completions. */
function accountView(ctx: IPadSettingsContext, api: AccountMembershipAdapter, id: string, title: string) {
  const content = settingsContent(ctx), fields = el(ctx.document, "fieldset", "pd-account-fields"), error = settingsError(ctx), leaveArea = el(ctx.document, "div", "pd-account-leave");
  content.classList.add("pd-account"); content.append(fields, error, leaveArea);
  let disposed = false, busy = false, nested = false, allowLeave = false, identity = accountKey(api), identityGeneration = 0, operation = 0, leave: Promise<boolean> | undefined;
  const cleanup: (() => void)[] = [];
  const state = {
    content, fields, error, leaveArea, page: { id, title, content } as MobileShellPage,
    get alive() { return !disposed; }, get busy() { return busy; }, dirty: () => false, discard: () => {}, update: () => {},
    changed: () => { allowLeave = false; error.hidden = true; }, allow: () => { allowLeave = true; },
    report: (failure: unknown, secrets: string[] = []) => { if (!disposed) showSettingsError(error, t(ctx, cleanFailure(failure, secrets))); },
    cleanup: (dispose: () => void) => cleanup.push(dispose),
    async run(action: () => Promise<void>, secrets: string[] = [], transition?: { identity: string | null }): Promise<boolean> {
      if (disposed || busy) return false;
      const ticket = ++operation, generation = identityGeneration, started = accountKey(api); busy = true; fields.disabled = true; error.hidden = true; content.setAttribute("aria-busy", "true"); state.update();
      const current = () => !disposed && operation === ticket && (transition
        ? identityGeneration <= generation + 1 && accountKey(api) === transition.identity
        : identityGeneration === generation && accountKey(api) === started);
      try { await action(); return current(); }
      catch (failure) { if (!disposed && operation === ticket && (identityGeneration === generation || transition && identityGeneration <= generation + 1 && accountKey(api) === transition.identity)) state.report(failure, secrets); return false; }
      finally { if (!disposed && operation === ticket) { busy = false; fields.disabled = false; content.setAttribute("aria-busy", "false"); state.update(); } }
    },
    async child(page: MobileShellPage): Promise<void> { if (disposed || busy) { page.dispose?.(); return; } nested = true; try { await ctx.push(page); } finally { nested = false; } },
    bind(refresh: () => void): MobileShellPage {
      state.page.canLeave = async () => {
        if (busy) return false;
        if (nested || allowLeave || !state.dirty()) return true;
        const allowed = await (leave ??= leaveSettingsConfirm(ctx, leaveArea).then(value => { leave = undefined; return value; }));
        if (allowed) { state.discard(); allowLeave = true; } return allowed;
      };
      const changed = () => { const next = accountKey(api); if (next !== identity) { identity = next; identityGeneration++; } refresh(); };
      state.page.dispose = () => { if (disposed) return; disposed = true; operation++; cleanup.forEach(dispose => dispose()); content.querySelectorAll<HTMLInputElement>("input").forEach(input => { input.value = ""; }); };
      const page = liveSettingsPage(ctx, state.page, changed), unsubscribe = api.subscribe?.(() => changed()); if (unsubscribe) cleanup.push(unsubscribe); return page;
    }
  };
  return state;
}

export function createAccountPage(ctx: IPadSettingsContext): MobileShellPage {
  const api: AccountMembershipAdapter = ctx.host.accountService ?? createUnavailableAccountAdapter(), v = accountView(ctx, api, "ipad-settings-account", "账号与会员");
  const head = el(ctx.document, "div", "pd-account-head-area"), notices = el(ctx.document, "div", "pd-account-notices"), usage = el(ctx.document, "div", "pd-account-stats"), benefits = el(ctx.document, "div", "pd-account-benefits"), plans = el(ctx.document, "div", "pd-account-plans");
  const usageHeading = heading(ctx, v.fields, "我的使用"); usageHeading.append(el(ctx.document, "span", "pd-account-location", t(ctx, "当前 Vault · 本地")));
  v.fields.prepend(head, notices); v.fields.append(usage); const benefitsHeading = heading(ctx, v.fields, "权益对比"); v.fields.append(benefits);
  const purchaseHeading = heading(ctx, v.fields, "购买方案"), redemption = el(ctx.document, "div", "pd-account-redemption"), redeemFeedback = settingsError(ctx);
  let redeemCode = "", redeemOpen = false, redeeming = false, identity = accountKey(api), headKey = "", planKey = "", language = "";
  const code = settingsField(ctx, redemption, t(ctx, "兑换码"), "", value => { redeemCode = value; v.changed(); redeemFeedback.hidden = true; update(); }); code.autocomplete = "off"; code.spellcheck = false; code.placeholder = t(ctx, "输入兑换码"); code.previousElementSibling?.remove();
  const redeem = settingsAction(ctx, "兑换", async () => {
    if (!api.read().identity || !api.actions.redeem || !redeemCode.trim()) return;
    redeeming = true; const submitted = redeemCode.trim(), saved = await v.run(async () => { await api.actions.redeem!(submitted); }, [submitted]); redeeming = false; update();
    if (!saved || !v.alive) {
      if (v.alive && !v.error.hidden) {
        redeemFeedback.classList.remove("pd-account-feedback"); redeemFeedback.classList.add("pd-settings-error"); redeemFeedback.setAttribute("role", "alert");
        showSettingsError(redeemFeedback, v.error.textContent ?? ""); v.error.hidden = true;
        redeemFeedback.scrollIntoView({ block: "nearest" });
      }
      return;
    }
    if (!validPro(api.read())) { v.report(t(ctx, "兑换后本机授权尚未生效，请重新验证权益。")); return; }
    redeemCode = ""; code.value = ""; status(redeemFeedback, t(ctx, "兑换成功")); ctx.refresh(); render();
  }, true); redemption.append(redeem, redeemFeedback); redemption.hidden = true;
  const toggle = settingsAction(ctx, "使用兑换码", () => {
    redeemOpen = !redeemOpen; redemption.hidden = !redeemOpen; toggle.setAttribute("aria-expanded", String(redeemOpen));
    if (redeemOpen) { if (!api.read().identity) showSettingsError(redeemFeedback, t(ctx, "请先登录账号。")); code.focus(); }
  }); toggle.classList.add("pd-account-text-action"); toggle.setAttribute("aria-expanded", "false"); purchaseHeading.append(toggle); v.fields.append(redemption, plans);
  const lifetime = el(ctx.document, "details", "pd-account-lifetime"); lifetime.append(el(ctx.document, "summary", "", t(ctx, "买断包含什么")), el(ctx.document, "div", "pd-account-lifetime-body", t(ctx, "包含购买时的 2.x 版本 PRO 插件，长期可用；不包含 3.x、以后的新插件和模型调用额度。需要定期联网更新授权。"))); v.fields.append(lifetime);
  v.dirty = () => !!redeemCode.trim(); v.discard = () => { redeemCode = ""; code.value = ""; };
  v.cleanup(() => { redeemCode = ""; });
  function update(): void { if (!v.alive) return; const vm = api.read(); redeem.disabled = v.busy || !vm.identity || !vm.serviceAvailable || !api.actions.redeem || !redeemCode.trim(); setLabel(redeem, t(ctx, v.busy && redeeming ? "兑换中…" : "兑换")); }
  v.update = update;
  function render(): void {
    if (!v.alive) return; const vm = api.read(), nextIdentity = accountKey(api);
    if (identity !== nextIdentity) { identity = nextIdentity; redeemCode = ""; code.value = ""; redeemFeedback.hidden = true; v.error.hidden = true; }
    const nextHead = JSON.stringify([vm.identity, vm.membership, vm.serviceAvailable, ctx.host.settings().settingsLanguage]);
    if (nextHead !== headKey) {
      headKey = nextHead; head.replaceChildren(); const row = el(ctx.document, "div", "pd-account-head"), avatar = el(ctx.document, "span", "pd-account-avatar"), copy = el(ctx.document, "div", "pd-account-copy"), name = el(ctx.document, "div", "pd-account-name");
      if (vm.identity?.avatar && vm.identity.avatar !== "initial") { const image = el(ctx.document, "img", ""); image.src = vm.identity.avatar.url; image.alt = ""; avatar.append(image); }
      else if (vm.identity) avatar.textContent = (Array.from(vm.identity.name || vm.identity.email)[0] ?? "").toUpperCase();
      else { avatar.classList.add("is-out"); avatar.append(ipadIcon(ctx.document, "user")); }
      name.append(el(ctx.document, "span", "", vm.identity?.name || vm.identity?.email || t(ctx, "未登录")));
      if (vm.identity) {
        if (validPro(vm)) edition(ctx, name); else name.append(el(ctx.document, "span", "pd-account-free", t(ctx, stateNames[vm.membership.state])));
        const membership = vm.membership, planId = membership.planId ?? (membership.state === "lifetime" ? "early" : null), plan = membership.planName || (planId && planId in planNames ? t(ctx, planNames[planId as MembershipPlanId]) : "");
        const lifetime = membership.state === "lifetime" || planId === "early";
        const details = validPro(vm) || plan ? [plan, !lifetime && membership.expiresAt ? `${formatMobileDate(membership.expiresAt)} ${t(ctx, "到期")}` : "", membership.verifiedAt ? `${formatMobileDateTime(membership.verifiedAt, Date.now(), english(ctx) ? "en" : "zh-CN")} ${t(ctx, "已验证")}` : "", !["active", "lifetime", "free"].includes(membership.state) ? t(ctx, stateNames[membership.state]) : ""].filter(Boolean).join(" · ") : vm.identity.email;
        copy.append(name, el(ctx.document, "div", "pd-account-sub", details));
      } else {
        copy.append(name); const login = el(ctx.document, "div", "pd-account-login-actions"), button = settingsAction(ctx, "登录 / 注册", () => v.child(createLoginPage(ctx, api)), true); button.disabled = !vm.serviceAvailable || !api.actions.signIn;
        login.append(button, el(ctx.document, "span", "pd-account-gift", t(ctx, "注册送激活码"))); copy.append(login);
      }
      row.append(avatar, copy); head.append(row);
      if (vm.identity) {
        const group = el(ctx.document, "div", "pd-settings-group pd-account-links"), outArea = el(ctx.document, "div", "pd-account-inline-confirm"); head.append(group);
        settingsRow(ctx, group, t(ctx, "编辑资料"), "", () => v.child(createProfilePage(ctx, api)));
        settingsRow(ctx, group, t(ctx, "设备管理"), vm.membership.devices ? `${vm.membership.devices.length} / ${vm.membership.deviceLimit ?? "—"}` : "—", () => v.child(createDevicesPage(ctx, api)));
        settingsRow(ctx, group, t(ctx, "退出登录"), "", () => inlineConfirm(ctx, outArea, "退出后这台设备不再使用 PRO 功能，已保存的内容不受影响。", "退出登录", async () => {
          const saved = await v.run(async () => { if (!api.actions.signOut) throw new Error(t(ctx, "账号服务暂不可用。")); await api.actions.signOut(); }, [], { identity: null });
          if (saved) { redeemCode = ""; code.value = ""; ctx.refresh(); render(); }
        }), undefined, undefined, false); group.append(outArea);
      }
    }
    notices.replaceChildren(); for (const message of [!vm.serviceAvailable ? t(ctx, "账号服务暂不可用。") : "", vm.storageNotice, vm.verificationError]) if (message) { const node = el(ctx.document, "div", "pd-settings-error", t(ctx, message)); node.setAttribute("role", "status"); notices.append(node); }
    if (vm.identity && ["verification-required", "device-limit", "device-required", "offline-valid", "expired", "revoked", "scheduled"].includes(vm.membership.state)) {
      const actions = bar(ctx, notices);
      const verify = settingsAction(ctx, "重新验证", async () => { await v.run(async () => { await api.actions.verify!(); }); render(); });
      verify.disabled = v.busy || !vm.serviceAvailable || !api.actions.verify; actions.append(verify);
      if (vm.membership.state === "device-required") {
        const activate = settingsAction(ctx, "启用本机", async () => { await v.run(async () => { await api.actions.activateDevice!(); }); render(); }, true);
        activate.disabled = v.busy || !vm.serviceAvailable || !api.actions.activateDevice; actions.append(activate);
      }
    }
    const nextLanguage = ctx.host.settings().settingsLanguage;
    if (language !== nextLanguage) {
      language = nextLanguage; renderBenefits(ctx, benefits); usageHeading.querySelector("h2")!.textContent = t(ctx, "我的使用"); usageHeading.querySelector(".pd-account-location")!.textContent = t(ctx, "当前 Vault · 本地");
      benefitsHeading.querySelector("h2")!.textContent = t(ctx, "权益对比"); purchaseHeading.querySelector("h2")!.textContent = t(ctx, "购买方案"); setLabel(toggle, t(ctx, "使用兑换码"));
      lifetime.querySelector("summary")!.textContent = t(ctx, "买断包含什么"); lifetime.lastElementChild!.textContent = t(ctx, "包含购买时的 2.x 版本 PRO 插件，长期可用；不包含 3.x、以后的新插件和模型调用额度。需要定期联网更新授权。");
      code.setAttribute("aria-label", t(ctx, "兑换码")); code.placeholder = t(ctx, "输入兑换码");
    }
    renderStatistics(ctx, usage, vm);
    const nextPlans = JSON.stringify([vm.products, vm.membership.planId, vm.membership.state, nextLanguage]);
    if (planKey !== nextPlans) { planKey = nextPlans; renderPlans(ctx, plans, vm); }
    update();
  }
  return v.bind(render);
}

function heading(ctx: IPadSettingsContext, parent: HTMLElement, title: string): HTMLElement { const row = el(ctx.document, "div", "pd-account-section-heading"); row.append(el(ctx.document, "h2", "pd-settings-label", t(ctx, title))); parent.append(row); return row; }
function status(node: HTMLElement, message: string): void { node.textContent = message; node.hidden = false; node.classList.remove("pd-settings-error"); node.classList.add("pd-account-feedback"); node.setAttribute("role", "status"); }
function renderStatistics(ctx: IPadSettingsContext, parent: HTMLElement, vm: AccountMembershipViewModel): void {
  const rows = [["累计估算 Token", vm.statistics.totalTokens, ""], ["完成的对话轮次", vm.statistics.totalTurns, ""], ["当前连续使用", vm.statistics.currentStreak, "天"], ["最长连续使用", vm.statistics.bestStreak, "天"]] as const;
  if (!parent.childElementCount) for (const [label] of rows) { const card = el(ctx.document, "div", "pd-account-stat"); card.append(el(ctx.document, "span", "", t(ctx, label)), el(ctx.document, "strong", "")); parent.append(card); }
  rows.forEach(([label, value, unit], index) => {
    const card = parent.children[index]; card.firstElementChild!.textContent = t(ctx, label); const number = card.lastElementChild!;
    const text = value === null || !Number.isFinite(value) ? "—" : value.toLocaleString(english(ctx) ? "en-US" : "zh-CN");
    number.replaceChildren(ctx.document.createTextNode(text)); if (unit && value !== null) number.append(el(ctx.document, "small", "", t(ctx, unit)));
  });
}
function renderBenefits(ctx: IPadSettingsContext, parent: HTMLElement): void {
  parent.replaceChildren(); const scroll = el(ctx.document, "div", "pd-account-comparison-scroll"), table = el(ctx.document, "table", "pd-account-comparison"), header = el(ctx.document, "thead", ""), headerRow = el(ctx.document, "tr", "");
  for (const label of ["功能", "免费", "PRO"]) { const cell = el(ctx.document, "th", "", t(ctx, label)); cell.scope = "col"; headerRow.append(cell); } header.append(headerRow); table.append(header);
  const groups = [{ title: "基础能力", pro: false, rows: [["Agent 对话", "多个 Agent、任务继续"], ["知识库", "整理、检索与补链"], ["长期记忆", ""], ["日记、复盘、待办", ""], ["选文提问", ""], ["Skills 与 MCP", ""]] },
    { title: "PRO 插件", pro: true, rows: [["财务", "记账、导入账单、预算与分析"], ["英文日记", "英文稿与表达库"], ["PDF 精读 · 提取", "原文、译文、精读、摘要（仅电脑）"]] }];
  const body = el(ctx.document, "tbody", "");
  for (const group of groups) {
    const headingRow = el(ctx.document, "tr", "pd-account-benefit-group"), headingCell = el(ctx.document, "th", "", t(ctx, group.title)); headingCell.colSpan = 3; headingCell.scope = "colgroup"; if (group.pro) edition(ctx, headingCell); headingRow.append(headingCell); body.append(headingRow);
    for (const [name, description] of group.rows) {
      const row = el(ctx.document, "tr", ""), label = el(ctx.document, "td", "", t(ctx, name)); if (description) label.append(el(ctx.document, "span", "pd-account-feature-description", t(ctx, description))); row.append(label);
      for (const included of [!group.pro, true]) { const cell = el(ctx.document, "td", included ? "is-included" : "is-excluded"); cell.append(ipadIcon(ctx.document, included ? "check" : "minus"), el(ctx.document, "span", "pd-account-sr", t(ctx, included ? "包含" : "不含"))); row.append(cell); } body.append(row);
    }
  }
  table.append(body); scroll.append(table); parent.append(scroll);
}
function renderPlans(ctx: IPadSettingsContext, parent: HTMLElement, vm: AccountMembershipViewModel): void {
  let zone: string | undefined; try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { /* Formal pricing supplies the international fallback. */ }
  const currency: MembershipCurrency = resolveMembershipCurrency(zone), symbol = currency === "CNY" ? "¥" : "US$";
  const money = (minor: number, daily = false) => (minor / 100).toLocaleString(english(ctx) ? "en-US" : "zh-CN", { minimumFractionDigits: daily || currency === "USD" ? 2 : 0, maximumFractionDigits: 2 });
  parent.replaceChildren();
  for (const plan of getMembershipPlanPricing(currency, vm.products)) {
    const active = validPro(vm) && (vm.membership.planId ?? (vm.membership.state === "lifetime" ? "early" : null)) === plan.id;
    const card = el(ctx.document, "article", `pd-account-plan${plan.id === "early" ? " is-early" : ""}`); card.dataset.planId = plan.id;
    const name = el(ctx.document, "div", "pd-account-plan-name", t(ctx, planNames[plan.id]));
    if (active) name.append(el(ctx.document, "span", "pd-account-current-plan", t(ctx, "使用中")));
    const price = el(ctx.document, "div", "pd-account-price"); price.append(el(ctx.document, "span", "pd-account-currency", symbol), el(ctx.document, "span", "", money(plan.amountMinor)));
    if (plan.id !== "early" && plan.savingsPercent !== null && plan.savingsPercent > 0) price.append(el(ctx.document, "span", "pd-account-saving", english(ctx) ? `Save ${plan.savingsPercent}%` : `省 ${plan.savingsPercent}%`));
    card.append(name, price, el(ctx.document, "div", "pd-account-plan-detail", plan.days === null ? t(ctx, "一次购买") : english(ctx) ? `${plan.days} days` : `${plan.days} 天`), el(ctx.document, "div", "pd-account-plan-detail", plan.dailyAmountMinor === null ? t(ctx, "当前 2.x 版本长期可用") : english(ctx) ? `About ${symbol}${money(plan.dailyAmountMinor, true)} / day` : `每天约 ${symbol}${money(plan.dailyAmountMinor, true)}`));
    const button = el(ctx.document, "button", "pd-settings-action"); button.type = "button"; button.disabled = true; button.append(el(ctx.document, "span", "pd-settings-action-visible", t(ctx, active ? "续费待开放" : "购买待开放"))); card.append(button); parent.append(card);
  }
}

function createLoginPage(ctx: IPadSettingsContext, api: AccountMembershipAdapter): MobileShellPage {
  const v = accountView(ctx, api, "ipad-account-login", "登录 / 注册"), feedback = el(ctx.document, "div", "pd-account-feedback"), mode = el(ctx.document, "div", "pd-account-mode"), credentials = el(ctx.document, "div", "pd-account-credentials");
  const formWindow = ctx.document.defaultView!;
  let email = "", method: "code" | "password" = "code", code = "", password = "", sending = false, identity = accountKey(api), sentEmail = "", deadline = 0, timer: number | undefined;
  const emailInput = settingsField(ctx, v.fields, t(ctx, "邮箱"), email, value => { email = value; v.changed(); update(); }, "email"); emailInput.autocomplete = "email"; emailInput.placeholder = "name@example.com";
  mode.setAttribute("role", "group"); mode.setAttribute("aria-label", t(ctx, "登录方式")); mode.append(el(ctx.document, "span", "pd-account-mode-thumb"));
  const choices = new Map<string, HTMLButtonElement>();
  for (const [value, label] of [["code", "邮箱验证码"], ["password", "密码登录"]] as const) {
    const button = el(ctx.document, "button", "pd-account-mode-button", t(ctx, label)); button.type = "button";
    button.addEventListener("click", () => { if (v.busy || method === value) return; method = value; renderCredential(); update(); }); choices.set(value, button); mode.append(button);
  }
  v.fields.append(mode, credentials, feedback); feedback.setAttribute("role", "status");
  const footer = el(ctx.document, "div", "pd-settings-actions"), login = settingsAction(ctx, "登录", async () => {
    const address = email.trim().toLowerCase(), credential = method === "code" ? code : password;
    if (!emailValid(address) || !credential || !api.actions.signIn) return;
    sending = false;
    const saved = await v.run(async () => { await api.actions.signIn!({ email: address, method, credential }); }, [credential], { identity: address });
    if (!saved || !v.alive) return; code = ""; password = ""; v.allow(); ctx.refresh(); await ctx.back();
  }, true); footer.append(login); footer.classList.add("pd-account-form-actions"); v.fields.append(footer);
  let send: HTMLButtonElement | undefined;
  function schedule(): void { if (timer !== undefined) formWindow.clearTimeout(timer); timer = undefined; if (v.alive && deadline > Date.now()) timer = formWindow.setTimeout(() => { timer = undefined; update(); schedule(); }, Math.min(1000, deadline - Date.now())); }
  function renderCredential(): void {
    credentials.querySelectorAll<HTMLInputElement>("input").forEach(input => { input.value = ""; });
    credentials.replaceChildren(); send = undefined; feedback.textContent = method === "code" ? t(ctx, "未注册的邮箱将自动创建账号。") : "";
    if (method === "code") {
      const field = settingsField(ctx, credentials, t(ctx, "邮箱验证码"), code, value => { code = value; v.changed(); update(); }); field.inputMode = "numeric"; field.placeholder = t(ctx, "6 位数字"); field.maxLength = 6; field.autocomplete = "one-time-code";
      const host = field.parentElement!, row = el(ctx.document, "div", "pd-account-code-row"); host.append(row); row.append(field);
      send = settingsAction(ctx, "获取验证码", async () => {
        if (!api.actions.requestCode || !emailValid(email) || v.busy) return; const address = email.trim().toLowerCase(); sending = true;
        const sent = await v.run(async () => { await api.actions.requestCode!({ email: address, purpose: "login" }); }); sending = false;
        if (sent && v.alive && email.trim().toLowerCase() === address) { sentEmail = address; deadline = Date.now() + 60_000; feedback.textContent = t(ctx, "验证码已发送，请查收邮箱。"); schedule(); }
        update();
      }); row.append(send);
    } else {
      const field = settingsField(ctx, credentials, t(ctx, "密码"), password, value => { password = value; v.changed(); update(); }, "password"); field.placeholder = t(ctx, "输入密码"); field.autocomplete = "current-password"; field.maxLength = 128;
    }
  }
  function update(): void {
    if (!v.alive) return; const vm = api.read(), foreign = !!vm.identity, remaining = sentEmail === email.trim().toLowerCase() ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) : 0;
    const credentialValid = method === "code" ? /^\d{6}$/u.test(code) : !!password && password.length <= 128;
    login.disabled = v.busy || foreign || !vm.serviceAvailable || !api.actions.signIn || !emailValid(email) || !credentialValid; setLabel(login, t(ctx, v.busy && !sending ? "登录中…" : "登录"));
    mode.dataset.value = method; for (const [value, button] of choices) { button.disabled = v.busy || foreign; button.setAttribute("aria-pressed", String(method === value)); }
    if (send) { send.disabled = v.busy || foreign || !vm.serviceAvailable || !api.actions.requestCode || !emailValid(email) || remaining > 0; setLabel(send, sending && v.busy ? t(ctx, "发送中…") : remaining ? english(ctx) ? `Resend in ${remaining}s` : `${remaining} 秒后重发` : t(ctx, "获取验证码")); }
  }
  v.dirty = () => !!email.trim() || !!code || !!password; v.discard = () => { email = ""; code = ""; password = ""; emailInput.value = ""; renderCredential(); update(); }; v.update = update;
  const resumed = () => { update(); schedule(); }; ctx.document.addEventListener("visibilitychange", resumed); ctx.document.defaultView?.addEventListener("pageshow", resumed);
  v.cleanup(() => { if (timer !== undefined) formWindow.clearTimeout(timer); email = ""; code = ""; password = ""; ctx.document.removeEventListener("visibilitychange", resumed); ctx.document.defaultView?.removeEventListener("pageshow", resumed); });
  renderCredential();
  return v.bind(() => {
    const next = accountKey(api); if (next !== identity) { identity = next; code = ""; password = ""; renderCredential(); if (next) { v.allow(); if (!v.busy) v.report(t(ctx, "账号已切换，本次操作已取消。")); } }
    update();
  });
}

function createProfilePage(ctx: IPadSettingsContext, api: AccountMembershipAdapter): MobileShellPage {
  const v = accountView(ctx, api, "ipad-account-profile", "编辑资料"), identity = accountKey(api), original = api.read().identity?.name ?? "";
  let name = original, switched = false;
  const input = settingsField(ctx, v.fields, t(ctx, "名字"), name, value => { name = value; v.changed(); update(); }); input.autocomplete = "name";
  const footer = el(ctx.document, "div", "pd-settings-actions"), save = settingsAction(ctx, "保存", async () => {
    if (switched || !name.trim() || !api.actions.saveProfile) return; const saved = await v.run(async () => { await api.actions.saveProfile!({ name: name.trim() }); });
    if (saved && v.alive) { v.allow(); ctx.refresh(); await ctx.back(); }
  }, true); footer.append(settingsAction(ctx, "取消", async () => { if (v.busy) return; v.allow(); await ctx.back(); }), save); footer.classList.add("pd-account-form-actions"); v.fields.append(footer);
  function update(): void { if (v.alive) { input.disabled = v.busy || switched; save.disabled = v.busy || switched || !api.read().serviceAvailable || !api.actions.saveProfile || !name.trim(); setLabel(save, t(ctx, v.busy ? "保存中…" : "保存")); } }
  v.dirty = () => !switched && name !== original; v.discard = () => { name = original; input.value = original; }; v.update = update;
  return v.bind(() => { if (accountKey(api) !== identity) { switched = true; name = ""; input.value = ""; v.allow(); v.report(t(ctx, "账号已切换，本次操作已取消。")); } update(); });
}

function createDevicesPage(ctx: IPadSettingsContext, api: AccountMembershipAdapter): MobileShellPage {
  const v = accountView(ctx, api, "ipad-account-devices", "设备管理"), identity = accountKey(api); let signature = "";
  const render = () => {
    if (!v.alive) return; const vm = api.read();
    if (accountKey(api) !== identity) { v.fields.replaceChildren(); v.report(t(ctx, "账号已切换，本次操作已取消。")); return; }
    const next = JSON.stringify([vm.membership.devices, vm.serviceAvailable, ctx.host.settings().settingsLanguage]); if (signature === next) return; signature = next; v.fields.replaceChildren();
    const group = el(ctx.document, "div", "pd-settings-group pd-account-devices"); v.fields.append(group);
    if (vm.membership.devices === null) group.append(el(ctx.document, "div", "pd-settings-empty", t(ctx, "设备列表暂不可用")));
    else if (!vm.membership.devices.length) group.append(el(ctx.document, "div", "pd-settings-empty", t(ctx, "还没有设备")));
    for (const device of vm.membership.devices ?? []) {
      const icon = /ipad|tablet/iu.test(device.description) ? "tablet" : /iphone|android|phone/iu.test(device.description) ? "smartphone" : "monitor";
      const row = settingsRow(ctx, group, device.name, device.current ? t(ctx, "本机") : "", undefined, ipadIcon(ctx.document, icon), device.description), area = el(ctx.document, "div", "pd-account-inline-confirm");
      if (!device.current) {
        const remove = settingsAction(ctx, "移除", () => inlineConfirm(ctx, area, "移除后，这台设备要重新登录才能使用 PRO。", "移除", async () => {
          if (!api.actions.removeDevice) return; const saved = await v.run(async () => { await api.actions.removeDevice!(device.id); });
          if (saved) { signature = ""; render(); ctx.refresh(); new Notice(t(ctx, "设备已移除")); }
        })); remove.disabled = !vm.serviceAvailable || !api.actions.removeDevice; row.append(remove);
      }
      group.append(area);
    }
  };
  return v.bind(render);
}
