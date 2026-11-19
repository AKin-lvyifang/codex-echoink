import { OriginSetting } from "./origin-setting";
import { createOriginButton, disposeOriginControls } from "./origin-controls";
import type { DeveloperAction, DeveloperModeService, DeveloperResult, DeveloperStatus } from "../plugin/developer-mode/service";
import { applySettingsRow } from "./settings-v2";
import { NEXT, failureText, type ErrorCopy, CAUSE } from "../core/error-copy";
import { SETTINGS_SCENE, joinCopyPair } from "../core/error-copy/codes/settings";

export class DeveloperModePanel {
  private running = false;
  private disposed = false;
  private renderVersion = 0;
  private message = "";
  private failed = false;
  private vault = "";

  constructor(
    private readonly contentEl: HTMLElement,
    private readonly service: DeveloperModeService,
    private readonly zh: boolean,
    private readonly isCurrent: () => boolean,
    private readonly onActionSettled: () => void
  ) {}

  dispose(): void {
    this.disposed = true;
    this.renderVersion++;
    disposeOriginControls(this.contentEl);
    this.contentEl.empty();
    this.contentEl.style.removeProperty("min-height");
  }
  private active(): boolean {
    return !this.disposed && this.service.access.enabled && this.contentEl.isConnected && this.isCurrent();
  }
  private t(zh: string, en: string): string { return this.zh ? zh : en; }

  private renderMessage(text: string, state: "loading" | "busy" | "error" | "result"): void {
    if (!text) return;
    this.contentEl.createEl("p", {
      cls: `echoink-developer-message is-${state}`,
      text,
      attr: { role: "status" }
    });
  }

  async render(): Promise<void> {
    if (!this.active()) return;
    const version = ++this.renderVersion;
    const current = (): boolean => this.active() && version === this.renderVersion;
    const el = this.contentEl;
    disposeOriginControls(el);
    el.empty();
    el.addClass("echoink-developer-mode");
    this.renderMessage(this.t("正在读取状态…", "Loading status…"), "loading");
    let status: DeveloperStatus;
    try { status = await this.service.status(); }
    catch (error) {
      if (current()) {
        disposeOriginControls(el);
        el.empty();
        el.style.removeProperty("min-height");
        this.renderMessage(this.errorText(error), "error");
      }
      return;
    }
    if (!current()) return;
    disposeOriginControls(el);
    el.empty();
    el.style.removeProperty("min-height");
    this.vault = status.vault;
    const summary = el.createDiv({ cls: "echoink-developer-status" });
    const heading = summary.createDiv({ cls: "echoink-developer-status-heading" });
    heading.createEl("h4", { text: this.t("当前状态", "Current status") });
    const refresh = createOriginButton(heading, {
      text: this.t("刷新", "Refresh"), attr: { type: "button" }
    });
    refresh.disabled = this.running;
    refresh.addEventListener("click", () => void this.render());
    const facts = summary.createEl("dl", { cls: "echoink-developer-facts" });
    const fact = (label: string, value: string, wide = false): void => {
      const item = facts.createDiv({ cls: `echoink-developer-fact${wide ? " is-wide" : ""}` });
      item.createEl("dt", { text: label });
      item.createEl("dd", { text: value });
    };
    fact(this.t("当前 Vault", "Current Vault"), status.vault, true);
    fact(this.t("记忆", "Memories"), String(status.memoryCount));
    fact(this.t("Dream 待处理", "Pending for Dream"), String(status.pending));
    const date = (at: number): string => at > 0
      ? new Date(at).toLocaleString(this.zh ? "zh-CN" : "en-US")
      : this.t("尚无记录", "No recorded run");
    fact(this.t("最近尝试", "Last attempt"), date(status.lastRunAt));
    fact(this.t("最近成功", "Last success"), date(status.lastSuccessAt));
    if (status.backup) fact(this.t("最近重置备份", "Latest reset backup"), status.backup, true);
    if (status.lastResult) this.renderMessage(this.dreamText(status.lastResult), "result");
    if (this.message) this.renderMessage(this.message, this.failed ? "error" : "result");
    else if (status.busy) this.renderMessage(this.t("正在执行，请稍候。", "An operation is running. Please wait."), "busy");
    const actions = el.createDiv({ cls: "echoink-developer-actions" });
    const add = (action: DeveloperAction, title: string, verb: string, desc: string, disabled = false): void => {
      applySettingsRow(new OriginSetting(actions).setName(title).setDesc(desc).addOriginButton((button) => {
        button.buttonEl.setAttribute("data-developer-action", action);
        button.buttonEl.setAttribute("aria-label", title);
        button.setButtonText(verb).setDisabled(this.running || status.busy || disabled)
          .onClick(() => {
            if (!this.active()) return;
            if (action === "reset" || action === "restore") this.confirm(action);
            else void this.run(action);
          });
      }));
    };
    add("seed", this.t("生成示例记忆", "Generate sample memories"), this.t("生成", "Generate"), this.t(
      "写入七类合成测试材料，不代表真实用户经历。重复生成自动去重，不调用模型。",
      "Write seven kinds of clearly marked synthetic test data. Repeated samples are deduplicated. No model call."
    ));
    add("dream", this.t("立即做梦一次", "Run Dream once"), this.t("执行", "Run"), this.t(
      "将调用当前模型，可能更新衍生记忆、用户画像与 Agent 学习内容。需要开启长期记忆与做梦。",
      "Calls the current model and may update derived memories, your profile, and learned Agent behavior. Memory and Dream must be enabled."
    ));
    add("reset", this.t("备份并重置记忆与做梦", "Back up and reset memory and Dream"), this.t("重置", "Reset"), this.t(
      "先确认范围，再自动备份。保留笔记、会话、知识库、Skills 和配置。",
      "Review the scope, then back up automatically. Notes, conversations, Knowledge, Skills, and settings are preserved."
    ));
    add("restore", this.t("恢复最近一次重置备份", "Restore latest reset backup"), this.t("恢复", "Restore"), this.t(
      "恢复前先备份当前记忆状态，原备份不会被覆盖。",
      "Protect the current memory state before restoring. The original backup is kept."
    ), !status.backup);
  }

