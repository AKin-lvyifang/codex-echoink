import { formatMobileDate, formatMobileDateTime } from "../../mobile/date-display";
import { createUnavailableAccountAdapter, type AccountIdentity, type AccountMembershipAdapter, type AccountMembershipViewModel, type MembershipState } from "../../settings/account-membership-model";
import { getMembershipPlanPricing, resolveMembershipCurrency, type MembershipPlanId } from "../../settings/account-membership-pricing";
import { createPluginEditionBadge } from "../../settings/plugin-edition-badge";
import type { MobileShellPage } from "../mobile/shell-types";
import { iphoneElement as el, iphoneIcon } from "./workbench-elements";
import type { IPhonePageContext } from "./workbench-contract";
import { settingsMessage, settingsText } from "./settings-language";
import { pushSettingsPage, settingsBody, settingsButton, settingsError, settingsField, settingsGroup, settingsRow } from "./settings-elements";

const PLAN_NAMES: Record<MembershipPlanId, string> = { early: "早鸟买断", month: "月卡", quarter: "季卡", year: "年卡" };
const STATE_NAMES: Record<MembershipState, string> = {
  unavailable: "账号服务暂不可用", anonymous: "未登录", free: "免费版", active: "有效", lifetime: "2.x 买断权益",
  "offline-valid": "离线可用", "verification-required": "需要联网验证", expired: "已到期", revoked: "已撤销", scheduled: "尚未生效",
  "device-limit": "设备名额已满", "device-required": "本机待激活"
};

/** Authentication stays in AccountService; iPhone owns this DOM and each short-lived draft. */
export class IPhoneAccountPages {
  private readonly adapter: AccountMembershipAdapter;
  private readonly refreshers = new Set<() => void>();
  private emailDraft = "";
  constructor(private readonly ctx: IPhonePageContext) { this.adapter = ctx.host.accountService ?? createUnavailableAccountAdapter(); }
  refresh(): void { for (const refresh of this.refreshers) refresh(); }

