import { Modal, Notice, setIcon } from "obsidian";
import {
  AGENT_DISPLAY_NAME_MAX_CHARS,
  countUnicodeChars,
  normalizeAgentDisplayName,
  type AgentAvatarState
} from "../harness/memory/agent-identity-state";
import { applyAmicroButton } from "../settings/amicro-buttons";
import {
  AvatarProcessingError,
  createBrowserAvatarRenderer,
  processAgentAvatar,
  type AvatarRenderer
} from "./agent-avatar-processor";
import {
  AGENT_AVATAR_PRESETS,
  DEFAULT_AGENT_AVATAR_PRESET_ID,
  type AgentAvatarPreset
} from "./agent-avatar-presets";
import { renderAnimateIcon } from "./animate-icon";

let avatarRadioGroupSequence = 0;

export interface AgentIdentityDraft {
  readonly displayName: string;
  readonly avatar: AgentAvatarState;
}

export interface AgentIdentityModalOptions {
  readonly initialName: string;
  readonly initialAvatar: AgentAvatarState;
  readonly language: "zh" | "en";
  readonly mode: "first-run" | "edit";
  readonly presets?: readonly AgentAvatarPreset[];
  readonly avatarRenderer?: AvatarRenderer;
  readonly resolvePresetAsset?: (presetId: string) => string | null;
  readonly onConfirm: (draft: AgentIdentityDraft) => Promise<void>;
}

export class AgentIdentityModal extends Modal {
  private readonly options: AgentIdentityModalOptions;
  private readonly radioGroupName = `echoink-agent-avatar-${++avatarRadioGroupSequence}`;
  private nameValue: string;
  private avatarValue: AgentAvatarState;
  private nameInputEl: HTMLInputElement | null = null;
  private nameErrorEl: HTMLElement | null = null;
  private avatarErrorEl: HTMLElement | null = null;
  private avatarGridEl: HTMLElement | null = null;
  private uploadButtonEl: HTMLButtonElement | null = null;
  private confirmButtonEl: HTMLButtonElement | null = null;
  private busy = false;

  constructor(app: unknown, options: AgentIdentityModalOptions) {
    super(app as never);
    this.options = options;
    this.nameValue = options.initialName;
    this.avatarValue = normalizeInitialAvatar(options.initialAvatar, this.presets());
  }

