import assert from "node:assert/strict";
import { Platform } from "obsidian";
import { JSDOM } from "jsdom";
import { installComposerMenuDomHelpers } from "./composer-menu-dom-host";
import { formatApprovalPresentation, renderApprovalPresentation } from "../ui/codex-view/approval-presentation";
import { createAIElementsConfirmation, createSmoothAIApprovalCard, type SmoothAIApprovalState } from "../ui/codex-view/smooth-chat-ui";
import { InteractionDockController } from "../ui/codex-view/interaction-dock";
import { PiAgentApprovalBroker } from "../plugin/pi-agent-approval-broker";

const json = (value: unknown) => JSON.stringify(value);
const values = (presentation: ReturnType<typeof formatApprovalPresentation>) =>
  [...presentation.destination, ...presentation.changes].map((field) => `${field.label}: ${field.value}`).join("\n");

export async function runApprovalPresentationTests(): Promise<void> {
  assertVaultPresentation();
  assertMcpAndFallbacks();
  await assertRealDomAndBindings();
  console.log("PASS approval presentation: actual Vault/MCP contracts, unknown/bad JSON, long/hostile text, persistent truncation/destructive warnings, original states and live/stale bindings");
}

function assertVaultPresentation(): void {
  const create = formatApprovalPresentation({
    target: json({ relativePath: "Outputs/新增.md" }),
    preview: json({ operation: "note_create", relativePath: "Outputs/新增.md", change: {
      kind: "add", relativePath: "Outputs/新增.md", added: 3, removed: 0,
      diff: "--- a/Outputs/新增.md\n+++ b/Outputs/新增.md\n@@ -1,0 +1,3 @@\n+# 标题\n+正文\n+", truncated: false
    }, byteLength: 20, contentSha256: "fixture-sha" })
  });
  assert.equal(create.action, "新建文件");
  assert.deepEqual(create.destination, [{ label: "文件路径", value: "Outputs/新增.md" }]);
  assert.ok(create.changes.some((field) => field.label === "新增内容" && field.value === "# 标题\n正文\n"));
  assert.match(values(create), /新增行数: 3/u);
  assert.match(values(create), /移除行数: 0/u);
  assert.match(values(create), /contentSha256: fixture-sha/u);

  const updatePreview = {
    operation: "note_update", relativePath: "Wiki/原稿.md", expectedVersion: "v1", change: {
      kind: "update", relativePath: "Wiki/原稿.md", added: 1, removed: 1,
      diff: "--- a/Wiki/原稿.md\n+++ b/Wiki/原稿.md\n@@ -2,3 +2,3 @@\n 上文\n-旧内容\n+新内容\n 下文", truncated: false,
      futureField: { reason: "不能丢失" }
    }
  };
  const update = formatApprovalPresentation({ target: json({ relativePath: "Wiki/原稿.md" }), preview: json(updatePreview) });
  assert.ok(update.changes.some((field) => field.label.startsWith("修改前") && field.value === "上文\n旧内容\n下文"));
  assert.ok(update.changes.some((field) => field.label.startsWith("修改后") && field.value === "上文\n新内容\n下文"));
  assert.match(values(update), /change\.futureField\.reason: 不能丢失/u);
  assert.equal(update.technicalDetails[1]?.value, json(updatePreview), "the exact original diff is available in technical details");

  const metadata = formatApprovalPresentation({ preview: json({ ...updatePreview, operation: "metadata_update", patch: { set: { tags: ["hello"] }, remove: [] } }) });
  assert.equal(metadata.action, "修改文件属性");
  assert.match(values(metadata), /patch\.set\.tags\[0\]: hello/u);
  assert.match(values(metadata), /patch\.remove: \[\]/u);
  const move = formatApprovalPresentation({ target: json({ sourcePath: "Old.md", targetPath: "New.md" }), preview: json({ operation: "note_move", sourcePath: "Old.md", targetPath: "New.md", expectedVersion: "v1" }) });
  assert.equal(move.action, "移动文件");
  assert.deepEqual(move.destination, [{ label: "原位置", value: "Old.md" }, { label: "新位置", value: "New.md" }]);
  const remove = formatApprovalPresentation({ target: json({ relativePath: "Trash.md" }), preview: json({ operation: "note_delete", relativePath: "Trash.md", recoverableTrashOnly: true }) });
  assert.match(remove.notices.join(""), /将删除以上文件/u);
  assert.match(values(remove), /recoverableTrashOnly: true/u);
  const append = formatApprovalPresentation({ target: json({ command: "daily:append", dailyPath: "Daily/Today.md" }), preview: json({ command: "daily:append", content: "追加\n完整内容", target: { dailyPath: "Daily/Today.md" }, atomicVersionCheck: false }) });
  assert.equal(append.action, "追加日记内容");
  assert.ok(append.changes.some((field) => field.value === "追加\n完整内容"));
  assert.match(values(append), /atomicVersionCheck: false/u);

  const truncated = formatApprovalPresentation({ preview: json({ operation: "note_update", change: {
    kind: "update", added: 10000, removed: 9000, truncated: true,
    diff: "--- a/Long.md\n+++ b/Long.md\n@@ -1,9000 +1,10000 @@\n-old\n+partial\n[DIFF_PREVIEW_TRUNCATED]"
  } }) });
  assert.equal(truncated.notices[0], "工具提供的预览已截断，当前仅展示部分内容");
  assert.match(values(truncated), /10000/u);
  assert.match(values(truncated), /9000/u);
  assert.match(values(truncated), /change\.truncated: true/u);
  assert.match(truncated.technicalDetails[0]!.value, /DIFF_PREVIEW_TRUNCATED/u);
}