  private confirm(action: "reset" | "restore"): void {
    if (!this.active()) return;
    this.renderVersion++;
    disposeOriginControls(this.contentEl);
    this.contentEl.empty();
    const confirmation = this.contentEl.createDiv({ cls: "echoink-developer-confirm" });
    confirmation.createEl("h4", { text: action === "reset"
      ? this.t("确认重置当前 Vault 的记忆", "Confirm memory reset for this Vault")
      : this.t("确认恢复记忆备份", "Confirm memory restore") });
    confirmation.createEl("p", { text: `${this.t("当前 Vault", "Current Vault")}: ${this.vault}` });
    confirmation.createEl("p", { text: action === "reset" ? this.t(
      "范围包含一级与二级记忆、USER 画像、Dream 队列及历史、Agent 学习衍生内容。Agent 名称、头像、模板选择及手工修改保留；从记忆学到的行为会清空。",
      "Includes primary and secondary memories, USER profile, Dream queue and history, and learned Agent content. Agent name, avatar, template selection, and manual edits are preserved; behavior learned from memory is cleared."
    ) : this.t(
      "恢复备份中的一级与二级记忆、USER 画像、Dream 队列及历史。当前 Agent 名称、头像、模板及手工修改优先保留；仅恢复不冲突且有来源的学习内容。",
      "Restore primary and secondary memories, USER profile, and Dream queue and history. Keep the current Agent name, avatar, template, and manual edits; restore only sourced learning that does not conflict."
    ) });
    confirmation.createEl("p", { text: this.t(
      "笔记、会话、知识库、Skills、模型配置和 API Key 不变。备份在当前 Vault 的 developer-backups 中。备份失败时不执行，部分失败自动尝试回滚。",
      "Notes, conversations, Knowledge, Skills, model settings, and API keys are unchanged. Backups stay in developer-backups in this Vault. A failed backup stops the operation; partial failures trigger rollback."
    ) });
    if (action === "restore") confirmation.createEl("p", { text: this.t(
      "将先保护当前状态，再恢复最近一次重置前的记忆。",
      "The current state will be protected before restoring the memories from the latest reset."
    ) });
    const controls = new OriginSetting(confirmation)
      .addOriginButton((button) => button.setButtonText(this.t("取消", "Cancel")).onClick(() => void this.render()))
      .addOriginButton((button) => button.setButtonText(this.t("确认并执行", "Confirm and continue"))
        .setWarning().onClick(() => void this.run(action)));
    controls.settingEl.addClass("echoink-developer-confirm-actions");
  }

