import type { AgentDefinition } from "../agents/types";
import { getAgentPersonaTemplate, isExpertAgent } from "../agents/persona";
import { userFacingErrorText } from "../core/error-copy";
import type { EchoInkResource } from "../resources/types";
import { ownedEl } from "../ui/owned-dom";
import { MAX_SUBMISSION_AVATAR_BYTES, type ExpertAvatarPreset, type ExpertSubmissionAvatar,
  type ExpertSubmissionHistory, type ExpertSubmissionPayload, type ExpertSubmissionReceipt, type ExpertReviewStatus } from "./submission-contract";
import { collectExpertSubmissionSkills, submissionText, type ExpertSubmissionService } from "./submission-service";

export interface ExpertSubmissionViewOptions {
  service: ExpertSubmissionService;
  agent: AgentDefinition;
  language?: string;
  resources(): Promise<readonly EchoInkResource[]>;
  readSkill(path: string): Promise<string>;
  button(parent: HTMLElement, text: string, action: () => void, primary?: boolean): HTMLButtonElement;
  input(parent: HTMLElement): HTMLInputElement;
  checkbox(parent: HTMLElement): HTMLButtonElement & { checked: boolean };
  pagination(parent: HTMLElement, page: number, pages: number, onChange: (page: number) => void): HTMLElement;
  clearControls?(root: HTMLElement): void;
}

