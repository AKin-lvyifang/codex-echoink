import assert from "node:assert/strict";
import { reportMessage, parseReportMessage } from "../company/logic";
import type { CompanyDispatch } from "../company/types";
import { projectCompanyReports, companyReportSourceLabel, isCompanyProgrammaticUserMessage, type CompanyTranscriptMessage } from "../company/report-presentation";
import { conversationTitleRequests, generateConversationTitle } from "../plugin/conversation-title";
import { buildConversationTurns } from "../ui/codex-view/turn-navigator";
import { CodexMessageListRenderer } from "../ui/codex-view/message-list";
import { renderCompanyReportSource } from "../ui/company-report-source";
import { mobileCompanyReportProjection } from "../ui/mobile/company-report";
import { installCompanyTestDom } from "./company-ui";
import type { ChatMessage } from "../settings/settings";
import type { MobileSession } from "../mobile/store";

export async function runCompanyReportCollapseTests(document: Document): Promise<void> {
  let passed = 0;
  const ok = (name: string) => console.log(`ok report ${++passed} - ${name}`);
  const dispatch: CompanyDispatch = { id: "conversation-worker-old", routerConversationId: "router", agentId: "generalist", brief: "整理资料\n保留第二行", status: "done", permission: "workspace-write", createdAt: 1, turns: 1,
    report: { outcome: "done", summary: "已整理\n第二行摘要", outputs: ["资料/甲、乙.md", "资料/丙.md"], question: "需确认\n文件路径", options: ["沿用", "换路径"], at: 2 } };
  for (const outcome of ["done", "failed", "need_decision"] as const) {
    for (const optional of [true, false]) {
      const report = optional ? { ...dispatch.report!, outcome } : { outcome, summary: "简单摘要", outputs: [], at: 3 };
      const text = reportMessage({ ...dispatch, report }, "旧通才", optional ? "旧项目" : undefined);
      const parsed = parseReportMessage(text)!;
      assert.ok(parsed); assert.equal(parsed.agentName, "旧通才"); assert.equal(parsed.outcome, outcome);
      assert.equal(parsed.projectName, optional ? "旧项目" : undefined); assert.equal(parsed.task, dispatch.brief);
      assert.equal(parsed.summary, report.summary); assert.equal(parsed.outputs, optional ? report.outputs.join("、") : undefined);
      assert.equal(parsed.question, optional ? dispatch.report!.question : undefined); assert.equal(parsed.options, optional ? "沿用 / 换路径" : undefined); assert.equal(parsed.taskId, dispatch.id);
      assert.deepEqual(parseReportMessage(`${text}\n这个项目的活都做完了：请核对。`), parsed);
      const rebuilt = reportMessage({ ...dispatch, brief: parsed.task, report: { outcome: parsed.outcome, summary: parsed.summary, outputs: parsed.outputs ? [parsed.outputs] : [], question: parsed.question, options: parsed.options ? [parsed.options] : [], at: 0 } }, parsed.agentName, parsed.projectName);
      assert.equal(rebuilt, text, "message -> snapshot -> message preserves the emitted fields verbatim");
    }
  }
  assert.equal(parseReportMessage("〔员工汇报〕通才：做完了\n摘要：引用示例"), null);
  ok("reportMessage round trips all outcomes, optional fields, multiline content and acceptance tail");

  const delivered = reportMessage(dispatch, "旧通才"), failed = reportMessage({ ...dispatch, id: "conversation-worker-failed", report: { outcome: "failed", summary: "路径不存在", outputs: [], at: 4 } }, "研究员");
  const msg = (id: string, role: string, text: string, extra = {}): CompanyTranscriptMessage => ({ id, role, text, ...extra });
  const human = msg("human", "user", "把资料整理好"), oldAnswer = msg("before-steer", "assistant", "我还在做原任务"), incoming = msg("pi:session:leaf:one:entry:delivered-entry", "user", delivered), reply = msg("reply-entry", "assistant", "资料已整理");
  const idle = projectCompanyReports([human, incoming, reply], "router");
  assert.ok(idle.hidden.has(incoming.id)); assert.equal(idle.replies.get(reply.id)?.[0].report.agentName, "旧通才");
  const steered = projectCompanyReports([human, oldAnswer, incoming, msg("tool", "tool", "工具结果"), reply], "router");
  assert.equal(steered.replies.has(oldAnswer.id), false); assert.equal(steered.replies.get(reply.id)?.length, 1);
  assert.equal(isCompanyProgrammaticUserMessage(incoming, "worker"), false);
  assert.equal(isCompanyProgrammaticUserMessage(msg("quoted", "user", "〔我自己的文字〕不要收起"), "router"), false);
  assert.equal(isCompanyProgrammaticUserMessage(msg("bad", "user", "〔员工汇报〕只是讨论这个格式"), "router"), false);
  assert.equal(isCompanyProgrammaticUserMessage(msg("cancel", "user", "〔项目已取消〕取消"), "router"), true);
  assert.equal(isCompanyProgrammaticUserMessage(msg("program", "user", "程序内容", { companyProgrammatic: true }), "router"), true);
  ok("idle and steer use message order; pre-steer answers and ordinary bracketed text are untouched");

  const mixed = projectCompanyReports([incoming, { ...incoming, id: "duplicate" }, msg("second-report", "user", failed), reply], "router");
  const sources = mixed.replies.get(reply.id)!;
  assert.equal(sources.length, 2); assert.equal(companyReportSourceLabel(sources), "2 份汇报 · 1 份没做成");
  assert.equal(companyReportSourceLabel([sources[0]]), "旧通才交回"); assert.equal(companyReportSourceLabel([sources[1]]), "研究员没做成");
  assert.equal(companyReportSourceLabel([sources[0], { ...sources[1], report: { ...sources[1].report, outcome: "done" } }]), "2 份交回");
  const renamed = { ...dispatch, report: { ...dispatch.report!, summary: "重做后的内容" } };
  assert.notEqual(reportMessage(renamed, "新名字"), delivered);
  assert.equal(steered.replies.get(reply.id)?.[0].report.summary, "已整理\n第二行摘要");
  ok("multiple reports deduplicate task IDs in delivery order; old text survives rework and renaming");

  const orphan = projectCompanyReports([oldAnswer, incoming, msg("error", "system", "已停止")], "router");
  assert.equal(orphan.standalone.get(incoming.id)?.length, 1); assert.equal(orphan.replies.size, 0);
  const afterStop = projectCompanyReports([incoming, human, reply], "router");
  assert.equal(afterStop.replies.size, 0); assert.equal(afterStop.standalone.size, 1);
  ok("stopped / unconsumed reports keep an inline source and never attach to a later human request");

  const transcript: ChatMessage[] = [human, incoming, reply, msg("cancel", "user", "〔项目已取消〕测试")].map(message => ({ ...message, role: message.role as ChatMessage["role"], createdAt: 1 }));
  assert.deepEqual(buildConversationTurns(transcript, false, "zh-CN", "router").map(turn => turn.messageId), [human.id]);
  assert.deepEqual(conversationTitleRequests(transcript, "router"), [human.text]);
  assert.equal(conversationTitleRequests(transcript, "worker").length, 3);
  let claimed = false;
  await generateConversationTitle({ catalog: { claimShortTitle: async () => { claimed = true; return false; } } as never, conversationId: "router", requests: conversationTitleRequests(transcript.slice(1), "router"), changed() {} });
  assert.equal(claimed, false, "only programmatic messages cannot claim a title");
  ok("navigation and title inputs exclude company messages without changing stored context");

  installCompanyTestDom(document);
  Object.assign(document.defaultView!.HTMLElement.prototype, {
    setCssStyles(this: HTMLElement, styles: Partial<CSSStyleDeclaration>) { Object.assign(this.style, styles); }
  });
  const root = document.body.appendChild(document.createElement("div")), open = new Map<string, boolean>();
  const draw = () => { root.replaceChildren(); renderCompanyReportSource({ buttonParent: root, detailParent: root, sources, open, key: "router:delivered-entry", mobile: true }); };
  draw(); let button = root.querySelector("button")!;
  assert.equal(button.getAttribute("aria-expanded"), "false"); button.click();
  assert.equal(root.querySelector<HTMLElement>(".echoink-report-details")!.hidden, false);
  draw(); button = root.querySelector("button")!; assert.equal(button.getAttribute("aria-expanded"), "true");
  assert.equal(root.querySelectorAll(".echoink-report-item").length, 2); assert.ok(button.classList.contains("is-failed")); button.click();
  assert.equal(root.querySelector<HTMLElement>(".echoink-report-details")!.hidden, true);
  root.remove();
  ok("shared desktop/mobile disclosure keeps expanded state across DOM replacement");

  const mobile = { id: "mobile-router", companyRole: "router", messages: [
    { role: "user", content: human.text, timestamp: 1 }, { role: "assistant", content: [{ type: "text", text: oldAnswer.text }], timestamp: 2 },
    { role: "user", content: delivered, timestamp: 3 }, { role: "assistant", content: [{ type: "text", text: reply.text }], timestamp: 4 }
  ], runs: [] } as unknown as MobileSession;
  const mobileProjection = mobileCompanyReportProjection(mobile);
  assert.equal(mobileProjection.hidden.size, 1); assert.equal(mobileProjection.replies.get("message:3:4")?.[0].report.agentName, "旧通才");
  ok("mobile legacy / steer text works without companyProgrammatic run metadata");

  const renderer = new CodexMessageListRenderer();
  const messagesEl = document.body.appendChild(document.createElement("div")), virtualListEl = messagesEl.appendChild(document.createElement("div"));
  const input = { app: { vault: { adapter: { getBasePath: () => "/disposable" }, getAbstractFileByPath: () => null } }, component: { addChild() {}, register() {} }, messagesEl, virtualListEl, sessionId: "router", companyRole: "router", agentIdentity: { displayName: "总助" }, settingsLanguage: "zh-CN", messages: transcript.slice(0, 3), vaultPath: "/disposable", readRawMessageText: async () => "", onScheduleMeasure() {}, onScheduleRunProgress() {} };
  renderer.render(input as unknown as Parameters<CodexMessageListRenderer["render"]>[0]);
  assert.equal(virtualListEl.querySelector(`[data-message-id="${incoming.id}"]`), null);
  let sourceButton = virtualListEl.querySelector<HTMLButtonElement>(".codex-agent-name-row > .echoink-report-source")!;
  assert.ok(sourceButton); sourceButton.click(); renderer.render(input as unknown as Parameters<CodexMessageListRenderer["render"]>[0]);
  sourceButton = virtualListEl.querySelector<HTMLButtonElement>(".echoink-report-source")!;
  assert.equal(sourceButton.getAttribute("aria-expanded"), "true");
  input.messages = input.messages.map(message => message.id === incoming.id ? { ...message, id: message.id.replace(":leaf:one:", ":leaf:two:") } : message);
  renderer.render(input as unknown as Parameters<CodexMessageListRenderer["render"]>[0]);
  assert.equal(virtualListEl.querySelector(".echoink-report-source")!.getAttribute("aria-expanded"), "true", "Pi active-leaf changes must not change the persistent source identity");
  renderer.dispose(); messagesEl.remove();
  ok("desktop real renderer hides the user bubble and preserves source expansion after a virtual redraw");
  console.log(`PASS company report collapse: ${passed} cases`);
}
