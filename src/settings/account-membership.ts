// SPDX-License-Identifier: LicenseRef-EchoInk-Pro
// Scope and preserved rights: ../../LICENSE
import { Modal, Notice, setIcon, type App } from "obsidian";
import { createOriginButton, createOriginInput, disposeOriginControls } from "./origin-controls";
import type { AccountActions, AccountAvatar, AccountMembershipViewModel, AccountRank, MembershipState } from "./account-membership-model";
import { getMembershipPlanPricing, resolveMembershipCurrency } from "./account-membership-pricing";

type PageOptions = { app: App; viewModel: AccountMembershipViewModel; actions?: AccountActions; language: string; openProviders: () => void; subscribe?: (listener:()=>void)=>()=>void; read?:()=>AccountMembershipViewModel; beginAction?:()=>()=>void; };
type Tag = keyof HTMLElementTagNameMap;
function el<K extends Tag>(parent: HTMLElement, tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const node = parent.ownerDocument.createElement(tag);
  node.className = cls;
  if (text) node.textContent = text;
  parent.appendChild(node);
  return node;
}
function icon(parent: HTMLElement, name: string, cls = "") { const node = el(parent, "span", cls); node.setAttribute("aria-hidden", "true"); node.dataset.icon = name; setIcon(node, name); return node; }
function button(parent: HTMLElement, text: string, cls: string, action?: () => void) {
  const node = createOriginButton(parent, { text, cls });
  if (action) node.onclick = action;
  return node;
}
type ProfileDraft = { name: string; avatar?: File | null; imageUrl: string | null; ownedUrl: string | null };
const plans = [
  { id: "early", zh: "限量早鸟买断", en: "Early lifetime", months: 0, zhTerm: "一次购买", enTerm: "one payment" },
  { id: "month", zh: "月卡", en: "Monthly", months: 1, zhTerm: "/ 月", enTerm: "/ month" },
  { id: "quarter", zh: "季卡", en: "Quarterly", months: 3, zhTerm: "/ 季", enTerm: "/ quarter" },
  { id: "year", zh: "年卡", en: "Annual", months: 12, zhTerm: "/ 年", enTerm: "/ year" }
];
const subscriptionLabels: Record<string, [string, string]> = {
  beta: ["内测 PRO", "Beta PRO"],
  early: ["买断订阅", "Lifetime plan"], month: ["月卡订阅", "Monthly subscription"],
  quarter: ["季卡订阅", "Quarterly subscription"], year: ["年卡订阅", "Annual subscription"]
};
const stateLabels: Record<MembershipState, [string, string]> = {
  unavailable: ["未开通 PRO", "Free plan"], anonymous: ["未登录", "Signed out"], free: ["未开通 PRO", "Free plan"],
  active: ["有效", "Active"], lifetime: ["2.x 买断权益", "2.x lifetime"], "offline-valid": ["离线可用", "Valid offline"],
  "verification-required": ["需要联网验证", "Verification needed"], expired: ["已到期", "Expired"], revoked: ["已撤销", "Revoked"],
  scheduled: ["尚未生效", "Starts later"],
  "device-limit": ["设备名额已满", "Device limit reached"], "device-required": ["本机待激活", "Activate this device"]
};