  async open(): Promise<void> {
    const { ctx } = this, id = "iphone-settings-account";
    if (ctx.shell.hasPage(id)) { this.refresh(); await ctx.shell.backTo(id); return; }
    const body = this.body(), identityArea = el(ctx.document, "div", "ip-account-identity"), accountLinks = el(ctx.document, "div", "ip-account-links"); body.append(identityArea, accountLinks);
    const serviceFeedback = settingsError(ctx, body), actionFeedback = settingsError(ctx, body), statusActions = el(ctx.document, "div", "ip-settings-actions ip-account-actions"); body.append(statusActions);
    this.heading(body, "我的使用", "当前 Vault · 本地"); const usage = el(ctx.document, "div", "ip-account-usage"); body.append(usage);
    this.heading(body, "权益对比"); this.benefits(body);
    const purchaseHeading = this.heading(body, "购买方案"), redeemToggle = settingsButton(ctx, "使用兑换码", () => { redeemOpen = !redeemOpen; redemption.hidden = !redeemOpen; redeemToggle.setAttribute("aria-expanded", String(redeemOpen)); if (redeemOpen) redeemInput.focus(); }, "is-text"); purchaseHeading.append(redeemToggle); redeemToggle.setAttribute("aria-expanded", "false");
    const redemption = el(ctx.document, "div", "ip-account-redemption"), redeemFields = el(ctx.document, "div", "ip-account-redeem-fields"); redemption.hidden = true; redemption.append(redeemFields); body.append(redemption);
    const redeemInput = settingsField(ctx, redeemFields, "兑换码", "", value => { redeemCode = value; syncRedeem(); }); redeemInput.autocomplete = "off"; redeemInput.spellcheck = false; redeemInput.placeholder = settingsText(ctx, "输入兑换码");
    const redeemError = settingsError(ctx, redemption), redeem = settingsButton(ctx, "兑换", () => { void (async () => {
      if (busy || !redeemCode.trim()) return;
      if (!this.adapter.read().identity) { redeemError.show(settingsText(ctx, "请先登录，再使用兑换码。")); return; }
      const operation = epoch; busy = true; syncRedeem(); redeemError.show();
      try {
        if (!this.adapter.actions.redeem) throw new Error(settingsText(ctx, "账号服务暂不可用"));
        await this.adapter.actions.redeem(redeemCode.trim());
        if (disposed || operation !== epoch) return; redeemCode = ""; redeemInput.value = ""; redeemError.show(); render();
      } catch (failure) { if (!disposed && operation === epoch) redeemError.show(this.safeFailure(failure, [redeemCode])); }
      finally { if (!disposed && operation === epoch) { busy = false; render(); } }
    })(); }, "is-primary"); redeemFields.append(redeem);
    const plans = el(ctx.document, "div", "ip-account-plans"); body.append(plans);
    const scope = el(ctx.document, "details", "ip-account-scope"); scope.append(settingsMessage(ctx, el(ctx.document, "summary", ""), "买断包含什么"), settingsMessage(ctx, el(ctx.document, "div", ""), "包含购买时的 2.x 版本 PRO 插件，长期可用；不包含 3.x、以后的新插件和模型调用额度。需要定期联网更新授权。")); body.append(scope);
    let disposed = false, busy = false, epoch = 0, identityKey = this.identityKey(), redeemCode = "", redeemOpen = false;
    const syncRedeem = () => { const vm = this.adapter.read(); redeemInput.disabled = busy; redeem.disabled = busy || !vm.serviceAvailable || !this.adapter.actions.redeem || !redeemCode.trim(); this.buttonText(redeem, busy ? "兑换中…" : "兑换"); redemption.setAttribute("aria-busy", String(busy)); if (busy) { this.disable(accountLinks, true); this.disable(statusActions, true); } };
    const runAccountAction = async (action: () => Promise<void>) => {
      if (busy) return; const operation = epoch; busy = true; actionFeedback.show(); syncRedeem();
      try { await action(); if (!disposed && operation === epoch) render(); }
      catch (failure) { if (!disposed && operation === epoch) actionFeedback.show(failure); }
      finally { if (!disposed && operation === epoch) { busy = false; render(); } }
    };
    const render = () => {
      if (disposed) return; const vm = this.adapter.read(), nextIdentity = this.identityKey();
      if (identityKey !== nextIdentity) {
        identityKey = nextIdentity; epoch++; busy = false; redeemCode = ""; redeemInput.value = ""; redeemError.show(); actionFeedback.show();
        accountLinks.querySelector(".ip-settings-confirm")?.remove();
      }
      identityArea.replaceChildren(); accountLinks.replaceChildren(); statusActions.replaceChildren();
      const head = el(ctx.document, "div", "ip-account-head"); head.append(this.avatar(vm.identity)); const copy = el(ctx.document, "div", "ip-settings-label"), name = el(ctx.document, "div", "ip-account-name"); copy.append(name); head.append(copy); identityArea.append(head);
      const links = settingsGroup(ctx, accountLinks);
      const orders = settingsRow(ctx, links, "我的订单", { action: () => runAccountAction(() => this.adapter.actions.openOrders!()) }) as HTMLButtonElement; orders.disabled = !this.adapter.actions.openOrders;
      if (vm.identity) {
        name.append(el(ctx.document, "span", "", vm.identity.name));
        if (this.valid(vm)) createPluginEditionBadge(name, "pro", ctx.host.settings().settingsLanguage);
        else name.append(settingsMessage(ctx, el(ctx.document, "span", "ip-account-free"), vm.membership.state === "free" ? "免费版" : STATE_NAMES[vm.membership.state]));
        const metadata = vm.membership.state === "free" ? vm.identity.email : this.membershipLine(vm); copy.append(el(ctx.document, "div", "ip-account-sub", metadata));
        settingsRow(ctx, links, "编辑资料", { action: () => this.profile() });
        settingsRow(ctx, links, "设备管理", { literalValue: true, value: `${vm.membership.devices?.length ?? "—"} / ${vm.membership.deviceLimit ?? "—"}`, action: () => this.devices() });
        const signOut = settingsRow(ctx, links, "退出登录", { navigation: false, action: () => {
          if (busy || !this.adapter.actions.signOut) return;
          this.confirm(links, "退出后这台设备不再使用 PRO 功能，已保存的内容不受影响。", "退出登录", () => runAccountAction(() => this.adapter.actions.signOut!()));
        } }); (signOut as HTMLButtonElement).disabled = !this.adapter.actions.signOut;
      } else {
        name.append(settingsMessage(ctx, el(ctx.document, "span", ""), "未登录")); const actions = el(ctx.document, "div", "ip-account-login-actions");
        const login = settingsButton(ctx, "登录 / 注册", () => { void this.login().catch(error => ctx.error(error)); }, "is-primary"); login.disabled = !vm.serviceAvailable || !this.adapter.actions.signIn;
        actions.append(login, settingsMessage(ctx, el(ctx.document, "span", "ip-account-gift"), "注册送激活码")); copy.append(actions);
      }
      serviceFeedback.show([vm.verificationError, vm.storageNotice, !vm.serviceAvailable ? settingsText(ctx, "账号服务暂不可用") : undefined].filter(Boolean).join("\n") || undefined);
      if (vm.identity && ["verification-required", "device-limit", "device-required", "offline-valid", "expired", "revoked", "scheduled"].includes(vm.membership.state)) {
        const verify = settingsButton(ctx, "重新验证", () => { void runAccountAction(() => this.adapter.actions.verify!()); }); verify.disabled = busy || !vm.serviceAvailable || !this.adapter.actions.verify; statusActions.append(verify);
        if (vm.membership.state === "device-required") { const activate = settingsButton(ctx, "启用本机", () => { void runAccountAction(() => this.adapter.actions.activateDevice!()); }, "is-primary"); activate.disabled = busy || !vm.serviceAvailable || !this.adapter.actions.activateDevice; statusActions.append(activate); }
      }
      usage.replaceChildren();
      for (const [label, value, unit] of [["累计估算 Token", vm.statistics.totalTokens, ""], ["完成的对话轮次", vm.statistics.totalTurns, ""], ["当前连续使用", vm.statistics.currentStreak, "天"], ["最长连续使用", vm.statistics.bestStreak, "天"]] as const) {
        const stat = el(ctx.document, "div", "ip-account-stat"); stat.append(settingsMessage(ctx, el(ctx.document, "span", ""), label)); const number = el(ctx.document, "strong", "", value === null ? "—" : this.number(value, label === "累计估算 Token")); if (unit && value !== null) number.append(settingsMessage(ctx, el(ctx.document, "small", ""), unit)); stat.append(number); usage.append(stat);
      }
      this.plans(plans, vm); syncRedeem();
    };
    render(); this.refreshers.add(render); const unsubscribe = this.adapter.subscribe?.(render);
    await pushSettingsPage(ctx, { id, title: "账号与会员", content: body, canLeave: () => !busy, dispose: () => { disposed = true; epoch++; redeemCode = ""; redeemInput.value = ""; unsubscribe?.(); this.refreshers.delete(render); } });
  }