function assertMcpAndFallbacks(): void {
  const target = { kind: "mcp_tool", resourceId: "fixture", resourceName: "本地待办", toolName: "add_todo" };
  const preview = { server: "本地待办", tool: "add_todo", destructive: false, arguments: { title: "核对账单", due: null, flags: [false, 0], extra: { untouched: "保留原字段" } } };
  const task = formatApprovalPresentation({ target: json(target), preview: json(preview) });
  assert.equal(task.action, "调用服务操作");
  assert.ok(!task.changes.some(field => field.label === "resourceId" || field.label === "destructive"));
  assert.match(task.technicalDetails[0]!.value, /resourceId/u);
  assert.match(task.technicalDetails[1]!.value, /destructive/u);
  assert.deepEqual(task.destination, [{ label: "服务", value: "本地待办" }, { label: "操作", value: "add_todo" }]);
  assert.match(values(task), /标题: 核对账单/u);
  assert.match(values(task), /arguments\.due: null/u);
  assert.match(values(task), /arguments\.flags\[0\]: false/u);
  assert.match(values(task), /arguments\.flags\[1\]: 0/u);
  assert.match(values(task), /arguments\.extra\.untouched: 保留原字段/u);
  assert.ok(!values(task).includes(".md"), "a todo tool name must not manufacture a file path");
  const file = formatApprovalPresentation({ target: json(target), preview: json({ ...preview, destructive: true, arguments: { request: { path: "Synthetic/真实目标.md" }, content: "<b>literal content</b>", before: "旧", after: "新" } }) });
  assert.ok(file.destination.some(field => field.label === "文件路径" && field.value === "Synthetic/真实目标.md"));
  assert.ok(!file.changes.some(field => field.label === "arguments.request.path"));
  const files = formatApprovalPresentation({ target: json(target), preview: json({ ...preview, arguments: { files: [{ path: "notes/a.md", content: "kept" }] } }) });
  assert.ok(files.destination.some(field => field.value === "notes/a.md"));
  assert.ok(!files.changes.some(field => field.value === "notes/a.md"), "array path is shown once");
  assert.ok(files.changes.some(field => field.value === "kept"), "non-path fields remain visible");
  assert.ok(file.destination.some((field) => field.value === "Synthetic/真实目标.md"));
  assert.match(values(file), /内容: <b>literal content<\/b>/u);
  assert.match(file.notices.join(""), /破坏性/u);
  const nonPath = formatApprovalPresentation({ target: json(target), preview: json({ ...preview, arguments: { path: null, request: { filePath: 42 }, title: "不能把数字编成路径" } }) });
  assert.equal(nonPath.destination.length, 2);
  const unknown = formatApprovalPresentation({ target: json({ futureTarget: { nested: [1, "value"] } }), preview: json({ operation: "future_operation", falseValue: false, zero: 0, empty: "", nil: null, array: [], object: {}, dangerousKey: { __proto__: "unused" } }) });
  assert.equal(unknown.action, "future_operation");
  for (const value of ["futureTarget.nested[0]: 1", "futureTarget.nested[1]: value", "falseValue: false", "zero: 0", "nil: null", "array: []", "object: {}", "empty: （空文本）"]) assert.ok(values(unknown).includes(value));
  const malformed = formatApprovalPresentation({ target: "ordinary/path.md", preview: '{"incomplete":' });
  assert.match(values(malformed), /ordinary\/path\.md/u);
  assert.match(values(malformed), /\{"incomplete":/u);
  assert.equal(malformed.technicalDetails[1]?.value, '{"incomplete":');
  const topArray = formatApprovalPresentation({ target: json(["one", { path: "two.md" }]), preview: json([{ future: "three" }]) });
  assert.match(values(topArray), /target\[0\]: one/u);
  assert.match(values(topArray), /target\[1\]\.path: two\.md/u);
  assert.match(values(topArray), /preview\[0\]\.future: three/u);
  const special = formatApprovalPresentation({ preview: '{"operation":"__proto__","__proto__":{"nested":"safe"}}' });
  assert.equal(special.action, "__proto__");
  assert.match(values(special), /__proto__\.nested: safe/u);
  const english = formatApprovalPresentation({ preview: json({ operation: "note_create", content: "" }), language: "en" });
  assert.equal(english.action, "Create a file");
  assert.equal(english.changes[0]?.value, "(empty text)");
  const conflict = formatApprovalPresentation({ target: json({ relativePath: "first.md" }), preview: json({ operation: "note_create", relativePath: "second.md" }) });
  assert.equal(conflict.destination.length, 2, "different target/preview paths must both remain visible");
}

async function assertRealDomAndBindings(): Promise<void> {
  const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: dom.window });
  installComposerMenuDomHelpers(dom.window.document);
  Object.assign(dom.window.HTMLElement.prototype, { empty(this: HTMLElement) { this.replaceChildren(); } });
  try {
    const parent = dom.window.document.body.createDiv();
    const hostile = '<img src=x onerror="globalThis.__approvalInjected=true"><script>bad()</script>';
    const longPath = `${"very-long-directory/".repeat(100)}file.md`;
    const longContent = `${hostile}\n${"长内容\n".repeat(10000)}END`;
    const options = { state: "waiting_approval" as const, controlled: true, target: json({ relativePath: longPath }), preview: json({ operation: "note_create", content: longContent }) };
    Platform.isMobile = true;
    try {
      const mobile = createAIElementsConfirmation(parent, options);
      assert.equal(mobile.root.querySelector(".codex-approval-presentation"), null);
      assert.equal(mobile.root.classList.contains("has-readable-approval"), false);
      assert.ok(mobile.root.textContent?.includes(options.target));
    } finally { Platform.isMobile = false; }
    const card = createAIElementsConfirmation(parent, options);
    assert.equal(card.root.querySelector(".codex-approval-field-value")?.textContent, longPath);
    assert.ok([...card.root.querySelectorAll(".codex-approval-field-value")].some((node) => node.textContent === longContent));
    assert.equal(card.root.querySelector("img, script"), null, "all user/tool text is inert");
    const technical = card.root.querySelector("details")!;
    assert.equal(technical.open, false);
    assert.equal(card.root.lastElementChild?.className, "codex-smooth-ai-approval-actions");
    assert.equal(card.rejectButton?.nextElementSibling, card.approveButton);
    assert.equal(card.approveButton, card.root.querySelector(".is-approve"));
    assert.equal(card.rejectButton, card.root.querySelector(".is-reject"));
    assert.equal(card.approveButton?.type, "button");
    assert.equal(card.approveButton?.disabled, false);
    let decisions = 0;
    card.approveButton!.onclick = () => { decisions++; };
    technical.open = true;
    technical.querySelector("summary")!.click();
    assert.equal(decisions, 0, "reading details is not approval");
    card.approveButton!.click();
    assert.equal(decisions, 1);

    for (const warning of [
      {
        target: json({ relativePath: longPath }),
        preview: json({ operation: "note_update", content: longContent, change: { kind: "update", diff: "partial diff", truncated: true, added: 10000, removed: 1 } }),
        expected: "工具提供的预览已截断，当前仅展示部分内容"
      },
      {
        target: json({ kind: "mcp_tool", resourceName: "测试服务", toolName: "fixture_operation" }),
        preview: json({ server: "测试服务", tool: "fixture_operation", destructive: true, arguments: { path: longPath, content: longContent } }),
        expected: "该服务将本次操作标记为破坏性操作。"
      }
    ]) {
      const warnedCard = createAIElementsConfirmation(parent, { ...options, target: warning.target, preview: warning.preview });
      const header = warnedCard.root.querySelector(".codex-smooth-ai-approval-header")!;
      const notices = warnedCard.root.querySelector(".codex-approval-notices")!;
      const body = warnedCard.root.querySelector<HTMLElement>(".codex-approval-presentation")!;
      const actions = warnedCard.root.querySelector(".codex-smooth-ai-approval-actions")!;
      assert.equal(notices.textContent, warning.expected);
      assert.equal(notices.parentElement, warnedCard.root, "warnings are siblings of the scrolling body");
      assert.equal(header.nextElementSibling, notices, "warnings follow the card header");
      assert.equal(notices.nextElementSibling, body, "warnings precede the scrolling content");
      assert.equal(body.nextElementSibling, actions, "original actions stay outside the scrolling content");
      assert.equal(body.querySelector(".codex-approval-notice"), null, "long content cannot push warnings to the bottom of the scroll area");
      assert.ok([...body.querySelectorAll(".codex-approval-field-value")].some((node) => node.textContent === longContent));
      body.scrollTop = 100000;
      assert.equal(warnedCard.root.querySelector(".codex-approval-notices"), notices);
      assert.equal(warnedCard.approveButton, actions.querySelector(".is-approve"));
      assert.equal(warnedCard.rejectButton, actions.querySelector(".is-reject"));
    }

    for (const state of ["waiting_approval", "approved", "denied", "cancelled", "expired"] satisfies SmoothAIApprovalState[]) {
      const rendered = createAIElementsConfirmation(parent, { ...options, state });
      assert.equal(rendered.root.getAttribute("data-approval-state"), state);
      assert.equal(Boolean(rendered.approveButton), state === "waiting_approval");
      assert.equal(Boolean(rendered.rejectButton), state === "waiting_approval");
    }
    assert.equal(createAIElementsConfirmation(parent, { ...options, controlled: false }).approveButton, undefined);
    const oldCard = createSmoothAIApprovalCard(parent, options);
    assert.ok(oldCard.root.querySelector(".codex-smooth-ai-approval-content"), "the legacy Smooth renderer is unchanged");
    renderApprovalPresentation(parent, formatApprovalPresentation({ preview: "{broken json" }));
    assert.equal(parent.querySelector("img, script"), null);
    await assertDockBinding(parent);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
    dom.window.close();
  }
}