/** Same production component is used by the private preview. Samples never enter this module. */
export function mountAccountMembership(parent: HTMLElement, options: PageOptions): { dispose: () => void } {
  if (options.subscribe && options.read) {
    let previous = JSON.stringify(options.read()), closed = false;
    let identityKey = options.read().identity?.email ?? null;
    const holds = new Set<object>();
    let mounted: ReturnType<typeof mountAccountMembership>;
    const redraw = () => {
      if (closed) return;
      const vm = options.read!(), next = JSON.stringify(vm);
      const nextIdentity = vm.identity?.email ?? null;
      if (holds.size && nextIdentity === identityKey) return;
      if (next === previous) return;
      previous = next;
      identityKey = nextIdentity;
      holds.clear();
      mounted.dispose();
      mounted = render(vm);
    };
    const beginAction = () => {
      const token = {}; holds.add(token);
      return () => { if (holds.delete(token)) redraw(); };
    };
    const render = (vm: AccountMembershipViewModel) => mountAccountMembership(parent, { ...options, subscribe: undefined, viewModel: vm, beginAction });
    mounted = render(options.read());
    const unsubscribe = options.subscribe(redraw);
    return { dispose: () => { closed = true; unsubscribe(); mounted.dispose(); } };
  }
  const { app, viewModel: vm, openProviders } = options;
  const actions = options.actions ?? {};
  const zh = options.language !== "en";
  const t = (cn: string, en: string) => zh ? cn : en;
  const page = el(parent, "div", "echoink-account");
  const tooltip = el(page.ownerDocument.body, "div", "echoink-account-tooltip");
  tooltip.id = `echoink-account-tooltip-${++fieldSequence}`;
  tooltip.setAttribute("role", "tooltip"); tooltip.hidden = true;
  const hideTip = () => { tooltip.hidden = true; };
  const escapeTip = (event: KeyboardEvent) => { if (event.key === "Escape") hideTip(); };
  page.ownerDocument.addEventListener("scroll", hideTip, true);
  page.ownerDocument.addEventListener("keydown", escapeTip);
  page.ownerDocument.defaultView?.addEventListener("resize", hideTip);
  const showTip = (cell: HTMLElement, text: string) => {
    if (disposed) return;
    copyAccountTheme(page, tooltip); tooltip.textContent = text; tooltip.hidden = false;
    const bounds = cell.getBoundingClientRect();
    const view = page.ownerDocument.defaultView;
    tooltip.style.left = `${Math.max(8, Math.min((view?.innerWidth ?? 320) - tooltip.offsetWidth - 8, bounds.left - tooltip.offsetWidth / 2))}px`;
    tooltip.style.top = `${Math.max(8, bounds.top - tooltip.offsetHeight - 8)}px`;
  };
  const modals = new Set<AccountModal>();
  let disposed = false;
  let feedbackTimer: ReturnType<typeof setTimeout> | null = null;
  let finishFeedback: (() => void) | null = null;
  const shortFeedback = () => new Promise<void>(resolve => {
    finishFeedback = resolve;
    feedbackTimer = setTimeout(() => { feedbackTimer = null; finishFeedback = null; resolve(); }, 650);
  });
  const beginAction = options.beginAction ?? (() => () => {});
  const buttonState = (node: HTMLButtonElement, state: "loading" | "success" | "idle", label: string) => {
    node.setAttribute("aria-busy", String(state === "loading"));
    node.textContent = "";
    if (state !== "idle") icon(node, state === "loading" ? "loader-circle" : "check", state === "loading" ? "account-action-spinner" : "account-action-check");
    el(node, "span", "", label);
  };
  const feedbackState = (node: HTMLElement, state: "status" | "loading" | "success" | "error", message: string) => {
    node.dataset.feedbackState = state;
    node.setAttribute("role", state === "error" ? "alert" : "status");
    node.textContent = message;
  };
  let heatFrame: number | null = null;
  const number = (n: number | null | undefined) => n == null ? "—" : n.toLocaleString(zh ? "zh-CN" : "en-US");
  const wireCode=(send:HTMLButtonElement,address:()=>string,purpose:"login"|"password-set"|"password-reset",parent:HTMLElement)=>{
    const feedback=el(parent,"div","activation-feedback");feedbackState(feedback,"status","");
    send.onclick=async()=>{if(send.disabled||!actions.requestCode)return;send.disabled=true;feedbackState(feedback,"loading","");try{await actions.requestCode({email:address().trim(),purpose});feedbackState(feedback,"success",t("验证码已发送，请查收邮箱。","Code sent. Check your email."));setTimeout(()=>{if(send.isConnected&&!disposed)send.disabled=false;},60000);}catch(error){feedbackState(feedback,"error",error instanceof Error?error.message:t("发送失败，请重试。","Could not send. Try again."));send.disabled=false;}};
  };
  const unavailable = t("即将开放", "Coming soon");
  const missing = t("暂无统计", "No statistics");
  const valid = ["active", "lifetime", "offline-valid"].includes(vm.membership.state);
  const currentPlanId = vm.membership.planId ?? (vm.membership.state === "lifetime" ? "early" : null);
  const currentPlanLabel = (currentPlanId && subscriptionLabels[currentPlanId]?.[zh ? 0 : 1]) || vm.membership.planName || t("已订阅", "Subscribed");
  const retainedMembership = valid || ["verification-required", "device-limit", "device-required", "revoked"].includes(vm.membership.state);
  let profileDraft: ProfileDraft | undefined;
  let replacingModal = false;
  const revokeImage = (draft: ProfileDraft) => {
    if (draft.ownedUrl) page.ownerDocument.defaultView?.URL.revokeObjectURL(draft.ownedUrl);
    draft.ownedUrl = null;
  };
  const clearDraft = () => { if (profileDraft) revokeImage(profileDraft); profileDraft = undefined; };
  const show = (title: string, render: (body: HTMLElement, modal: AccountModal) => void, keepDraft = false) => {
    if (disposed) return;
    hideTip();
    replacingModal = keepDraft;
    for (const previous of [...modals]) previous.close();
    replacingModal = false;
    if (!keepDraft) clearDraft();
    const modal = new AccountModal(app, page, title, render, () => { modals.delete(modal); if (!replacingModal) clearDraft(); });
    modals.add(modal); modal.open();
  };
  const copy = (body: HTMLElement, text: string) => el(body, "p", "dialog-copy", text);
  const field = (body: HTMLElement, label: string, type = "text", value = "", inputGroup = false) => {
    const row = el(body, "div", "form-field");
    const inputLabel = el(row, "label", "", label);
    const inputHost = inputGroup ? el(row, "div", "input-action") : row;
    const input = createOriginInput(inputHost, { cls: "form-input", attr: { type, autocomplete: type === "password" ? "off" : type === "email" ? "email" : "off" }, value });
    input.id = `echoink-account-field-${++fieldSequence}`; inputLabel.htmlFor = input.id;
    return input;
  };
  const submit = (form: HTMLFormElement, label: string, callback: (() => Promise<void>) | undefined, modal: AccountModal) => {
    const status = el(form, "p", "dialog-footnote");
    status.setAttribute("role", "status");
    const controls = el(form, "div", "dialog-actions");
    button(controls, t("取消", "Cancel"), "quiet", () => modal.close());
    const save = button(controls, !vm.serviceAvailable || !callback ? unavailable : label, "primary"); save.type = "submit";
    save.disabled = !vm.serviceAvailable || !callback;
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (save.disabled || !vm.serviceAvailable || !callback || disposed) return;
      if (!form.reportValidity()) return;
      save.disabled = true;
      const release = beginAction();
      try { await callback(); if (!disposed && form.isConnected) modal.close(); }
      catch (error) { if (form.isConnected) { status.classList.add("form-error"); status.textContent = error instanceof Error ? error.message : t("操作失败，请重试", "Unable to complete the action"); save.disabled = false; } }
      finally { form.querySelectorAll<HTMLInputElement>('input[type="password"]').forEach(input => input.value = ""); release(); }
    };
  };
  const password = (reset: boolean, draft?: ProfileDraft, emailValue = vm.identity?.email ?? "") => show(
    reset ? t("重置密码", "Reset password") : vm.identity?.passwordSet ? t("修改密码", "Change password") : t("设置密码", "Set password"),
    (body, modal) => {
      const form = el(body, "form");
      copy(form, t("通过邮箱验证身份后设置密码。", "Verify your email before setting a password."));
      const email = field(form, t("账号邮箱", "Account email"), "email", emailValue); email.required = true; email.readOnly = !reset && !!vm.identity;
      const code = field(form, t("身份验证码", "Verification code"), "text", "", true); code.inputMode = "numeric"; code.required = true;
      const inputAction = code.parentElement!;
      const send = button(inputAction, t("获取验证码", "Send code"), "secondary", () => {}); send.disabled = !vm.serviceAvailable || !actions.requestCode; wireCode(send,()=>email.value,reset?"password-reset":"password-set",form);
      const next = field(form, t("新密码", "New password"), "password"); next.minLength = 10; next.maxLength = 128; next.placeholder = t("10–128 个字符", "10–128 characters"); next.required = true; next.autocomplete = "new-password";
      const confirm = field(form, t("确认新密码", "Confirm password"), "password"); confirm.maxLength = 128; confirm.required = true; confirm.autocomplete = "new-password";
      const validate = () => confirm.setCustomValidity(confirm.value !== next.value ? t("两次输入的密码不一致", "Passwords do not match") : "");
      next.oninput = confirm.oninput = validate;
      button(form, t("返回", "Back"), "quiet", () => reset ? login(email.value) : profile(draft));
      const callback = reset ? actions.resetPassword && (() => actions.resetPassword!({ email: email.value.trim(), code: code.value, next: next.value })) : actions.setPassword && (() => actions.setPassword!({ email: email.value.trim(), code: code.value, next: next.value }));
      submit(form, t("确认", "Confirm"), callback, modal);
    }, !!draft
  );
  const profile = (draft?: ProfileDraft) => {
    if (!vm.identity) return;
    show(t("编辑个人资料", "Edit profile"), (body, modal) => {
      const form = el(body, "form");
      const selected: ProfileDraft = draft ?? { name: vm.identity!.name, imageUrl: vm.identity!.avatar === "initial" ? null : vm.identity!.avatar.url, ownedUrl: null };
      profileDraft = selected;
      const fs = el(form, "fieldset", "avatar-field"); el(fs, "legend", "", t("头像", "Avatar"));
      const editor = el(fs, "div", "avatar-editor"); const preview = el(editor, "div", "avatar-draft-preview");
      const controls = el(editor, "div", "avatar-edit-actions");
      const file = el(controls, "input"); file.type = "file"; file.accept = "image/png,image/jpeg,image/webp"; file.hidden = true;
      const error = el(fs, "p", "form-error"); error.setAttribute("role", "status");
      const paint = () => {
        preview.replaceChildren();
        renderAvatar(preview, selected.imageUrl ? { url: selected.imageUrl } : "initial", selected.name);
        const image = preview.querySelector("img");
        const url = selected.imageUrl;
        if (image) image.onerror = () => {
          if (profileDraft !== selected || selected.imageUrl !== url) return;
          revokeImage(selected); selected.imageUrl = null; selected.avatar = null;
          error.textContent = t("无法读取图片，请重新选择", "Unable to read this image. Choose another."); paint();
        };
      };
      button(controls, t("选择图片", "Choose image"), "secondary", () => file.click());
      button(controls, t("恢复默认", "Reset avatar"), "quiet", () => { revokeImage(selected); selected.imageUrl = null; selected.avatar = null; file.value = ""; error.textContent = ""; paint(); });
      el(controls, "small", "muted", t("PNG、JPEG 或 WebP，最大 5MB", "PNG, JPEG or WebP, up to 5MB"));
      file.onchange = () => {
        const image = file.files?.[0]; file.value = "";
        if (!image) return;
        if (!["image/png", "image/jpeg", "image/webp"].includes(image.type) || !image.size || image.size > 5 * 1024 * 1024) {
          error.textContent = t("请选择不超过 5MB 的 PNG、JPEG 或 WebP 图片", "Choose a PNG, JPEG or WebP image up to 5MB"); return;
        }
        const url = page.ownerDocument.defaultView!.URL.createObjectURL(image);
        revokeImage(selected); selected.avatar = image; selected.imageUrl = selected.ownedUrl = url; error.textContent = ""; paint();
      };
      const name = field(form, t("昵称", "Nickname"), "text", selected.name); name.required = true; name.maxLength = 80;
      name.oninput = () => { selected.name = name.value; paint(); };
      const row = el(form, "div", "password-setting"); const label = el(row, "div");
      el(label, "strong", "", t("登录密码", "Login password")); el(label, "p", "", vm.identity!.passwordSet ? t("已设置", "Set") : t("尚未设置", "Not set"));
      button(row, vm.identity!.passwordSet ? t("修改密码", "Change password") : t("设置密码", "Set password"), "secondary", () => password(false, selected));
      paint();
      submit(form, t("保存资料", "Save profile"), actions.saveProfile && (() => actions.saveProfile!({ name: name.value.trim(), avatar: selected.avatar })), modal);
    }, !!draft);
  };
  const login = (emailValue = "") => show(t("登录 / 注册", "Sign in / register"), (body, modal) => {
    const methods = el(body, "div", "segments login-methods");
    const form = el(body, "form");
    copy(form, t("未注册的邮箱将自动创建账号。", "An unregistered email will create an account."));
    const email = field(form, t("邮箱", "Email"), "email", emailValue); email.required = true;
    const code = field(form, t("邮箱验证码", "Email verification code"), "text", "", true); code.inputMode = "numeric"; code.maxLength = 6; code.placeholder = t("邮箱收到的 6 位数字", "6 digits from your email");
    const inputAction = code.parentElement!;
    const send = button(inputAction, t("获取验证码", "Send code"), "secondary", () => {}); send.disabled = !vm.serviceAvailable || !actions.requestCode; wireCode(send,()=>email.value,"login",form);
    const secret = field(form, t("密码", "Password"), "password"); secret.maxLength = 128;
    let method: "code" | "password" = "code";
    const modes = [button(methods, t("邮箱验证码", "Email code"), "quiet", () => change("code")), button(methods, t("密码登录", "Password"), "quiet", () => change("password"))];
    const change = (next: typeof method) => {
      method = next; code.closest<HTMLElement>(".form-field")!.hidden = method !== "code"; secret.parentElement!.hidden = method !== "password";
      code.disabled = method !== "code"; code.required = !code.disabled; secret.disabled = method !== "password"; secret.required = !secret.disabled;
      code.value = ""; secret.value = ""; modes.forEach((node, index) => node.setAttribute("aria-pressed", String(index === (method === "code" ? 0 : 1))));
    };
    change("code");
    button(form, t("忘记密码", "Forgot password"), "quiet", () => password(true, undefined, email.value));
    submit(form, t("登录", "Sign in"), actions.signIn && (() => actions.signIn!({ email: email.value.trim(), method, credential: method === "code" ? code.value : secret.value })), modal);
  });
  const devices = () => show(t("设备管理", "Devices"), (body, modal) => {
    if (vm.membership.devices == null) copy(body, t("设备信息暂不可用", "Device information unavailable"));
    else if (!vm.membership.devices.length) copy(body, t("暂无已激活设备", "No activated devices"));
    for (const device of vm.membership.devices ?? []) {
      const row = el(body, "div", "device-row"); const info = el(row, "div"); el(info, "strong", "", device.name); el(info, "small", "", device.description);
      if(actions.renameDevice) button(row,t("改名","Rename"),"quiet",()=>{const form=el(body,"form");const name=field(form,t("设备名称","Device name"),"text",device.name);name.maxLength=80;submit(form,t("保存名称","Save name"),()=>actions.renameDevice!(device.id,name.value),modal);});
      const remove = button(row, device.current ? t("解绑本机", "Remove this device") : t("解绑", "Remove"), "secondary");
      remove.disabled = !vm.serviceAvailable || !actions.removeDevice;
      remove.onclick = () => { if (!remove.disabled) { const form = el(body, "form"); submit(form, t("确认解绑", "Confirm removal"), () => actions.removeDevice!(device.id), modal); } };
    }
  });

  if(vm.storageNotice) copy(page,vm.storageNotice);
  const profileSection = el(page, "section", "profile-section"); profileSection.setAttribute("aria-label", t("个人资料", "Profile"));
  const profileCopy = el(profileSection, "div", "profile-copy");
  const profileActions = el(profileSection, "div", "profile-actions");
  if (vm.identity) {
    renderAvatar(profileCopy, vm.identity.avatar, vm.identity.name);
    const identity = el(profileCopy, "div"); const line = el(identity, "div", "name-line");
    el(line, "h2", "", vm.identity.name);
    const hasPro = retainedMembership || vm.membership.state === "scheduled";
    const expired = ["expired", "revoked"].includes(vm.membership.state);
    el(line, "span", `badge${expired ? " expired" : hasPro ? " pro" : ""}`, expired ? stateLabels[vm.membership.state][zh ? 0 : 1] : hasPro ? "✧ PRO" : t("基础版", "Free"));
    el(identity, "p", "", vm.identity.email);
    if (vm.identity.joinedAt) el(identity, "span", "muted", vm.identity.joinedAt);
    button(profileActions, t("编辑资料", "Edit profile"), "secondary", () => profile());
    button(profileActions, t("退出登录", "Sign out"), "quiet", () => show(t("退出登录", "Sign out"), (body, modal) => { const form = el(body, "form"); submit(form, t("退出登录", "Sign out"), actions.signOut, modal); }));
  } else {
    const identity = el(profileCopy, "div"); el(identity, "h2", "", t("未登录", "Signed out"));
    button(profileActions, t("登录 / 注册", "Sign in / register"), "primary", () => login());
    el(profileActions, "span", "registration-gift-tag", t("注册送激活码", "Register for an activation code"));
  }
  const heading = (parent: HTMLElement, title: string, caption?: string) => {
    const row = el(parent, "div", "section-heading"); el(row, "h2", "", title); if (caption) el(row, "span", "muted", caption); return row;
  };
  const overview = heading(page, t("我的使用概览", "My usage"));
  const scope = el(overview, "div", "scope", t("当前 Vault · 本地", "This vault · local"));
  const statsInfo = button(scope, "", "icon-button", () => show(t("统计口径", "About statistics"), body => {
    copy(body, t("统计仅覆盖当前知识库。", "Statistics cover this vault only."));
    copy(body, t("Token 为模型返回的输入 + 输出，缓存和思考明细包含在其中，不重复累加。", "Tokens are reported input + output. Cache and reasoning subsets are included, not added again."));
  })); icon(statsInfo, "circle-help"); statsInfo.setAttribute("aria-label", t("查看统计口径", "About statistics"));
  const metrics = el(page, "section", "metrics");
  const stats = vm.statistics;
  const metricRows = [
    [t("累计 Token", "Total tokens"), stats.totalTokens, t("输入 + 输出", "Input + output"), ""],
    [t("完成的对话轮次", "Completed turns"), stats.totalTurns, stats.coverage ?? t("从首次记录起", "Since first record"), ""],
    [t("当前连续使用", "Current streak"), stats.currentStreak, stats.coverage ?? t("仅已记录主动操作", "Recorded user activity"), t("天", "days")],
    [t("最长连续使用", "Longest streak"), stats.bestStreak, stats.coverage ?? t("仅已记录主动操作", "Recorded user activity"), t("天", "days")]
  ] as const;
  for (const [label, value, note, unit] of metricRows) {
    const card = el(metrics, "div"); el(card, "span", "metric-label", label);
    const big = el(card, "strong", "", value != null && label === metricRows[0][0] && value >= 1e6 ? (value / 1e6).toFixed(2) : number(value));
    if (value != null && label === metricRows[0][0] && value >= 1e6) el(big, "span", "unit", "M");
    if (value != null && unit) el(big, "span", "unit", unit);
    el(card, "small", "", value == null ? t("暂无统计", "No statistics") : note);
  }

  const activity = el(page, "section", "panel activity-panel");
  const activityHead = el(activity, "div", "section-heading compact"); const activityTitle = el(activityHead, "div", "heading-inline"); el(activityTitle, "h3", "", t("使用足迹", "Activity")); el(activityTitle, "span", "muted", stats.coverage ?? missing);
  const segments = el(activityHead, "div", "segments"); let heatMode: "tokens" | "turns" = "tokens";
  const heatButtons = [button(segments, "Token", "quiet", () => changeHeat("tokens")), button(segments, t("对话轮次", "Turns"), "quiet", () => changeHeat("turns"))];
  const layout = el(activity, "div", "heatmap-layout"); const weekdays = el(layout, "div", "week-labels"); weekdays.setAttribute("aria-hidden", "true");
  for (const name of zh ? ["一", "", "三", "", "五", "", "日"] : ["M", "", "W", "", "F", "", "S"]) el(weekdays, "span", "", name);
  const scroll = el(layout, "div", "heatmap-scroll"); const inner = el(scroll, "div", "heatmap-inner"); const months = el(inner, "div", "heat-months"); const heat = el(inner, "div", "heatmap");
  heat.setAttribute("role", "group"); heat.setAttribute("aria-label", t("使用热力图，方向键移动，Home/End 到首尾", "Activity heatmap. Use arrow keys or Home/End."));
  const endDate = stats.days.at(-1)?.date ?? localDate(new Date()); const dates = recentDates(endDate);
  const dayMap = new Map(stats.days.map(day => [day.date, day]));
  const footer = el(activity, "div", "heat-footer"); el(footer, "span", "", `${dates[0]} — ${dates.at(-1)}`);
  const legend = el(footer, "div", "legend", t("少", "Less")); for (let level = 0; level <= 4; level++) el(legend, "i").dataset.level = String(level); el(legend, "span", "", t("多", "More"));
  const changeHeat = (mode: typeof heatMode) => {
    hideTip(); heatMode = mode; const previousScroll = scroll.scrollLeft; disposeOriginControls(heat); heat.replaceChildren(); months.replaceChildren();
    heatButtons.forEach((node, i) => node.setAttribute("aria-pressed", String(i === (mode === "tokens" ? 0 : 1))));
    const leading = (new Date(`${dates[0]}T12:00:00`).getDay() + 6) % 7; for (let i = 0; i < leading; i++) el(heat, "span");
    const maximum = Math.max(1, ...dates.map(date => dayMap.get(date)?.[heatMode] ?? 0)); let lastMonth = "";
    const cells: HTMLButtonElement[] = [];
    dates.forEach((date, index) => {
      const day = dayMap.get(date); const count = day?.[mode];
      const cell = el(heat, "button", "heat-cell"); cell.type = "button"; cell.dataset.level = count == null || count === 0 ? "0" : String(Math.min(4, Math.ceil(count / maximum * 4))); cell.dataset.date = date;
      cell.tabIndex = index === dates.length - 1 ? 0 : -1;
      const label = `${date} · ${count == null ? t("暂无统计", "No statistics") : `${number(count)} ${mode === "tokens" ? "Token" : t("轮对话", "turns")}`}`;
      cell.setAttribute("aria-label", label); cell.setAttribute("aria-describedby", tooltip.id);
      cell.onfocus = cell.onmouseenter = () => showTip(cell, label);
      cell.onblur = cell.onmouseleave = hideTip;
      cell.onclick = () => show(`${date} · ${t("使用记录", "Usage")}`, body => {
        if (!day) copy(body, missing);
        else { copy(body, `${t("完成对话", "Completed turns")} ${number(day.turns)}`); copy(body, `${t("输入", "Input")} ${number(day.input)} Token · ${t("输出", "Output")} ${number(day.output)} Token`); copy(body, `${t("合计", "Total")} ${number(day.tokens)} Token`); }
      });
      cell.onkeydown = event => {
        const delta: Record<string, number> = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 };
        if (!(event.key in delta) && event.key !== "Home" && event.key !== "End") return;
        event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? cells.length - 1 : Math.max(0, Math.min(cells.length - 1, index + delta[event.key]));
        cell.tabIndex = -1; cells[next].tabIndex = 0; cells[next].focus({ preventScroll: true });
        const item = cells[next].getBoundingClientRect(), bounds = scroll.getBoundingClientRect(); if (item.right > bounds.right) scroll.scrollLeft += item.right - bounds.right; else if (item.left < bounds.left) scroll.scrollLeft -= bounds.left - item.left;
      };
      cells.push(cell);
      if (date.slice(0, 7) !== lastMonth) { lastMonth = date.slice(0, 7); const month = el(months, "span", "", zh ? `${Number(date.slice(5, 7))}月` : new Date(`${date}T12:00:00`).toLocaleDateString("en-US", { month: "short" })); month.style.gridColumn = String(Math.floor((index + leading) / 7) + 1); }
    });
    scroll.scrollLeft = previousScroll;
  };
  changeHeat("tokens");
  const view = page.ownerDocument.defaultView; if (view) heatFrame = view.requestAnimationFrame(() => { heatFrame = null; if (!disposed) scroll.scrollLeft = scroll.scrollWidth; });

  const preferencesHead = heading(page, t("使用偏好", "Usage preferences")); const ranges = el(preferencesHead, "div", "segments");
  const preferences = el(page, "div", "two-columns preferences");
  const modelCard = el(preferences, "section", "panel"), skillCard = el(preferences, "section", "panel");
  const rank = (card: HTMLElement, title: string, rows?: readonly AccountRank[]) => {
    card.replaceChildren(); const titleRow = el(card, "div", "section-heading compact"); el(titleRow, "h3", "", title); el(titleRow, "span", "muted", t("按使用次数", "By usage count"));
    const list = el(card, "div", "rank-list"); if (!rows?.length) { el(list, "p", "muted", missing); return; }
    const total = rows.reduce((sum, row) => sum + row.count, 0); const max = Math.max(1, ...rows.map(row => row.count));
    for (const item of rows) { const row = el(list, "div", "rank-row"); el(row, "div", "rank-icon", item.name.slice(0, 1)); el(row, "span", "rank-title", item.name); el(row, "span", "rank-count", `${number(item.count)} ${t("次", "uses")} · ${Math.round(item.count / Math.max(1, total) * 100)}%`); el(el(row, "div", "rank-bar"), "i").style.width = `${item.count / max * 100}%`; }
  };
  const rangeButtons: HTMLButtonElement[] = [];
  const changeRange = (range: 30 | 90 | "all") => { rangeButtons.forEach((node, index) => node.setAttribute("aria-pressed", String([30, 90, "all"][index] === range))); rank(modelCard, t("常用模型", "Models"), stats.rankings[range]?.models); rank(skillCard, t("常用 Skill", "Skills"), stats.rankings[range]?.skills); };
  for (const range of [30, 90, "all"] as const) rangeButtons.push(button(ranges, range === "all" ? t("全部", "All") : t(`近 ${range} 天`, `${range} days`), "quiet", () => changeRange(range)));
  changeRange(30);
  const assets = el(page, "section", "panel assets-panel"); const assetTitle = el(assets, "div", "section-heading compact"); el(assetTitle, "h3", "", t("我的知识资产", "Knowledge assets")); el(assetTitle, "span", "muted", t("当前 Vault", "This vault"));
  const assetGrid = el(assets, "div", "assets-grid");
  for (const [key, name, nameEn, symbol] of [["notes", "笔记", "Notes", "file-text"], ["knowledge", "知识条目", "Knowledge", "book-text"], ["memory", "个人记忆", "Memories", "layers"], ["expressions", "表达收藏", "Expressions", "feather"]] as const) {
    const asset = button(assetGrid, "", "asset", () => show(t(name, nameEn), body => copy(body, t("请从对应功能入口查看已有内容。", "View your content through its feature entry.")))); icon(asset, symbol); const label = el(asset, "span"); el(label, "strong", "", number(stats.assets[key])); el(label, "small", "", t(name, nameEn)); icon(asset, "chevron-right", "chevron"); asset.setAttribute("aria-label", `${t(name, nameEn)} · ${stats.assets[key] == null ? t("暂无统计", "No statistics") : number(stats.assets[key])}`);
  }
  const membership = el(page, "section", "membership-section"); heading(membership, t("订阅管理", "Subscription"));
  const panel = el(membership, "div", "panel membership-panel"); const summary = el(panel, "div", "membership-summary"); icon(summary, "feather", "membership-symbol"); const memberCopy = el(summary, "div", "membership-copy"); const nameLine = el(memberCopy, "div", "name-line"); el(nameLine, "h3", "", retainedMembership ? "EchoInk PRO" : t("EchoInk 基础版", "EchoInk Free")); el(nameLine, "span", `badge${valid ? " pro" : ["expired", "revoked"].includes(vm.membership.state) ? " expired" : ""}`, (stateLabels[vm.membership.state] ?? stateLabels["verification-required"])[zh ? 0 : 1]);
  const descriptions: Partial<Record<MembershipState, string>> = {
    scheduled: vm.membership.startsAt ? `${t("权益开始于", "Access starts on")} ${vm.membership.startsAt}` : t("权益尚未生效。", "Access has not started yet."),
    "verification-required": t("账号权益仍保留，请联网刷新验证。", "Your account access is retained. Refresh verification online."),
    "device-limit": t("账号权益仍保留，请先管理旧设备名额。", "Your account access is retained. Manage existing devices first."),
    revoked: t("授权已撤销，请联系支持核实；已有资料保留。", "Authorization was revoked. Contact support; saved content is retained."),
    expired: t("订阅已到期，已有资料仍可查看。", "Subscription expired. Saved content remains accessible.")
  };
  el(memberCopy, "p", "", descriptions[vm.membership.state] ?? (vm.membership.expiresAt ? `${t("有效至", "Valid until")} ${vm.membership.expiresAt}` : valid && currentPlanId === "early" ? t("财务 + 英语日记 2.x 不限时使用。", "Finance + English Diary 2.x lifetime access.") : valid ? t("已解锁 PRO 功能。", "PRO features unlocked.") : t("财务和英文日记需要 PRO，AI 需配置自己的模型服务。", "Finance and English Diary require PRO. Bring your own model provider.")));
  const verificationNote = [vm.membership.verifiedAt && `${t("最近验证", "Last verified")} ${vm.membership.verifiedAt}`, vm.membership.offlineUntil && `${t("凭证有效至", "Offline until")} ${vm.membership.offlineUntil}`].filter(Boolean).join(" · ");
  if (verificationNote) el(memberCopy, "div", "verification-note", verificationNote);
  const memberActions = el(summary, "div", "membership-actions");
  if(vm.identity&&["device-required","device-limit"].includes(vm.membership.state)&&actions.activateDevice) button(memberActions,t("在此设备启用","Activate this device"),"primary",()=>show(t("启用本机","Activate device"),(body,modal)=>{const form=el(body,"form");const name=field(form,t("设备名称","Device name"),"text",t("我的 Obsidian","My Obsidian"));name.maxLength=80;submit(form,t("启用","Activate"),()=>actions.activateDevice!(name.value),modal);}));
  const details = el(membership, "details", "plans-details"); const planSummary = el(details, "summary", "", t("查看订阅计划", "View subscription plans")); icon(planSummary, "chevron-right");
  details.open = valid;
  const openPlans = () => { details.open = true; details.scrollIntoView?.({ block: "nearest" }); };
  const needsVerification = !!vm.identity && (!!vm.verificationError || ["offline-valid", "verification-required", "revoked", "device-required", "device-limit", "scheduled"].includes(vm.membership.state));
  const refreshStatus = el(memberActions, "div", "activation-feedback");
  feedbackState(refreshStatus, vm.verificationError ? "error" : "status", vm.verificationError ?? "");
  let verifying = false;
  let verifyButton: HTMLButtonElement | undefined;
  const verify = async () => {
    if (verifying || !actions.verify || !vm.serviceAvailable || disposed) return;
    verifying = true;
    const release = beginAction();
    if (verifyButton) { verifyButton.disabled = true; buttonState(verifyButton, "loading", t("验证中", "Verifying")); }
    feedbackState(refreshStatus, "loading", t("正在联网验证…", "Verifying online…"));
    try {
      await actions.verify();
      if (!disposed) {
        feedbackState(refreshStatus, "success", t("验证完成", "Verification complete"));
        if (verifyButton) buttonState(verifyButton, "success", t("验证完成", "Verified"));
        await shortFeedback();
      }
    } catch (error) {
      if (!disposed) feedbackState(refreshStatus, "error", error instanceof Error ? error.message : t("验证失败，请重试。", "Verification failed. Try again."));
    } finally {
      verifying = false;
      if (!disposed && verifyButton) { verifyButton.disabled = false; buttonState(verifyButton, "idle", t("刷新验证", "Refresh verification")); }
      release();
    }
  };
  const recovery = vm.identity && ["device-limit", "device-required"].includes(vm.membership.state)
    ? { label: t("管理设备", "Manage devices"), action: devices }
    : vm.identity && vm.membership.state === "revoked" ? { label: t("联系支持", "Contact support"), action: () => show(t("联系支持", "Contact support"), body => copy(body, t("请提供账号邮箱，联系支持核实授权状态。", "Contact support with your account email to check your access."))) }
    : { label: vm.membership.state === "expired" ? t("查看权益", "View benefits") : valid ? t("查看权益", "View benefits") : t("查看订阅计划", "View subscription plans"), action: openPlans };
  button(memberActions, valid ? currentPlanLabel : recovery.label, "primary", valid ? openPlans : recovery.action);
  if (needsVerification) {
    verifyButton = button(memberActions, t("刷新验证", "Refresh verification"), "quiet", () => void verify());
    verifyButton.disabled = !vm.serviceAvailable || !actions.verify;
  }
  if (vm.identity && ["free", "expired"].includes(vm.membership.state)) {
    const redeemEntry = button(memberActions, t("使用兑换码", "Use a redemption code"), "secondary", () => show(t("使用兑换码", "Use a redemption code"), (body, modal) => {
      const releaseModal = beginAction();
      modal.afterClose = releaseModal;
      const form = el(body, "form", "activation-form");
      const code = field(form, t("兑换码", "Redemption code"));
      code.placeholder = t("输入兑换码", "Enter a redemption code"); code.required = true; code.spellcheck = false;
      const feedback = el(form, "p", "activation-feedback"); feedbackState(feedback, "status", "");
      feedback.id = `echoink-redemption-feedback-${++fieldSequence}`; code.setAttribute("aria-describedby", feedback.id);
      const controls = el(form, "div", "dialog-actions");
      button(controls, t("取消", "Cancel"), "quiet", () => modal.close());
      const redeem = button(controls, t("兑换", "Redeem"), "primary"); redeem.type = "submit";
      let submitting = false;
      form.onsubmit = async event => {
        event.preventDefault();
        if (submitting || disposed || !actions.redeem || !vm.serviceAvailable) return;
        if (options.read && options.read().identity?.email !== vm.identity?.email) { modal.close(); return; }
        if (!code.value.trim()) { feedbackState(feedback, "error", t("请输入兑换码", "Enter a redemption code")); return; }
        submitting = true; redeem.disabled = true; code.readOnly = true;
        feedbackState(feedback, "loading", t("正在兑换并验证本机授权…", "Redeeming and verifying device access…"));
        buttonState(redeem, "loading", t("兑换中", "Redeeming"));
        const release = beginAction();
        try {
          await actions.redeem(code.value.trim());
          const latest = options.read?.() ?? vm;
          if (!["active", "lifetime", "offline-valid"].includes(latest.membership.state))
            throw new Error(t("兑换后本机授权尚未生效，请在账号与会员中恢复授权。", "Device access is not active yet. Restore authorization in Account."));
          if (!disposed && form.isConnected) {
            feedbackState(feedback, "success", t("兑换码使用成功", "Redemption successful"));
            buttonState(redeem, "success", t("兑换成功", "Redeemed"));
            await shortFeedback();
            if (!disposed && form.isConnected) { modal.close(); new Notice(t("兑换码使用成功", "Redemption successful")); }
          }
        } catch (error) {
          if (!disposed && form.isConnected) {
            feedbackState(feedback, "error", error instanceof Error ? error.message : t("兑换失败，请重试。", "Redemption failed. Try again."));
            buttonState(redeem, "idle", t("兑换", "Redeem")); redeem.disabled = false; code.readOnly = false;
          }
        } finally { submitting = false; release(); }
      };
    }));
    redeemEntry.disabled = !vm.serviceAvailable || !actions.redeem;
  }
  const memberFooter = el(panel, "div", "membership-footer");
  if (vm.identity) {
    const devicesButton = button(memberFooter, "", "quiet", devices); icon(devicesButton, "layers");
    el(devicesButton, "span", "", vm.membership.devices == null ? t("设备管理", "Devices") : `${t("设备管理", "Devices")} · ${vm.membership.devices.length} / ${number(vm.membership.deviceLimit)}`); icon(devicesButton, "chevron-right");
  }
  el(memberFooter, "span", "", t("AI 需自备 API Key，模型调用费另计", "Bring your own API key; model costs are separate"));
  const intro = el(details, "div", "plans-intro");
  if (!valid) el(intro, "p", "", t("升级 PRO，解锁更多插件的进阶功能。", "Upgrade to PRO for advanced features across more plugins."));
  el(intro, "p", "", t("详细功能见下方 PRO 版本功能权益介绍。", "Explore PRO features in the benefits section below."));
  const planGrid = el(details, "div", "plan-grid");
  let timeZone: string | undefined;
  try { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { /* Unknown zones use the international price list. */ }
  const currency = resolveMembershipCurrency(timeZone);
  const currencySymbol = currency === "CNY" ? "¥" : "US$";
  const money = (amountMinor: number, savings = false) => (amountMinor / 100).toLocaleString(zh ? "zh-CN" : "en-US", {
    minimumFractionDigits: currency === "USD" || savings && amountMinor % 100 !== 0 ? 2 : 0,
    maximumFractionDigits: 2
  });
  const serverPrices=vm.products?.length?vm.products:null;
  const pricingRows=getMembershipPlanPricing(currency).map(row=>{const p=serverPrices?.find(p=>p.id===row.id);if(!p)return row;const amountMinor=p.prices[currency],comparisonAmountMinor=row.id==="early"?serverPrices!.find(p=>p.id==="year")!.prices[currency]:row.id==="quarter"?serverPrices!.find(p=>p.id==="month")!.prices[currency]*3:row.id==="year"?serverPrices!.find(p=>p.id==="month")!.prices[currency]*12:null;const savingsAmountMinor=comparisonAmountMinor===null?null:comparisonAmountMinor-amountMinor;return {...row,amountMinor,days:p.days,dailyAmountMinor:p.days===null?null:amountMinor/p.days,comparisonAmountMinor,savingsAmountMinor,savingsPercent:comparisonAmountMinor?Math.round(savingsAmountMinor!/comparisonAmountMinor*100):null};});
  for (const pricing of pricingRows) {
    const plan = plans.find(item => item.id === pricing.id)!;
    const card = el(planGrid, "article", `plan${plan.id === "early" ? " is-early" : ""}`);
    card.dataset.planId = plan.id;
    el(card, "strong", "plan-title", zh ? plan.zh : plan.en);
    const badge = plan.months > 1
      ? t(`约 ${(pricing.amountMinor / pricing.comparisonAmountMinor! * 10).toFixed(1).replace(/\.0$/, "")} 折`, `Save ${pricing.savingsPercent}%`)
      : plan.id === "early" ? t("早鸟专享", "Early bird") : t("灵活体验", "Flexible access");
    el(card, "span", "plan-offer", badge);
    const price = el(card, "div", "price");
    const amount = el(price, "span", "price-amount");
    el(amount, "span", currency === "USD" ? "price-currency" : "", currencySymbol);
    el(amount, "span", "", money(pricing.amountMinor));
    el(price, "small", "price-term", zh ? plan.zhTerm : plan.enTerm);
    el(card, "p", "plan-daily", pricing.dailyAmountMinor != null
      ? currency === "USD"
        ? t(`约 ${pricing.dailyAmountMinor.toFixed(1).replace(/\.0$/, "")} 美分 / 天`, `≈ ${pricing.dailyAmountMinor.toFixed(1).replace(/\.0$/, "")}¢ / day`)
        : t(`约 ¥${(pricing.dailyAmountMinor / 100).toFixed(2)} / 天`, `≈ ¥${(pricing.dailyAmountMinor / 100).toFixed(2)} / day`)
      : t("2.x 不限时使用", "Lifetime access to 2.x"));
    const comparison = el(card, "p", "plan-comparison");
    if (pricing.savingsAmountMinor != null) {
      el(comparison, "span", "", plan.id === "early"
        ? t("比年卡少付", "vs. an annual pass")
        : t(`比连续买 ${plan.months} 个月月卡`, `vs. ${plan.months} monthly passes`));
      const saving = el(comparison, "strong", "plan-saving");
      el(saving, "span", "plan-saving-amount", `${plan.id === "early" && zh ? "" : t("省 ", "Save ")}${currencySymbol}${money(pricing.savingsAmountMinor, true)}`);
      el(saving, "span", "plan-saving-percent", `-${pricing.savingsPercent}%`);
    } else {
      comparison.textContent = t("按月购买，轻松开始", "Start with one month");
    }
    const current = valid && currentPlanId === plan.id;
    const purchase = button(card, current ? t("使用中", "Current plan") : t("购买待开放", "Purchasing unavailable"), current ? "secondary is-current" : "secondary");
    purchase.disabled = true;
    if (current) purchase.setAttribute("aria-current", "true");
  }
  el(details, "p", "plan-note", t("日均价格按月卡 30 天、季卡 90 天、年卡 365 天估算。", "Daily estimates use 30, 90 and 365 days for monthly, quarterly and annual passes."));
  const features = el(page, "section", "features-section"); heading(features, t("功能权益", "Benefits"));
  const featureGrid = el(features, "div", "two-columns");
  const groups = [
    { name: t("财务", "Finance"), symbol: "folder-kanban", rows: [[t("AI 整理", "AI organization"), true, t("体验整理", "Organize")], [t("账单计划", "Bill plans"), true, t("新建计划", "New plan")], [t("AI 财务分析", "AI financial analysis"), true, t("生成分析", "Analyze")], [t("CSV 导出", "CSV export"), true, t("导出", "Export")]] },
    { name: t("英语日记", "English Diary"), symbol: "feather", rows: [[t("已保存的原文与对照", "Saved original and translation"), false, t("查看已有", "View saved")], [t("生成中英对照", "Generate bilingual diary"), true, t("生成对照", "Translate")], [t("表达讲解", "Expression explanations"), true, t("生成讲解", "Explain")], [t("自动归入表达库", "Expression collection"), true, t("收藏表达", "Collect")], [t("跨日表达回顾", "Expression timeline"), true, t("查看回顾", "Review")]] }
  ];
  for (const group of groups) {
    const card = el(featureGrid, "article", "panel plugin-feature-card"); const head = el(card, "div", "feature-head"); const title = el(head, "div", "feature-title"); icon(title, group.symbol); el(title, "h3", "", group.name); el(head, "span", `badge${valid ? " pro" : ""}`, valid ? "✧ PRO" : t("功能权益", "Benefits"));
    for (const [rowIndex, [name, pro, actionLabel]] of group.rows.entries()) {
      const needsProvider = group.symbol === "folder-kanban" ? rowIndex === 0 || rowIndex === 2 : [1, 2, 3].includes(rowIndex);
      const blocked = Boolean(pro) && !valid || needsProvider && vm.provider !== "configured";
      const reason = Boolean(pro) && !valid ? t("需要有效的 PRO 权益。", "An active PRO plan is required.") : t("需先配置自己的模型服务。", "Configure your model provider first.");
      const row = el(card, "div", `feature-row${blocked ? " locked" : ""}`); const label = el(row, "div", "label-group"); el(label, "strong", "", String(name)); if (pro) el(label, "span", "badge pro", "PRO");
      const action = button(row, String(actionLabel), "secondary", () => show(String(name), body => copy(body, t("请从对应插件入口使用此功能。", "Use this feature through its plugin entry."))));
      action.disabled = blocked;
      if (blocked) { action.title = reason; const explanation = el(row, "span", "account-visually-hidden", reason); explanation.id = `echoink-feature-reason-${++fieldSequence}`; action.setAttribute("aria-describedby", explanation.id); }
    }
    const hint = el(card, "div", "feature-hint");
    const providerMissing = vm.provider !== "configured" && (valid || vm.membership.state === "free");
    el(hint, "span", "", providerMissing ? t("AI 功能需配置模型", "Configure a provider for AI") : valid ? t("PRO 权益有效", "PRO active") : descriptions[vm.membership.state] ?? t("PRO 功能", "PRO features"));
    button(hint, providerMissing ? t("配置模型", "Configure provider") : recovery.label, "quiet", providerMissing ? openProviders : recovery.action);
  }
  appendAccountComingSoon(featureGrid, groups.length, zh);
  if (vm.provider !== "configured") { const provider = el(page, "div", "provider-note"); el(provider, "span", "muted", vm.provider === "missing" ? t("AI 功能需配置自己的模型服务", "AI requires your own model provider") : t("模型配置状态未知", "Model provider status unknown")); button(provider, t("配置模型", "Configure provider"), "quiet", openProviders); }
  return { dispose: () => {
    if (disposed) return; disposed = true;
    if (feedbackTimer !== null) clearTimeout(feedbackTimer);
    finishFeedback?.(); finishFeedback = null;
    if (heatFrame != null) view?.cancelAnimationFrame(heatFrame);
    page.ownerDocument.removeEventListener("scroll", hideTip, true);
    page.ownerDocument.removeEventListener("keydown", escapeTip);
    page.ownerDocument.defaultView?.removeEventListener("resize", hideTip); tooltip.remove();
    for (const modal of [...modals]) modal.close(); modals.clear(); clearDraft();
    page.querySelectorAll<HTMLInputElement>("input").forEach(input => input.value = "");
    page.querySelectorAll<HTMLElement>("*").forEach(node => { node.onclick = node.oninput = node.onchange = node.onkeydown = node.onfocus = node.onmouseenter = node.onmouseleave = node.onblur = null; if (node.tagName === "FORM") (node as HTMLFormElement).onsubmit = null; });
    disposeOriginControls(page); page.remove();
  } };
}
let fieldSequence = 0;
function renderAvatar(parent: HTMLElement, avatar: AccountAvatar, name: string) {
  const node = el(parent, "div", "avatar"); node.setAttribute("role", "img"); node.setAttribute("aria-label", name);
  if (avatar === "initial") node.textContent = [...name.trim()][0] || "E";
  else { const image = el(node, "img"); image.src = avatar.url; image.alt = ""; }
}
export function appendAccountComingSoon(parent: HTMLElement, pluginCount: number, zh: boolean) {
  const card = el(parent, "article", `panel coming-soon${pluginCount % 2 === 0 ? " span-full" : ""}`); const title = el(card, "div", "feature-title"); icon(title, "layers"); el(title, "h3", "", zh ? "更多插件，敬请期待" : "More plugins coming soon"); el(card, "p", "", zh ? "后续插件权益以发布说明为准。" : "Future benefits will be announced with releases."); return card;
}
function localDate(date: Date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
function recentDates(end: string) {
  const date = new Date(`${end}T12:00:00`); if (!Number.isFinite(date.getTime())) return recentDates(localDate(new Date()));
  return Array.from({ length: 365 }, (_, index) => { const day = new Date(date); day.setDate(day.getDate() - 364 + index); return localDate(day); });
}
class AccountModal extends Modal {
  afterClose?: () => void;
  private readonly opener: HTMLElement | null;
  private escapeDocument: Document | null = null;
  constructor(app: App, private readonly source: HTMLElement, private readonly title: string, private readonly render: (body: HTMLElement, modal: AccountModal) => void, private readonly closed: () => void) {
    super(app); this.opener = source.ownerDocument.activeElement as HTMLElement | null;
  }
  private readonly escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); this.close(); } };
  onOpen() {
    const doc = this.source.ownerDocument;
    if (this.modalEl.ownerDocument !== doc) doc.body.appendChild(doc.adoptNode(this.containerEl));
    this.modalEl.classList.add("echoink-account-modal", "echoink-account");
    this.titleEl.textContent = this.title;
    copyAccountTheme(this.source, this.modalEl);
    this.escapeDocument = doc; doc.addEventListener("keydown", this.escape, true);
    this.render(this.contentEl, this);
    this.contentEl.querySelector<HTMLElement>("input:not([disabled]), button:not([disabled])")?.focus();
  }
  onClose() {
    this.escapeDocument?.removeEventListener("keydown", this.escape, true); this.escapeDocument = null;
    this.contentEl.querySelectorAll<HTMLInputElement>("input").forEach(input => input.value = "");
    this.contentEl.querySelectorAll<HTMLElement>("*").forEach(node => { node.onclick = node.oninput = node.onchange = node.onerror = null; if (node.tagName === "FORM") (node as HTMLFormElement).onsubmit = null; });
    disposeOriginControls(this.contentEl); this.contentEl.replaceChildren(); this.closed(); this.afterClose?.(); this.afterClose = undefined;
    if (this.opener?.isConnected) this.opener.focus({ preventScroll: true });
  }
}

function copyAccountTheme(source: HTMLElement, target: HTMLElement) {
  const tokens = source.ownerDocument.defaultView?.getComputedStyle(source);
  for (const name of ["--bg", "--text", "--secondary", "--muted", "--line", "--soft", "--accent", "--accent-bg", "--font-text-size", "--font-interface", "--chart", "--chart-soft", "--card", "--raised", "--active", "--on-accent", "--gold", "--gold-bg", "--danger", "--account-primary-bg", "--account-primary-text"]) { const value = tokens?.getPropertyValue(name); if (value?.trim()) target.style.setProperty(name, value); }
}