  private async login(): Promise<void> {
    const { ctx } = this, id = "iphone-settings-account-login";
    if (ctx.shell.hasPage(id)) { await ctx.shell.backTo(id); return; }
    const body = this.body(), form = el(ctx.document, "form", "ip-account-login-form"), footer = el(ctx.document, "div", "ip-settings-actions ip-account-actions"); body.append(form);
    let mode: "code" | "password" = "code", code = "", password = "", busy = false, sending = false, disposed = false, invalidated = false, targetEmail: string | undefined, deadline = 0, deadlineEmail = "";
    const initialIdentity = this.identityKey(), view = ctx.document.defaultView;
    const email = settingsField(ctx, form, "邮箱", this.emailDraft, value => { this.emailDraft = value; sync(); }, "email"); email.autocomplete = "email"; email.placeholder = "name@example.com"; email.maxLength = 254;
    const segments = el(ctx.document, "div", "ip-account-segments"); segments.setAttribute("role", "group"); segments.setAttribute("aria-label", settingsText(ctx, "登录方式")); const slider = el(ctx.document, "span", "ip-account-segment-slider"); slider.setAttribute("aria-hidden", "true"); segments.append(slider); form.append(segments);
    const credentials = el(ctx.document, "div", "ip-account-credentials"), feedback = el(ctx.document, "div", "ip-account-feedback"); feedback.setAttribute("role", "status"); feedback.setAttribute("aria-live", "polite"); form.append(credentials, feedback); const error = settingsError(ctx, form);
    const codeArea = el(ctx.document, "div", "ip-account-code-area"), passwordArea = el(ctx.document, "div", "ip-account-password-area"); credentials.append(codeArea, passwordArea);
    const codeInput = settingsField(ctx, codeArea, "邮箱验证码", "", value => { code = value; sync(); }); codeInput.inputMode = "numeric"; codeInput.autocomplete = "one-time-code"; codeInput.maxLength = 6; codeInput.placeholder = settingsText(ctx, "6 位数字");
    const send = settingsButton(ctx, "获取验证码", () => { void (async () => {
      if (send.disabled || !this.adapter.actions.requestCode) return; sending = true; const requestedEmail = email.value.trim(), requestedKey = requestedEmail.toLowerCase(); error.show(); feedback.textContent = ""; sync();
      try { await this.adapter.actions.requestCode({ email: requestedEmail, purpose: "login" }); if (!disposed && !invalidated) { deadline = Date.now() + 60_000; deadlineEmail = requestedKey; feedback.textContent = settingsText(ctx, "验证码已发送，请查收邮箱。"); } }
      catch (failure) { if (!disposed && !invalidated) error.show(this.safeFailure(failure, [code, password])); }
      finally { if (!disposed) { sending = false; sync(); } }
    })(); }); codeArea.querySelector("label")!.append(send);
    const passwordInput = settingsField(ctx, passwordArea, "密码", "", value => { password = value; sync(); }, "password"); passwordInput.autocomplete = "current-password"; passwordInput.maxLength = 128; passwordInput.placeholder = settingsText(ctx, "输入密码");
    const modeButtons = (["code", "password"] as const).map(value => {
      const button = settingsButton(ctx, value === "code" ? "邮箱验证码" : "密码登录", () => { if (!busy && !sending && !invalidated) { mode = value; error.show(); feedback.textContent = ""; sync(); } }, "ip-account-segment"); segments.append(button); return button;
    });
    const signIn = async () => {
      if (submit.disabled || !this.adapter.actions.signIn) return; busy = true; targetEmail = email.value.trim().toLowerCase(); const requestedEmail = email.value.trim(), credential = mode === "code" ? code : password, submittedMode = mode; error.show(); feedback.textContent = ""; sync();
      try {
        await this.adapter.actions.signIn({ email: requestedEmail, method: submittedMode, credential });
        if (disposed || invalidated) return;
        if (this.identityKey() !== targetEmail) { error.show(settingsText(ctx, "登录尚未完成，请重试。")); return; }
        code = ""; password = ""; codeInput.value = ""; passwordInput.value = ""; busy = false; await ctx.shell.back(); this.refresh();
      } catch (failure) { if (!disposed && !invalidated) error.show(this.safeFailure(failure, [code, password])); }
      finally { if (!disposed) { busy = false; targetEmail = undefined; sync(); } }
    };
    const submit = settingsButton(ctx, "登录", () => { void signIn(); }, "is-primary"); footer.append(submit); form.addEventListener("submit", event => { event.preventDefault(); void signIn(); });
    form.addEventListener("keydown", event => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); void signIn(); } });
    const sync = () => {
      if (disposed) return; const vm = this.adapter.read(), locked = busy || sending || invalidated, remaining = deadlineEmail === email.value.trim().toLowerCase() ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) : 0, emailValid = email.validity.valid && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email.value.trim());
      codeArea.hidden = mode !== "code"; passwordArea.hidden = mode !== "password"; segments.dataset.selected = mode;
      modeButtons.forEach((button, index) => { const selected = mode === (index === 0 ? "code" : "password"); button.setAttribute("aria-pressed", String(selected)); button.disabled = locked; });
      email.disabled = locked; codeInput.disabled = locked; passwordInput.disabled = locked; send.disabled = locked || !emailValid || remaining > 0 || !vm.serviceAvailable || !this.adapter.actions.requestCode;
      this.buttonText(send, sending ? "发送中…" : remaining ? this.text(`${remaining} 秒后重发`, `Resend in ${remaining}s`) : "获取验证码", !!remaining && !sending);
      submit.disabled = locked || !vm.serviceAvailable || !this.adapter.actions.signIn || !emailValid || (mode === "code" ? !/^\d{6}$/u.test(code) : !password || password.length > 128); this.buttonText(submit, busy ? "登录中…" : "登录");
      if (!feedback.textContent && !busy && mode === "code") feedback.textContent = settingsText(ctx, "未注册的邮箱将自动创建账号。");
      if (mode === "password" && feedback.textContent === settingsText(ctx, "未注册的邮箱将自动创建账号。")) feedback.textContent = "";
      form.setAttribute("aria-busy", String(busy || sending));
    };
    const refresh = () => {
      const current = this.identityKey(); if (current !== initialIdentity && !(busy && current === targetEmail)) { invalidated = true; code = ""; password = ""; codeInput.value = ""; passwordInput.value = ""; error.show(settingsText(ctx, "账号已变化，请重新进入。")); }
      sync();
    };
    sync(); const timer = view?.setInterval(sync, 250), unsubscribe = this.adapter.subscribe?.(refresh); this.refreshers.add(refresh);
    await pushSettingsPage(ctx, { id, title: "登录 / 注册", content: body, footer, canLeave: () => invalidated || !busy && !sending, dispose: () => { disposed = true; code = ""; password = ""; codeInput.value = ""; passwordInput.value = ""; view?.clearInterval(timer); unsubscribe?.(); this.refreshers.delete(refresh); } });
  }

  private async devices(): Promise<void> {
    const { ctx } = this, id = "iphone-settings-account-devices";
    if (ctx.shell.hasPage(id)) { await ctx.shell.backTo(id); return; }
    const body = this.body(), key = this.identityKey(); let disposed = false, busy = false, invalidated = false;
    const render = () => {
      if (disposed) return; if (this.identityKey() !== key) { invalidated = true; body.replaceChildren(); settingsError(ctx, body).show(settingsText(ctx, "账号已变化，请重新进入。")); return; } if (busy) return;
      const vm = this.adapter.read(); body.replaceChildren(); const group = settingsGroup(ctx, body), devices = vm.membership.devices, error = settingsError(ctx, group);
      if (devices === null) { this.empty(group, "暂时无法读取设备列表"); return; } if (!devices.length) this.empty(group, "还没有已绑定设备");
      for (const device of devices) {
        const row = el(ctx.document, "div", "ip-settings-row ip-account-device"), copy = el(ctx.document, "span", "ip-settings-label"), title = el(ctx.document, "span", "ip-settings-name", device.name); row.append(iphoneIcon(ctx.document, "monitor-smartphone"));
        if (device.current) title.append(settingsMessage(ctx, el(ctx.document, "span", "ip-account-current-device"), "本机")); copy.append(title, el(ctx.document, "span", "ip-settings-detail", device.description)); row.append(copy); group.append(row);
        if (!device.current) {
          const remove = settingsButton(ctx, "移除", () => this.confirm(group, "移除后，这台设备要重新登录才能使用 PRO。", "移除", async () => {
            if (busy || invalidated || !this.adapter.actions.removeDevice) return; busy = true; this.disable(group, true); error.show();
            try { await this.adapter.actions.removeDevice(device.id); if (!disposed && this.identityKey() === key) { busy = false; render(); this.refresh(); } }
            catch (failure) { if (!disposed && this.identityKey() === key) error.show(failure); }
            finally { busy = false; if (!disposed && !invalidated) this.disable(group, false); }
          }, true)); remove.disabled = !vm.serviceAvailable || !this.adapter.actions.removeDevice; row.append(remove);
        }
      }
    };
    render(); this.refreshers.add(render); const unsubscribe = this.adapter.subscribe?.(render);
    await pushSettingsPage(ctx, { id, title: "设备管理", content: body, canLeave: () => invalidated || !busy, dispose: () => { disposed = true; unsubscribe?.(); this.refreshers.delete(render); } });
  }

  private async profile(): Promise<void> {
    const { ctx } = this, id = "iphone-settings-account-profile", original = this.adapter.read().identity;
    if (ctx.shell.hasPage(id)) { await ctx.shell.backTo(id); return; } if (!original) return;
    const body = this.body(), footer = el(ctx.document, "div", "ip-settings-actions ip-account-actions"), key = this.identityKey(); let draft = original.name, disposed = false, busy = false, invalidated = false;
    const guard = this.leaveGuard(body, () => busy && !invalidated, () => !invalidated && draft !== original.name);
    const name = settingsField(ctx, body, "名字", draft, value => { draft = value; sync(); }); name.setAttribute("autocomplete", "nickname");
    const error = settingsError(ctx, body), save = settingsButton(ctx, "保存", () => { void (async () => {
      if (save.disabled || !this.adapter.actions.saveProfile) return; busy = true; error.show(); sync();
      try { await this.adapter.actions.saveProfile({ name: draft.trim() }); if (!disposed && this.identityKey() === key) { busy = false; guard.allow(); this.refresh(); await ctx.shell.back(); } }
      catch (failure) { if (!disposed && this.identityKey() === key) error.show(failure); }
      finally { if (!disposed) { busy = false; sync(); } }
    })(); }, "is-primary"); const cancel = settingsButton(ctx, "取消", () => { if (busy && !invalidated) return; guard.allow(); void ctx.shell.back(); }); footer.append(cancel, save);
    const sync = () => { name.disabled = busy || invalidated; cancel.disabled = busy && !invalidated; save.disabled = busy || invalidated || !draft.trim() || !this.adapter.read().serviceAvailable || !this.adapter.actions.saveProfile; this.buttonText(save, busy ? "保存中…" : "保存"); };
    const refresh = () => { if (this.identityKey() !== key) { invalidated = true; draft = ""; name.value = ""; error.show(settingsText(ctx, "账号已变化，请重新进入。")); } sync(); };
    sync(); this.refreshers.add(refresh); const unsubscribe = this.adapter.subscribe?.(refresh);
    await pushSettingsPage(ctx, { id, title: "编辑资料", content: body, footer, canLeave: guard.canLeave, dispose: () => { disposed = true; guard.dispose(); unsubscribe?.(); this.refreshers.delete(refresh); } });
  }

  private benefits(body: HTMLElement): void {
    const { ctx } = this, group = settingsGroup(ctx, body), viewport = el(ctx.document, "div", "ip-account-benefits-scroll"), table = el(ctx.document, "table", "ip-account-benefits"); group.append(viewport); viewport.append(table);
    const head = el(ctx.document, "tr", ""); for (const title of ["功能", "免费", "PRO"]) { const cell = el(ctx.document, "th", ""); settingsMessage(ctx, cell, title); cell.scope = "col"; head.append(cell); } const thead = el(ctx.document, "thead", ""); thead.append(head); table.append(thead); const rows = el(ctx.document, "tbody", ""); table.append(rows);
    const groups = [
      { name: "基础能力", pro: false, rows: [["Agent 对话", "多个 Agent、任务继续"], ["知识库", "整理、检索与补链"], ["长期记忆", ""], ["日记、复盘、待办", ""], ["选文提问", ""], ["Skills 与 MCP", ""]] },
      { name: "PRO 插件", pro: true, rows: [["财务", "记账、导入账单、预算与分析"], ["英文日记", "英文稿与表达库"], ["PDF 精读 · 提取", "原文、译文、精读、摘要（仅电脑）"]] }
    ];
    for (const group of groups) {
      const titleRow = el(ctx.document, "tr", "ip-account-benefit-group"), title = el(ctx.document, "td", ""); title.append(settingsMessage(ctx, el(ctx.document, "span", ""), group.name)); title.colSpan = 3; if (group.pro) createPluginEditionBadge(title, "pro", ctx.host.settings().settingsLanguage); titleRow.append(title); rows.append(titleRow);
      for (const [name, description] of group.rows) {
        const row = el(ctx.document, "tr", ""), feature = el(ctx.document, "td", ""); feature.append(settingsMessage(ctx, el(ctx.document, "span", ""), name)); if (description) feature.append(settingsMessage(ctx, el(ctx.document, "span", "ip-account-feature-description"), description)); row.append(feature);
        for (const included of [!group.pro, true]) { const cell = el(ctx.document, "td", included ? "is-included" : "is-excluded"); cell.append(iphoneIcon(ctx.document, included ? "check" : "minus"), settingsMessage(ctx, el(ctx.document, "span", "ip-account-sr"), included ? "包含" : "不含")); row.append(cell); } rows.append(row);
      }
    }
  }
  private plans(parent: HTMLElement, vm: AccountMembershipViewModel): void {
    const { ctx } = this; let timeZone: string | undefined; try { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { /* The pricing contract handles an unknown zone. */ }
    const currency = resolveMembershipCurrency(timeZone), symbol = currency === "CNY" ? "¥" : "US$", currentPlan = vm.membership.planId ?? (vm.membership.state === "lifetime" ? "early" : null); parent.replaceChildren();
    const money = (minor: number) => (minor / 100).toLocaleString(this.language(), { minimumFractionDigits: currency === "USD" ? 2 : 0, maximumFractionDigits: 2 });
    for (const plan of getMembershipPlanPricing(currency, vm.products)) {
      const current = this.valid(vm) && currentPlan === plan.id, card = el(ctx.document, "article", `ip-account-plan${plan.id === "early" ? " is-early" : ""}`); card.dataset.planId = plan.id;
      const title = el(ctx.document, "div", "ip-account-plan-name", settingsText(ctx, PLAN_NAMES[plan.id])); if (current) title.append(settingsMessage(ctx, el(ctx.document, "span", "ip-account-current-plan"), "使用中")); card.append(title);
      const price = el(ctx.document, "div", "ip-account-price"); price.append(el(ctx.document, "span", "ip-account-currency", symbol), el(ctx.document, "span", "", money(plan.amountMinor)));
      if (plan.id !== "early" && plan.savingsPercent !== null && plan.savingsPercent > 0) price.append(el(ctx.document, "span", "ip-account-savings", this.text(`省 ${plan.savingsPercent}%`, `Save ${plan.savingsPercent}%`))); card.append(price);
      card.append(el(ctx.document, "div", "ip-account-plan-detail", plan.days === null ? settingsText(ctx, "一次购买") : this.text(`${plan.days} 天`, `${plan.days} days`)));
      card.append(el(ctx.document, "div", "ip-account-plan-detail", plan.dailyAmountMinor === null ? settingsText(ctx, "当前 2.x 版本长期可用") : this.text(`每天约 ${symbol}${(plan.dailyAmountMinor / 100).toFixed(2)}`, `About ${symbol}${(plan.dailyAmountMinor / 100).toFixed(2)} / day`)));
      const purchasable = vm.salesOpen === true && plan.id !== "early" && !!this.adapter.actions.selectPlan;
      const label = !vm.salesOpen ? settingsText(ctx, "购买待开放") : plan.id === "early" ? this.text("暂不出售", "Not for sale") : currency === "USD" ? this.text("查看人民币套餐", "View CNY plans") : current ? this.text("续费", "Renew") : this.text("立即订阅", "Subscribe now");
      const feedback = settingsError(ctx, card);
      const purchase = settingsButton(ctx, label, () => {
        if (purchase.disabled) return;
        purchase.disabled = true; feedback.show();
        void this.adapter.actions.selectPlan!({ planId: plan.id, currency: "CNY" }).catch(error => feedback.show(error instanceof Error ? error.message : String(error))).finally(() => { purchase.disabled = !purchasable; });
      }); purchase.disabled = !purchasable; if (current) purchase.setAttribute("aria-current", "true"); card.append(purchase); parent.append(card);
    }
  }
  private membershipLine(vm: AccountMembershipViewModel): string {
    const member = vm.membership, planName = member.planName || (member.planId && PLAN_NAMES[member.planId as MembershipPlanId] ? settingsText(this.ctx, PLAN_NAMES[member.planId as MembershipPlanId]) : "");
    return [planName, settingsText(this.ctx, STATE_NAMES[member.state]), member.state === "scheduled" && member.startsAt ? this.text(`${formatMobileDate(member.startsAt)} 生效`, `Starts ${formatMobileDate(member.startsAt)}`) : "", member.expiresAt && member.state !== "lifetime" ? this.text(`${formatMobileDate(member.expiresAt)} 到期`, `Expires ${formatMobileDate(member.expiresAt)}`) : "", member.verifiedAt ? this.text(`${formatMobileDateTime(member.verifiedAt, Date.now(), this.language().startsWith("en") ? "en" : "zh-CN")} 已验证`, `Verified ${formatMobileDateTime(member.verifiedAt, Date.now(), this.language().startsWith("en") ? "en" : "zh-CN")}`) : "", member.state === "offline-valid" && member.offlineUntil ? this.text(`离线可用至 ${formatMobileDate(member.offlineUntil)}`, `Offline until ${formatMobileDate(member.offlineUntil)}`) : ""].filter(Boolean).join(" · ");
  }
  private valid(vm: AccountMembershipViewModel): boolean { return ["active", "lifetime", "offline-valid"].includes(vm.membership.state); }
  private avatar(identity: AccountIdentity | null): HTMLElement { const { ctx } = this; if (identity && identity.avatar !== "initial") { const image = el(ctx.document, "img", "ip-account-avatar"); image.src = identity.avatar.url; image.alt = ""; return image; } const avatar = el(ctx.document, "span", `ip-account-avatar${identity ? "" : " is-anonymous"}`); avatar.setAttribute("aria-hidden", "true"); if (identity) avatar.textContent = Array.from(identity.name)[0]?.toUpperCase() || "?"; else avatar.append(iphoneIcon(ctx.document, "user")); return avatar; }
  private identityKey(): string | null { return this.adapter.read().identity?.email.trim().toLowerCase() ?? null; }
  private language(): string { return this.ctx.host.settings().settingsLanguage === "en" ? "en-US" : "zh-CN"; }
  private number(value: number, compact = false): string { return new Intl.NumberFormat(this.language(), compact ? { notation: "compact", maximumFractionDigits: 1 } : {}).format(value); }
  private text(zh: string, en: string): string { return this.ctx.host.settings().settingsLanguage === "en" ? en : zh; }
  private body(): HTMLElement { const body = settingsBody(this.ctx); body.classList.add("ip-account-settings"); return body; }
  private heading(parent: HTMLElement, title: string, caption?: string): HTMLElement { const heading = el(this.ctx.document, "div", "ip-account-section-head"); heading.append(settingsMessage(this.ctx, el(this.ctx.document, "h2", ""), title)); if (caption) heading.append(settingsMessage(this.ctx, el(this.ctx.document, "span", "ip-account-caption"), caption)); parent.append(heading); return heading; }
  private empty(parent: HTMLElement, text: string): void { parent.append(settingsMessage(this.ctx, el(this.ctx.document, "div", "ip-account-empty"), text)); }
  private buttonText(button: HTMLButtonElement, text: string, literal = false): void { const label = button.querySelector<HTMLElement>(".ip-button-visible > span:last-child"); if (label) { if (literal) { delete label.dataset.ipMessage; label.textContent = text; } else settingsMessage(this.ctx, label, text); } }
  private safeFailure(failure: unknown, secrets: string[]): string { let message = failure instanceof Error ? failure.message : String(failure); for (const secret of secrets) if (secret) message = message.split(secret).join("••••"); return message; }
  private disable(parent: HTMLElement, value: boolean): void { for (const button of Array.from(parent.querySelectorAll("button"))) button.disabled = value; parent.setAttribute("aria-busy", String(value)); }
  private confirm(parent: HTMLElement, message: string, label: string, execute: () => Promise<void>, danger = false): void {
    if (parent.querySelector(":scope > .ip-settings-confirm")) return; const confirmation = el(this.ctx.document, "div", "ip-settings-confirm"); confirmation.append(settingsMessage(this.ctx, el(this.ctx.document, "p", ""), message)); const actions = el(this.ctx.document, "div", "ip-settings-actions");
    actions.append(settingsButton(this.ctx, "取消", () => confirmation.remove()), settingsButton(this.ctx, label, () => { void (async () => { this.disable(confirmation, true); try { await execute(); } catch (failure) { settingsError(this.ctx, confirmation).show(failure); } finally { if (confirmation.isConnected) this.disable(confirmation, false); } })(); }, danger ? "is-danger" : "is-primary")); confirmation.append(actions); parent.append(confirmation); confirmation.scrollIntoView({ block: "nearest" });
  }
  private leaveGuard(body: HTMLElement, blocked: () => boolean, dirty: () => boolean): { canLeave: NonNullable<MobileShellPage["canLeave"]>; allow: () => void; dispose: () => void } {
    let resolve: ((value: boolean) => void) | undefined, allow = false;
    return { allow: () => { allow = true; }, canLeave: () => {
      if (blocked()) return false; if (allow || !dirty()) return true; if (resolve) return false;
      return new Promise<boolean>(done => { resolve = done; const confirmation = el(this.ctx.document, "div", "ip-settings-confirm"); confirmation.append(settingsMessage(this.ctx, el(this.ctx.document, "p", ""), "还有未保存的修改。")); const actions = el(this.ctx.document, "div", "ip-settings-actions"); const decide = (value: boolean) => { const pending = resolve; resolve = undefined; confirmation.remove(); pending?.(value); }; const keep = settingsButton(this.ctx, "继续编辑", () => decide(false)); actions.append(keep, settingsButton(this.ctx, "放弃修改", () => { allow = true; decide(true); }, "is-primary")); confirmation.append(actions); body.append(confirmation); confirmation.scrollIntoView({ block: "nearest" }); keep.focus(); });
    }, dispose: () => { resolve?.(false); resolve = undefined; } };
  }
}