async function assertDockBinding(parent: HTMLElement): Promise<void> {
  const broker = new PiAgentApprovalBroker();
  const dock = new InteractionDockController();
  const container = parent.createDiv();
  const identity = { conversationId: "presentation-session", piSessionId: "pi", productRunId: "run", toolCallId: "first" };
  const original = { target: json({ relativePath: "Synthetic/一.md" }), preview: json({ operation: "note_create", content: "第一次内容" }) };
  const pending = broker.waitForDecision({ ...identity, ...original, requestId: "first-ticket" });
  const binding = broker.bindingFor(identity)!;
  assert.equal(binding.target, original.target);
  assert.equal(binding.preview, original.preview);
  let resolved = 0;
  let stale = 0;
  const input = { sessionId: identity.conversationId, confirmation: { binding, onResolved() { resolved++; } }, onStale() { stale++; }, onScheduleMeasure() {} };
  dock.render(container, input);
  const first = container.querySelector<HTMLButtonElement>(".is-approve")!;
  first.click();
  assert.equal(await pending, true);
  assert.equal(resolved, 1);

  const secondIdentity = { ...identity, toolCallId: "second" };
  const secondOriginal = { target: json({ relativePath: "Synthetic/二.md" }), preview: json({ operation: "note_create", content: "第二次内容" }) };
  const secondPending = broker.waitForDecision({ ...secondIdentity, ...secondOriginal, requestId: "second-ticket" });
  const secondBinding = broker.bindingFor(secondIdentity)!;
  first.disabled = false;
  first.click();
  assert.equal(stale, 0, "an already decided original button is ignored by the existing guard");
  assert.equal(broker.bindingFor(secondIdentity)?.preview, secondOriginal.preview);
  dock.render(container, { ...input, confirmation: { binding: secondBinding, onResolved() { resolved++; } } });
  container.querySelector<HTMLButtonElement>(".is-reject")!.click();
  assert.equal(await secondPending, false);
  assert.equal(resolved, 2);
  assert.equal(broker.bindingFor(secondIdentity), null);
  const staleIdentity = { ...identity, toolCallId: "stale" };
  const stalePending = broker.waitForDecision({ ...staleIdentity, ...original, requestId: "stale-ticket" });
  const staleBinding = broker.bindingFor(staleIdentity)!;
  dock.render(container, { ...input, confirmation: { binding: staleBinding, onResolved() { resolved++; } } });
  const staleButton = container.querySelector<HTMLButtonElement>(".is-approve")!;
  assert.equal(staleBinding.decide("reject"), true);
  assert.equal(await stalePending, false);
  const nextIdentity = { ...identity, toolCallId: "after-stale" };
  const nextPending = broker.waitForDecision({ ...nextIdentity, ...secondOriginal, requestId: "after-stale-ticket" });
  staleButton.click();
  assert.equal(stale, 1, "an unclicked but expired binding still invokes the original stale handling");
  assert.equal(broker.bindingFor(nextIdentity)?.preview, secondOriginal.preview);
  assert.equal(broker.bindingFor(nextIdentity)!.decide("reject"), true);
  assert.equal(await nextPending, false);
  dock.dispose();
  broker.dispose();
}