  onOpen(): void {
    this.modalEl.addClass("echoink-theme-boundary");
    const zh = this.options.language !== "en";
    const content = this.contentEl;
    content.empty();
    content.addClass("echoink-agent-identity-modal");

    content.createEl("h2", { text: zh ? "给你的 Agent 起个名字" : "Name your Agent" });
    content.createDiv({
      cls: "echoink-agent-identity-modal-desc",
      text: this.options.mode === "first-run"
        ? (zh
            ? "这个名称和头像会显示在 Agent 的回复旁。以后可以在「基础设置 → 身份与用户画像」中修改。"
            : "This name and avatar appear next to the Agent's replies. You can change them later in Settings → Identity and user profile.")
        : (zh ? "修改身份不会重置人格或 Memory。" : "Changing identity does not reset personality or Memory.")
    });

    const nameField = content.createDiv({ cls: "echoink-agent-identity-field" });
    const nameLabel = nameField.createEl("label", {
      cls: "echoink-agent-identity-label",
      text: zh ? "Agent 名称" : "Agent name"
    });
    this.nameInputEl = nameField.createEl("input", {
      attr: {
        type: "text",
        placeholder: zh ? "例如：小墨" : "e.g. Xiaomo",
        maxlength: String(AGENT_DISPLAY_NAME_MAX_CHARS * 4)
      }
    });
    const nameInputId = `${this.radioGroupName}-name`;
    this.nameInputEl.id = nameInputId;
    nameLabel.setAttribute("for", nameInputId);
    this.nameInputEl.value = this.nameValue;
    this.nameErrorEl = nameField.createDiv({
      cls: "echoink-agent-identity-error",
      attr: { "aria-live": "polite" }
    });
    this.nameInputEl.addEventListener("input", () => {
      this.nameValue = this.nameInputEl?.value ?? "";
      this.refreshConfirmState();
    });

    const avatarArea = content.createDiv({ cls: "echoink-agent-identity-avatar-area" });
    const avatarHeader = avatarArea.createDiv({ cls: "echoink-agent-identity-avatar-header" });
    avatarHeader.createDiv({
      cls: "echoink-agent-identity-avatar-title",
      text: zh ? "给你的 Agent 选一个形象" : "Choose a look for your Agent"
    });
    this.uploadButtonEl = avatarHeader.createEl("button", {
      cls: "echoink-agent-identity-upload",
      attr: {
        type: "button",
        "aria-label": zh ? "上传 SVG 头像" : "Upload SVG avatar",
        title: zh ? "上传 SVG 头像" : "Upload SVG avatar"
      }
    });
    renderAnimateIcon(this.uploadButtonEl, "upload");
    this.uploadButtonEl.createSpan({ text: "Upload" });

    const fileInput = avatarArea.createEl("input", {
      cls: "echoink-agent-identity-file",
      attr: { type: "file", accept: ".svg,image/svg+xml" }
    });
    this.uploadButtonEl.addEventListener("click", () => {
      (fileInput as unknown as { click?: () => void }).click?.();
    });
    fileInput.addEventListener("change", () => void this.handleFilePicked(fileInput));

    this.avatarErrorEl = avatarArea.createDiv({
      cls: "echoink-agent-avatar-error",
      attr: { role: "status", "aria-live": "polite" }
    });
    const fieldset = avatarArea.createEl("fieldset", {
      cls: "echoink-agent-avatar-fieldset"
    });
    fieldset.createEl("legend", {
      cls: "echoink-agent-avatar-legend",
      text: zh ? "选择 Agent 头像" : "Choose Agent avatar"
    });
    this.avatarGridEl = fieldset.createDiv({ cls: "echoink-agent-avatar-grid" });
    this.renderAvatarOptions();

    const footer = content.createDiv({ cls: "echoink-agent-identity-footer" });
    const cancelButton = footer.createEl("button", {
      cls: "echoink-agent-identity-cancel",
      text: zh ? "取消" : "Cancel",
      attr: { type: "button" }
    });
    applyAmicroButton(cancelButton, { variant: "secondary" });
    cancelButton.addEventListener("click", () => this.close());
    this.confirmButtonEl = footer.createEl("button", {
      cls: "echoink-agent-identity-confirm mod-cta",
      text: this.options.mode === "first-run"
        ? (zh ? "完成设置" : "Finish setup")
        : (zh ? "保存" : "Save"),
      attr: { type: "button" }
    });
    applyAmicroButton(this.confirmButtonEl, { variant: "primary", motion: "complete" });
    this.confirmButtonEl.addEventListener("click", () => void this.handleConfirm());
    this.refreshConfirmState();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  nameValidationError(): string | null {
    const zh = this.options.language !== "en";
    const trimmed = this.nameValue.trim();
    if (!trimmed) return zh ? "请输入名称。" : "Please enter a name.";
    if (countUnicodeChars(trimmed) > AGENT_DISPLAY_NAME_MAX_CHARS) {
      return zh
        ? `名称不能超过 ${AGENT_DISPLAY_NAME_MAX_CHARS} 个字符。`
        : `The name must be at most ${AGENT_DISPLAY_NAME_MAX_CHARS} characters.`;
    }
    if (!normalizeAgentDisplayName(this.nameValue)) {
      return zh ? "名称不能包含换行或制表符。" : "The name cannot contain newlines or tabs.";
    }
    return null;
  }

  currentDraft(): AgentIdentityDraft {
    return Object.freeze({ displayName: this.nameValue.trim(), avatar: this.avatarValue });
  }

  private presets(): readonly AgentAvatarPreset[] {
    return this.options.presets ?? AGENT_AVATAR_PRESETS;
  }

  private refreshConfirmState(): void {
    const error = this.nameValidationError();
    if (this.nameErrorEl) this.nameErrorEl.setText(error ?? "");
    if (this.confirmButtonEl) this.confirmButtonEl.disabled = Boolean(error) || this.busy;
    if (this.uploadButtonEl) this.uploadButtonEl.disabled = this.busy;
  }

  private renderAvatarOptions(): void {
    if (!this.avatarGridEl) return;
    this.avatarGridEl.empty();
    for (const preset of this.presets()) {
      this.renderAvatarOption(
        `preset:${preset.id}`,
        this.options.language === "en" ? preset.labelEn : preset.labelZh,
        preset.assetPath,
        { kind: "preset", presetId: preset.id }
      );
    }
    if (this.avatarValue.kind === "custom") {
      this.renderAvatarOption(
        "custom",
        this.options.language === "en" ? "Custom" : "自定义",
        this.avatarValue.dataUrl,
        this.avatarValue
      );
    }
  }

  private renderAvatarOption(
    value: string,
    label: string,
    imageUrl: string,
    avatar: AgentAvatarState
  ): void {
    if (!this.avatarGridEl) return;
    const selected = avatarEquals(this.avatarValue, avatar);
    const tile = this.avatarGridEl.createEl("label", {
      cls: `echoink-agent-avatar-option${selected ? " is-selected" : ""}`,
      attr: { "data-avatar-value": value }
    });
    const input = tile.createEl("input", {
      cls: "echoink-agent-avatar-radio",
      attr: {
        type: "radio",
        name: this.radioGroupName,
        value,
        "aria-label": label
      }
    });
    input.checked = selected;
    tile.createEl("img", { attr: { src: imageUrl, alt: "" } });
    tile.createSpan({ cls: "echoink-agent-avatar-option-name", text: label });
    const check = tile.createSpan({
      cls: "echoink-agent-avatar-option-check",
      attr: { "aria-hidden": "true" }
    });
    setIcon(check, "check");
    const select = (): void => {
      this.avatarValue = Object.freeze(avatar);
      if (this.avatarErrorEl) this.avatarErrorEl.setText("");
      this.refreshAvatarSelection();
    };
    input.addEventListener("change", select);
  }

  private refreshAvatarSelection(): void {
    if (!this.avatarGridEl) return;
    const selectedValue = this.avatarValue.kind === "preset"
      ? `preset:${this.avatarValue.presetId}`
      : this.avatarValue.kind;
    for (const tile of Array.from(
      this.avatarGridEl.querySelectorAll<HTMLElement>(".echoink-agent-avatar-option")
    )) {
      const selected = tile.getAttribute("data-avatar-value") === selectedValue;
      tile.toggleClass("is-selected", selected);
      const radio = tile.querySelector<HTMLInputElement>(".echoink-agent-avatar-radio");
      if (radio) radio.checked = selected;
    }
  }

  private async handleFilePicked(fileInput: HTMLInputElement): Promise<void> {
    const files = (fileInput as unknown as { files?: FileList | null }).files;
    const file = files && files.length > 0 ? files[0] : null;
    if (!file) return;
    this.busy = true;
    this.refreshConfirmState();
    if (this.avatarErrorEl) this.avatarErrorEl.setText("");
    try {
      const avatar = await processAgentAvatar(
        file,
        file.type,
        file.size,
        this.options.avatarRenderer ?? createBrowserAvatarRenderer()
      );
      this.avatarValue = avatar;
      this.renderAvatarOptions();
    } catch (error) {
      const code = error instanceof AvatarProcessingError ? error.code : "decode_failed";
      if (this.avatarErrorEl) {
        this.avatarErrorEl.setText(avatarErrorMessage(code, this.options.language !== "en"));
      }
    } finally {
      (fileInput as unknown as { value: string }).value = "";
      this.busy = false;
      this.refreshConfirmState();
    }
  }

  private async handleConfirm(): Promise<void> {
    if (this.busy || this.nameValidationError()) {
      this.refreshConfirmState();
      return;
    }
    this.busy = true;
    this.refreshConfirmState();
    try {
      await this.options.onConfirm(this.currentDraft());
      this.close();
    } catch (error) {
      const zh = this.options.language !== "en";
      const message = error instanceof Error && error.message === "agent_identity_invalid_name"
        ? (zh ? "名称无效，请检查后重试。" : "Invalid name. Please check and retry.")
        : (zh ? "身份保存失败，请重试。" : "Failed to save identity. Please retry.");
      new Notice(message);
    } finally {
      this.busy = false;
      this.refreshConfirmState();
    }
  }
}

function normalizeInitialAvatar(
  avatar: AgentAvatarState,
  presets: readonly AgentAvatarPreset[]
): AgentAvatarState {
  if (avatar.kind === "custom") return avatar;
  if (avatar.kind === "preset" && presets.some((preset) => preset.id === avatar.presetId)) {
    return avatar;
  }
  const fallback = presets.find((preset) => preset.id === DEFAULT_AGENT_AVATAR_PRESET_ID)
    ?? presets[0];
  return fallback
    ? Object.freeze({ kind: "preset", presetId: fallback.id })
    : avatar;
}

function avatarEquals(left: AgentAvatarState, right: AgentAvatarState): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "preset" && right.kind === "preset") return left.presetId === right.presetId;
  if (left.kind === "custom" && right.kind === "custom") return left.dataUrl === right.dataUrl;
  return left.kind === "default" && right.kind === "default";
}

function avatarErrorMessage(code: string, zh: boolean): string {
  switch (code) {
    case "unsupported_type":
      return zh ? "只支持 SVG 头像，请重新选择。" : "Only SVG avatars are supported. Choose another file.";
    case "source_too_large":
      return zh ? "SVG 文件不能超过 4MB。" : "The SVG file must be under 4MB.";
    case "svg_not_square":
      return zh ? "SVG 画布必须是正方形。" : "The SVG canvas must be square.";
    case "svg_unsafe":
      return zh
        ? "这个 SVG 含脚本、事件或外部资源，无法安全使用。"
        : "This SVG contains scripts, events, or external resources and cannot be used safely.";
    case "image_too_large":
      return zh ? "SVG 尺寸过大（任一边不能超过 4096px）。" : "The SVG is too large (max 4096px per edge).";
    case "output_too_large":
      return zh ? "处理后的头像仍然过大，请换一个 SVG。" : "The processed avatar is still too large. Try another SVG.";
    case "svg_invalid":
      return zh ? "SVG 文件已损坏或画布信息无效。" : "The SVG is damaged or has an invalid canvas.";
    default:
      return zh ? "头像处理失败，请换一个 SVG 后重试。" : "Failed to process the avatar. Try another SVG.";
  }
}