export function renderExpertSubmission(root: HTMLElement, options: ExpertSubmissionViewOptions) {
  const { service, agent } = options;
  const lang = options.language === "en" ? "en" : "zh";
  const t = (zh: string, en: string) => lang === "en" ? en : zh;
  const owner = service.owner();
  if (!owner || isExpertAgent(agent)) throw new Error(t("请登录后查看投稿回执。", "Sign in to view submission receipts."));
  let disposed = false, busy = false;
  let presets: ExpertAvatarPreset[] = [];
  let receipt: ExpertSubmissionReceipt | null = null;
  let history: ExpertSubmissionHistory | null = null, justSubmitted = false, receiptSaved = true;
  let staged: { payload: ExpertSubmissionPayload; avatarUrl: string } | undefined;

  function el<K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
    const node = ownedEl(root.ownerDocument, tag);
    node.className = cls;
    if (text !== undefined) node.textContent = text;
    parent.append(node);
    return node;
  }
  const value = {
    name: agent.name, scene: agent.position, summary: agent.positionDescription ?? "", quote: "", tags: "", examples: "", author: "",
  };
  let avatar: ExpertSubmissionAvatar | undefined, avatarUrl = "";
  const initialAvatar = agent.avatar;
  if (initialAvatar.kind === "custom") {
    const mime = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/u.exec(initialAvatar.dataUrl);
    if (mime && mime[2].length <= Math.ceil(MAX_SUBMISSION_AVATAR_BYTES / 3) * 4) {
      avatar = { base64: mime[2] }; avatarUrl = initialAvatar.dataUrl;
    }
  }

  root.classList.add("echoink-expert-submission");
  root.lang = lang === "en" ? "en" : "zh-CN";
  root.tabIndex = -1;

  const clear = () => { options.clearControls?.(root); root.replaceChildren(); };
  const report = (status: HTMLElement, error: unknown) => {
    const code = (error as { code?: string } | null)?.code;
    const copy: Record<string, string> = {
      EXPERT_SUBMISSION_PENDING: t("这一份投稿已有版本在等待审核。", "A version of this submission is already awaiting review."),
      INVALID_INPUT: t("投稿资料格式有误，请返回检查。", "Check the submission fields and try again."),
      AVATAR_INVALID: t("请选择 1 MiB 以内的单帧 PNG、JPEG 或 WebP 图片。", "Choose a single-frame PNG, JPEG or WebP image up to 1 MiB."),
      EXPERT_PACKAGE_TOO_LARGE: t("投稿内容过大，请缩短人设或减少所挂 Skill 后重试。", "The submission is too large. Shorten the persona or attach fewer Skills."),
      OPERATION_CANCELLED: t("账号已切换，请重新打开投稿页。", "Your account changed. Reopen the submission page."),
    };
    status.textContent = code && copy[code] || userFacingErrorText(error,
      t("暂时无法完成投稿，请稍后重试。", "The submission could not be completed. Try again later."), lang);
  };
  const current = () => !disposed && service.owner() === owner;
  const statusArea = () => {
    const status = el(root, "p", "echoink-expert-submission-error");
    status.setAttribute("role", "alert");
    return status;
  };
  const fieldNames = {
    name: t("名字", "Name"), scene: t("场景", "Use case"), summary: t("简介", "Summary"), quote: t("一句话", "Quote"),
    tags: t("标签（3 个，每行一个）", "Tags (3, one per line)"), examples: t("示例问题（3–4 条，每行一条）", "Example questions (3–4, one per line)"),
    author: t("公开署名", "Public attribution"), avatar: t("头像", "Avatar"), persona: t("人设", "Persona"),
  };
  const asLines = (raw: string) => raw.split(/\r?\n/u).map(submissionText).filter(Boolean);

  function drawForm() {
    clear();
    if (history?.total || receipt) {
      options.button(root, t("查看投稿回执", "View submission receipts"), () => { void load(); })
        .classList.add("echoink-expert-submission-back");
    }
    const fields = el(root, "fieldset", "echoink-expert-submission-fields");
    const field = (key: keyof typeof value, max: number, multi = false, rows = 3) => {
      const label = el(fields, "label", "echoink-expert-submission-field");
      el(label, "span", "", fieldNames[key]);
      const input = multi ? el(label, "textarea", "") : options.input(label);
      input.name = key;
      input.value = value[key]; input.maxLength = max; input.required = true;
      if (input instanceof root.ownerDocument.defaultView!.HTMLTextAreaElement) input.rows = rows;
      input.addEventListener("input", () => { value[key] = input.value; });
      return input;
    };
    field("name", 300); field("scene", 300); field("summary", 4000, true, 2); field("quote", 4000);
    field("tags", 903, true); field("examples", 16004, true, 4); field("author", 120);
    const avatarField = el(fields, "label", "echoink-expert-submission-field");
    el(avatarField, "span", "", fieldNames.avatar);
    const picker = el(avatarField, "select", "");
    const add = (id: string, label: string) => { const item = el(picker, "option", "", label); item.value = id; };
    add("", t("选择站内预设", "Choose a preset"));
    picker.options[0].disabled = true;
    for (const item of presets) add(item.id, item.id[0].toUpperCase() + item.id.slice(1));
    if (avatar && "base64" in avatar) add("uploaded", t("已上传图片", "Uploaded image"));
    picker.value = avatar ? ("presetId" in avatar ? avatar.presetId : "uploaded") : "";
    const picture = el(fields, "img", "echoink-expert-submission-avatar");
    const updatePicture = () => {
      picture.alt = fieldNames.avatar; picture.hidden = !avatarUrl; picture.referrerPolicy = "no-referrer";
      if (avatarUrl) picture.src = avatarUrl;
    };
    updatePicture();
    picker.onchange = () => {
      const item = presets.find(preset => preset.id === picker.value);
      if (item) { avatar = { presetId: item.id }; avatarUrl = item.avatarUrl; picker.querySelector('[value="uploaded"]')?.remove(); updatePicture(); }
    };
    const file = el(fields, "input", "");
    file.hidden = true; file.type = "file"; file.accept = "image/png,image/jpeg,image/webp";
    options.button(fields, t("上传图片", "Upload image"), () => file.click()).classList.add("echoink-expert-submission-upload");
    const status = statusArea();
    const actions = el(root, "div", "echoink-expert-submission-actions");
    const preview = options.button(actions, t("预览投稿", "Preview submission"), () => { void prepare(); }, true);
    file.onchange = () => {
      const item = file.files?.[0];
      if (!item || busy) return;
      if (!["image/png", "image/jpeg", "image/webp"].includes(item.type) || item.size > MAX_SUBMISSION_AVATAR_BYTES || !item.size) {
        report(status, { code: "AVATAR_INVALID" }); return;
      }
      const reader = new root.ownerDocument.defaultView!.FileReader();
      reader.onerror = () => report(status, { code: "AVATAR_INVALID" });
      reader.onload = () => {
        if (disposed || !fields.isConnected || typeof reader.result !== "string") return;
        const comma = reader.result.indexOf(",");
        if (comma < 0) return;
        avatarUrl = reader.result; avatar = { base64: avatarUrl.slice(comma + 1) };
        if (!picker.querySelector('[value="uploaded"]')) add("uploaded", t("已上传图片", "Uploaded image"));
        picker.value = "uploaded"; updatePicture(); status.textContent = "";
      };
      reader.readAsDataURL(item);
    };
    async function prepare() {
      if (busy || disposed) return;
      const fieldsToSend = { name: submissionText(value.name), scene: submissionText(value.scene),
        summary: submissionText(value.summary), quote: submissionText(value.quote) };
      const author = { name: submissionText(value.author) }, tags = asLines(value.tags), examples = asLines(value.examples);
      const persona = submissionText(agent.persona?.trim() || getAgentPersonaTemplate(agent.styleId, lang));
      if (Object.values(fieldsToSend).some(field => !field) || !author.name || !avatar) {
        status.textContent = t("请填完整投稿资料、公开署名和头像。", "Complete the submission fields, public attribution and avatar."); return;
      }
      if (tags.length !== 3 || tags.some(tag => tag.length > 300) || examples.length < 3 || examples.length > 4 || examples.some(item => item.length > 4000)) {
        status.textContent = t("请填写 3 个标签、3–4 条示例问题，每行一条。", "Enter 3 tags and 3–4 example questions, one per line."); return;
      }
      if (Array.from(persona).length > 4000) {
        status.textContent = t("请返回 Agent 编辑页，把人设缩短到 4000 字以内。", "Shorten the Agent persona to 4,000 characters in the Agent editor."); return;
      }
      const candidate = { ...fieldsToSend, author, tags, examples, persona, avatar };
      const image = avatarUrl;
      busy = true; fields.disabled = true; preview.disabled = true; status.textContent = "";
      try {
        const skills = await collectExpertSubmissionSkills(agent, await options.resources(), path => options.readSkill(path));
        if (disposed) return;
        if (skills.length > 100) throw new Error(t("投稿最多包含 100 个 Skill。", "A submission can include at most 100 Skills."));
        staged = { payload: { ...candidate, skills }, avatarUrl: image };
        drawPreview();
      } catch (error) { if (!disposed) report(status, error); }
      finally { busy = false; fields.disabled = false; preview.disabled = false; }
    }
  }

  function drawPreview() {
    if (!staged) return;
    clear();
    const { payload, avatarUrl } = staged;
    options.button(root, t("返回填写", "Back to details"), drawForm).classList.add("echoink-expert-submission-back");
    el(root, "h3", "", t("预览投稿", "Preview submission")).tabIndex = -1;
    el(root, "p", "echoink-expert-submission-muted", t("请确认公开署名及本次上传的内容。人设和 Skill 在收录后会下载到聘用者的设备，并用于其选择的模型。",
      "Confirm your public attribution and the content to upload. Once published, the persona and Skills download to the hiring user's device for use with their chosen model."));
    const data = el(root, "dl", "echoink-expert-submission-preview");
    const show = (label: string, value: string) => { el(data, "dt", "", label); el(data, "dd", "", value); };
    show(fieldNames.author, payload.author.name);
    el(data, "dt", "", fieldNames.avatar);
    const picture = el(el(data, "dd", ""), "img", "echoink-expert-submission-avatar");
    picture.src = avatarUrl; picture.alt = fieldNames.avatar; picture.referrerPolicy = "no-referrer";
    show(fieldNames.name, payload.name); show(fieldNames.scene, payload.scene); show(fieldNames.summary, payload.summary); show(fieldNames.quote, payload.quote);
    show(t("标签", "Tags"), payload.tags.join(lang === "en" ? ", " : "、"));
    show(t("示例问题", "Example questions"), payload.examples.join("\n"));
    show(fieldNames.persona, payload.persona);
    el(root, "h4", "", t("库内 Skill", "Vault Skills"));
    if (!payload.skills.length) el(root, "p", "echoink-expert-submission-muted", t("无", "None"));
    for (const skill of payload.skills) {
      const details = el(root, "details", "echoink-expert-submission-skill");
      el(details, "summary", "", skill.name);
      el(details, "p", "", skill.description);
      el(details, "pre", "", skill.content);
    }
    const declaration = t("人设里如藏有删除、篡改用户内容或外传数据的指令，一经发现立即封号。",
      "Hidden instructions to delete, tamper with, or exfiltrate user content will lead to immediate account termination if found.");
    const consent = el(root, "div", "echoink-expert-submission-consent");
    const checkbox = options.checkbox(consent);
    checkbox.setAttribute("aria-label", declaration);
    el(consent, "span", "", declaration).onclick = () => { if (!busy) checkbox.click(); };
    const status = statusArea();
    const actions = el(root, "div", "echoink-expert-submission-actions");
    const submitLabel = t("提交审核", "Submit for review");
    const submit = options.button(actions, submitLabel, () => { void send(); }, true);
    submit.disabled = true;
    checkbox.addEventListener("change", () => { submit.disabled = busy || !checkbox.checked; });
    root.querySelector("h3")?.focus();
    async function send() {
      if (busy || disposed || !checkbox.checked) return;
      busy = true; submit.disabled = true; checkbox.disabled = true;
      const back = root.querySelector<HTMLButtonElement>(".echoink-expert-submission-back");
      if (back) back.disabled = true;
      submit.setAttribute("aria-busy", "true");
      status.textContent = t("正在提交…", "Submitting…");
      try {
        const result = await service.submit(agent.id, owner!, payload);
        if (!current()) return;
        receipt = result.receipt; receiptSaved = result.saved; justSubmitted = true;
        await load();
      } catch (error) { if (!disposed) report(status, error); }
      finally {
        busy = false; submit.disabled = !checkbox.checked; checkbox.disabled = false;
        if (back) back.disabled = false;
        submit.removeAttribute("aria-busy");
      }
    }
  }
  const statusNames: Record<ExpertReviewStatus, string> = {
    pending: t("待审", "Pending review"), published: t("已收录", "Published"),
    rejected: t("已驳回", "Rejected"), unlisted: t("已下架", "Unlisted"),
  };
  const date = new Intl.DateTimeFormat(lang === "en" ? "en" : "zh-CN", { dateStyle: "medium" });

  function drawReceipt(page: ExpertSubmissionHistory) {
    clear();
    if (service.canSubmit()) el(root, "h3", "", t("投稿回执", "Submission receipts"));
    if (!page.items.length) el(root, "p", "echoink-expert-submission-muted", t("暂无投稿", "No submissions yet"));
    else {
      const list = el(root, "ul", "echoink-expert-submission-reviews");
      for (const review of page.items) {
        const row = el(list, "li", "");
        el(row, "h4", "", review.name);
        const version = t(`第 ${review.version} 版`, `Version ${review.version}`);
        const state = review.superseded ? t("已收录（已被新版替代）", "Published (replaced by a newer version)") : statusNames[review.status];
        el(row, "p", "echoink-expert-submission-muted", `${version} · ${state} · ${date.format(review.updatedAt)}`);
        if (review.reason) el(row, "p", "echoink-expert-submission-reason", review.reason);
      }
    }
    if (!receiptSaved) el(root, "p", "echoink-expert-submission-error",
      t("提交成功，回执未能保存在本机。", "The submission succeeded, but the receipt could not be saved on this device."));
    const pages = Math.ceil(page.total / page.pageSize);
    if (pages > 1) options.pagination(root, page.page, pages, next => { void load(next); });
    const status = statusArea();
    const actions = el(root, "div", "echoink-expert-submission-actions");
    options.button(actions, t("刷新", "Refresh"), () => { void load(page.page); });
    if (service.canSubmit()) {
      const label = receipt ? t("提交新版本", "Submit a new version") : t("新投稿", "New submission");
      const button = options.button(actions, label, () => { void openForm(status); }, true);
      button.disabled = page.items.some(review => review.id === receipt?.id && review.status === "pending");
    }
  }

  async function openForm(status: HTMLElement) {
    if (busy || !current() || !service.canSubmit()) return;
    busy = true;
    try {
      presets = await service.presets(owner!);
      if (!avatar) {
        const preferred = presets.find(item => initialAvatar.kind === "preset" && item.id === initialAvatar.presetId) ?? presets[0];
        if (preferred) { avatar = { presetId: preferred.id }; avatarUrl = preferred.avatarUrl; }
      }
      if (current()) drawForm();
    } catch (error) { if (!disposed) report(status, error); }
    finally { busy = false; }
  }
  async function load(page = 1) {
    if (!current()) return;
    clear();
    const status = statusArea();
    status.textContent = t("正在读取…", "Loading…");
    const retry = () => options.button(root, t("重试", "Retry"), () => { void load(page); });
    try {
      const [saved, result] = await Promise.all([service.receipt(agent.id, owner!), service.history(owner!, page)]);
      if (!current()) return;
      receipt ??= saved;
      history = result;
      if (receipt || result.total || !service.canSubmit()) drawReceipt(result);
      else {
        await openForm(status);
        if (current() && root.contains(status)) retry();
      }
      justSubmitted = false;
    } catch (error) {
      if (!current()) return;
      status.textContent = justSubmitted
        ? t("已提交，等待审核。暂时无法读取投稿回执。", "Submitted for review. Receipts could not be loaded.")
        : userFacingErrorText(error, t("暂时无法读取投稿回执。", "Could not load submission receipts."), lang);
      retry();
    }
  }

  const unsubscribe = service.subscribe(() => {
    if (disposed || current()) return;
    clear();
    statusArea().textContent = t("账号已切换，请重新打开投稿回执。", "Your account changed. Reopen the submission receipts.");
  });
  void load();
  return { canLeave: () => !busy, dispose() { disposed = true; unsubscribe(); clear(); } };
}
