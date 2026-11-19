import { NEXT, failureText } from "../core/error-copy";
import { Component, MarkdownRenderer, Modal, Notice, setIcon } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { friendlyDeviceName, readSyncConversationMessages, transcriptItems, type RemoteConversationSummary, type SyncConversationMessage } from "../sync/conversations";
import { applyAmicroButton } from "../settings/amicro-buttons";
import { createOriginButton, disposeOriginControls } from "../settings/origin-controls";
import { formatClock } from "./project-parts";

/** Long transcripts open on the latest messages; older ones wait behind one button. */
const RECENT_MESSAGES = 30;

/** Read-only transcript of a conversation that lives on another device, with one way forward: continue it here as a new conversation. */
export class RemoteConversationModal extends Modal {
  private messages: SyncConversationMessage[] = [];
  private state: "loading" | "ready" | "error" = "loading";
  private showAll = false;
  private markdown = new Component();
  constructor(private readonly plugin: CodexForObsidianPlugin, private readonly summary: RemoteConversationSummary) { super(plugin.app); }
  onOpen(): void {
    this.modalEl.addClass("echoink-theme-boundary", "echoink-remote-conversation-modal");
    this.markdown.load();
    this.load();
  }
  onClose(): void { this.markdown.unload(); disposeOriginControls(this.contentEl); this.contentEl.empty(); }
  private load(): void {
    this.state = "loading"; this.render();
    void readSyncConversationMessages(this.plugin.app.vault.adapter, this.summary.deviceId, this.summary.id, this.summary.messageCount)
      .then(messages => { this.messages = messages; this.state = "ready"; this.render(); })
      .catch(error => { console.error("EchoInk remote conversation could not be read", error); this.state = "error"; this.render(); });
  }
  private render(): void {
    const { contentEl } = this, summary = this.summary;
    disposeOriginControls(contentEl); contentEl.empty();
    this.markdown.unload(); this.markdown = new Component(); this.markdown.load();
    const head = contentEl.createDiv({ cls: "echoink-remote-conversation-head" });
    head.createEl("h2", { text: summary.title });
    const where = head.createDiv({ cls: "echoink-remote-conversation-where" });
    setIcon(where.createSpan({ cls: "echoink-remote-conversation-where-icon", attr: { "aria-hidden": "true" } }), "monitor-smartphone");
    where.createSpan({ text: [friendlyDeviceName(summary.deviceName), formatClock(summary.updatedAt), `${summary.messageCount} 条`].join(" · ") });
    if (summary.continuedOn.length) {
      const note = contentEl.createDiv({ cls: "echoink-remote-conversation-note" });
      setIcon(note.createSpan({ attr: { "aria-hidden": "true" } }), "git-branch");
      note.createSpan({ text: `已在${summary.continuedOn.map(item => friendlyDeviceName(item.deviceName)).join("、")}上接着聊` });
    }
    const list = contentEl.createDiv({ cls: "echoink-remote-conversation-messages" });
    if (this.state === "loading") list.createDiv({ cls: "echoink-remote-conversation-state", text: "正在读取…" });
    else if (this.state === "error") {
      const box = list.createDiv({ cls: "echoink-remote-conversation-state is-error" });
      box.createDiv({ text: "该对话记录暂时无法读取。请稍后重试。" });
      const retry = createOriginButton(box, { text: "重试" }); applyAmicroButton(retry, { variant: "secondary" }); retry.onclick = () => this.load();
    } else this.renderTranscript(list);
    const actions = contentEl.createDiv({ cls: "echoink-remote-conversation-actions" });
    const fork = createOriginButton(actions, { text: "在这台设备接着聊" }); applyAmicroButton(fork, { variant: "primary" });
    fork.disabled = this.state !== "ready" || !this.messages.length;
    fork.onclick = () => { void this.fork().catch(err => new Notice(failureText(err, ["该会话未能在本机继续。", "This conversation could not be continued on this device."], NEXT.retryLater, this.plugin.settings.settingsLanguage))); };
  }
  private renderTranscript(list: HTMLElement): void {
    const items = transcriptItems(this.messages);
    if (!items.length) { list.createDiv({ cls: "echoink-remote-conversation-state", text: "这段对话还没有可显示的内容。" }); return; }
    let start = 0;
    if (!this.showAll) {
      let seen = 0;
      for (let i = items.length - 1; i >= 0; i--) { if (items[i].kind === "message" && ++seen > RECENT_MESSAGES) { start = i + 1; break; } }
    }
    if (start > 0) {
      const hidden = items.slice(0, start).filter(item => item.kind === "message").length;
      const more = list.createEl("button", { cls: "echoink-remote-conversation-earlier", text: `更早的 ${hidden} 条` });
      more.onclick = () => { this.showAll = true; this.render(); this.contentEl.querySelector(".echoink-remote-conversation-messages")?.scrollTo({ top: 0 }); };
    }
    const renders: Promise<void>[] = [];
    for (const item of items.slice(start)) {
      if (item.kind === "steps") { this.renderSteps(list, item.names); continue; }
      const message = item.message;
      if (message.role === "user") { list.createDiv({ cls: "echoink-remote-msg is-user", text: message.text }); continue; }
      const answer = list.createDiv({ cls: "echoink-remote-msg is-assistant markdown-rendered" });
      renders.push(MarkdownRenderer.render(this.app, message.text, answer, "", this.markdown).catch(() => { answer.setText(message.text); }));
    }
    if (!this.showAll) { list.scrollTop = list.scrollHeight; void Promise.all(renders).then(() => { list.scrollTop = list.scrollHeight; }); }
  }
  private renderSteps(list: HTMLElement, names: readonly string[]): void {
    const steps = list.createEl("details", { cls: "echoink-remote-steps" });
    const summary = steps.createEl("summary");
    setIcon(summary.createSpan({ cls: "echoink-remote-steps-chevron", attr: { "aria-hidden": "true" } }), "chevron-right");
    setIcon(summary.createSpan({ attr: { "aria-hidden": "true" } }), "wrench");
    summary.createSpan({ text: names.length === 1 ? names[0] : `${names[0]} 等 ${names.length} 步` });
    const rows = steps.createEl("ul");
    for (const name of names) rows.createEl("li", { text: name });
  }
  /** The original stays on its device; this opens a new general-assistant conversation here with the transcript as its history. */
  private async fork(): Promise<void> {
    if (await this.plugin.continueSyncedConversation(this.summary, this.messages)) this.close();
  }

}