  private async run(action: DeveloperAction): Promise<void> {
    if (this.running || !this.active()) return;
    this.renderVersion++;
    this.running = true;
    this.contentEl.style.setProperty("min-height", `${this.contentEl.getBoundingClientRect().height}px`);
    disposeOriginControls(this.contentEl);
    this.contentEl.empty();
    this.renderMessage(this.t("正在执行，请稍候…", "Working, please wait…"), "busy");
    try {
      const result = await this.service.execute(action);
      this.failed = result.action === "dream" && (result.result.providerUnavailable || Boolean(result.result.error));
      this.message = this.resultText(result);
    } catch (error) { this.failed = true; this.message = this.errorText(error); }
    finally {
      this.running = false;
      if (this.active()) await this.render();
      else this.onActionSettled();
    }
  }

  private dreamText(result: NonNullable<DeveloperStatus["lastResult"]>): string {
    if (result.providerUnavailable) return this.t("Dream 未运行：没有可用的模型配置。", "Dream did not run: no model is configured.");
    const summary = this.t(
      `Dream 已处理 ${result.processedMemoryIds.length} 条，失败 ${result.failedMemoryIds.length} 条，新增关联 ${result.factsCreated} 条。`,
      `Dream processed ${result.processedMemoryIds.length}, failed ${result.failedMemoryIds.length}, and created ${result.factsCreated} associations.`
    );
    return result.error ? `${summary} ${this.t("错误", "Error")}: ${result.error}` : summary;
  }

  private resultText(result: DeveloperResult): string {
    if (result.action === "dream") return this.dreamText(result.result);
    if (result.action === "seed") return this.t(
      `新增 ${result.created} 条示例记忆，${result.existing} 条已存在。`,
      `Created ${result.created} sample memories; ${result.existing} already existed.`
    );
    const conflicts = result.preservedLearningConflicts > 0 ? this.t(
      ` ${result.preservedLearningConflicts} 项学习内容与当前手工状态冲突，已保留当前值。`,
      ` Kept the current values for ${result.preservedLearningConflicts} learning conflicts with manual settings.`
    ) : "";
    return `${result.action === "reset" ? this.t("重置完成", "Reset complete") : this.t("恢复完成；原备份与当前状态备份均保留", "Restore complete; both the original and current-state backups were kept")}${conflicts} ${result.backup}`;
  }

  private errorText(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const known: Record<string, ErrorCopy> = {
      developer_mode_locked: ["开发者模式已关闭。请先在基础设置中打开开关。", "Developer mode is off. Turn it on in General settings first."],
      developer_mode_busy: ["会话、做梦或本地数据操作正在进行。请结束后重试。", "A conversation, Dream, or local data operation is in progress. Try again when it finishes."],
      developer_mode_read_only: CAUSE.workspaceReadOnly,
      developer_dream_unavailable: ["做梦未能运行。请检查长期记忆、做梦开关及忙碌状态。", "Dream did not run. Check the long-term memory and Dream switches and the busy state."],
      developer_backup_missing: ["没有可恢复的重置备份。", "No reset backup is available."],
      developer_memory_changing: joinCopyPair(["记忆正在重置或恢复。", "Memory is being reset or restored."], NEXT.retryLater)
    };
    const localized = Object.hasOwn(known, message) ? known[message] : undefined;
    return localized ? localized[this.zh ? 0 : 1] : failureText(error, SETTINGS_SCENE.actionIncomplete, NEXT.retryLater, this.zh ? "zh" : "en");
  }
}
