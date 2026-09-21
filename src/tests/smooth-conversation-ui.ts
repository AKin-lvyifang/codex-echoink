import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Platform, TFile } from "obsidian";
import type { ChatMessage, SettingsLanguage, StoredSession } from "../settings/settings";
import { conversationCopy, settingsCopy } from "../settings/i18n";
import { extractProcessFileRefs, stableHashedIdentity } from "../core/mapping";
import { PiChatUiProjector } from "../harness/pi-native/pi-chat-ui-projector";
import { PiAgentApprovalBroker } from "../plugin/pi-agent-approval-broker";
import { PiTurnInteractionBroker } from "../plugin/pi-turn-interaction-broker";
import { renderRichText } from "../ui/render-message";
import {
  CodexMessageListRenderer,
  isReasoningScrollNearBottom,
  nextReasoningDisclosureState,
  preserveTextSelectionDuringMutation,
  REASONING_SCROLL_BOTTOM_EPSILON_PX,
  userVisibleProviderReasoningText
} from "../ui/codex-view/message-list";
import { buildAgentTurnProjection } from "../ui/codex-view/agent-turn-process";
import { buildActionTimeline } from "../ui/codex-view/action-timeline";
import {
  createAIElementsDocumentSources,
  createSmoothAIArtifact,
  markSmoothAITaskList,
  renderSmoothBlurOutUp,
  SMOOTH_BLUR_OUT_UP_DURATION_MS,
  SMOOTH_BLUR_OUT_UP_EASING,
  SMOOTH_BLUR_OUT_UP_STAGGER_MS
} from "../ui/codex-view/smooth-chat-ui";
import {
  createAIElementsReasoning,
  markAIElementsTool
} from "../ui/codex-view/ai-elements-dom";
import {
  TASK_PLAN_DOCK_CLOSEOUT_MS,
  TaskPlanDockController,
  selectTaskPlanForDock,
  type TaskPlanDockClock
} from "../ui/codex-view/task-plan-dock";
import type { EchoInkTaskPlanSnapshot } from "../types/task-plan";
import type { EchoInkQuestionInteraction } from "../types/conversation-turn";
import { InteractionDockController } from "../ui/codex-view/interaction-dock";
import { renderCodexTabs } from "../ui/codex-view/tabs";
import { CodexView } from "../ui/codex-view";

type TestEventHandler = (event: {
  preventDefault(): void;
  stopPropagation(): void;
}) => unknown;

interface TestActivationEvent {
  readonly isTrusted: boolean;
  readonly detail?: number;
  readonly key?: string;
  readonly code?: string;
  preventDefault(): void;
  stopPropagation(): void;
}

export class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, TestEventHandler>();
  children: FakeElement[] = [];
  content: Array<string | FakeElement> = [];
  className = "";
  clientHeight = 640;
  clientWidth = 420;
  emptyCallCount = 0;
  checked = false;
  boundingHeight = 0;
  boundingLeft = 0;
  boundingWidth = 56;
  disabled = false;
  focusVisible = false;
  focused = false;
  id = "";
  open = false;
  parent: FakeElement | null = null;
  scrollHeight = 640;
  scrollLeft = 0;
  scrollTop = 0;
  scrollWidth = 420;
  src = "";
  style: Record<string, string> = {};
  textContent = "";
  value = "";
  onclick: ((event: TestActivationEvent) => unknown) | null = null;
  onchange: (() => unknown) | null = null;
  onerror: (() => unknown) | null = null;
  onload: (() => unknown) | null = null;
  oninput: (() => unknown) | null = null;
  onblur: (() => unknown) | null = null;
  onfocus: (() => unknown) | null = null;
  onkeydown: ((event: TestActivationEvent) => unknown) | null = null;
  onmouseenter: (() => unknown) | null = null;
  onmouseleave: (() => unknown) | null = null;
  onpointerdown: ((event: {
    readonly button: number;
    readonly isPrimary: boolean;
    readonly pointerType: string;
  }) => unknown) | null = null;
  onpointercancel: (() => unknown) | null = null;
  ontoggle: ((event: { readonly isTrusted: boolean }) => unknown) | null = null;

  constructor(readonly tag: string) {}

  get childElementCount(): number {
    return this.children.length;
  }

  get ownerDocument(): Document {
    return (globalThis as unknown as { document: Document }).document;
  }

  createEl(
    tag: string,
    options: { cls?: string; text?: string; attr?: Record<string, string> } = {}
  ): FakeElement {
    const child = new FakeElement(tag);
    child.parent = this;
    if (options.cls) child.className = options.cls;
    if (options.text !== undefined) {
      child.textContent = options.text;
      child.content.push(options.text);
    }
    for (const [name, value] of Object.entries(options.attr ?? {})) {
      child.setAttribute(name, value);
    }
    this.children.push(child);
    this.content.push(child);
    return child;
  }

  createDiv(options: { cls?: string; text?: string; attr?: Record<string, string> } | string = {}): FakeElement {
    return this.createEl("div", typeof options === "string" ? { cls: options } : options);
  }

  createSpan(options: { cls?: string; text?: string; attr?: Record<string, string> } | string = {}): FakeElement {
    return this.createEl("span", typeof options === "string" ? { cls: options } : options);
  }

  append(...nodes: unknown[]): void {
    for (const node of nodes) {
      if (!(node instanceof FakeElement)) continue;
      node.parent = this;
      this.children.push(node);
      this.content.push(node);
    }
  }

  appendText(text: string): void {
    this.textContent += text;
    this.content.push(text);
  }

  empty(): void {
    this.emptyCallCount += 1;
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.content = [];
    this.textContent = "";
  }

  remove(): void {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent.content = this.parent.content.filter((item) => item !== this);
    this.parent = null;
  }

  setText(text: string): void {
    this.children = [];
    this.content = [text];
    this.textContent = text;
  }

  addClass(cls: string): void {
    const classes = new Set(this.className.split(/\s+/u).filter(Boolean));
    classes.add(cls);
    this.className = [...classes].join(" ");
  }

  removeClass(cls: string): void {
    this.className = this.className
      .split(/\s+/u)
      .filter((candidate) => candidate && candidate !== cls)
      .join(" ");
  }

  hasClass(cls: string): boolean {
    return this.className.split(/\s+/u).includes(cls);
  }

  toggleClass(cls: string, enabled: boolean): void {
    const classes = new Set(this.className.split(/\s+/u).filter(Boolean));
    if (enabled) classes.add(cls);
    else classes.delete(cls);
    this.className = [...classes].join(" ");
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "id") this.id = value;
  }

  setAttr(name: string, value: string): void {
    this.setAttribute(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
    if (name === "id") this.id = "";
  }

  querySelector<T = FakeElement>(selector: string): T | null {
    return this.querySelectorAll<T>(selector)[0] ?? null;
  }

  querySelectorAll<T = FakeElement>(selector: string): T[] {
    const matches: FakeElement[] = [];
    const visit = (node: FakeElement): void => {
      for (const child of node.children) {
        if (child.matchesSelector(selector)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches as unknown as T[];
  }

  closest<T = FakeElement>(selector: string): T | null {
    let current: FakeElement | null = this;
    while (current) {
      if (current.matchesSelector(selector)) return current as unknown as T;
      current = current.parent;
    }
    return null;
  }

  contains(candidate: unknown): boolean {
    if (candidate === this) return true;
    return this.children.some((child) => child.contains(candidate));
  }

  focus(): void {
    const testDocument = (globalThis as unknown as {
      document?: { activeElement: FakeElement | null };
    }).document;
    const previous = testDocument?.activeElement;
    const inheritFocusVisible = previous?.focusVisible === true;
    if (previous && previous !== this) {
      previous.focused = false;
      previous.onblur?.();
    }
    if (testDocument) testDocument.activeElement = this;
    if (inheritFocusVisible) this.focusVisible = true;
    this.focused = true;
    this.onfocus?.();
  }

  blur(): void {
    const testDocument = (globalThis as unknown as {
      document?: { activeElement: FakeElement | null };
    }).document;
    if (testDocument?.activeElement === this) testDocument.activeElement = null;
    this.focused = false;
    this.onblur?.();
  }

  matches(selector: string): boolean {
    if (selector === ":focus-visible") return this.focused && this.focusVisible;
    return this.matchesSelector(selector);
  }

  setCssStyles(_styles: Record<string, string>): void {}

  getBoundingClientRect(): { height: number; left: number; width: number } {
    return {
      height: this.boundingHeight,
      left: this.boundingLeft,
      width: this.boundingWidth
    };
  }

  scrollTo(options: { left?: number }): void {
    if (typeof options.left === "number") this.scrollLeft = options.left;
  }

  findByClass(cls: string): FakeElement | null {
    return this.findAllByClass(cls)[0] ?? null;
  }

  findAllByClass(cls: string): FakeElement[] {
    const matches: FakeElement[] = [];
    const visit = (node: FakeElement): void => {
      for (const child of node.children) {
        if (child.className.split(/\s+/u).includes(cls)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  findAllByTag(tag: string): FakeElement[] {
    const matches: FakeElement[] = [];
    const visit = (node: FakeElement): void => {
      for (const child of node.children) {
        if (child.tag === tag) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  private matchesSelector(selector: string): boolean {
    if (selector.startsWith(".")) return this.hasClass(selector.slice(1));
    if (selector.startsWith("#")) {
      const expected = selector.slice(1);
      return this.id === expected || this.attributes.get("id") === expected;
    }
    const attribute = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/u);
    if (attribute) {
      const name = attribute[1]!;
      const expected = attribute[2];
      const datasetKey = name.startsWith("data-")
        ? name.slice(5).replace(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase())
        : "";
      const actual = this.attributes.get(name)
        ?? (datasetKey ? this.dataset[datasetKey] : undefined);
      return expected === undefined ? actual !== undefined : actual === expected;
    }
    return this.tag === selector.toLowerCase();
  }
}

export function renderedText(element: FakeElement): string {
  return element.content
    .map((item) => typeof item === "string" ? item : renderedText(item))
    .join("");
}

export interface TestContext {
  app: unknown;
  component: unknown;
  openedPaths: string[];
}

export function createTestContext(): TestContext {
  const files = new Map([
    ["projects/Alpha.md", new TFile("projects/Alpha.md")],
    ["outputs/Result.md", new TFile("outputs/Result.md")],
    ["images/cover #1.png", new TFile("images/cover #1.png")],
    ["videos/meeting.mp4", new TFile("videos/meeting.mp4")]
  ]);
  const openedPaths: string[] = [];
  const app = {
    vault: {
      adapter: { getBasePath: () => "/test-vault" },
      getAbstractFileByPath: (path: string) => files.get(path) ?? null,
      getResourcePath: (file: TFile) => `app://echoink-vault/${file.path
        .split("/")
        .map((part) => encodeURIComponent(part))
        .join("/")}`
    },
    metadataCache: {
      getFirstLinkpathDest: () => null
    },
    workspace: {
      getLeaf: (kind: string) => {
        assert.equal(kind, "tab", "note links must use Obsidian internal tab navigation");
        return {
          view: {},
          openFile: async (file: TFile) => {
            openedPaths.push(file.path);
          }
        };
      }
    }
  };
  const component = {
    registerDomEvent: (
      element: FakeElement,
      eventName: string,
      handler: TestEventHandler
    ) => {
      element.listeners.set(eventName, handler);
    }
  };
  return { app, component, openedPaths };
}

function bindRenderer(
  renderer: CodexMessageListRenderer,
  context: TestContext,
  settingsLanguage: SettingsLanguage = "zh-CN"
): void {
  (renderer as unknown as { env: unknown }).env = {
    app: context.app,
    component: context.component,
    messagesEl: new FakeElement("div"),
    virtualListEl: new FakeElement("div"),
    sessionId: "smooth-ui-test",
    welcomeCopy: { title: "EchoInk", subtitle: "从一个问题开始" },
    settingsLanguage,
    messages: [],
    vaultPath: "/test-vault",
    readRawMessageText: async () => "",
    onDerivePiConversation: async () => undefined,
    onScheduleMeasure: () => undefined,
    onScheduleRunProgress: () => undefined,
    options: {}
  };
}

function renderMessage(
  renderer: CodexMessageListRenderer,
  message: ChatMessage,
  options: {
    showAgentFooter: boolean;
    showAgentHeader: boolean;
    processExpanded?: boolean;
  }
): FakeElement {
  const container = new FakeElement("div");
  (renderer as unknown as {
    renderMessage(container: unknown, message: ChatMessage, options: unknown): void;
  }).renderMessage(container, message, options);
  return container;
}

async function clickRegistered(element: FakeElement): Promise<void> {
  const handler = element.listeners.get("click");
  assert.ok(handler, "note link must register a click handler");
  await handler!({ preventDefault: () => undefined, stopPropagation: () => undefined });
}

function clickElement(element: FakeElement): void {
  element.onclick?.({
    preventDefault: () => undefined,
    stopPropagation: () => undefined
  } as never);
}

function testConversationSession(
  id: string,
  title: string,
  createdAt: number
): StoredSession {
  return {
    id,
    title,
    kind: "chat",
    piSessionId: `pi-${id}`,
    bodyAuthority: "pi_session_only",
    cwd: "/disposable-vault",
    messages: [],
    createdAt,
    updatedAt: createdAt
  };
}

function assertSessionSummaryTooltipLifecycle(): void {
  const testGlobal = globalThis as unknown as Record<string, unknown>;
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalHTMLElement = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
  const testDocument: { activeElement: FakeElement | null } = { activeElement: null };
  Object.defineProperty(testGlobal, "document", {
    configurable: true,
    value: testDocument
  });
  Object.defineProperty(testGlobal, "HTMLElement", {
    configurable: true,
    value: FakeElement
  });

  try {
    const container = new FakeElement("div");
    const sessions = [
      testConversationSession("first", "第一会话", 1),
      testConversationSession("second", "第二会话", 2)
    ];
    let activeSessionId = "first";
    const render = () => renderCodexTabs(
      container as unknown as HTMLElement,
      sessions,
      activeSessionId,
      {
        onActivate: (session) => {
          activeSessionId = session.id;
          render();
        },
        onContextMenu: () => undefined,
        onRename: () => undefined,
        onArchive: () => undefined,
        onDeleteSessions: () => undefined,
        onCreateSession: () => undefined
      }
    );
    render();

    const pointerTarget = container.findAllByClass("codex-session-tab")[1]!;
    pointerTarget.onmouseenter?.();
    assert.equal(
      container.findByClass("codex-session-summary-tooltip")?.hasClass("is-visible"),
      true,
      "pointer hover shows the session summary"
    );
    pointerTarget.onpointerdown?.({
      button: 0,
      isPrimary: true,
      pointerType: "mouse"
    });
    assert.equal(
      container.findByClass("codex-session-summary-tooltip")?.hasClass("is-visible"),
      false,
      "primary pointer down dismisses the current summary before activation"
    );
    pointerTarget.onpointercancel?.();
    pointerTarget.onmouseenter?.();
    assert.equal(
      container.findByClass("codex-session-summary-tooltip")?.hasClass("is-visible"),
      true,
      "a cancelled pointer activation releases the one-shot dismissal"
    );
    pointerTarget.onpointerdown?.({
      button: 0,
      isPrimary: true,
      pointerType: "mouse"
    });
    pointerTarget.focus();
    pointerTarget.onclick?.({
      isTrusted: true,
      detail: 1,
      preventDefault: () => undefined,
      stopPropagation: () => undefined
    });

    const selectedAfterPointerSwitch = container
      .findAllByClass("codex-session-tab")
      .find((tab) => tab.getAttribute("aria-selected") === "true")!;
    const tooltipAfterPointerSwitch = container.findByClass("codex-session-summary-tooltip")!;
    selectedAfterPointerSwitch.onmouseenter?.();
    assert.equal(selectedAfterPointerSwitch.getAttribute("data-session-id"), "second");
    assert.equal(
      tooltipAfterPointerSwitch.hasClass("is-visible"),
      false,
      "pointer activation must keep the summary closed after focus restoration"
    );
    assert.equal(tooltipAfterPointerSwitch.getAttribute("aria-hidden"), "true");

    selectedAfterPointerSwitch.onmouseleave?.();
    selectedAfterPointerSwitch.onmouseenter?.();
    assert.equal(tooltipAfterPointerSwitch.hasClass("is-visible"), true);
    selectedAfterPointerSwitch.onmouseleave?.();
    assert.equal(
      tooltipAfterPointerSwitch.hasClass("is-visible"),
      false,
      "pointer-focused tabs must dismiss the summary on mouse leave"
    );

    selectedAfterPointerSwitch.blur();
    const keyboardTarget = container.findAllByClass("codex-session-tab")[0]!;
    keyboardTarget.focusVisible = true;
    keyboardTarget.focus();
    const tooltipBeforeKeyboardActivation = container.findByClass(
      "codex-session-summary-tooltip"
    )!;
    assert.equal(
      tooltipBeforeKeyboardActivation.hasClass("is-visible"),
      true,
      "keyboard-visible focus keeps the accessible session summary"
    );
    keyboardTarget.onclick?.({
      isTrusted: true,
      detail: 0,
      preventDefault: () => undefined,
      stopPropagation: () => undefined
    });
    const selectedAfterKeyboardSwitch = container
      .findAllByClass("codex-session-tab")
      .find((tab) => tab.getAttribute("aria-selected") === "true")!;
    const tooltipAfterKeyboardSwitch = container.findByClass(
      "codex-session-summary-tooltip"
    )!;
    assert.equal(selectedAfterKeyboardSwitch.getAttribute("data-session-id"), "first");
    assert.equal(
      tooltipAfterKeyboardSwitch.hasClass("is-visible"),
      true,
      "keyboard activation keeps the summary visible after focus restoration"
    );
    selectedAfterKeyboardSwitch.onmouseleave?.();
    assert.equal(tooltipAfterKeyboardSwitch.hasClass("is-visible"), true);
    selectedAfterKeyboardSwitch.blur();
    assert.equal(tooltipAfterKeyboardSwitch.hasClass("is-visible"), false);
  } finally {
    if (originalDocument) Object.defineProperty(testGlobal, "document", originalDocument);
    else delete testGlobal.document;
    if (originalHTMLElement) {
      Object.defineProperty(testGlobal, "HTMLElement", originalHTMLElement);
    } else {
      delete testGlobal.HTMLElement;
    }
  }
}

function assertSessionPickerArchiveActions(): void {
  const testGlobal = globalThis as unknown as Record<string, unknown>;
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalHTMLElement = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
  const testDocument: { activeElement: FakeElement | null } = { activeElement: null };
  Object.defineProperty(testGlobal, "document", {
    configurable: true,
    value: testDocument
  });
  Object.defineProperty(testGlobal, "HTMLElement", {
    configurable: true,
    value: FakeElement
  });

  try {
    const container = new FakeElement("div");
    const sessions = [
      testConversationSession("idle", "可归档会话", 1),
      testConversationSession("running", "运行会话", 2),
      testConversationSession("running-second", "另一个运行会话", 3)
    ];
    sessions[0]!.unreadAnswerAt = 10;
    sessions[1]!.unreadAnswerAt = 20;
    const archivedSessionIds: string[] = [];
    renderCodexTabs(
      container as unknown as HTMLElement,
      sessions,
      "idle",
      {
        onActivate: () => undefined,
        onContextMenu: () => undefined,
        onRename: () => undefined,
        onArchive: (session) => archivedSessionIds.push(session.id),
        onDeleteSessions: () => undefined,
        onCreateSession: () => undefined
      },
      new Set(["running", "running-second"])
    );
    assert.equal(container.findAllByClass("codex-session-tab-running").length, 2,
      "each running conversation has its own compact-tab spinner");
    const compactTabs = container.findAllByClass("codex-session-tab");
    const unreadTab = compactTabs.find((tab) =>
      tab.getAttribute("data-session-id") === "idle"
    );
    const runningTab = compactTabs.find((tab) =>
      tab.getAttribute("data-session-id") === "running"
    );
    assert.ok(unreadTab && runningTab);
    assert.equal(unreadTab.findByClass("codex-session-tab-title")?.textContent, "1");
    assert.ok(unreadTab.findByClass("codex-session-tab-unread"));
    assert.equal(unreadTab.getAttribute("aria-label"), "可归档会话，有未读答案");
    assert.equal(runningTab.findByClass("codex-session-tab-title")?.textContent, "2");
    assert.ok(runningTab.findByClass("codex-session-tab-running"));
    assert.equal(runningTab.findByClass("codex-session-tab-unread"), null);
    assert.equal(
      runningTab.getAttribute("aria-label"),
      "运行会话，正在运行",
      "running status must take precedence over unread status"
    );
    container.findByClass("codex-session-all")?.onclick?.({
      isTrusted: true,
      detail: 1,
      preventDefault: () => undefined,
      stopPropagation: () => undefined
    });

    const rows = container.findAllByClass("codex-session-row");
    const idleRow = rows.find((row) => row.getAttribute("data-session-id") === "idle");
    const runningRow = rows.find((row) => row.getAttribute("data-session-id") === "running");
    const secondRunningRow = rows.find((row) => row.getAttribute("data-session-id") === "running-second");
    assert.ok(secondRunningRow?.findByClass("codex-session-row-leading")?.hasClass("is-spinning"));
    assert.equal(secondRunningRow?.findAllByClass("codex-session-row-action")[1]?.disabled, true);
    assert.ok(idleRow && runningRow);
    assert.equal(idleRow.hasClass("is-unread"), true);
    assert.ok(idleRow.findByClass("codex-session-unread-dot"));
    assert.equal(
      idleRow.findByClass("codex-session-row-meta")?.children[0]?.textContent,
      "有未读答案"
    );
    assert.equal(idleRow.getAttribute("aria-label"), "可归档会话，有未读答案");
    assert.equal(runningRow.hasClass("is-unread"), false);
    assert.ok(runningRow.findByClass("codex-session-row-leading")?.hasClass("is-spinning"));
    assert.equal(runningRow.findByClass("codex-session-unread-dot"), null);
    assert.equal(runningRow.getAttribute("aria-label"), "运行会话，正在运行");
    const idleActions = idleRow.findAllByClass("codex-session-row-action");
    const runningActions = runningRow.findAllByClass("codex-session-row-action");
    assert.deepEqual(
      idleActions.map((button) => button.getAttribute("title")),
      ["重命名", "归档", "删除"],
      "row actions keep rename, archive, and delete in that order"
    );
    assert.equal(runningActions.length, 3);
    assert.equal(runningActions[1]?.disabled, true, "running conversations cannot be archived");
    clickElement(idleActions[1]!);
    clickElement(runningActions[1]!);
    assert.deepEqual(archivedSessionIds, ["idle"], "only the matching idle row archives");
    const styles = readFileSync("styles.css", "utf8");
    assert.match(
      styles,
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.codex-session-tab-running,[\s\S]*?\.codex-session-row-leading\.is-spinning\s*\{\s*animation:\s*none\s*!important;/u,
      "reduced motion keeps the status icon visible without continuous rotation"
    );
  } finally {
    if (originalDocument) Object.defineProperty(testGlobal, "document", originalDocument);
    else delete testGlobal.document;
    if (originalHTMLElement) {
      Object.defineProperty(testGlobal, "HTMLElement", originalHTMLElement);
    } else {
      delete testGlobal.HTMLElement;
    }
  }
}

async function assertInteractionDockContracts(): Promise<void> {
  const controller = new InteractionDockController();
  const container = new FakeElement("div");
  const questionBroker = new PiTurnInteractionBroker();
  const interaction: EchoInkQuestionInteraction = {
    kind: "question",
    interactionId: "question-interaction",
    conversationId: "conversation-question",
    piSessionId: "pi-question",
    turnId: "turn-question",
    status: "pending",
    questions: [{
      questionId: "approach",
      prompt: "采用哪种方案？",
      selection: "single",
      options: [{ optionId: "simple", label: "简单方案" }, {
        optionId: "extended",
        label: "扩展方案"
      }],
      allowSupplement: false
    }, {
      questionId: "evidence",
      prompt: "需要哪些验收证据？",
      selection: "multiple",
      options: [{ optionId: "ui", label: "界面" }, {
        optionId: "provider",
        label: "Provider"
      }],
      allowSupplement: true
    }],
    createdAt: 1,
    updatedAt: 1
  };
  const answerPromise = questionBroker.waitForAnswers({
    conversationId: interaction.conversationId,
    piSessionId: interaction.piSessionId,
    productRunId: interaction.turnId,
    interactionId: interaction.interactionId,
    interaction
  });
  const questionBinding = questionBroker.bindingFor({
    conversationId: interaction.conversationId,
    piSessionId: interaction.piSessionId,
    productRunId: interaction.turnId,
    interactionId: interaction.interactionId
  });
  assert.ok(questionBinding);
  let questionResolved = 0;
  const questionInput = {
    question: {
      binding: questionBinding!,
      onResolved: () => { questionResolved += 1; }
    },
    onStale: () => assert.fail("a live Question binding must not go stale"),
    onScheduleMeasure: () => undefined
  } as const;

  controller.render(container as unknown as HTMLElement, {
    sessionId: "ui-session-a",
    ...questionInput
  });
  assert.equal(container.hasClass("is-visible"), true);
  assert.equal(
    container.findByClass("codex-ai-elements-question")?.attributes.get("data-ai-elements-pattern"),
    "question"
  );
  assert.equal(container.findByClass("codex-interaction-progress")?.textContent, "1/2");
  controller.render(container as unknown as HTMLElement, {
    sessionId: "ui-session-en",
    language: "en",
    ...questionInput
  });
  assert.equal(
    container.findByClass("codex-interaction-card")?.attributes.get("aria-label"),
    "Your input is needed"
  );
  assert.equal(
    container.findByClass("codex-interaction-heading-primary")?.textContent,
    "Your input is needed"
  );
  assert.equal(
    container.findByClass("codex-interaction-heading-secondary"),
    null,
    "the localized heading must not repeat a visible English Question label"
  );
  assert.equal(
    container.findByClass("codex-interaction-progress")?.attributes.get("aria-label"),
    "Question 1 of 2"
  );
  assert.equal(container.findByClass("codex-interaction-prompt")?.textContent, "采用哪种方案？");
  assert.deepEqual(
    container.findAllByClass("codex-interaction-option-label").map((option) => option.textContent),
    ["简单方案", "扩展方案"],
    "Question prompts and options remain verbatim in English mode"
  );
  assert.equal(container.findByClass("codex-interaction-action")?.textContent, "Next");

  controller.render(container as unknown as HTMLElement, {
    sessionId: "ui-session-a",
    ...questionInput
  });
  const firstSessionControls = container.findAllByClass("codex-interaction-option-control");
  firstSessionControls[0]!.checked = true;
  firstSessionControls[0]!.onchange?.();
  assert.equal(questionResolved, 0, "selecting an option must preserve the optional supplement step");
  assert.equal(container.hasClass("is-visible"), true, "selection alone must not dismiss the Question dock");
  clickElement(container.findByClass("codex-interaction-action")!);
  assert.equal(container.findByClass("codex-interaction-progress")?.textContent, "2/2");

  controller.render(container as unknown as HTMLElement, {
    sessionId: "ui-session-b",
    ...questionInput
  });
  assert.equal(container.findByClass("codex-interaction-progress")?.textContent, "1/2");
  assert.equal(
    container.findAllByClass("codex-interaction-option-control").some((control) => control.checked),
    false,
    "Question drafts are isolated by UI session"
  );

  controller.render(container as unknown as HTMLElement, {
    sessionId: "ui-session-a",
    ...questionInput
  });
  assert.equal(container.findByClass("codex-interaction-progress")?.textContent, "2/2");
  assert.equal(
    container.findByClass("codex-interaction-instruction")?.textContent,
    "选择一项或多项，或填写自己的回答，也可以两者都填。"
  );
  const secondQuestionControls = container.findAllByClass("codex-interaction-option-control");
  secondQuestionControls[1]!.checked = true;
  secondQuestionControls[1]!.onchange?.();
  const supplement = container.findByClass("codex-interaction-supplement-input")!;
  supplement.value = "保留真实 Provider 证据";
  supplement.oninput?.();
  const submit = container.findAllByClass("codex-interaction-action").at(-1)!;
  assert.equal(submit.textContent, "提交回答");
  assert.equal(
    submit.closest(".codex-interaction-question"),
    null,
    "the primary action must stay outside the independently scrolling Question body"
  );
  clickElement(submit);
  clickElement(submit);
  assert.equal(questionResolved, 1, "Question resolves exactly once");
  assert.equal(container.hasClass("is-visible"), false, "answered Question leaves the Dock");
  assert.equal(container.childElementCount, 0);
  assert.deepEqual(await answerPromise, [{
    questionId: "approach",
    selectedOptionIds: ["simple"]
  }, {
    questionId: "evidence",
    selectedOptionIds: ["provider"],
    supplement: "保留真实 Provider 证据"
  }]);
  assert.equal(questionBinding!.submit([]), false, "resolved Question binding cannot be replayed");

  const singleQuestionBroker = new PiTurnInteractionBroker();
  const singleInteraction: EchoInkQuestionInteraction = {
    kind: "question",
    interactionId: "single-question-interaction",
    conversationId: "conversation-single-question",
    piSessionId: "pi-single-question",
    turnId: "turn-single-question",
    status: "pending",
    questions: [{
      questionId: "custom-answer",
      prompt: "What should we review?",
      selection: "single",
      options: [{ optionId: "boundaries", label: "Product boundaries" }],
      allowSupplement: true
    }],
    createdAt: 2,
    updatedAt: 2
  };
  const singleAnswerPromise = singleQuestionBroker.waitForAnswers({
    conversationId: singleInteraction.conversationId,
    piSessionId: singleInteraction.piSessionId,
    productRunId: singleInteraction.turnId,
    interactionId: singleInteraction.interactionId,
    interaction: singleInteraction
  });
  const singleBinding = singleQuestionBroker.bindingFor({
    conversationId: singleInteraction.conversationId,
    piSessionId: singleInteraction.piSessionId,
    productRunId: singleInteraction.turnId,
    interactionId: singleInteraction.interactionId
  });
  assert.ok(singleBinding);
  const singleInput = {
    question: {
      binding: singleBinding!,
      onResolved: () => undefined
    },
    onStale: () => assert.fail("a live single-Question binding must not go stale"),
    onScheduleMeasure: () => undefined
  } as const;
  controller.render(container as unknown as HTMLElement, {
    sessionId: "ui-session-single",
    language: "en",
    ...singleInput
  });
  assert.equal(
    container.findByClass("codex-interaction-progress"),
    null,
    "a single question must not show a redundant 1/1 progress label"
  );
  assert.equal(
    container.findByClass("codex-interaction-instruction")?.textContent,
    "Select an option or write your own answer. You can also do both."
  );
  controller.render(container as unknown as HTMLElement, {
    sessionId: "ui-session-single",
    ...singleInput
  });
  assert.equal(
    container.findByClass("codex-interaction-instruction")?.textContent,
    "选择一项或填写自己的回答，也可以两者都填。"
  );
  const customAnswer = container.findByClass("codex-interaction-supplement-input")!;
  customAnswer.value = "复盘真实运行边界";
  customAnswer.oninput?.();
  clickElement(container.findByClass("codex-interaction-action")!);
  assert.deepEqual(await singleAnswerPromise, [{
    questionId: "custom-answer",
    selectedOptionIds: [],
    supplement: "复盘真实运行边界"
  }]);

  const approvalBroker = new PiAgentApprovalBroker();
  const approvalIdentity = {
    conversationId: "conversation-confirmation",
    piSessionId: "pi-confirmation",
    productRunId: "turn-confirmation",
    toolCallId: "tool-confirmation"
  } as const;
  const approvalPromise = approvalBroker.waitForDecision({
    ...approvalIdentity,
    requestId: "approval-request",
    target: "写入 disposable.md",
    preview: "仅写入一次"
  });
  const confirmationBinding = approvalBroker.bindingFor(approvalIdentity);
  assert.ok(confirmationBinding);
  let confirmationResolved = 0;
  controller.render(container as unknown as HTMLElement, {
    sessionId: "ui-session-confirmation",
    language: "en",
    confirmation: {
      binding: confirmationBinding!,
      onResolved: () => { confirmationResolved += 1; }
    },
    onStale: () => assert.fail("a live Confirmation binding must not go stale"),
    onScheduleMeasure: () => undefined
  });
  assert.equal(
    container.findByClass("codex-ai-elements-confirmation")?.attributes.get("data-ai-elements-pattern"),
    "confirmation"
  );
  assert.match(renderedText(container), /Awaiting approval to run/u);
  assert.match(renderedText(container), /写入 disposable\.md/u);
  assert.match(renderedText(container), /仅写入一次/u,
    "approval target and preview remain verbatim in English mode");
  assert.equal(container.findByClass("is-reject")?.textContent, "Reject");
  assert.equal(container.findByClass("is-approve")?.textContent, "Approve");
  const approve = container.findByClass("is-approve")!;
  clickElement(approve);
  clickElement(approve);
  assert.equal(await approvalPromise, true);
  assert.equal(confirmationResolved, 1, "Confirmation resolves exactly once");
  assert.equal(container.hasClass("is-visible"), false, "resolved Confirmation leaves the Dock");
  assert.equal(container.childElementCount, 0);
  assert.equal(confirmationBinding!.decide("reject"), false,
    "resolved Confirmation binding cannot be replayed");

  controller.dispose();
  questionBroker.dispose();
  approvalBroker.dispose();
}

class FakeTaskPlanDockClock implements TaskPlanDockClock {
  nowValue = 10_000;
  nextHandle = 0;
  readonly timers = new Map<number, { callback: () => void; delayMs: number }>();
  readonly cleared = new Set<number>();

  now(): number {
    return this.nowValue;
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const handle = ++this.nextHandle;
    this.timers.set(handle, { callback, delayMs });
    return handle;
  }

  clearTimeout(handle: number): void {
    this.cleared.add(handle);
  }

  fire(handle: number): void {
    this.timers.get(handle)?.callback();
  }
}

function taskPlanMessage(
  plan: Readonly<EchoInkTaskPlanSnapshot>,
  id = `task-plan-${plan.version}`
): ChatMessage {
  return {
    id,
    role: "assistant",
    itemType: "taskPlan",
    text: "",
    taskPlan: plan,
    createdAt: plan.createdAt
  };
}

export async function runSmoothConversationUiTests(): Promise<void> {
  const paragraphContext = createTestContext();
  const firstSentence = `${"甲".repeat(70)}。`;
  const secondSentence = `${"乙".repeat(55)}！`;
  const thirdSentence = `${"丙".repeat(70)}？`;
  const paragraphCases: Array<[string, string[]]> = [
    ["短句。 保留空格！", ["短句。 保留空格！"]],
    [`${firstSentence} \t${secondSentence}\u3000${thirdSentence}`, [firstSentence, secondSentence, thirdSentence]],
    [`${firstSentence}！${secondSentence}；${thirdSentence}`, [`${firstSentence}！`, `${secondSentence}；`, thirdSentence]],
    ["没有句号的内容".repeat(40), ["没有句号的内容".repeat(40)]],
    [`${firstSentence}${secondSentence}${"尾".repeat(70)}`, [firstSentence, secondSentence, "尾".repeat(70)]]
  ];
  for (const [input, expected] of paragraphCases) {
    const container = new FakeElement("div");
    renderRichText(
      paragraphContext.app as Parameters<typeof renderRichText>[0],
      paragraphContext.component as Parameters<typeof renderRichText>[1],
      container as unknown as HTMLElement,
      input
    );
    assert.deepEqual(container.findAllByTag("p").map(renderedText), expected,
      "paragraph rendering preserves punctuation, whitespace rules and unfinished sentences without lookbehind");
  }
  assertSessionSummaryTooltipLifecycle();
  assertSessionPickerArchiveActions();
  assert.equal(
    settingsCopy("zh-CN").general.settingsLanguageDesc,
    "控制 EchoInk 界面语言；不会改写 Prompt、会话内容或用户自定义名称。"
  );
  assert.equal(
    settingsCopy("en").general.settingsLanguageDesc,
    "Controls the EchoInk interface language. Prompts, chats, and custom names are unchanged."
  );
  const noteMentionContext = createTestContext();
  const noteMentionRenderer = new CodexMessageListRenderer();
  bindRenderer(noteMentionRenderer, noteMentionContext);
  const noteMentionMessage = renderMessage(noteMentionRenderer, {
    id: "user-note-mention",
    role: "user",
    itemType: "user",
    text: "请总结",
    noteMentions: [{
      vaultRelativePath: "projects/Alpha.md",
      fileName: "Alpha.md"
    }],
    createdAt: 1
  }, { showAgentFooter: false, showAgentHeader: false });
  const noteMentionChip = noteMentionMessage.findByClass("codex-message-note-mention-chip");
  assert.ok(noteMentionChip);
  assert.equal(renderedText(noteMentionChip!), "Alpha.md");
  assert.doesNotMatch(renderedText(noteMentionChip!), /projects/u,
    "historical note chips display the filename only");
  clickElement(noteMentionChip!);
  await Promise.resolve();
  assert.deepEqual(noteMentionContext.openedPaths, ["projects/Alpha.md"],
    "historical note chips open their Vault-relative note without a line target");

  const englishSystemRenderer = new CodexMessageListRenderer();
  bindRenderer(englishSystemRenderer, noteMentionContext, "en");
  const legacySystemError = renderMessage(englishSystemRenderer, {
    id: "legacy-system-error",
    role: "system",
    itemType: "error",
    title: "回答失败",
    text: "网络连接中断，回答未完成。",
    status: "failed",
    createdAt: 2
  }, { showAgentFooter: false, showAgentHeader: false });
  assert.match(renderedText(legacySystemError), /Answer failed/u);
  assert.match(
    renderedText(legacySystemError),
    /The network connection was interrupted, so the answer was not completed\./u,
    "known legacy EchoInk system failures are localized in English mode"
  );
  const unknownSystemError = renderMessage(englishSystemRenderer, {
    id: "unknown-system-error",
    role: "system",
    itemType: "error",
    title: "会话诊断",
    text: "provider-gateway-52",
    status: "failed",
    createdAt: 3
  }, { showAgentFooter: false, showAgentHeader: false });
  assert.match(renderedText(unknownSystemError), /provider-gateway-52/u,
    "unclassified Provider diagnostics stay verbatim");
  const preservedUserContent = renderMessage(englishSystemRenderer, {
    id: "preserved-user-content",
    role: "user",
    itemType: "user",
    text: "网络连接中断，回答未完成。",
    createdAt: 4
  }, { showAgentFooter: false, showAgentHeader: false });
  assert.match(renderedText(preservedUserContent), /网络连接中断，回答未完成。/u,
    "user-authored history is never translated by the system-copy mapper");
  const preservedToolContent = renderMessage(englishSystemRenderer, {
    id: "preserved-tool-content",
    role: "tool",
    itemType: "error",
    title: "回答失败",
    text: "网络连接中断，回答未完成。",
    status: "failed",
    createdAt: 5
  }, { showAgentFooter: false, showAgentHeader: false });
  assert.match(renderedText(preservedToolContent), /回答失败/u);
  assert.match(renderedText(preservedToolContent), /网络连接中断，回答未完成。/u,
    "Tool-returned text is never translated by the system-copy mapper");
  const initialDisclosure = nextReasoningDisclosureState(undefined, "running");
  assert.deepEqual(initialDisclosure, {
    open: true,
    manual: false,
    autoFoldHandled: false,
    lastStatus: "running"
  });
  const pendingAutoFoldDisclosure = nextReasoningDisclosureState(
    initialDisclosure,
    "completed"
  );
  assert.deepEqual(pendingAutoFoldDisclosure, {
    open: true,
    manual: false,
    autoFoldHandled: false,
    lastStatus: "completed"
  }, "the running disclosure remains open while the one-second fold delay is pending");
  assert.equal(
    nextReasoningDisclosureState(pendingAutoFoldDisclosure, "failed").open,
    true,
    "later terminal updates preserve the pending delayed fold"
  );
  assert.deepEqual(nextReasoningDisclosureState(undefined, "interrupted"), {
    open: false,
    manual: false,
    autoFoldHandled: true,
    lastStatus: "interrupted"
  }, "a restored terminal snapshot starts folded with auto-fold already handled");
  assert.equal(isReasoningScrollNearBottom(0, 280, 180), true,
    "naturally sized Reasoning content remains in follow mode before it overflows");
  assert.equal(
    isReasoningScrollNearBottom(535, 280, 840),
    false,
    "Reasoning pauses follow when the reader is beyond the near-bottom threshold"
  );
  assert.equal(
    isReasoningScrollNearBottom(536, 280, 840),
    true,
    `Reasoning resumes follow within ${REASONING_SCROLL_BOTTOM_EPSILON_PX}px of the bottom`
  );
  const chineseHost = new FakeElement("div");
  const chinese = renderSmoothBlurOutUp(
    chineseHost as unknown as HTMLElement,
    "从一个问题开始"
  ) as unknown as FakeElement;
  assert.equal(chinese.attributes.get("aria-label"), "从一个问题开始");
  assert.equal(chinese.attributes.get("data-duration-ms"), String(SMOOTH_BLUR_OUT_UP_DURATION_MS));
  assert.equal(chinese.attributes.get("data-easing"), SMOOTH_BLUR_OUT_UP_EASING);
  assert.equal(chinese.attributes.get("data-stagger-ms"), String(SMOOTH_BLUR_OUT_UP_STAGGER_MS));
  assert.equal(chinese.findAllByClass("codex-smooth-blur-out-up-unit").length, 1,
    "Chinese subtitle may animate as one semantic unit");
  assert.equal(chinese.findByClass("codex-smooth-blur-out-up-unit")?.attributes.get("aria-hidden"), "true");

  const englishHost = new FakeElement("div");
  const english = renderSmoothBlurOutUp(
    englishHost as unknown as HTMLElement,
    "Smooth conversation"
  ) as unknown as FakeElement;
  const units = english.findAllByClass("codex-smooth-blur-out-up-unit");
  assert.equal(units.length, 2);
  assert.equal(units[0].attributes.get("style"), "--codex-smooth-blur-delay: 0ms");
  assert.equal(units[1].attributes.get("style"), "--codex-smooth-blur-delay: 28ms");

  const primitiveHost = new FakeElement("div");
  const reasoning = createAIElementsReasoning(primitiveHost as unknown as HTMLElement, {
    bodyId: "reasoning-body",
    open: true,
    status: "running",
    summary: "正在思考"
  });
  assert.equal((reasoning.root as unknown as FakeElement).tag, "details");
  assert.equal((reasoning.root as unknown as FakeElement).attributes.get("data-ai-elements-pattern"), "reasoning");
  assert.equal((reasoning.summary as unknown as FakeElement).attributes.get("aria-expanded"), "true");
  const tool = primitiveHost.createDiv();
  assert.equal(markAIElementsTool(tool as unknown as HTMLElement, "completed"), "success");
  assert.equal(tool.attributes.get("data-ai-elements-pattern"), "tool");
  const artifact = createSmoothAIArtifact(primitiveHost as unknown as HTMLElement, "输出");
  assert.equal((artifact.root as unknown as FakeElement).attributes.get("data-smooth-ui-pattern"), "ai-artifact");
  const tasks = primitiveHost.createDiv();
  markSmoothAITaskList(tasks as unknown as HTMLElement);
  assert.equal(tasks.attributes.get("data-smooth-ui-pattern"), "ai-task-list");

  const selectionHost = new FakeElement("div");
  const selectionText = new FakeElement("text");
  selectionText.textContent = "alpha";
  selectionText.parent = selectionHost;
  selectionHost.children.push(selectionText);
  selectionHost.content.push(selectionText);
  let restoredSelection: readonly [unknown, number, unknown, number] | null = null;
  const selection = {
    rangeCount: 1,
    anchorNode: selectionText,
    anchorOffset: 1,
    focusNode: selectionText,
    focusOffset: 4,
    setBaseAndExtent: (anchorNode: unknown, anchorOffset: number, focusNode: unknown, focusOffset: number) => {
      restoredSelection = [anchorNode, anchorOffset, focusNode, focusOffset];
    }
  };
  const selectionDocument = {
    defaultView: { NodeFilter: { SHOW_TEXT: 4 } },
    getSelection: () => selection,
    createRange: () => {
      let endNode: FakeElement | null = null;
      let endOffset = 0;
      return {
        selectNodeContents: () => undefined,
        setEnd: (node: FakeElement, offset: number) => {
          endNode = node;
          endOffset = offset;
        },
        toString: () => endNode?.textContent.slice(0, endOffset) ?? ""
      };
    },
    createTreeWalker: () => {
      let yielded = false;
      return {
        nextNode: () => {
          if (yielded) return null;
          yielded = true;
          return selectionText;
        }
      };
    }
  };
  Object.defineProperty(selectionHost, "ownerDocument", {
    configurable: true,
    value: selectionDocument
  });
  preserveTextSelectionDuringMutation(selectionHost as unknown as HTMLElement, () => {
    selectionText.textContent = "alpha beta";
  });
  assert.deepEqual(restoredSelection, [selectionText, 1, selectionText, 4],
    "a local streaming mutation restores the browser text selection by character offsets");

  const dockClock = new FakeTaskPlanDockClock();
  const inProgressPlan: Readonly<EchoInkTaskPlanSnapshot> = Object.freeze({
    schemaVersion: 1,
    planId: "shared-plan",
    title: "共享计划",
    status: "in_progress",
    version: 1,
    steps: Object.freeze([
      Object.freeze({ stepId: "step-1", text: "读取真实状态", status: "completed" as const }),
      Object.freeze({ stepId: "step-2", text: "更新界面", status: "in_progress" as const })
    ]),
    currentStepId: "step-2",
    source: "agent",
    createdAt: 9_000,
    updatedAt: 9_500
  });
  const inProgressMessage = taskPlanMessage(inProgressPlan, "stable-plan-message");
  assert.equal(
    selectTaskPlanForDock([inProgressMessage])?.plan,
    inProgressPlan,
    "the dock selector returns the exact projected taskPlan reference"
  );
  assert.equal(selectTaskPlanForDock([{
    id: "natural-language-plan",
    role: "assistant",
    text: "计划：先读，再写",
    createdAt: 9_600
  }]), null, "natural-language planning copy must not create a dock plan");

  const versionTwoPlan: Readonly<EchoInkTaskPlanSnapshot> = Object.freeze({
    ...inProgressPlan,
    version: 2,
    steps: Object.freeze([
      Object.freeze({ stepId: "step-1", text: "读取真实状态", status: "completed" as const }),
      Object.freeze({ stepId: "step-2", text: "界面已同步到 v2", status: "in_progress" as const })
    ]),
    updatedAt: 9_700
  });
  const dock = new TaskPlanDockController(dockClock);
  const dockHost = new FakeElement("div");
  dock.render(dockHost as unknown as HTMLElement, {
    sessionId: "session-a",
    messages: [inProgressMessage]
  });
  assert.equal(dockHost.dataset.sessionTaskPlanId, "shared-plan");
  assert.ok(dockHost.findByClass("codex-smooth-ai-task-list"));
  assert.equal(
    dockHost.findByClass("codex-task-plan-progress")?.textContent,
    "2/2 · 进行中",
    "compact progress reports the real current step and whole-plan state"
  );
  assert.match(renderedText(dockHost), /更新界面/u);
  dock.render(dockHost as unknown as HTMLElement, {
    sessionId: "session-a",
    messages: [taskPlanMessage(versionTwoPlan, "stable-plan-message")]
  });
  assert.match(renderedText(dockHost), /界面已同步到 v2/u,
    "a same-message plan version replaces the dock immediately");
  clickElement(dockHost.findByClass("codex-task-plan-header")!);
  assert.equal(
    dockHost.findAllByClass("codex-task-plan-step").length,
    2,
    "expanded dock renders every real step"
  );
  dock.dispose();

  const englishDock = new TaskPlanDockController(new FakeTaskPlanDockClock());
  const englishDockHost = new FakeElement("div");
  englishDock.render(englishDockHost as unknown as HTMLElement, {
    sessionId: "session-english",
    language: "en",
    messages: [inProgressMessage],
    onAction: async () => undefined
  });
  assert.equal(
    englishDockHost.findByClass("codex-task-plan-card")?.attributes.get("aria-label"),
    "Current task: 共享计划"
  );
  assert.equal(
    englishDockHost.findByClass("codex-task-plan-progress")?.textContent,
    "2/2 · In progress"
  );
  assert.equal(
    englishDockHost.findByClass("codex-task-plan-status")?.attributes.get("aria-label"),
    "In progress"
  );
  assert.match(renderedText(englishDockHost), /共享计划/u);
  assert.match(renderedText(englishDockHost), /更新界面/u,
    "plan titles and steps remain verbatim while dock chrome is localized");
  assert.equal(
    englishDockHost.findByClass("codex-task-plan-header")?.attributes.get("title"),
    "Expand current task"
  );
  clickElement(englishDockHost.findByClass("codex-task-plan-header")!);
  assert.equal(
    englishDockHost.findByClass("codex-task-plan-header")?.attributes.get("title"),
    "Collapse current task"
  );
  assert.equal(
    englishDockHost.findByClass("codex-task-plan-action")?.textContent,
    "Pause / stop"
  );
  englishDock.dispose();

  const completionClock = new FakeTaskPlanDockClock();
  const completedPlan: Readonly<EchoInkTaskPlanSnapshot> = Object.freeze({
    ...versionTwoPlan,
    status: "completed",
    version: 3,
    steps: Object.freeze(versionTwoPlan.steps.map((step) => Object.freeze({
      ...step,
      status: "completed" as const
    }))),
    currentStepId: undefined,
    updatedAt: completionClock.now()
  });
  const completionDock = new TaskPlanDockController(completionClock);
  const completionHost = new FakeElement("div");
  const completionInput = {
    sessionId: "session-completed",
    messages: [
      taskPlanMessage({
        ...inProgressPlan,
        planId: "older-plan",
        updatedAt: 8_000
      }, "older-plan-message"),
      taskPlanMessage(completedPlan)
    ]
  };
  completionDock.render(completionHost as unknown as HTMLElement, completionInput);
  completionDock.render(completionHost as unknown as HTMLElement, completionInput);
  assert.match(renderedText(completionHost), /2\/2 · 已完成/u);
  assert.equal(completionClock.timers.size, 1,
    "repeated renders schedule one completion closeout");
  const completionHandle = [...completionClock.timers.keys()][0];
  assert.equal(completionClock.timers.get(completionHandle)?.delayMs, TASK_PLAN_DOCK_CLOSEOUT_MS);
  completionClock.fire(completionHandle);
  assert.equal(completionHost.hasClass("is-visible"), false);
  assert.equal(completionHost.dataset.sessionTaskPlanId, undefined,
    "hiding the latest completed plan never falls back to an older plan");
  completionDock.render(completionHost as unknown as HTMLElement, completionInput);
  assert.equal(completionClock.timers.size, 1,
    "a hidden completed plan never schedules again");

  const manualClock = new FakeTaskPlanDockClock();
  const manualDock = new TaskPlanDockController(manualClock);
  const manualHost = new FakeElement("div");
  const manualInput = {
    sessionId: "session-manual",
    messages: [taskPlanMessage({ ...completedPlan, updatedAt: manualClock.now() })]
  };
  manualDock.render(manualHost as unknown as HTMLElement, manualInput);
  const manualHandle = [...manualClock.timers.keys()][0];
  clickElement(manualHost.findByClass("codex-task-plan-header")!);
  assert.equal(manualClock.cleared.has(manualHandle), true);
  manualClock.fire(manualHandle);
  assert.equal(manualHost.hasClass("is-visible"), true,
    "manual expansion protects a completed dock from collapse or hiding");

  const switchClock = new FakeTaskPlanDockClock();
  const switchDock = new TaskPlanDockController(switchClock);
  const switchHost = new FakeElement("div");
  switchDock.render(switchHost as unknown as HTMLElement, {
    sessionId: "session-old",
    messages: [taskPlanMessage({ ...completedPlan, updatedAt: switchClock.now() })]
  });
  const staleHandle = [...switchClock.timers.keys()][0];
  switchDock.render(switchHost as unknown as HTMLElement, {
    sessionId: "session-new",
    messages: [inProgressMessage]
  });
  assert.equal(switchClock.cleared.has(staleHandle), true);
  switchClock.fire(staleHandle);
  assert.equal(switchHost.dataset.sessionTaskPlanId, "shared-plan",
    "a late callback from the old session cannot hide the new session plan");
  switchDock.render(switchHost as unknown as HTMLElement, {
    sessionId: "session-old",
    messages: [taskPlanMessage({ ...completedPlan, updatedAt: switchClock.now() })]
  });
  assert.equal(switchHost.hasClass("is-visible"), false,
    "switching back restores that session's handled presentation without replaying it");

  const oldClock = new FakeTaskPlanDockClock();
  oldClock.nowValue = completedPlan.updatedAt + TASK_PLAN_DOCK_CLOSEOUT_MS + 1;
  const oldHost = new FakeElement("div");
  new TaskPlanDockController(oldClock).render(oldHost as unknown as HTMLElement, {
    sessionId: "session-reopened",
    messages: [taskPlanMessage(completedPlan)]
  });
  assert.equal(oldHost.hasClass("is-visible"), false);
  assert.equal(oldClock.timers.size, 0,
    "an old completed plan does not replay its closeout on reopen");

  const failedPlan: Readonly<EchoInkTaskPlanSnapshot> = Object.freeze({
    ...inProgressPlan,
    status: "failed",
    version: 4,
    steps: Object.freeze([
      Object.freeze({ stepId: "step-1", text: "中断的步骤", status: "interrupted" as const }),
      Object.freeze({ stepId: "step-2", text: "尚未开始", status: "pending" as const })
    ]),
    currentStepId: undefined,
    reason: "任务执行失败",
    updatedAt: 9_900
  });
  const failedHost = new FakeElement("div");
  new TaskPlanDockController(dockClock).render(failedHost as unknown as HTMLElement, {
    sessionId: "session-failed",
    messages: [taskPlanMessage(failedPlan)]
  });
  assert.match(renderedText(failedHost), /任务失败/u);
  assert.equal(failedHost.findAllByClass("codex-task-plan-step-current").length, 0,
    "whole-task failure never fabricates a current or failed step");

  const pausedPlan: Readonly<EchoInkTaskPlanSnapshot> = Object.freeze({
    ...inProgressPlan,
    status: "paused",
    version: 5,
    steps: Object.freeze([
      Object.freeze({ stepId: "step-1", text: "已完成步骤", status: "completed" as const }),
      Object.freeze({ stepId: "step-2", text: "中断步骤", status: "paused" as const })
    ]),
    currentStepId: "step-2",
    updatedAt: 10_100
  });
  const pausedHost = new FakeElement("div");
  new TaskPlanDockController(dockClock).render(pausedHost as unknown as HTMLElement, {
    sessionId: "session-paused",
    messages: [taskPlanMessage(pausedPlan)]
  });
  assert.match(renderedText(pausedHost), /已中断，可继续/u);
  assert.doesNotMatch(renderedText(pausedHost), /进行中/u);
  assert.equal(
    pausedHost.findAllByClass("codex-task-plan-step")
      .some((step) => step.hasClass("is-failed")),
    false,
    "a paused Dock never fabricates a failed step"
  );

  const cancelledPlan: Readonly<EchoInkTaskPlanSnapshot> = Object.freeze({
    ...inProgressPlan,
    status: "cancelled",
    version: 6,
    steps: Object.freeze([
      Object.freeze({ stepId: "step-1", text: "已完成步骤", status: "completed" as const }),
      Object.freeze({ stepId: "step-2", text: "取消步骤", status: "cancelled" as const })
    ]),
    currentStepId: undefined,
    updatedAt: 10_200
  });
  const cancelledHost = new FakeElement("div");
  new TaskPlanDockController(dockClock).render(cancelledHost as unknown as HTMLElement, {
    sessionId: "session-cancelled",
    messages: [taskPlanMessage(cancelledPlan)]
  });
  assert.match(renderedText(cancelledHost), /已取消/u);
  assert.doesNotMatch(renderedText(cancelledHost), /进行中/u);
  assert.equal(
    cancelledHost.findAllByClass("codex-task-plan-step")
      .some((step) => step.hasClass("is-failed")),
    false,
    "a cancelled Dock never fabricates a failed step"
  );

  const localSources = createAIElementsDocumentSources(
    primitiveHost as unknown as HTMLElement,
    1,
    true
  );
  assert.equal((localSources.root as unknown as FakeElement).tag, "details");
  assert.equal(
    (localSources.root as unknown as FakeElement).attributes.get("data-ai-elements-pattern"),
    "sources"
  );
  assert.equal(
    (localSources.summary as unknown as FakeElement).findByClass("codex-ai-elements-sources-label")?.textContent,
    "Used 1 document"
  );

  const emptyMessages = new FakeElement("div");
  const emptyVirtualList = new FakeElement("div");
  const selectedSuggestions: string[] = [];
  new CodexMessageListRenderer().render({
    app: {} as never,
    component: {} as never,
    messagesEl: emptyMessages as unknown as HTMLElement,
    virtualListEl: emptyVirtualList as unknown as HTMLElement,
    sessionId: "empty-conversation",
    welcomeCopy: { title: "EchoInk", subtitle: "从一个问题开始" },
    settingsLanguage: "zh-CN",
    messages: [],
    vaultPath: "/test-vault",
    readRawMessageText: async () => "",
    onSuggestionSelect: (text) => selectedSuggestions.push(text),
    onScheduleMeasure: () => undefined,
    onScheduleRunProgress: () => undefined
  });
  const suggestionButtons = emptyVirtualList.findAllByClass("codex-smooth-ai-suggestion");
  assert.deepEqual(
    suggestionButtons.map((button) => button.textContent),
    ["整理知识库", "总结当前笔记", "从知识库找答案"]
  );
  suggestionButtons[1].onclick?.({} as never);
  assert.deepEqual(selectedSuggestions, ["总结当前笔记"], "suggestion click only selects its exact visible text");

  const englishEmptyMessages = new FakeElement("div");
  const englishEmptyVirtualList = new FakeElement("div");
  new CodexMessageListRenderer().render({
    app: {} as never,
    component: {} as never,
    messagesEl: englishEmptyMessages as unknown as HTMLElement,
    virtualListEl: englishEmptyVirtualList as unknown as HTMLElement,
    sessionId: "empty-conversation-en",
    welcomeCopy: { title: "EchoInk", subtitle: "Start with a question" },
    settingsLanguage: "en",
    messages: [],
    vaultPath: "/test-vault",
    readRawMessageText: async () => "",
    onScheduleMeasure: () => undefined,
    onScheduleRunProgress: () => undefined
  });
  assert.equal(
    englishEmptyVirtualList.findByClass("codex-smooth-ai-suggestions")?.attributes.get("aria-label"),
    "Suggested questions"
  );
  assert.deepEqual(
    englishEmptyVirtualList
      .findAllByClass("codex-smooth-ai-suggestion")
      .map((button) => button.textContent),
    ["Organize knowledge", "Summarize current note", "Search knowledge"]
  );

  assert.deepEqual(
    extractProcessFileRefs("读取 Foo.md 后继续", "/test-vault").map((file) => file.path),
    ["Foo.md"],
    "a root-level Vault filename is projected like a nested path"
  );
  const durationFixture: ChatMessage = {
    id: "duration-tool",
    role: "tool",
    itemType: "dynamicToolCall",
    processKind: "view",
    title: "read",
    text: "result",
    status: "completed",
    createdAt: 1_000,
    completedAt: 2_250
  };
  assert.equal(
    buildActionTimeline([durationFixture]).groups[0]?.items[0]?.durationMs,
    1_250,
    "the compact ledger uses completion minus start"
  );
  assert.equal(
    buildActionTimeline([{ ...durationFixture, id: "missing-duration", completedAt: undefined }])
      .groups[0]?.items[0]?.durationMs,
    undefined,
    "a missing completion timestamp never fabricates duration"
  );
  assert.equal(
    buildActionTimeline([{ ...durationFixture, id: "reverse-duration", completedAt: 999 }])
      .groups[0]?.items[0]?.durationMs,
    undefined,
    "a reversed timestamp pair is not displayed as duration"
  );

  const semanticTool = (
    id: string,
    title: string,
    processInput: string,
    processOutput = "",
    itemType = "dynamicToolCall",
    processKind = "tool"
  ): ChatMessage => ({
    id,
    role: "tool",
    itemType,
    processKind: processKind as ChatMessage["processKind"],
    title,
    text: processOutput,
    processInput,
    processOutput,
    processInputAvailability: processInput ? "provided" : "empty",
    processOutputAvailability: processOutput ? "provided" : "empty",
    status: "completed",
    runId: "run-semantic-tools",
    turnId: "run-semantic-tools",
    createdAt: 10_000,
    completedAt: 10_100
  });
  const semanticMessages: ChatMessage[] = [
    semanticTool(
      "semantic-search",
      "使用工具：vault_search",
      JSON.stringify({ query: "EchoInk", scopePath: "projects" }),
      JSON.stringify({
        query: "EchoInk",
        scopePath: "projects",
        items: [{ relativePath: "projects/EchoInk.md", excerpt: "matched" }]
      }),
      "dynamicToolCall",
      "view"
    ),
    semanticTool("semantic-read", "note_read", JSON.stringify({ relativePath: "Source.md" })),
    semanticTool("semantic-create", "note_create", JSON.stringify({
      relativePath: "Created.md",
      content: "first line\nsecond line"
    })),
    semanticTool("semantic-update", "note_update", JSON.stringify({
      relativePath: "Updated.md",
      content: "updated body",
      expectedVersion: "version"
    })),
    semanticTool("semantic-metadata", "metadata_update", JSON.stringify({
      relativePath: "Metadata.md",
      expectedVersion: "version",
      patch: { set: { status: "done" } }
    })),
    semanticTool("semantic-move", "note_move", JSON.stringify({
      sourcePath: "Old.md",
      targetPath: "New.md",
      expectedVersion: "version"
    })),
    semanticTool("semantic-delete", "note_delete", JSON.stringify({
      relativePath: "Trash.md",
      expectedVersion: "version"
    }), JSON.stringify({
      status: "completed",
      sourcePath: "Trash.md",
      readback: { trash: { kind: "obsidian_recoverable" } }
    })),
    semanticTool(
      "semantic-command",
      "bash",
      JSON.stringify({ command: "npm run typecheck" }),
      JSON.stringify({ stdout: "typecheck passed", stderr: "" }),
      "commandExecution",
      "command"
    ),
    semanticTool(
      "semantic-unknown",
      "third_party_create_everything",
      JSON.stringify({ path: "Unknown.md" }),
      JSON.stringify({ message: "done" }),
      "dynamicToolCall",
      "edit"
    )
  ];
  const semanticTimeline = buildActionTimeline(semanticMessages);
  const semanticItems = semanticTimeline.groups.flatMap((group) => group.items);
  assert.deepEqual(
    semanticItems.map((item) => item.toolAction),
    ["search", "read", "create", "edit", "edit", "move", "delete", "command", "call"],
    "Tool actions come from exact Tool IDs; an unknown name containing create stays a call"
  );
  assert.deepEqual(
    semanticItems.map((item) => item.toolId),
    [
      "vault_search",
      "note_read",
      "note_create",
      "note_update",
      "metadata_update",
      "note_move",
      "note_delete",
      "bash",
      "third_party_create_everything"
    ]
  );
  assert.deepEqual(semanticItems[0]?.userDetails, {
    action: "search",
    query: "EchoInk",
    scopePath: "projects",
    resultCount: 1,
    results: [{ path: "projects/EchoInk.md", excerpt: "matched" }]
  });
  assert.deepEqual(semanticItems[2]?.userDetails, {
    action: "create",
    targetPath: "Created.md",
    preview: "first line\nsecond line"
  });
  assert.deepEqual(semanticItems[5]?.userDetails, {
    action: "move",
    sourcePath: "Old.md",
    destinationPath: "New.md"
  });
  assert.deepEqual(semanticItems[6]?.userDetails, {
    action: "delete",
    sourcePath: "Trash.md",
    targetPath: "Trash.md",
    deleteOutcome: "recoverable"
  });
  assert.deepEqual(semanticItems[7]?.userDetails, {
    action: "command",
    command: "npm run typecheck",
    stdout: "typecheck passed"
  });
  assert.equal(semanticItems[8]?.kind, "tool");

  const approvalToolCallId = "approval-preview-Foo";
  const approvalMessageId = `pi:session-ledger:leaf:leaf-ledger:tool:${encodeURIComponent(approvalToolCallId)}`;
  const approvalDiff = [
    "--- a/Foo.md",
    "+++ b/Foo.md",
    "@@ -1 +1 @@",
    "-old",
    "+new"
  ].join("\n");
  const approvalPreview = JSON.stringify({
    operation: "note_update",
    relativePath: "Foo.md",
    change: {
      kind: "update",
      relativePath: "Foo.md",
      added: 1,
      removed: 1,
      diff: approvalDiff
    }
  });
  const projector = new PiChatUiProjector();
  const approvalBase = projector.createEmpty({
    piSessionId: "session-ledger",
    activeLeafId: "leaf-ledger",
    now: 3_000
  });
  approvalBase.productRunId = "run-approval-ledger";
  approvalBase.runState = "running";
  approvalBase.messages = [{
    id: approvalMessageId,
    role: "tool",
    itemType: "dynamicToolCall",
    processKind: "tool",
    title: "note_update",
    text: "",
    processInput: "{\"relativePath\":\"Foo.md\"}",
    processInputAvailability: "provided",
    processOutputAvailability: "unavailable",
    status: "running",
    runId: "run-approval-ledger",
    turnId: "run-approval-ledger",
    createdAt: 3_000
  }];
  approvalBase.provisionalMessageIds = [approvalMessageId];
  approvalBase.pendingToolCallIds = [approvalToolCallId];
  const approvalRecords = [{
    piSessionId: "session-ledger",
    toolCallId: approvalToolCallId,
    productRunId: "run-approval-ledger",
    status: "pending" as const,
    target: "{\"relativePath\":\"Foo.md\"}",
    preview: approvalPreview,
    updatedAt: 3_100
  }];
  const approvalProjected = projector.decorateToolProductState(approvalBase, {
    approvals: approvalRecords
  });
  const approvalProjectionMessage = approvalProjected.messages[0]!;
  assert.equal(approvalProjectionMessage.status, "waiting_approval");
  assert.equal(approvalProjectionMessage.files?.[0]?.path, "Foo.md");
  assert.deepEqual(approvalProjectionMessage.diffSummary, {
    totalFiles: 1,
    added: 1,
    removed: 1,
    files: [{ path: "Foo.md", kind: "update", added: 1, removed: 1 }]
  });
  assert.deepEqual(
    projector.decorateToolProductState(approvalBase, { approvals: approvalRecords }).messages,
    approvalProjected.messages,
    "reopening from the same durable Approval preview rebuilds the same Tool projection"
  );

  const context = createTestContext();
  const renderer = new CodexMessageListRenderer();
  bindRenderer(renderer, context);
  const previousDocument = (globalThis as unknown as { document?: unknown }).document;
  const previousHTMLElement = (globalThis as unknown as { HTMLElement?: unknown }).HTMLElement;
  const previousWindow = (globalThis as unknown as { window?: unknown }).window;
  const originalDateNow = Date.now;
  const platform = Platform as { isDesktopApp: boolean };
  const previousDesktopApp = platform.isDesktopApp;
  platform.isDesktopApp = true;
  const imageOverlayBody = new FakeElement("body");
  const electronOpenedPaths: string[] = [];
  const electronShownPaths: string[] = [];
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      body: imageOverlayBody,
      createElementNS: (_namespace: string, tag: string) => new FakeElement(tag)
    }
  });
  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    value: FakeElement
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setTimeout: (callback: () => void) => {
        callback();
        return 1;
      },
      clearTimeout: () => undefined,
      requestAnimationFrame: (callback: (timestamp: number) => void) => {
        callback(0);
        return 1;
      },
      cancelAnimationFrame: () => undefined,
      require: (moduleName: string) => {
        assert.equal(moduleName, "electron");
        return {
          shell: {
            openPath: (path: string) => {
              electronOpenedPaths.push(path);
              return "";
            },
            showItemInFolder: (path: string) => {
              electronShownPaths.push(path);
            }
          }
        };
      }
    }
  });
  try {
    const answer = renderMessage(renderer, {
      id: "smooth:entry:answer-1",
      role: "assistant",
      text: "查看 **[[projects/Alpha.md|别名]]**",
      backendId: "deepseek-chat",
      providerId: "deepseek",
      modelId: "deepseek-chat",
      status: "completed",
      createdAt: 1_700_000_000_000,
      completedAt: 1_700_000_001_000
    }, { showAgentFooter: true, showAgentHeader: true });
    assert.equal(answer.findAllByClass("codex-agent-header").length, 1);
    assert.equal(answer.findAllByClass("codex-agent-footer").length, 1);
    assert.equal(answer.findAllByClass("codex-answer-copy").length, 1);
    assert.equal(answer.findAllByClass("codex-message-derive-action").length, 1);
    assert.equal(answer.findByClass("codex-agent-footer-model")?.textContent, "deepseek-chat");
    assert.ok(answer.findByClass("codex-agent-footer-time"));
    assert.equal(
      answer.findByClass("codex-ai-elements-message")?.attributes.get("data-ai-elements-pattern"),
      "message"
    );
    assert.ok(answer.findByClass("codex-ai-elements-message-content"));
    assert.equal(
      answer.findByClass("codex-ai-elements-response")?.attributes.get("data-streaming"),
      "false"
    );
    const normalLink = answer.findByClass("codex-message-note-link");
    assert.ok(normalLink);
    assert.equal(normalLink!.textContent, "Alpha", "resolved links display the note name, not aliases or paths");
    assert.equal(normalLink!.attributes.get("data-path"), "projects/Alpha.md");
    assert.equal(normalLink!.attributes.get("aria-label"), "打开笔记 Alpha");
    await clickRegistered(normalLink!);

    const imageAttachments = renderMessage(renderer, {
      id: "user-images",
      role: "user",
      text: "请比较两张图",
      attachments: [{
        type: "image",
        name: "clipboard-1720000000000-0.png",
        path: "images/cover #1.png",
        mimeType: "image/png",
        availability: "unavailable"
      }, {
        type: "file",
        name: "meeting.mp4",
        path: "videos/meeting.mp4",
        mimeType: "video/mp4"
      }],
      images: [{
        type: "image",
        name: "clipboard-1720000000000-0.png",
        path: "images/cover #1.png",
        mimeType: "image/png",
        availability: "unavailable"
      }, {
        type: "image",
        name: "clipboard-1720000000000-1.png",
        path: "images/missing.png",
        mimeType: "image/png",
        availability: "available"
      }],
      createdAt: 1_700_000_000_500
    }, { showAgentFooter: false, showAgentHeader: false });
    const imageAttachmentList = imageAttachments.findByClass("codex-ai-elements-attachments")!;
    assert.equal(imageAttachmentList.attributes.get("data-ai-elements-pattern"), "attachments");
    assert.equal(imageAttachmentList.attributes.get("data-attachment-variant"), "grid");
    assert.equal(imageAttachmentList.attributes.get("role"), "list");
    assert.equal(imageAttachments.findAllByClass("codex-message-attachments").length, 1);
    assert.equal(imageAttachments.findByClass("codex-message-images"), null);
    assert.equal(imageAttachments.findAllByClass("codex-message-attachment-item").length, 3);
    const imagePreview = imageAttachments.findByClass("codex-message-attachment-preview")!;
    assert.equal(imagePreview.tag, "button");
    assert.equal(imagePreview.attributes.get("aria-label"), "打开图片：粘贴图片 1.png");
    assert.equal(
      imagePreview.findAllByTag("img")[0]?.src,
      "app://echoink-vault/images/cover%20%231.png",
      "message Attachments use the current Obsidian resource URI"
    );
    clickElement(imagePreview);
    const imageOverlay = imageOverlayBody.findByClass("codex-image-overlay")!;
    assert.equal(imageOverlay.findAllByTag("img")[0]?.src, "app://echoink-vault/images/cover%20%231.png");
    const videoCard = imageAttachments.findByClass("codex-file-card-message")!;
    assert.equal(videoCard.attributes.get("title"), "meeting.mp4");
    assert.equal(videoCard.attributes.get("data-attachment-kind"), "video");
    assert.ok(videoCard.findByClass("codex-file-card-icon"));
    assert.equal(videoCard.findByClass("codex-file-card-name")?.textContent, "meeting.mp4");
    assert.equal(videoCard.findByClass("codex-file-card-meta")?.textContent, "大小未知");
    const videoOpen = videoCard.findByClass("codex-file-card-open")!;
    assert.equal(videoOpen.attributes.get("aria-label"), "打开附件：meeting.mp4");
    clickElement(videoOpen);
    assert.deepEqual(electronOpenedPaths, ["/test-vault/videos/meeting.mp4"]);
    assert.deepEqual(
      electronShownPaths,
      [],
      "sent FileCard opens with the system default app instead of revealing in Finder"
    );
    const unavailableImages = imageAttachments.findAllByClass("codex-message-attachment-unavailable");
    assert.equal(unavailableImages.length, 1, "duplicate or missing images render one unavailable state");
    assert.equal(unavailableImages[0]?.attributes.get("role"), "status");
    assert.equal(
      unavailableImages[0]?.attributes.get("aria-label"),
      "粘贴图片 2.png：图片附件不可在本地打开"
    );
    assert.doesNotMatch(renderedText(imageAttachments), /clipboard-/u);

    const englishAttachmentRenderer = new CodexMessageListRenderer();
    bindRenderer(englishAttachmentRenderer, context, "en");
    const englishImageAttachment = renderMessage(englishAttachmentRenderer, {
      id: "user-image-english",
      role: "user",
      text: "用户输入保持原样",
      attachments: [{
        type: "image",
        name: "clipboard-1720000000000-0.png",
        path: "images/missing.png",
        mimeType: "image/png",
        availability: "unavailable"
      }],
      createdAt: 1_700_000_000_550
    }, { showAgentFooter: false, showAgentHeader: false });
    assert.match(renderedText(englishImageAttachment), /用户输入保持原样/u);
    assert.equal(
      englishImageAttachment
        .findByClass("codex-message-attachment-unavailable")
        ?.attributes.get("aria-label"),
      "Pasted image 1.png: Image attachment cannot be opened locally"
    );

    const failedImageRenderer = new CodexMessageListRenderer();
    bindRenderer(failedImageRenderer, context);
    let failedImageMeasureSchedules = 0;
    (failedImageRenderer as unknown as {
      env: { onScheduleMeasure: () => void };
    }).env.onScheduleMeasure = () => { failedImageMeasureSchedules += 1; };
    const failedImageMessage: ChatMessage = {
      id: "user-image-load-failure",
      role: "user",
      text: "失败图片",
      attachments: [{
        type: "image",
        name: "cover #1.png",
        path: "images/cover #1.png",
        mimeType: "image/png",
        availability: "available"
      }],
      createdAt: 1_700_000_000_600
    };
    const firstFailedImage = renderMessage(failedImageRenderer, failedImageMessage, {
      showAgentFooter: false,
      showAgentHeader: false
    });
    const failedResourceImage = firstFailedImage.findAllByTag("img")[0]!;
    failedResourceImage.onerror?.();
    assert.equal(
      firstFailedImage.findAllByClass("codex-message-attachment-unavailable").length,
      1,
      "a failed image load settles into one fixed-size unavailable tile"
    );
    const repeatedFailedImage = renderMessage(failedImageRenderer, failedImageMessage, {
      showAgentFooter: false,
      showAgentHeader: false
    });
    assert.equal(repeatedFailedImage.findAllByTag("img").length, 0,
      "the same failed resource is not reloaded on the next full message render");
    assert.equal(
      repeatedFailedImage.findAllByClass("codex-message-attachment-unavailable").length,
      1
    );
    assert.equal(failedImageMeasureSchedules, 0,
      "fixed-size image failure replacement does not request an unmeasurable table rebuild");

    const measuredRowsRenderer = new CodexMessageListRenderer();
    bindRenderer(measuredRowsRenderer, context);
    const measuredMessages = new FakeElement("div");
    measuredMessages.scrollHeight = 900;
    measuredMessages.scrollTop = 120;
    const measuredVirtualList = new FakeElement("div");
    const measuredRow = measuredVirtualList.createDiv({ cls: "codex-virtual-row" });
    measuredRow.dataset.rowId = "message:stable-image";
    measuredRow.boundingHeight = 120;
    assert.equal(measuredRowsRenderer.measureVisibleVirtualRows(
      measuredMessages as unknown as HTMLElement,
      measuredVirtualList as unknown as HTMLElement,
      false,
      { rerender: false }
    ), true);
    measuredMessages.scrollTop = 120;
    assert.equal(measuredRowsRenderer.measureVisibleVirtualRows(
      measuredMessages as unknown as HTMLElement,
      measuredVirtualList as unknown as HTMLElement,
      true,
      { rerender: false }
    ), false);
    assert.equal(measuredMessages.scrollTop, 120,
      "an unchanged ResizeObserver measurement neither rewrites scrollTop nor starts another render");

    const terminalRenderer = new CodexMessageListRenderer();
    bindRenderer(terminalRenderer, context);
    let terminalProgressSchedules = 0;
    (terminalRenderer as unknown as {
      env: { onScheduleRunProgress: () => void };
    }).env.onScheduleRunProgress = () => { terminalProgressSchedules += 1; };
    const terminalProjection = buildAgentTurnProjection([{
      id: "terminal-error-only",
      role: "system",
      itemType: "error",
      title: "回答失败",
      text: "Provider 返回了明确错误",
      status: "failed",
      runId: "terminal-error-run",
      turnId: "terminal-error-run",
      createdAt: 1_700_000_000_700,
      completedAt: 1_700_000_000_700
    }]);
    const terminalTurn = terminalProjection[0]?.kind === "assistantTurn"
      ? terminalProjection[0].turn
      : null;
    assert.ok(terminalTurn);
    const terminalSurface = new FakeElement("div");
    (terminalRenderer as unknown as {
      renderAssistantTurn(
        container: unknown,
        turn: NonNullable<typeof terminalTurn>,
        showAgentHeader: boolean
      ): void;
    }).renderAssistantTurn(terminalSurface, terminalTurn!, false);
    assert.equal(terminalProgressSchedules, 0,
      "a failed terminal Turn never schedules the 700ms progress repaint");
    assert.equal(terminalSurface.findAllByClass("codex-smooth-ai-loader").length, 0);
    assert.equal(terminalSurface.findAllByClass("codex-message-type-error").length, 1);
    assert.match(renderedText(terminalSurface), /Provider 返回了明确错误/u,
      "the terminal diagnostic remains visible instead of being replaced by a loader");

    const processFailureProjection = buildAgentTurnProjection([{
      id: "terminal-process-reasoning",
      role: "assistant",
      itemType: "reasoning",
      text: "已完成失败前的推理",
      status: "completed",
      runId: "terminal-process-run",
      turnId: "terminal-process-run",
      createdAt: 1_700_000_000_800,
      completedAt: 1_700_000_000_850
    }, {
      id: "terminal-process-error",
      role: "system",
      itemType: "error",
      title: "回答失败",
      text: "工具执行后 Provider 失败",
      status: "failed",
      runId: "terminal-process-run",
      turnId: "terminal-process-run",
      createdAt: 1_700_000_000_900,
      completedAt: 1_700_000_000_900
    }]);
    const processFailureTurn = processFailureProjection[0]?.kind === "assistantTurn"
      ? processFailureProjection[0].turn
      : null;
    assert.ok(processFailureTurn?.processNodes.length);
    const processFailureSurface = new FakeElement("div");
    (terminalRenderer as unknown as {
      renderAssistantTurn(
        container: unknown,
        turn: NonNullable<typeof processFailureTurn>,
        showAgentHeader: boolean
      ): void;
    }).renderAssistantTurn(processFailureSurface, processFailureTurn!, false);
    assert.equal(processFailureSurface.findAllByClass("codex-assistant-turn-process").length, 1);
    assert.equal(processFailureSurface.findAllByClass("codex-message-type-error").length, 1);
    assert.match(renderedText(processFailureSurface), /工具执行后 Provider 失败/u,
      "a terminal diagnostic remains visible after existing process nodes");

    const emptyAnswerFailureProjection = buildAgentTurnProjection([{
      id: "terminal-empty-answer",
      role: "assistant",
      text: "",
      status: "completed",
      runId: "terminal-empty-answer-run",
      turnId: "terminal-empty-answer-run",
      createdAt: 1_700_000_001_000,
      completedAt: 1_700_000_001_000
    }, {
      id: "terminal-empty-answer-error",
      role: "system",
      itemType: "error",
      title: "回答失败",
      text: "空回答之后的明确错误",
      status: "failed",
      runId: "terminal-empty-answer-run",
      turnId: "terminal-empty-answer-run",
      createdAt: 1_700_000_001_050,
      completedAt: 1_700_000_001_050
    }]);
    const emptyAnswerFailureTurn = emptyAnswerFailureProjection[0]?.kind === "assistantTurn"
      ? emptyAnswerFailureProjection[0].turn
      : null;
    assert.equal(emptyAnswerFailureTurn?.finalAnswer?.id, "terminal-empty-answer");
    const emptyAnswerFailureSurface = new FakeElement("div");
    (terminalRenderer as unknown as {
      renderAssistantTurn(
        container: unknown,
        turn: NonNullable<typeof emptyAnswerFailureTurn>,
        showAgentHeader: boolean
      ): void;
    }).renderAssistantTurn(emptyAnswerFailureSurface, emptyAnswerFailureTurn!, false);
    assert.equal(emptyAnswerFailureSurface.findAllByClass("codex-assistant-turn-final").length, 0);
    assert.equal(emptyAnswerFailureSurface.findAllByClass("codex-message-type-error").length, 1);
    assert.match(renderedText(emptyAnswerFailureSurface), /空回答之后的明确错误/u,
      "an empty finalAnswer cannot suppress the terminal diagnostic");
    assert.equal(terminalProgressSchedules, 0,
      "terminal diagnostics with process or empty-answer history never restart progress polling");

    const partialFailureProjection = buildAgentTurnProjection([{
      id: "terminal-partial-answer",
      role: "assistant",
      text: "失败前保留的公开回答 partial",
      details: "网络连接中断，回答未完成。",
      status: "failed",
      runId: "terminal-partial-answer-run",
      turnId: "terminal-partial-answer-run",
      createdAt: 1_700_000_001_075,
      completedAt: 1_700_000_001_080
    }]);
    const partialFailureTurn = partialFailureProjection[0]?.kind === "assistantTurn"
      ? partialFailureProjection[0].turn
      : null;
    assert.ok(partialFailureTurn?.finalAnswer);
    const partialFailureSurface = new FakeElement("div");
    (terminalRenderer as unknown as {
      renderAssistantTurn(
        container: unknown,
        turn: NonNullable<typeof partialFailureTurn>,
        showAgentHeader: boolean
      ): void;
    }).renderAssistantTurn(partialFailureSurface, partialFailureTurn!, false);
    assert.match(
      renderedText(partialFailureSurface),
      /失败前保留的公开回答 partial/u
    );
    assert.match(
      renderedText(partialFailureSurface),
      /网络连接中断，回答未完成/u
    );
    assert.equal(
      partialFailureSurface
        .findAllByClass("codex-assistant-turn-failure-reason").length,
      1,
      "a durable partial answer renders one separate concise failure reason"
    );

    await assertInteractionDockContracts();

    const zhConversationCopy = conversationCopy("zh-CN");
    assert.equal(zhConversationCopy.process.publicReasoningRunning, "思考中");
    assert.equal(zhConversationCopy.process.publicReasoningCompleted, "思考完成");
    assert.equal(zhConversationCopy.process.publicReasoningDuration("12s"), "思考了 12 秒");
    assert.equal(zhConversationCopy.process.providerReasoningRunning, "思考中");
    assert.equal(zhConversationCopy.process.providerReasoningEnded, "思考完成");
    assert.equal(zhConversationCopy.process.providerReasoningDuration("1m 02s"), "思考了 1 分 2 秒");
    assert.equal(zhConversationCopy.message.thinking, "思考中");

    const expectedWaitingCopies: Readonly<Record<string, readonly string[]>> = {
      executor: ["正在直奔问题核心", "正在快速收拢结论", "正在风风火火推进", "正在整理行动要点"],
      advisor: ["正在核对关键前提", "正在逐项梳理依据", "正在检查逻辑细节", "正在推敲稳妥结论"],
      butler: ["正在按序整理回复", "正在仔细核对细节", "正在沉稳组织答案", "正在为你梳理要点"],
      companion: ["正在顺着你的问题想", "正在和你一起梳理", "正在细心理清思路", "正在把答案理得更顺"],
      steward: ["正在统筹回复结构", "正在把复杂问题理清", "正在核对有没有遗漏", "正在将要点一一归位"],
      enthusiast: ["正在让思路跑起来", "正在带着劲头推进", "正在试试不同办法", "正在把想法串起来"],
      creative: ["正在展开更多可能", "正在换几个角度想", "正在把灵感串起来", "正在收拢创意回答"],
      pragmatist: ["正在筛选可行方案", "正在去掉多余废话", "正在把话说清楚", "正在核对落地细节"]
    };
    for (const [templateId, expected] of Object.entries(expectedWaitingCopies)) {
      assert.deepEqual(
        zhConversationCopy.message.generatingReplyCopies(templateId),
        expected,
        `${templateId} uses its own waiting copy set`
      );
    }
    const expectedFallbackWaitingCopies = [
      "正在理解你的问题",
      "正在整理关键信息",
      "正在组织回复",
      "正在检查答案"
    ];
    assert.deepEqual(
      zhConversationCopy.message.generatingReplyCopies(null),
      expectedFallbackWaitingCopies
    );
    assert.deepEqual(
      zhConversationCopy.message.generatingReplyCopies("unknown-template"),
      expectedFallbackWaitingCopies
    );

    const rendererEnv = (renderer as unknown as {
      env: {
        agentIdentity?: { displayName: string; avatarUrl: string | null; personalityTemplateId?: string | null };
        onScheduleRunProgress: () => void;
      };
    }).env;
    rendererEnv.agentIdentity = {
      displayName: "EchoInk",
      avatarUrl: null,
      personalityTemplateId: "executor"
    };
    let waitingProgressSchedules = 0;
    rendererEnv.onScheduleRunProgress = () => { waitingProgressSchedules += 1; };
    const waitingCreatedAt = 1_700_000_001_100;
    const emptyRunningMessage: ChatMessage = {
      id: "answer-running-empty",
      role: "assistant",
      text: "",
      status: "running",
      createdAt: waitingCreatedAt
    };
    Date.now = () => waitingCreatedAt;
    const emptyRunningAnswer = renderMessage(
      renderer,
      emptyRunningMessage,
      { showAgentFooter: false, showAgentHeader: false }
    );
    assert.ok(emptyRunningAnswer.findByClass("codex-smooth-ai-loader"));
    const waitingLoader = emptyRunningAnswer.findByClass("codex-smooth-ai-loader")!;
    const waitingLabel = waitingLoader.findByClass("codex-smooth-ai-loader-label")!;
    assert.equal(waitingLoader.attributes.get("aria-label"), "正在生成回复");
    assert.equal(waitingLoader.attributes.get("role"), "status");
    assert.equal(waitingLabel.attributes.get("aria-hidden"), "true");
    assert.equal(waitingLabel.attributes.get("data-ai-elements-pattern"), "shimmer");
    assert.ok(waitingLabel.hasClass("codex-ai-elements-shimmer"));
    assert.equal(waitingLabel.textContent, "正在直奔问题核心");
    assert.equal(waitingProgressSchedules, 1);
    const waitingContent = emptyRunningAnswer.findByClass("codex-ai-elements-message-content")!;
    const emptyCallsBeforeRotation = waitingContent.emptyCallCount;
    Date.now = () => waitingCreatedAt + 1_800;
    (renderer as unknown as {
      renderAgentAnswerContent(container: HTMLElement, message: ChatMessage): void;
    }).renderAgentAnswerContent(waitingContent as unknown as HTMLElement, emptyRunningMessage);
    assert.equal(
      waitingContent.findByClass("codex-smooth-ai-loader"),
      waitingLoader,
      "copy rotation keeps one stable status node for assistive technology"
    );
    assert.equal(waitingContent.emptyCallCount, emptyCallsBeforeRotation);
    assert.equal(waitingLabel.textContent, "正在快速收拢结论");
    assert.equal(waitingLoader.attributes.get("aria-label"), "正在生成回复");
    assert.equal(waitingProgressSchedules, 2);
    Date.now = originalDateNow;
    assert.equal(emptyRunningAnswer.findAllByClass("codex-ai-elements-response").length, 0,
      "empty running answer stays a truthful loader before the first delta");

    const streamingAnswer = renderMessage(renderer, {
      id: "answer-running-text",
      role: "assistant",
      text: "第一段回复",
      status: "running",
      createdAt: 1_700_000_001_200
    }, { showAgentFooter: false, showAgentHeader: false });
    assert.equal(
      streamingAnswer.findByClass("codex-ai-elements-response")?.attributes.get("data-streaming"),
      "true"
    );
    assert.equal(streamingAnswer.findAllByClass("codex-smooth-ai-loader").length, 0,
      "first text delta replaces the answer loader rather than coexisting with it");
    assert.equal(waitingProgressSchedules, 2,
      "the first non-empty answer delta stops waiting-copy scheduling");

    const completedEmptyAnswer = renderMessage(renderer, {
      ...emptyRunningMessage,
      id: "answer-completed-empty",
      status: "completed"
    }, { showAgentFooter: false, showAgentHeader: false });
    assert.equal(completedEmptyAnswer.findAllByClass("codex-smooth-ai-loader").length, 0);
    assert.equal(waitingProgressSchedules, 2,
      "terminal empty answers never restart waiting-copy scheduling");

    const englishWaitingRenderer = new CodexMessageListRenderer();
    bindRenderer(englishWaitingRenderer, context, "en");
    const englishRendererEnv = (englishWaitingRenderer as unknown as {
      env: { agentIdentity?: { displayName: string; avatarUrl: string | null; personalityTemplateId?: string | null } };
    }).env;
    englishRendererEnv.agentIdentity = {
      displayName: "EchoInk",
      avatarUrl: null,
      personalityTemplateId: "executor"
    };
    const englishWaitingCreatedAt = 1_700_000_001_150;
    Date.now = () => englishWaitingCreatedAt;
    const englishWaitingAnswer = renderMessage(englishWaitingRenderer, {
      id: "answer-running-empty-en",
      role: "assistant",
      text: "",
      status: "running",
      createdAt: englishWaitingCreatedAt
    }, { showAgentFooter: false, showAgentHeader: false });
    assert.equal(
      englishWaitingAnswer
        .findByClass("codex-smooth-ai-loader")
        ?.attributes.get("aria-label"),
      "Generating reply"
    );
    assert.equal(
      englishWaitingAnswer
        .findByClass("codex-smooth-ai-loader-label")
        ?.textContent,
      "Going straight to the point"
    );
    Date.now = originalDateNow;
    rendererEnv.onScheduleRunProgress = () => undefined;

    const reasoningMessage = renderMessage(renderer, {
      id: "reasoning-1",
      role: "assistant",
      itemType: "reasoning",
      text: "正在检查上下文",
      status: "running",
      createdAt: 1_700_000_002_000
    }, { showAgentFooter: false, showAgentHeader: false });
    const reasoningRoot = reasoningMessage.findByClass("codex-ai-elements-reasoning");
    assert.ok(reasoningRoot);
    assert.equal(reasoningRoot!.tag, "details");
    assert.equal(reasoningRoot!.open, true);

    const structuredRunning: ChatMessage = {
      id: "pi:session:reasoning:run-structured",
      role: "assistant",
      itemType: "reasoning",
      title: "思考中",
      text: "",
      status: "running",
      reasoningSummary: {
        schemaVersion: 1,
        conversationId: "conversation-structured",
        piSessionId: "session-structured",
        productRunId: "run-structured",
        status: "running",
        startedAt: 10_000,
        updatedAt: 10_000,
        activities: []
      },
      runId: "run-structured",
      turnId: "run-structured",
      createdAt: 10_000
    };
    const runningReasoning = renderMessage(
      renderer,
      structuredRunning,
      { showAgentFooter: false, showAgentHeader: false }
    );
    const runningReasoningRoot = runningReasoning.findByClass(
      "codex-ai-elements-reasoning"
    );
    assert.equal(runningReasoningRoot?.open, true);
    assert.equal(
      runningReasoning.findByClass("codex-ai-elements-reasoning-label")?.textContent,
      "思考中"
    );
    assert.equal(
      renderedText(runningReasoning).match(/思考中/gu)?.length,
      1,
      "empty structured activity renders exactly one truthful summary label"
    );
    assert.equal(
      renderedText(runningReasoning.findByClass("codex-ai-elements-reasoning-content")!),
      "",
      "empty Reasoning has no duplicate body fallback"
    );

    const conversationMessages = new FakeElement("div");
    const conversationVirtualList = new FakeElement("div");
    const sameRunEmptyAnswer: ChatMessage = {
      id: "answer-same-running-empty",
      role: "assistant",
      text: "",
      status: "running",
      runId: "run-structured",
      turnId: "run-structured",
      createdAt: 10_100
    };
    const otherRunEmptyAnswer: ChatMessage = {
      ...sameRunEmptyAnswer,
      id: "answer-other-running-empty",
      runId: "run-without-reasoning",
      turnId: "run-without-reasoning",
      createdAt: 10_200
    };
    const suppressionRenderer = new CodexMessageListRenderer();
    suppressionRenderer.render({
      app: context.app as never,
      component: context.component as never,
      messagesEl: conversationMessages as unknown as HTMLElement,
      virtualListEl: conversationVirtualList as unknown as HTMLElement,
      sessionId: "reasoning-loader-suppression",
      welcomeCopy: { title: "EchoInk", subtitle: "从一个问题开始" },
      settingsLanguage: "zh",
      messages: [structuredRunning, sameRunEmptyAnswer, otherRunEmptyAnswer],
      vaultPath: "/test-vault",
      readRawMessageText: async () => "",
      onScheduleMeasure: () => undefined,
      onScheduleRunProgress: () => undefined
    });
    const runningTurnKeys = conversationVirtualList
      .findAllByClass("codex-message-type-assistantTurn")
      .map((message) => message.dataset.turnKey);
    assert.deepEqual(runningTurnKeys, ["run:run-structured", "run:run-without-reasoning"],
      "same-run Process and empty Answer share one Assistant Turn while another run remains isolated");
    assert.equal(
      conversationVirtualList.findAllByClass("codex-message-type-assistantTurn").length,
      2
    );
    assert.equal(
      conversationVirtualList.findAllByClass("codex-assistant-turn-node-title")
        .filter((title) => title.textContent === "思考中").length,
      1,
      "legacy reasoningSummary creates one Process node, not fake Provider Reasoning"
    );
    assert.equal(
      conversationVirtualList.findAllByClass("codex-assistant-turn-summary-copy").length,
      0,
      "ChainOfThought does not add a second process title or summary disclosure"
    );
    assert.equal(
      conversationVirtualList.findAllByClass("codex-ai-elements-reasoning").length,
      0
    );
    assert.equal(conversationVirtualList.findAllByClass("codex-smooth-ai-loader").length, 2,
      "each active Assistant Turn owns at most one generating-answer Loader");
    assert.ok(
      conversationVirtualList
        .findAllByClass("codex-smooth-ai-loader")
        .every((loader) => loader.attributes.get("aria-label") === "正在生成回复"),
      "each visual personality copy keeps one stable accessible loading label"
    );
    suppressionRenderer.render({
      app: context.app as never,
      component: context.component as never,
      messagesEl: conversationMessages as unknown as HTMLElement,
      virtualListEl: conversationVirtualList as unknown as HTMLElement,
      sessionId: "reasoning-loader-suppression",
      welcomeCopy: { title: "EchoInk", subtitle: "从一个问题开始" },
      settingsLanguage: "zh",
      messages: [
        structuredRunning,
        { ...sameRunEmptyAnswer, text: "首段公开回答" }
      ],
      vaultPath: "/test-vault",
      readRawMessageText: async () => "",
      onScheduleMeasure: () => undefined,
      onScheduleRunProgress: () => undefined
    });
    assert.equal(
      conversationVirtualList.findAllByClass("codex-message-type-assistantTurn").length,
      1,
      "the first public Answer delta updates the same Assistant Turn"
    );
    assert.equal(
      conversationVirtualList.findByClass("codex-assistant-turn-final")?.dataset.messageId,
      sameRunEmptyAnswer.id,
      "the final Answer section retains the original message identity"
    );
    assert.ok(conversationVirtualList.findByClass("codex-ai-elements-response"));
    assert.equal(conversationVirtualList.findAllByClass("codex-smooth-ai-loader").length, 0);

    const structuredAnswered: ChatMessage = {
      ...structuredRunning,
      title: "思考完成 · 2 秒",
      text: "请求模型完成",
      status: "completed",
      reasoningSummary: {
        ...structuredRunning.reasoningSummary!,
        status: "completed",
        firstAssistantTextAt: 12_000,
        updatedAt: 12_000,
        activities: [{
          id: "provider",
          kind: "provider",
          status: "completed",
          stage: "requesting",
          startedAt: 10_100,
          updatedAt: 12_000
        }]
      }
    };
    const answeredReasoning = renderMessage(
      renderer,
      structuredAnswered,
      { showAgentFooter: false, showAgentHeader: false }
    );
    const answeredReasoningRoot = answeredReasoning.findByClass(
      "codex-ai-elements-reasoning"
    );
    assert.equal(answeredReasoningRoot?.open, false,
      "the first real answer transition auto-folds once");
    assert.equal(
      answeredReasoning.findByClass("codex-ai-elements-reasoning-label")?.textContent,
      "思考完成 · 2 秒"
    );
    answeredReasoningRoot!.open = true;
    answeredReasoningRoot!.ontoggle?.({ isTrusted: true });
    assert.equal(
      answeredReasoning.findByClass("codex-ai-elements-reasoning-trigger")
        ?.attributes.get("aria-expanded"),
      "true",
      "a trusted programmatic toggle still synchronizes accessibility state"
    );
    const afterProgrammaticOpen = renderMessage(
      renderer,
      structuredAnswered,
      { showAgentFooter: false, showAgentHeader: false }
    );
    const afterProgrammaticRoot = afterProgrammaticOpen.findByClass(
      "codex-ai-elements-reasoning"
    )!;
    assert.equal(afterProgrammaticRoot.open, false,
      "a trusted programmatic toggle without summary activation never becomes manual");
    const afterProgrammaticSummary = afterProgrammaticOpen.findByClass(
      "codex-ai-elements-reasoning-trigger"
    )!;
    afterProgrammaticSummary.onclick?.({
      isTrusted: true,
      preventDefault: () => undefined,
      stopPropagation: () => undefined
    });
    afterProgrammaticRoot.open = true;
    afterProgrammaticRoot.ontoggle?.({ isTrusted: true });

    const structuredFailed: ChatMessage = {
      ...structuredAnswered,
      title: "处理失败 · 4 秒",
      status: "failed",
      completedAt: 14_000,
      reasoningSummary: {
        ...structuredAnswered.reasoningSummary!,
        status: "failed",
        terminalAt: 14_000,
        updatedAt: 14_000
      }
    };
    const failedAfterManualOpen = renderMessage(
      renderer,
      structuredFailed,
      { showAgentFooter: false, showAgentHeader: false }
    );
    assert.equal(
      failedAfterManualOpen.findByClass("codex-ai-elements-reasoning")?.open,
      true,
      "manual disclosure permanently wins over later live and terminal updates"
    );

    const collapsedRun: ChatMessage = {
      ...structuredRunning,
      id: "pi:session:reasoning:run-collapsed",
      runId: "run-collapsed",
      turnId: "run-collapsed",
      reasoningSummary: {
        ...structuredRunning.reasoningSummary!,
        productRunId: "run-collapsed"
      }
    };
    const collapsedRunning = renderMessage(
      renderer,
      collapsedRun,
      { showAgentFooter: false, showAgentHeader: false }
    );
    const collapsedRoot = collapsedRunning.findByClass("codex-ai-elements-reasoning")!;
    collapsedRunning.findByClass("codex-ai-elements-reasoning-trigger")
      ?.onkeydown?.({
        isTrusted: true,
        key: "Enter",
        code: "Enter",
        preventDefault: () => undefined,
        stopPropagation: () => undefined
      });
    collapsedRoot.open = false;
    collapsedRoot.ontoggle?.({ isTrusted: true });
    const collapsedAnswered = renderMessage(
      renderer,
      {
        ...structuredAnswered,
        id: collapsedRun.id,
        runId: "run-collapsed",
        turnId: "run-collapsed",
        reasoningSummary: {
          ...structuredAnswered.reasoningSummary!,
          productRunId: "run-collapsed"
        }
      },
      { showAgentFooter: false, showAgentHeader: false }
    );
    assert.equal(
      collapsedAnswered.findByClass("codex-ai-elements-reasoning")?.open,
      false,
      "trusted Enter collapse before first text is never stolen"
    );

    const spaceRun: ChatMessage = {
      ...collapsedRun,
      id: "pi:session:reasoning:run-space",
      runId: "run-space",
      turnId: "run-space",
      reasoningSummary: {
        ...collapsedRun.reasoningSummary!,
        productRunId: "run-space"
      }
    };
    const spaceRunning = renderMessage(
      renderer,
      spaceRun,
      { showAgentFooter: false, showAgentHeader: false }
    );
    const spaceRoot = spaceRunning.findByClass("codex-ai-elements-reasoning")!;
    const spaceSummary = spaceRunning.findByClass(
      "codex-ai-elements-reasoning-trigger"
    )!;
    spaceSummary.onkeydown?.({
      isTrusted: true,
      key: " ",
      code: "Space",
      preventDefault: () => undefined,
      stopPropagation: () => undefined
    });
    spaceSummary.onclick?.({
      isTrusted: true,
      preventDefault: () => undefined,
      stopPropagation: () => undefined
    });
    spaceRoot.open = false;
    spaceRoot.ontoggle?.({ isTrusted: true });
    const spaceAnswered = renderMessage(
      renderer,
      {
        ...structuredAnswered,
        id: spaceRun.id,
        runId: "run-space",
        turnId: "run-space",
        reasoningSummary: {
          ...structuredAnswered.reasoningSummary!,
          productRunId: "run-space"
        }
      },
      { showAgentFooter: false, showAgentHeader: false }
    );
    assert.equal(
      spaceAnswered.findByClass("codex-ai-elements-reasoning")?.open,
      false,
      "trusted Space activation is consumed once even when it also emits click"
    );

    (renderer as unknown as { env: { sessionId: string } }).env.sessionId =
      "smooth-ui-other-session";
    const otherSessionRunning = renderMessage(
      renderer,
      collapsedRun,
      { showAgentFooter: false, showAgentHeader: false }
    );
    assert.equal(
      otherSessionRunning.findByClass("codex-ai-elements-reasoning")?.open,
      true,
      "another session cannot inherit disclosure state for the same productRunId"
    );
    (renderer as unknown as { env: { sessionId: string } }).env.sessionId =
      "smooth-ui-test";

    const restoredTerminalCases = [
      { status: "completed", title: "思考完成 · 4 秒" },
      { status: "failed", title: "处理失败 · 4 秒" },
      { status: "interrupted", title: "思考中断 · 4 秒" },
      { status: "cancelled", title: "思考已取消 · 4 秒" }
    ] as const;
    for (const terminalCase of restoredTerminalCases) {
      const restoredRenderer = new CodexMessageListRenderer();
      bindRenderer(restoredRenderer, context);
      const restoredTerminal = renderMessage(
        restoredRenderer,
        {
          ...structuredFailed,
          id: `reasoning-restored-${terminalCase.status}`,
          title: terminalCase.title,
          status: terminalCase.status,
          reasoningSummary: {
            ...structuredFailed.reasoningSummary!,
            productRunId: `run-restored-${terminalCase.status}`,
            status: terminalCase.status
          }
        },
        { showAgentFooter: false, showAgentHeader: false }
      );
      assert.equal(
        restoredTerminal.findByClass("codex-ai-elements-reasoning")?.open,
        false,
        `restored ${terminalCase.status} Reasoning starts folded`
      );
      assert.equal(
        restoredTerminal.findByClass("codex-ai-elements-reasoning-label")?.textContent,
        terminalCase.title
      );
    }

    const siblingCanaries = {
      prompt: "PROMPT_DOM_PRIVATE_CANARY",
      answer: "ANSWER_DOM_PRIVATE_CANARY",
      toolArgument: "TOOL_ARGUMENT_DOM_PRIVATE_CANARY",
      toolResult: "TOOL_RESULT_DOM_PRIVATE_CANARY",
      sourceData: "SOURCE_DATA_DOM_PRIVATE_CANARY",
      diffContent: "DIFF_CONTENT_DOM_PRIVATE_CANARY",
      approvalPayload: "APPROVAL_PAYLOAD_DOM_PRIVATE_CANARY",
      publicReasoning: "PUBLIC_PROVIDER_REASONING_DOM_CANARY",
      publicReasoningAfterTool: "PUBLIC_PROVIDER_REASONING_AFTER_TOOL_DOM_CANARY",
      privateReasoning: "PRIVATE_REASONING_DOM_CANARY"
    } as const;
    const isolatedInternalReasoning = [
      "revision 29",
      "recordId",
      "targetId",
      "call_abcd",
      "kind=goal"
    ].join(" ");
    const ordinaryTechnicalReasoning = "检查 Git revision 29、recordId、targetId、call_abcd 和 kind=task 的代码语义";
    assert.equal(
      userVisibleProviderReasoningText(ordinaryTechnicalReasoning),
      ordinaryTechnicalReasoning,
      "Memory display copy does not rewrite similarly formatted fields in ordinary technical reasoning"
    );
    const internalMemoryReasoning = [
      "原记录 mem_8a45",
      "新记录 mem_0123456789abcdef0123456789abcdef",
      "call_0123456789abcdef0123456789abcdef",
      "memory_search",
      "memory_read",
      "memory_write",
      "outcome=profile_updated",
      "revision 28",
      "targetId",
      "profileKey",
      "schema=echoink.memory.v1",
      "shared-user/memory/active/mem_0123456789abcdef0123456789abcdef.md",
      "pi://conversation/session/entry",
      "kind=open_loop",
      "Repository Harness ProductRun view task goal"
    ].join(" ");
    const reasoningSibling = {
      ...structuredRunning,
      id: "reasoning-separated",
      title: "正在思考",
      text: "请求模型",
      status: "completed",
      details: siblingCanaries.privateReasoning,
      runId: "run-separated",
      turnId: "run-separated",
      reasoningSummary: {
        ...structuredRunning.reasoningSummary!,
        productRunId: "run-separated",
        status: "completed",
        updatedAt: 4,
        activities: [{
          id: "provider",
          kind: "provider",
          status: "completed",
          stage: "requesting",
          startedAt: 2,
          updatedAt: 4
        }]
      },
      assistantTurn: {
        viewVersion: 1,
        turnId: "run-separated",
        status: "completed",
        startedAt: 2,
        updatedAt: 10,
        completedAt: 10,
        processNodes: [],
        providerReasoningSegments: [{
          reasoningId: "provider-reasoning-separated-before-tool",
          source: "provider_public",
          status: "completed",
          text: `${siblingCanaries.publicReasoning} ${isolatedInternalReasoning}`,
          startedAt: 2,
          updatedAt: 4,
          completedAt: 4,
          durationMs: 2_000
        }, {
          reasoningId: "provider-reasoning-separated-after-tool",
          source: "provider_public",
          status: "completed",
          text: `${siblingCanaries.publicReasoningAfterTool} ${internalMemoryReasoning}`,
          startedAt: 8,
          updatedAt: 9,
          completedAt: 9,
          durationMs: 1_000
        }],
        interactionRecords: [{
          interactionId: "approval-separated",
          kind: "confirmation",
          outcome: "approved",
          summary: "已批准一次性写入",
          updatedAt: 7
        }],
        finalAnswerMessageId: "answer-separated",
        summary: {
          completedSteps: 7,
          toolCount: 2,
          durationMs: 8_000
        }
      }
    } as ChatMessage;
    const siblingMessages: ChatMessage[] = [
      {
        id: "reasoning-user-row",
        role: "user",
        text: `问题 ${siblingCanaries.prompt}`,
        runId: "run-separated",
        turnId: "run-separated",
        createdAt: 1
      },
      reasoningSibling,
      {
        id: "tool-separated",
        role: "tool",
        itemType: "dynamicToolCall",
        title: "使用工具：vault_search",
        text: siblingCanaries.toolResult,
        processInput: siblingCanaries.toolArgument,
        processOutput: siblingCanaries.toolResult,
        processInputAvailability: "provided",
        processOutputAvailability: "provided",
        status: "completed",
        runId: "run-separated",
        turnId: "run-separated",
        createdAt: 3
      },
      {
        id: "task-separated",
        role: "assistant",
        itemType: "taskPlan",
        text: "",
        taskPlan: {
          schemaVersion: 1,
          planId: "plan-separated",
          title: "独立任务",
          status: "in_progress",
          version: 1,
          steps: [{ stepId: "step-separated", text: "继续处理", status: "in_progress" }],
          currentStepId: "step-separated",
          source: "agent",
          productRunId: "run-separated",
          createdAt: 4,
          updatedAt: 4
        },
        runId: "run-separated",
        turnId: "run-separated",
        createdAt: 4
      },
      {
        id: "sources-separated",
        role: "assistant",
        text: "基于本地资料",
        citations: {
          status: "strong",
          counts: { wiki: 1, journal: 0, outputs: 0 },
          citations: [{
            bucket: "wiki",
            title: "Alpha",
            path: "projects/Alpha.md",
            excerptLines: [siblingCanaries.sourceData],
            relevance: "strong",
            reason: "matched",
            score: 1
          }]
        },
        askSourceAttribution: true,
        runId: "run-separated",
        turnId: "run-separated",
        createdAt: 5
      },
      {
        id: "diff-separated",
        role: "tool",
        itemType: "fileChange",
        title: "文件改动",
        text: `@@ -1 +1 @@\n-old\n+${siblingCanaries.diffContent}`,
        status: "completed",
        diffSummary: {
          totalFiles: 1,
          added: 1,
          removed: 1,
          files: [{ path: "projects/Alpha.md", kind: "update", added: 1, removed: 1 }]
        },
        runId: "run-separated",
        turnId: "run-separated",
        createdAt: 6
      },
      {
        id: "approval-separated",
        role: "assistant",
        itemType: "interactionRecord",
        title: "用户已批准",
        text: "",
        details: "已批准一次性写入",
        status: "completed",
        interactionRecord: {
          interactionId: "approval-separated",
          kind: "confirmation",
          outcome: "approved",
          summary: "已批准一次性写入",
          updatedAt: 7
        },
        runId: "run-separated",
        turnId: "run-separated",
        createdAt: 7
      },
      {
        id: "loader-separated",
        role: "assistant",
        text: "",
        status: "running",
        runId: "run-separated",
        turnId: "run-separated",
        createdAt: 8
      },
      {
        id: "answer-separated",
        role: "assistant",
        text: `最终回答 ${siblingCanaries.answer}`,
        status: "completed",
        runId: "run-separated",
        turnId: "run-separated",
        createdAt: 9,
        completedAt: 10
      }
    ];
    const sourceSibling = siblingMessages.find((message) => message.id === "sources-separated") as
      | (ChatMessage & { knowledgeProducedPaths?: string[] })
      | undefined;
    assert.ok(sourceSibling);
    sourceSibling!.knowledgeProducedPaths = ["outputs/Generated.md"];
    const separatedProjection = buildAgentTurnProjection(siblingMessages);
    assert.equal(
      separatedProjection.some((item) => item.kind === "completedProcess"),
      false,
      "the legacy completedProcess projection is no longer emitted"
    );
    assert.equal(separatedProjection.length, 2,
      "one user row plus one Assistant Turn are the only projected rows");
    assert.equal(separatedProjection[0]?.kind, "message");
    assert.equal(separatedProjection[1]?.kind, "assistantTurn");
    const unifiedTurn = separatedProjection[1]?.kind === "assistantTurn"
      ? separatedProjection[1].turn
      : null;
    assert.ok(unifiedTurn);
    assert.equal(unifiedTurn!.messages.length, siblingMessages.length - 1);
    assert.equal(unifiedTurn!.finalAnswer?.id, "answer-separated");
    assert.equal(unifiedTurn!.status, "completed");
    assert.equal(unifiedTurn!.currentNodeId, undefined);
    assert.deepEqual(
      unifiedTurn!.processNodes.map((node) => node.kind),
      ["process", "reasoning", "tool", "task", "retrieval", "artifact", "diff", "interaction", "reasoning"],
      "multiple Reasoning segments, Tool, Task, Sources, Artifact, Diff, and interaction retain chronological order"
    );

    const uniqueToolCallId = "call:read/Foo.md";
    const projectedToolMessageId = `pi:session-unique-tool:leaf:leaf-unique-tool:tool:${encodeURIComponent(uniqueToolCallId)}`;
    const duplicateToolActivityId = stableHashedIdentity("reasoning-tool", uniqueToolCallId);
    const uniqueToolMessages: ChatMessage[] = [
      {
        id: "unique-tool-user",
        role: "user",
        text: "读取文件",
        runId: "run-unique-tool",
        turnId: "run-unique-tool",
        createdAt: 10
      },
      {
        id: "unique-tool-reasoning",
        role: "assistant",
        itemType: "reasoning",
        text: "",
        status: "completed",
        reasoningSummary: {
          schemaVersion: 1,
          conversationId: "conversation-unique-tool",
          piSessionId: "session-unique-tool",
          productRunId: "run-unique-tool",
          status: "completed",
          startedAt: 11,
          updatedAt: 14,
          firstAssistantTextAt: 14,
          activities: [{
            id: duplicateToolActivityId,
            kind: "tool",
            status: "completed",
            name: "read",
            startedAt: 12,
            updatedAt: 13
          }]
        },
        runId: "run-unique-tool",
        turnId: "run-unique-tool",
        createdAt: 11,
        completedAt: 14
      },
      {
        id: projectedToolMessageId,
        role: "tool",
        itemType: "dynamicToolCall",
        processKind: "view",
        title: "read",
        text: "Foo contents",
        status: "completed",
        runId: "run-unique-tool",
        turnId: "run-unique-tool",
        createdAt: 12,
        completedAt: 13
      },
      {
        id: "unique-tool-answer",
        role: "assistant",
        text: "读取完成",
        status: "completed",
        runId: "run-unique-tool",
        turnId: "run-unique-tool",
        createdAt: 14,
        completedAt: 15
      }
    ];
    const uniqueToolProjection = buildAgentTurnProjection(uniqueToolMessages);
    const uniqueToolTurn = uniqueToolProjection[1]?.kind === "assistantTurn"
      ? uniqueToolProjection[1].turn
      : null;
    assert.ok(uniqueToolTurn);
    const uniqueToolNodes = uniqueToolTurn!.processNodes.filter(
      (node) => node.toolCallId === uniqueToolCallId
    );
    assert.equal(uniqueToolNodes.length, 1, "one toolCallId produces one process node");
    assert.equal(uniqueToolNodes[0]?.toolCallId, uniqueToolCallId);
    assert.equal(uniqueToolNodes[0]?.sourceMessageId, projectedToolMessageId,
      "the real Tool message remains the one content authority");
    assert.equal(uniqueToolTurn!.toolCount, 1, "the duplicate reasoning activity is not counted twice");
    assert.equal(
      uniqueToolMessages[1]?.reasoningSummary?.activities[0]?.id,
      duplicateToolActivityId,
      "the durable Reasoning snapshot remains unchanged"
    );

    const processOutput = [
      "{",
      "  \"status\": \"ok\",",
      "  \"note\": \"[[outputs/Result.md|结果别名]]\",",
      "  \"items\": [",
      "    \"alpha\",",
      "",
      "    \"beta\"",
      "  ]",
      "}",
      "",
      "[info] phase=done",
      "  detail: indentation stays",
      "",
      "$ printf \"done\\n\"",
      "done"
    ].join("\n");
    const processMessage = renderMessage(renderer, {
      id: "tool-1",
      role: "tool",
      itemType: "dynamicToolCall",
      title: "生成结果",
      text: "已生成输出",
      status: "completed",
      processInputAvailability: "provided",
      processInput: "生成笔记",
      processOutputAvailability: "provided",
      processOutput,
      createdAt: 1_700_000_003_000
    }, { showAgentFooter: false, showAgentHeader: false, processExpanded: true });
    assert.ok(processMessage.findByClass("codex-ai-elements-tool"));
    assert.ok(processMessage.findByClass("codex-smooth-ai-artifact"));
    const artifactRoot = processMessage.findByClass("codex-smooth-ai-artifact");
    assert.ok(artifactRoot);
    const outputBlocks = artifactRoot!.findAllByTag("pre");
    assert.equal(outputBlocks.length, 1, "artifact/process output stays in one preformatted block");
    assert.equal(
      renderedText(outputBlocks[0]),
      processOutput.replace("[[outputs/Result.md|结果别名]]", "Result"),
      "preformatted output preserves every non-note character and replaces only the resolved note span"
    );
    assert.equal(artifactRoot!.findAllByTag("p").length, 0, "process output must not create Markdown paragraphs");
    assert.equal(artifactRoot!.findAllByClass("codex-message-spacer").length, 0,
      "process output must not create Markdown spacers");
    const artifactLink = artifactRoot!.findByClass("codex-message-note-link");
    assert.ok(artifactLink, "artifact/process output must keep rich Vault-note rendering");
    assert.equal(artifactLink!.textContent, "Result");
    await clickRegistered(artifactLink!);

    const activeUnavailableTool = renderMessage(renderer, {
      id: "tool-active-unavailable",
      role: "tool",
      itemType: "dynamicToolCall",
      title: "等待工具",
      text: "",
      status: "running",
      processContentAvailability: "unavailable",
      createdAt: 1_700_000_003_100
    }, { showAgentFooter: false, showAgentHeader: false, processExpanded: true });
    assert.ok(activeUnavailableTool.findByClass("codex-smooth-ai-loader"));

    const completedUnavailableTool = renderMessage(renderer, {
      id: "tool-completed-unavailable",
      role: "tool",
      itemType: "dynamicToolCall",
      title: "工具完成",
      text: "",
      status: "completed",
      processContentAvailability: "unavailable",
      createdAt: 1_700_000_003_200
    }, { showAgentFooter: false, showAgentHeader: false, processExpanded: true });
    assert.equal(completedUnavailableTool.findAllByClass("codex-smooth-ai-loader").length, 0,
      "terminal unavailable output is static and never keeps spinning");

    const decisions: string[] = [];
    (renderer as unknown as { env: { resolveApprovalDecision?: unknown } }).env.resolveApprovalDecision = () => ({
      target: "{\"relativePath\":\"projects/Alpha.md\"}",
      preview: "{\"change\":\"update\"}",
      decide: (decision: string) => {
        decisions.push(decision);
        return true;
      }
    });
    const approval = renderMessage(renderer, {
      id: "tool-waiting-approval",
      role: "tool",
      itemType: "dynamicToolCall",
      title: "等待确认",
      text: "即将运行命令",
      status: "waiting_approval",
      approval: {
        status: "pending",
        target: "{\"relativePath\":\"projects/Alpha.md\"}",
        preview: "{\"change\":\"update\"}",
        updatedAt: 1_700_000_003_300
      },
      createdAt: 1_700_000_003_300
    }, { showAgentFooter: false, showAgentHeader: false, processExpanded: true });
    const approvalRoot = approval.findByClass("codex-smooth-ai-approval-card");
    assert.ok(approvalRoot);
    assert.equal(approvalRoot!.attributes.get("data-approval-state"), "waiting_approval");
    assert.match(renderedText(approvalRoot!), /目标/u);
    assert.match(renderedText(approvalRoot!), /预览/u);
    const approveButton = approvalRoot!.findByClass("is-approve")!;
    const rejectButton = approvalRoot!.findByClass("is-reject")!;
    assert.ok(approveButton);
    assert.ok(rejectButton);
    clickElement(approveButton);
    assert.deepEqual(decisions, ["approve"]);
    assert.equal(approveButton.disabled, true);
    assert.equal(rejectButton.disabled, true);
    assert.equal(approvalRoot!.attributes.get("aria-busy"), "true");
    clickElement(rejectButton);
    assert.deepEqual(decisions, ["approve"], "the first decision disables both controls and decides once");

    (renderer as unknown as { env: { resolveApprovalDecision?: unknown } }).env.resolveApprovalDecision = () => null;
    const pendingWithoutWaiter = renderMessage(renderer, {
      id: "tool-pending-without-waiter",
      role: "tool",
      itemType: "dynamicToolCall",
      title: "等待确认",
      text: "恢复的等待记录",
      status: "waiting_approval",
      approval: { status: "pending", target: "Recovered.md" },
      createdAt: 1_700_000_003_301
    }, { showAgentFooter: false, showAgentHeader: false, processExpanded: true });
    assert.ok(pendingWithoutWaiter.findByClass("codex-smooth-ai-approval-card"));
    assert.equal(pendingWithoutWaiter.findAllByClass("codex-smooth-ai-approval-button").length, 0,
      "a durable pending record without a live waiter is read-only");

    const statusOnlyApproval = renderMessage(renderer, {
      id: "tool-status-only-approval",
      role: "tool",
      itemType: "dynamicToolCall",
      title: "工具状态",
      text: "工具生命周期不能伪造审批记录",
      status: "denied",
      createdAt: 1_700_000_003_301
    }, { showAgentFooter: false, showAgentHeader: false, processExpanded: true });
    assert.equal(statusOnlyApproval.findAllByClass("codex-smooth-ai-approval-card").length, 0,
      "Tool status alone never fabricates a durable Approval lifecycle");

    (renderer as unknown as { env: { resolveApprovalDecision?: unknown } }).env.resolveApprovalDecision = () => ({
      target: "Live.md",
      preview: "live waiter",
      decide: () => true
    });
    const liveFallbackApproval = renderMessage(renderer, {
      id: "tool-live-fallback-approval",
      role: "tool",
      itemType: "dynamicToolCall",
      title: "实时等待",
      text: "Ticket 投影刷新前的 live waiter",
      status: "running",
      createdAt: 1_700_000_003_301
    }, { showAgentFooter: false, showAgentHeader: false, processExpanded: true });
    assert.equal(
      liveFallbackApproval.findByClass("codex-smooth-ai-approval-card")
        ?.attributes.get("data-approval-state"),
      "waiting_approval",
      "an exact live waiter is the only allowed pre-projection pending fallback"
    );
    assert.equal(liveFallbackApproval.findAllByClass("codex-smooth-ai-approval-button").length, 2);

    const staleDecisions: string[] = [];
    (renderer as unknown as { env: { resolveApprovalDecision?: unknown } }).env.resolveApprovalDecision = () => ({
      target: "Stale.md",
      preview: "stale",
      decide: (decision: string) => {
        staleDecisions.push(decision);
        return false;
      }
    });
    const staleApproval = renderMessage(renderer, {
      id: "tool-stale-approval",
      role: "tool",
      itemType: "dynamicToolCall",
      title: "等待确认",
      text: "已失效的按钮闭包",
      status: "waiting_approval",
      approval: { status: "pending", target: "Stale.md" },
      createdAt: 1_700_000_003_302
    }, { showAgentFooter: false, showAgentHeader: false, processExpanded: true });
    const staleCard = staleApproval.findByClass("codex-smooth-ai-approval-card")!;
    const staleApprove = staleCard.findByClass("is-approve")!;
    const staleReject = staleCard.findByClass("is-reject")!;
    clickElement(staleReject);
    assert.deepEqual(staleDecisions, ["reject"]);
    assert.equal(staleCard.attributes.get("aria-busy"), "false");
    assert.equal(staleApprove.disabled, false);
    assert.equal(staleReject.disabled, false);

    (renderer as unknown as { env: { resolveApprovalDecision?: unknown } }).env.resolveApprovalDecision = () => null;

    for (const state of ["approved", "denied", "cancelled", "expired"] as const) {
      const transcript = renderMessage(renderer, {
        id: `tool-approval-${state}`,
        role: "tool",
        itemType: "dynamicToolCall",
        title: "确认状态",
        text: "只读状态记录",
        status: state === "approved" ? "completed" : "denied",
        approval: { status: state, target: "Target.md", updatedAt: 1_700_000_003_302 },
        createdAt: 1_700_000_003_302
      }, { showAgentFooter: false, showAgentHeader: false, processExpanded: true });
      const card = transcript.findByClass("codex-smooth-ai-approval-card");
      assert.equal(
        card?.attributes.get("data-approval-state"),
        state
      );
      assert.equal(card?.findAllByClass("codex-smooth-ai-approval-button").length, 0);
    }

    const localSourceMessage = {
      id: "answer-with-local-sources",
      role: "assistant",
      text: "基于本地资料回答。",
      status: "completed",
      citations: {
        status: "strong",
        counts: { wiki: 1, journal: 0, outputs: 1 },
        citations: [
          {
            bucket: "wiki",
            title: "Alpha 别名",
            path: "projects/Alpha.md",
            excerptLines: ["Alpha citation excerpt"],
            relevance: "strong",
            reason: "matched",
            score: 0.9
          },
          {
            bucket: "outputs",
            title: "Missing",
            path: "wiki/Missing.md",
            excerptLines: ["Missing structured excerpt"],
            relevance: "weak",
            reason: "historical",
            score: 0.4
          }
        ]
      },
      askSourceAttribution: true,
      knowledgeReferences: [
        {
          referenceId: "reference-alpha",
          vaultRelativePath: "projects/Alpha.md",
          title: "Alpha reference title",
          excerpt: "Alpha reference excerpt",
          contentRevision: `sha256:${"a".repeat(64)}`,
          lineStart: 2,
          lineEnd: 3
        },
        {
          referenceId: "reference-result",
          vaultRelativePath: "outputs/Result.md",
          title: "Result reference title",
          excerpt: "Result reference excerpt",
          contentRevision: `sha256:${"b".repeat(64)}`,
          lineStart: 5,
          lineEnd: 5
        }
      ],
      personalMemorySources: [
        { id: " memory-1 ", title: "共同记忆" },
        { id: "memory-1", title: "不应重复的同 id 记忆" },
        { id: "memory-2", title: "共同记忆" }
      ],
      knowledgeProducedPaths: ["outputs/Result.md"],
      createdAt: 1_700_000_003_400
    } as ChatMessage & {
      knowledgeProducedPaths: string[];
      knowledgeReferences: Array<{
        referenceId: string;
        vaultRelativePath: string;
        title: string;
        excerpt: string;
        contentRevision: string;
        lineStart: number;
        lineEnd: number;
      }>;
    };
    const localSourcesMessage = renderMessage(
      renderer,
      localSourceMessage,
      { showAgentFooter: false, showAgentHeader: false }
    );
    const localSourcesRoot = localSourcesMessage.findByClass("codex-ai-elements-sources");
    assert.ok(localSourcesRoot);
    assert.equal(localSourcesMessage.findAllByClass("codex-ai-elements-sources").length, 1,
      "one message has one local document source surface");
    assert.equal(localSourcesMessage.findAllByClass("codex-smooth-ai-sources").length, 0,
      "local documents never populate SmoothUI webpage Sources");
    assert.equal(
      localSourcesRoot!.findByClass("codex-ai-elements-sources-label")?.textContent,
      "使用了 5 个文档",
      "count uses unique citations, references, and Memory ids but excludes produced paths"
    );
    const localRows = localSourcesRoot!.findAllByClass("codex-ai-elements-source");
    assert.equal(localRows.length, 5);
    assert.deepEqual(
      localRows.map((row) => row.attributes.get("data-source-key")),
      [
        "vault:projects/Alpha.md",
        "vault:wiki/Missing.md",
        "vault:outputs/Result.md",
        "memory:memory-1",
        "memory:memory-2"
      ],
      "local sources preserve first-seen structured order and stable deduplication keys"
    );
    assert.equal(localSourcesRoot!.findAllByClass("codex-ai-elements-source-icon").length, 5);
    assert.equal(localSourcesRoot!.findAllByClass("is-disabled").length, 3,
      "missing Vault path and Personal Memory stay non-clickable");
    assert.equal(localSourcesRoot!.findAllByTag("button").length, 2,
      "only currently resolvable Vault files render navigation buttons");
    assert.match(renderedText(localSourcesRoot!), /Alpha citation excerpt/u);
    assert.match(renderedText(localSourcesRoot!), /Alpha reference excerpt/u);
    assert.match(renderedText(localSourcesRoot!), /第 2-3 行/u);
    assert.match(renderedText(localSourcesRoot!), /强证据/u);
    const producedSources = localSourcesMessage.findByClass("codex-ai-elements-artifact-sources");
    assert.ok(producedSources, "generated paths remain a separate Sources-style surface");
    assert.equal(producedSources!.findAllByClass("codex-smooth-ai-artifact").length, 0,
      "generated paths are not wrapped in a Smooth Artifact card");
    assert.equal(producedSources!.findAllByClass("codex-ai-elements-source-icon").length, 0,
      "generated paths stay pure text without document icons");
    const producedLink = producedSources!.findByClass("codex-ai-elements-artifact-source");
    assert.equal(producedLink?.tag, "button",
      "generated path text retains native keyboard activation semantics");
    assert.equal(producedLink?.textContent, "Result");
    producedLink?.onclick?.({
      preventDefault: () => undefined,
      stopPropagation: () => undefined
    } as never);
    await Promise.resolve();
    assert.ok(context.openedPaths.includes("outputs/Result.md"),
      "generated path text preserves the existing Obsidian open behavior");
    localSourcesRoot!.findAllByTag("button")[0].onclick?.({
      preventDefault: () => undefined,
      stopPropagation: () => undefined
    } as never);
    await Promise.resolve();

    const citationOnlyMessage = renderMessage(renderer, {
      ...localSourceMessage,
      id: "answer-with-citations-only",
      knowledgeReferences: [],
      personalMemorySources: []
    }, { showAgentFooter: false, showAgentHeader: false });
    assert.equal(citationOnlyMessage.findAllByClass("codex-kb-no-evidence").length, 0,
      "existing structured citations also count as local evidence");

    const emptyAttributionMessage = renderMessage(renderer, {
      id: "answer-with-empty-attribution",
      role: "assistant",
      text: "没有本地依据。",
      status: "completed",
      citations: {
        status: "none",
        counts: { wiki: 0, journal: 0, outputs: 0 },
        citations: []
      },
      askSourceAttribution: true,
      personalMemorySources: [],
      createdAt: 1_700_000_003_500
    }, { showAgentFooter: false, showAgentHeader: false });
    assert.equal(emptyAttributionMessage.findAllByClass("codex-ai-elements-sources").length, 0);
    assert.match(renderedText(emptyAttributionMessage), /知识库没有找到可引用依据/u);
    assert.doesNotMatch(renderedText(emptyAttributionMessage), /Personal Memory|个人记忆|不会显示伪来源/u);
    assert.doesNotMatch(renderedText(emptyAttributionMessage), /使用了 0 个文档/u);

    const diffMessage = renderMessage(renderer, {
      id: "file-change-diff",
      role: "tool",
      itemType: "fileChange",
      title: "编辑 Alpha",
      text: "@@ -1,1 +1,2 @@\n-old\n+\n+new",
      status: "completed",
      diffSummary: {
        totalFiles: 1,
        added: 2,
        removed: 1,
        files: [{
          path: "projects/Alpha.md",
          kind: "update",
          added: 2,
          removed: 1
        }]
      },
      createdAt: 1_700_000_003_600
    }, { showAgentFooter: false, showAgentHeader: false, processExpanded: true });
    assert.ok(diffMessage.findByClass("codex-smooth-ai-diff"));
    const diffContent = diffMessage.findAllByClass("codex-diff-content").map((line) => line.textContent);
    assert.ok(diffContent.includes(""), "an actually empty added line stays an empty string");
    assert.equal(diffContent.includes(" "), false, "diff rendering never substitutes fake whitespace");
    assert.match(renderedText(diffMessage), /\+2/u);
    assert.match(renderedText(diffMessage), /-1/u);

    const nonDiffFileChange = renderMessage(renderer, {
      id: "file-change-plain-text",
      role: "tool",
      itemType: "fileChange",
      title: "文件改动摘要",
      text: "plain text without a parseable diff",
      status: "completed",
      diffSummary: {
        totalFiles: 1,
        added: 0,
        removed: 0,
        files: [{
          path: "projects/Alpha.md",
          kind: "update",
          added: 0,
          removed: 0
        }]
      },
      createdAt: 1_700_000_003_700
    }, { showAgentFooter: false, showAgentHeader: false, processExpanded: true });
    assert.equal(nonDiffFileChange.findAllByClass("codex-smooth-ai-diff").length, 0,
      "diffSummary alone cannot turn plain text into an AI Diff");
    assert.match(renderedText(nonDiffFileChange), /plain text without a parseable diff/u);

    const planMessage = renderMessage(renderer, {
      id: "plan-1",
      role: "assistant",
      itemType: "taskPlan",
      text: "",
      taskPlan: {
        schemaVersion: 1,
        planId: "plan-1",
        title: "真实计划",
        status: "in_progress",
        version: 1,
        steps: [{ stepId: "step-1", text: "完成界面", status: "in_progress" }],
        currentStepId: "step-1",
        source: "agent",
        createdAt: 1_700_000_004_000,
        updatedAt: 1_700_000_004_000
      },
      createdAt: 1_700_000_004_000
    }, { showAgentFooter: false, showAgentHeader: false });
    assert.ok(planMessage.findByClass("codex-ai-elements-task"));
    assert.equal(planMessage.findAllByClass("codex-smooth-ai-task-list").length, 0);
    assert.equal(planMessage.findAllByTag("button").length, 0,
      "the durable history Task is read-only");

    const userRow = renderMessage(renderer, siblingMessages[0]!, {
      showAgentFooter: false,
      showAgentHeader: false
    });
    const assistantTurnSurface = new FakeElement("div");
    (renderer as unknown as {
      renderAssistantTurn(
        container: unknown,
        turn: NonNullable<typeof unifiedTurn>,
        showAgentHeader: boolean
      ): void;
    }).renderAssistantTurn(assistantTurnSurface, unifiedTurn!, false);
    const assistantTurnRoot = assistantTurnSurface.findByClass("codex-message-type-assistantTurn")!;
    assert.equal(assistantTurnRoot.attributes.get("data-bubble"), "false");
    assert.equal(assistantTurnSurface.findAllByClass("codex-message-type-assistantTurn").length, 1);
    assert.equal(assistantTurnRoot.findAllByClass("codex-assistant-turn-spine").length, 1);
    const chainOfThought = assistantTurnRoot.findByClass("codex-ai-elements-chain-of-thought")!;
    assert.equal(chainOfThought.tag, "div",
      "ChainOfThought is a static event spine, not a second disclosure");
    assert.equal(chainOfThought.findAllByClass("codex-ai-elements-chain-of-thought-trigger").length, 0,
      "ChainOfThought has no repeated title, duration summary, or Chevron");
    assert.equal(
      assistantTurnRoot.findAllByClass("codex-assistant-turn-node").some((node) => node.hasClass("is-current")),
      false,
      "a completed Assistant Turn has no animated current node"
    );
    assert.ok(
      assistantTurnRoot.findAllByClass("codex-assistant-turn-node").some((node) => node.hasClass("is-completed")),
      "completed nodes retain their low-contrast status class"
    );
    const primaryLabels = new Set(
      assistantTurnRoot.findAllByClass("codex-assistant-turn-section-primary")
        .map((label) => label.textContent)
    );
    const secondaryLabels = new Set(
      assistantTurnRoot.findAllByClass("codex-assistant-turn-section-secondary")
        .map((label) => label.textContent)
    );
    assert.deepEqual(primaryLabels, new Set(["最终回答"]));
    assert.deepEqual(secondaryLabels, new Set());
    assert.doesNotMatch(renderedText(assistantTurnRoot), /处理过程|模型推理|执行动作/u,
      "event rows omit repeated category prefixes");

    for (const componentClass of [
      "codex-ai-elements-chain-of-thought",
      "codex-ai-elements-tool",
      "codex-assistant-turn-task-summary",
      "codex-ai-elements-sources",
      "codex-ai-elements-artifact-sources",
      "codex-ai-elements-reasoning",
      "codex-ai-elements-response"
    ]) {
      assert.ok(assistantTurnRoot.findByClass(componentClass),
        `${componentClass} stays inside the one Assistant Turn`);
    }
    assert.equal(
      assistantTurnRoot.findAllByClass("codex-smooth-ai-reasoning").length,
      0,
      "the Assistant Turn does not reuse Smooth reasoning chrome"
    );
    assert.equal(
      assistantTurnRoot.findAllByClass("codex-smooth-ai-loader").length,
      0,
      "Reasoning and Tool event subtrees do not reuse Smooth loaders"
    );
    const turnArtifactSources = assistantTurnRoot.findByClass("codex-ai-elements-artifact-sources")!;
    assert.equal(turnArtifactSources.closest(".codex-assistant-turn-resource"), null,
      "produced artifacts do not repeat the process-node heading in a nested disclosure");
    assert.equal(turnArtifactSources.findAllByClass("codex-ai-elements-artifact-source").length, 1);
    assert.equal(turnArtifactSources.findAllByClass("codex-ai-elements-source-icon").length, 0);
    assert.match(renderedText(assistantTurnRoot), /已批准一次性写入/u,
      "resolved interaction leaves one compact process record");
    assert.equal(assistantTurnRoot.findAllByClass("codex-smooth-ai-approval-card").length, 0,
      "resolved Confirmation does not leave an interactive approval card in history");

    const unifiedLedgers = assistantTurnRoot.findAllByClass(
      "codex-assistant-turn-action-ledger"
    );
    assert.equal(unifiedLedgers.length, 0,
      "Tool rows are direct ChainOfThought children without a grouping ledger");
    assert.equal(
      assistantTurnRoot.findAllByClass("codex-assistant-turn-action-ledger-summary").length,
      0,
      "per-ledger counts are omitted because the Turn summary owns Tool quantity"
    );
    const unifiedActions = assistantTurnRoot.findAllByClass("codex-action-item");
    assert.equal(unifiedActions.length, 2);
    assert.equal(
      unifiedActions.find((action) => action.dataset.messageId === "tool-separated")
        ?.findByClass("codex-action-item-title")?.textContent,
      "vault_search",
      "persisted Tool chrome is stripped so the Chinese action row keeps only the raw tool name"
    );
    assert.ok(unifiedActions.every((action) => action.closest(".codex-assistant-turn-node") === null),
      "an Action row is not wrapped in a second titled process node");
    assert.ok(unifiedActions.every((action) =>
      action.findAllByClass("codex-ai-elements-tool-status").length === 1
    ), "each collapsed Action owns one semantic icon");
    assert.equal(assistantTurnRoot.findAllByClass("codex-action-item-prefix").length, 0,
      "semantic icons replace repeated action verb prefixes");
    assert.equal(
      unifiedActions.find((action) => action.dataset.messageId === "tool-separated")
        ?.findByClass("codex-ai-elements-tool-status")?.dataset.icon,
      "search"
    );
    assert.equal(
      unifiedActions.find((action) => action.dataset.messageId === "diff-separated")
        ?.findByClass("codex-ai-elements-tool-status")?.dataset.icon,
      "file-diff"
    );
    assert.equal(assistantTurnRoot.findAllByClass("codex-action-item-time").length, 0,
      "message clock time is never presented as Tool duration");
    assert.equal(assistantTurnRoot.findAllByClass("codex-action-item-detail").length, 0,
      "Tool details and error copy are not repeated as a collapsed second title");
    assert.ok(assistantTurnRoot.findAllByClass("codex-action-item-expandable")
      .every((action) => !action.open), "Action rows start collapsed");
    for (const action of assistantTurnRoot.findAllByClass("codex-action-item-expandable")) {
      action.open = true;
      action.ontoggle?.({ isTrusted: false });
    }
    assert.ok(assistantTurnRoot.findByClass("codex-smooth-ai-diff"),
      "expanded Diff stays reachable inside the one Assistant Turn");
    const providerReasoningDom = assistantTurnRoot.findAllByClass(
      "codex-ai-elements-reasoning"
    );
    assert.equal(providerReasoningDom.length, 2,
      "each Provider reasoning segment owns one independent Reasoning disclosure");
    assert.equal(
      providerReasoningDom.flatMap((reasoning) =>
        reasoning.findAllByClass("codex-smooth-ai-loader")
      ).length,
      0,
      "Reasoning bodies contain only real streamed text and never a Smooth loader"
    );
    assert.ok(providerReasoningDom.every((reasoning) =>
      reasoning.parent?.hasClass("codex-assistant-turn-spine")
    ), "Provider Reasoning is a direct ChainOfThought child");
    assert.ok(providerReasoningDom.every((reasoning) =>
      reasoning.closest(".codex-assistant-turn-node") === null
    ), "Provider Reasoning bypasses the legacy process-node wrapper");
    assert.equal(assistantTurnRoot.findAllByClass("codex-assistant-turn-node-marker").length, 0,
      "the old status ring and completion check are absent");
    const firstReasoningTrigger = providerReasoningDom[0]
      .findByClass("codex-ai-elements-reasoning-trigger")!;
    assert.deepEqual(
      firstReasoningTrigger.children.map((child) => child.className),
      [
        "codex-ai-elements-reasoning-icon",
        "codex-ai-elements-reasoning-label",
        "codex-ai-elements-reasoning-caret"
      ],
      "Reasoning Trigger follows Brain, status or duration, then Chevron"
    );
    assert.equal(firstReasoningTrigger.children[0]?.dataset.icon, "brain");
    assert.equal(firstReasoningTrigger.children[2]?.dataset.icon, "chevron-down");
    assert.deepEqual(
      new Set(
        assistantTurnRoot.findAllByClass("codex-assistant-turn-node-icon")
          .map((icon) => icon.dataset.icon)
      ),
      new Set(["dot", "search", "image"]),
      "ordinary Steps retain only the frozen semantic Dot, Search, and Image icons"
    );
    const providerReasoningText = providerReasoningDom.map((element) => renderedText(element)).join("\n");
    assert.match(renderedText(providerReasoningDom[0]), new RegExp(siblingCanaries.publicReasoning, "u"));
    assert.doesNotMatch(
      renderedText(providerReasoningDom[0]),
      /revision\s*29|recordId|targetId|call_abcd|kind\s*=\s*goal/iu,
      "isolated internal fields are hidden without relying on a Memory Tool name or Memory record ID in the same segment"
    );
    assert.match(
      renderedText(providerReasoningDom[0]),
      /当前记忆版本.*对应记忆.*对应记忆.*本次操作.*记忆类型：目标/su
    );
    assert.doesNotMatch(renderedText(providerReasoningDom[0]), new RegExp(siblingCanaries.publicReasoningAfterTool, "u"));
    assert.match(renderedText(providerReasoningDom[1]), new RegExp(siblingCanaries.publicReasoningAfterTool, "u"));
    assert.doesNotMatch(renderedText(providerReasoningDom[1]), new RegExp(siblingCanaries.publicReasoning, "u"));
    assert.doesNotMatch(
      providerReasoningText,
      /mem_[0-9a-f]{4,64}|call_[a-z0-9_-]{4,128}|memory_(?:search|read|write)|profile_updated|revision\s*28|targetId|profileKey|schema\s*=\s*echoink\.memory\.v1|shared-user\/memory\/|pi:\/\/|kind\s*=\s*open_loop/iu,
      "user-visible Provider Reasoning hides Personal Memory implementation fields"
    );
    assert.match(
      providerReasoningText,
      /原有记忆.*更新后的记忆.*本次操作.*检查已有长期记忆.*读取长期记忆.*更新长期记忆.*记忆结果：已更新用户信息.*当前记忆版本.*对应记忆.*用户信息类别.*记忆格式.*内部记忆位置.*对话来源.*记忆类型：未决事项/su,
      "user-visible Provider Reasoning keeps the model's meaning in plain language"
    );
    assert.match(
      providerReasoningText,
      /Repository Harness ProductRun view task goal/u,
      "ordinary technical words are not rewritten merely because the same Reasoning also mentions Memory"
    );
    assert.match(
      reasoningSibling.assistantTurn?.providerReasoningSegments?.[1]?.text ?? "",
      /mem_8a45.*memory_search.*outcome=profile_updated.*schema=echoink\.memory\.v1.*kind=open_loop.*Repository Harness ProductRun view task goal/su,
      "the internal Reasoning view model keeps the Provider text verbatim"
    );

    const localUpdater = renderer as unknown as {
      env: { messages: ChatMessage[] };
      tryUpdateAssistantTurnMessage(row: unknown, message: ChatMessage): boolean;
    };
    const secondReasoningRoot = providerReasoningDom[1];
    const secondReasoningBody = secondReasoningRoot.findByClass(
      "codex-ai-elements-reasoning-content"
    )!;
    secondReasoningBody.clientHeight = 280;
    secondReasoningBody.scrollHeight = 840;
    secondReasoningBody.scrollTop = 560;
    const reasoningDelta = " SECOND_REASONING_DELTA memory_read mem_fedc";
    const updatedReasoningSibling: ChatMessage = {
      ...reasoningSibling,
      assistantTurn: {
        ...reasoningSibling.assistantTurn!,
        updatedAt: 11,
        providerReasoningSegments: reasoningSibling.assistantTurn!.providerReasoningSegments!.map((segment, index) =>
          index === 1
            ? { ...segment, text: `${segment.text}${reasoningDelta}`, updatedAt: 11 }
            : segment
        )
      }
    };
    const locallyUpdatedMessages = [...siblingMessages];
    locallyUpdatedMessages[1] = updatedReasoningSibling;
    localUpdater.env.messages = locallyUpdatedMessages;
    assert.equal(
      localUpdater.tryUpdateAssistantTurnMessage(assistantTurnSurface, updatedReasoningSibling),
      true,
      "an existing Provider reasoning delta is handled without rebuilding the Turn row"
    );
    assert.equal(assistantTurnRoot.findAllByClass("codex-ai-elements-reasoning")[1], secondReasoningRoot,
      "the Reasoning disclosure keeps its DOM identity across a delta");
    assert.match(renderedText(secondReasoningRoot), /SECOND_REASONING_DELTA/u);
    assert.match(renderedText(secondReasoningRoot), /读取长期记忆.*相关记忆/su);
    assert.doesNotMatch(
      renderedText(secondReasoningRoot),
      /memory_read|mem_fedc/u,
      "a live Provider Reasoning patch also hides internal Memory fields"
    );
    assert.doesNotMatch(
      secondReasoningRoot.findByClass("codex-ai-elements-reasoning-content")?.dataset.renderedText ?? "",
      /memory_read|mem_fedc/u,
      "the Reasoning DOM cache stores only user-facing text"
    );
    assert.equal(secondReasoningBody.scrollTop, secondReasoningBody.scrollHeight,
      "a Reasoning delta keeps following while the reader is at the bottom");

    secondReasoningBody.scrollHeight = 960;
    secondReasoningBody.scrollTop = 240;
    const manualReviewReasoningSibling: ChatMessage = {
      ...updatedReasoningSibling,
      assistantTurn: {
        ...updatedReasoningSibling.assistantTurn!,
        updatedAt: 12,
        providerReasoningSegments: updatedReasoningSibling.assistantTurn!.providerReasoningSegments!.map(
          (segment, index) => index === 1
            ? { ...segment, text: `${segment.text} MANUAL_REVIEW_DELTA`, updatedAt: 12 }
            : segment
        )
      }
    };
    locallyUpdatedMessages[1] = manualReviewReasoningSibling;
    localUpdater.env.messages = locallyUpdatedMessages;
    assert.equal(
      localUpdater.tryUpdateAssistantTurnMessage(assistantTurnSurface, manualReviewReasoningSibling),
      true
    );
    assert.equal(secondReasoningBody.scrollTop, 240,
      "a Reasoning delta preserves the reader's manual scroll position");

    secondReasoningBody.scrollTop = secondReasoningBody.scrollHeight - secondReasoningBody.clientHeight;
    const resumedFollowReasoningSibling: ChatMessage = {
      ...manualReviewReasoningSibling,
      assistantTurn: {
        ...manualReviewReasoningSibling.assistantTurn!,
        updatedAt: 13,
        providerReasoningSegments: manualReviewReasoningSibling.assistantTurn!.providerReasoningSegments!.map(
          (segment, index) => index === 1
            ? { ...segment, text: `${segment.text} RESUMED_FOLLOW_DELTA`, updatedAt: 13 }
            : segment
        )
      }
    };
    locallyUpdatedMessages[1] = resumedFollowReasoningSibling;
    localUpdater.env.messages = locallyUpdatedMessages;
    assert.equal(
      localUpdater.tryUpdateAssistantTurnMessage(assistantTurnSurface, resumedFollowReasoningSibling),
      true
    );
    assert.equal(secondReasoningBody.scrollTop, secondReasoningBody.scrollHeight,
      "returning to the Reasoning bottom restores follow on the next delta");

    const answerContentBefore = assistantTurnRoot.findByClass("codex-assistant-turn-answer")!;
    const updatedAnswer: ChatMessage = {
      ...locallyUpdatedMessages[locallyUpdatedMessages.length - 1]!,
      text: `${siblingMessages.at(-1)!.text} ANSWER_LOCAL_DELTA`
    };
    locallyUpdatedMessages[locallyUpdatedMessages.length - 1] = updatedAnswer;
    localUpdater.env.messages = locallyUpdatedMessages;
    assert.equal(localUpdater.tryUpdateAssistantTurnMessage(assistantTurnSurface, updatedAnswer), true);
    assert.equal(assistantTurnRoot.findByClass("codex-assistant-turn-answer"), answerContentBefore,
      "the final Answer keeps its content node across a delta");
    assert.match(renderedText(answerContentBefore), /ANSWER_LOCAL_DELTA/u);

    const toolRowBefore = unifiedActions.find((action) => action.dataset.messageId === "tool-separated")!;
    const updatedTool: ChatMessage = { ...locallyUpdatedMessages[2]!, status: "running" };
    locallyUpdatedMessages[2] = updatedTool;
    localUpdater.env.messages = locallyUpdatedMessages;
    assert.equal(localUpdater.tryUpdateAssistantTurnMessage(assistantTurnSurface, updatedTool), true);
    assert.equal(
      assistantTurnRoot.findAllByClass("codex-action-item")
        .find((action) => action.dataset.messageId === "tool-separated"),
      toolRowBefore,
      "the Tool row keeps its DOM identity across a status update"
    );
    assert.equal(toolRowBefore.attributes.get("data-tool-status"), "running");
    assert.equal(toolRowBefore.findAllByClass("codex-action-item-prefix").length, 0,
      "a local Tool status patch does not restore the removed action prefix");
    assert.equal(
      toolRowBefore.findByClass("codex-ai-elements-tool-status")?.dataset.icon,
      "search",
      "a local Tool status patch preserves its semantic icon"
    );

    const visibleTurnCanaries = [
      siblingCanaries.answer,
      siblingCanaries.sourceData,
      siblingCanaries.diffContent,
      siblingCanaries.publicReasoning,
      siblingCanaries.publicReasoningAfterTool
    ];
    for (const canary of visibleTurnCanaries) {
      assert.match(renderedText(assistantTurnRoot), new RegExp(canary, "u"),
        `${canary} remains reachable inside the unified Assistant Turn`);
    }
    assert.match(renderedText(userRow), new RegExp(siblingCanaries.prompt, "u"));
    assert.doesNotMatch(renderedText(assistantTurnRoot), new RegExp(siblingCanaries.prompt, "u"),
      "the user prompt remains outside the Assistant Turn");
    for (const canary of [
      siblingCanaries.prompt,
      siblingCanaries.answer,
      siblingCanaries.toolArgument,
      siblingCanaries.toolResult,
      siblingCanaries.sourceData,
      siblingCanaries.diffContent,
      siblingCanaries.approvalPayload,
      siblingCanaries.privateReasoning
    ]) {
      assert.doesNotMatch(
        JSON.stringify(reasoningSibling.reasoningSummary),
        new RegExp(canary, "u"),
        `Reasoning snapshot excludes ${canary}`
      );
      assert.doesNotMatch(reasoningSibling.text, new RegExp(canary, "u"),
        `Reasoning message text excludes ${canary}`);
      assert.doesNotMatch(providerReasoningText, new RegExp(canary, "u"),
        `Provider Reasoning DOM excludes unrelated or private ${canary}`);
    }
    assert.doesNotMatch(
      renderedText(assistantTurnRoot),
      new RegExp(siblingCanaries.privateReasoning, "u"),
      "private reasoning canary is never rendered anywhere"
    );
    for (const canary of [siblingCanaries.toolArgument, siblingCanaries.toolResult]) {
      assert.doesNotMatch(
        renderedText(assistantTurnRoot),
        new RegExp(canary, "u"),
        "ordinary Tool protocol input and output stay out of the user-facing Turn"
      );
    }
    assert.doesNotMatch(
      renderedText(assistantTurnRoot),
      new RegExp(siblingCanaries.approvalPayload, "u"),
      "resolved Confirmation history does not expose its live approval payload"
    );

    const approvalTurnProjection = buildAgentTurnProjection([{
      id: "approval-ledger-user",
      role: "user",
      text: "更新根目录文件",
      runId: "run-approval-ledger",
      turnId: "run-approval-ledger",
      createdAt: 2_900
    }, approvalProjectionMessage]);
    const approvalTurn = approvalTurnProjection[1]?.kind === "assistantTurn"
      ? approvalTurnProjection[1].turn
      : null;
    assert.ok(approvalTurn);
    const approvalTurnSurface = new FakeElement("div");
    (renderer as unknown as {
      renderAssistantTurn(
        container: unknown,
        turn: NonNullable<typeof approvalTurn>,
        showAgentHeader: boolean
      ): void;
    }).renderAssistantTurn(approvalTurnSurface, approvalTurn!, false);
    const approvalTurnRoot = approvalTurnSurface.findByClass(
      "codex-message-type-assistantTurn"
    )!;
    assert.equal(approvalTurnRoot.findAllByClass("codex-smooth-ai-approval-card").length, 0,
      "Approval preview remains inside its Tool Action instead of a sibling card");
    assert.equal(
      approvalTurnRoot.findAllByClass("codex-assistant-turn-action-ledger-summary").length,
      0
    );
    assert.deepEqual(
      approvalTurnRoot.findAllByClass("codex-diff-stat").map((stat) => stat.textContent),
      ["+1", "-1"]
    );
    const approvalAction = approvalTurnRoot.findByClass("codex-action-item-expandable")!;
    assert.equal(approvalAction.open, false);
    approvalAction.open = true;
    approvalAction.ontoggle?.({ isTrusted: false });
    assert.ok(approvalAction.findByClass("codex-smooth-ai-diff"),
      "the expanded Approval Tool exposes the structured preview Diff");
    assert.match(renderedText(approvalAction), /Foo\.md/u);
    assert.match(renderedText(approvalAction), /new/u);

    const reopenedRenderer = new CodexMessageListRenderer();
    bindRenderer(reopenedRenderer, context);
    const reopenedApprovalSurface = new FakeElement("div");
    (reopenedRenderer as unknown as {
      renderAssistantTurn(
        container: unknown,
        turn: NonNullable<typeof approvalTurn>,
        showAgentHeader: boolean
      ): void;
    }).renderAssistantTurn(reopenedApprovalSurface, approvalTurn!, false);
    assert.equal(
      reopenedApprovalSurface.findByClass("codex-action-item-expandable")?.open,
      false,
      "reopening a durable Tool rebuilds the same collapsed Action without stale disclosure state"
    );
    assert.deepEqual(
      reopenedApprovalSurface.findAllByClass("codex-diff-stat").map((stat) => stat.textContent),
      ["+1", "-1"]
    );

    const failedToolError = "FAILED_TOOL_ERROR_ONLY_IN_DETAILS";
    const ledgerMessages: ChatMessage[] = [{
      id: "ledger-user",
      role: "user",
      text: "处理 Foo.md",
      runId: "run-compact-ledger",
      turnId: "run-compact-ledger",
      createdAt: 1_000
    }, {
      id: "ledger-read",
      role: "tool",
      itemType: "dynamicToolCall",
      processKind: "view",
      title: "read",
      text: "old",
      processInput: "Foo.md",
      processOutput: "old",
      processInputAvailability: "provided",
      processOutputAvailability: "provided",
      files: [{
        name: "Foo.md",
        path: "Foo.md",
        displayPath: "Foo.md",
        kind: "vault",
        openable: true
      }],
      status: "completed",
      runId: "run-compact-ledger",
      turnId: "run-compact-ledger",
      createdAt: 2_000,
      completedAt: 3_250
    }, {
      id: "ledger-edit",
      role: "tool",
      itemType: "fileChange",
      processKind: "edit",
      title: "file change",
      text: approvalDiff,
      diffSummary: {
        totalFiles: 1,
        added: 1,
        removed: 1,
        files: [{ path: "Foo.md", kind: "update", added: 1, removed: 1 }]
      },
      files: [{
        name: "Foo.md",
        path: "Foo.md",
        displayPath: "Foo.md",
        kind: "vault",
        openable: true
      }],
      status: "completed",
      runId: "run-compact-ledger",
      turnId: "run-compact-ledger",
      createdAt: 3_300,
      completedAt: 4_300
    }, {
      id: "ledger-task",
      role: "assistant",
      itemType: "taskPlan",
      text: "",
      taskPlan: {
        schemaVersion: 1,
        planId: "ledger-plan",
        title: "账本任务",
        status: "completed",
        version: 1,
        steps: [{ stepId: "ledger-step", text: "核对结果", status: "completed" }],
        source: "agent",
        productRunId: "run-compact-ledger",
        createdAt: 4_400,
        updatedAt: 4_400
      },
      status: "completed",
      runId: "run-compact-ledger",
      turnId: "run-compact-ledger",
      createdAt: 4_400,
      completedAt: 4_400
    }, {
      id: "ledger-failed-tool",
      role: "tool",
      itemType: "dynamicToolCall",
      processKind: "tool",
      title: "danger_tool",
      details: failedToolError,
      text: failedToolError,
      processInput: "{\"path\":\"Foo.md\"}",
      processOutput: failedToolError,
      processInputAvailability: "provided",
      processOutputAvailability: "provided",
      status: "failed",
      runId: "run-compact-ledger",
      turnId: "run-compact-ledger",
      createdAt: 4_500,
      completedAt: 5_000
    }, {
      id: "ledger-answer",
      role: "assistant",
      text: "已报告失败",
      status: "completed",
      runId: "run-compact-ledger",
      turnId: "run-compact-ledger",
      createdAt: 5_100,
      completedAt: 5_200
    }];
    const ledgerProjection = buildAgentTurnProjection(ledgerMessages);
    const ledgerTurn = ledgerProjection[1]?.kind === "assistantTurn"
      ? ledgerProjection[1].turn
      : null;
    assert.ok(ledgerTurn);
    const ledgerSurface = new FakeElement("div");
    const ledgerRenderer = new CodexMessageListRenderer();
    bindRenderer(ledgerRenderer, context);
    (ledgerRenderer as unknown as {
      renderAssistantTurn(
        container: unknown,
        turn: NonNullable<typeof ledgerTurn>,
        showAgentHeader: boolean
      ): void;
    }).renderAssistantTurn(ledgerSurface, ledgerTurn!, false);
    const ledgerRoot = ledgerSurface.findByClass("codex-message-type-assistantTurn")!;
    assert.equal(
      ledgerRoot.findAllByClass("codex-assistant-turn-action-ledger-summary").length,
      0,
      "adjacent actions keep chronology without repeating per-ledger quantities"
    );
    const ledgerActions = ledgerRoot.findAllByClass("codex-action-item");
    assert.equal(ledgerActions.length, 3);
    assert.deepEqual(
      ledgerRoot.findAllByClass("codex-action-item-duration")
        .map((duration) => duration.textContent.trim()),
      ["1.3s", "1s", "500ms"]
    );
    const readAction = ledgerActions.find((action) =>
      action.dataset.messageId === "ledger-read"
    )!;
    assert.equal(readAction.findByClass("codex-action-item-file")?.attributes.get("title"), "Foo.md");
    const editAction = ledgerActions.find((action) =>
      action.dataset.messageId === "ledger-edit"
    )!;
    assert.deepEqual(
      editAction.findAllByClass("codex-diff-stat").map((stat) => stat.textContent),
      ["+1", "-1"]
    );
    const failedAction = ledgerActions.find((action) =>
      action.dataset.messageId === "ledger-failed-tool"
    )!;
    assert.equal(failedAction.open, false);
    assert.doesNotMatch(renderedText(failedAction), new RegExp(failedToolError, "u"),
      "the collapsed failed row does not repeat its error as a second title");
    assert.equal(renderedText(failedAction).match(/失败/gu)?.length, 1,
      "the failed state is expressed once in the collapsed action copy");
    failedAction.open = true;
    failedAction.ontoggle?.({ isTrusted: false });
    assert.match(renderedText(failedAction), new RegExp(failedToolError, "u"),
      "the original backend error remains reachable after expansion");

    const createDiff = [
      "--- /dev/null",
      "+++ b/outputs/Result.md",
      "@@ -0,0 +1,7 @@",
      "+line 1",
      "+line 2",
      "+line 3",
      "+line 4",
      "+line 5",
      "+line 6",
      "+line 7"
    ].join("\n");
    const semanticById = new Map(semanticMessages.map((message) => [message.id, message]));
    const userFacingToolMessages: ChatMessage[] = [{
      id: "semantic-ui-user",
      role: "user",
      text: "核对用户化工具详情",
      runId: "run-semantic-tools",
      turnId: "run-semantic-tools",
      createdAt: 9_900
    }, {
      ...semanticById.get("semantic-search")!,
      files: [{
        name: "Alpha.md",
        path: "projects/Alpha.md",
        displayPath: "projects/Alpha.md",
        kind: "vault",
        openable: true
      }]
    }, {
      ...semanticById.get("semantic-read")!,
      processInput: JSON.stringify({ relativePath: "projects/Alpha.md" }),
      processOutput: JSON.stringify({
        snapshot: { relativePath: "projects/Alpha.md", content: "READ_PROTOCOL_BODY" }
      }),
      text: "READ_PROTOCOL_BODY",
      files: [{
        name: "Alpha.md",
        path: "projects/Alpha.md",
        displayPath: "projects/Alpha.md",
        kind: "vault",
        openable: true
      }]
    }, {
      ...semanticById.get("semantic-create")!,
      processInput: JSON.stringify({
        relativePath: "outputs/Result.md",
        content: ["line 1", "line 2", "line 3", "line 4", "line 5", "line 6", "line 7"].join("\n")
      }),
      processOutput: JSON.stringify({
        operationIdentity: "PROTOCOL_OPERATION_IDENTITY",
        readbackVerified: true,
        status: "completed",
        sourcePath: "outputs/Result.md"
      }),
      text: "PROTOCOL_OPERATION_IDENTITY",
      files: [{
        name: "Result.md",
        path: "outputs/Result.md",
        displayPath: "outputs/Result.md",
        kind: "vault",
        openable: true
      }],
      diffSummary: {
        totalFiles: 1,
        added: 7,
        removed: 0,
        files: [{ path: "outputs/Result.md", kind: "add", added: 7, removed: 0 }]
      },
      approval: {
        status: "approved",
        target: JSON.stringify({ relativePath: "outputs/Result.md" }),
        preview: JSON.stringify({
          operation: "note_create",
          relativePath: "outputs/Result.md",
          change: {
            kind: "add",
            relativePath: "outputs/Result.md",
            added: 7,
            removed: 0,
            diff: createDiff
          }
        })
      }
    }, semanticById.get("semantic-move")!, semanticById.get("semantic-delete")!,
    semanticById.get("semantic-command")!, semanticById.get("semantic-unknown")!, {
      ...semanticTool(
        "semantic-failure",
        "third_party_tool",
        JSON.stringify({ path: "Broken.md", operationIdentity: "HIDDEN_FAILURE_ID" }),
        JSON.stringify({ error: { message: "明确失败原因" }, readbackVerified: false })
      ),
      status: "failed"
    }, {
      id: "semantic-ui-answer",
      role: "assistant",
      text: "工具详情已核对",
      status: "completed",
      runId: "run-semantic-tools",
      turnId: "run-semantic-tools",
      createdAt: 10_200,
      completedAt: 10_300
    }];
    const userFacingProjection = buildAgentTurnProjection(userFacingToolMessages);
    const userFacingTurn = userFacingProjection[1]?.kind === "assistantTurn"
      ? userFacingProjection[1].turn
      : null;
    assert.ok(userFacingTurn);
    const userFacingSurface = new FakeElement("div");
    (ledgerRenderer as unknown as {
      renderAssistantTurn(
        container: unknown,
        turn: NonNullable<typeof userFacingTurn>,
        showAgentHeader: boolean
      ): void;
    }).renderAssistantTurn(userFacingSurface, userFacingTurn!, false);
    const userFacingRoot = userFacingSurface.findByClass("codex-message-type-assistantTurn")!;
    const userFacingActions = userFacingRoot.findAllByClass("codex-action-item");
    const userFacingAction = (id: string) => userFacingActions.find((action) =>
      action.dataset.messageId === id
    )!;
    const searchAction = userFacingAction("semantic-search");
    const readOnlyAction = userFacingAction("semantic-read");
    const createAction = userFacingAction("semantic-create");
    const moveAction = userFacingAction("semantic-move");
    const deleteAction = userFacingAction("semantic-delete");
    const commandAction = userFacingAction("semantic-command");
    const unknownAction = userFacingAction("semantic-unknown");
    const semanticFailure = userFacingAction("semantic-failure");
    assert.equal(readOnlyAction.hasClass("codex-action-item-expandable"), false,
      "a successful read with no extra user value has no disclosure or Chevron");
    assert.equal(readOnlyAction.findAllByClass("codex-action-item-caret").length, 0);
    assert.equal(renderedText(semanticFailure).match(/失败/gu)?.length, 1,
      "the collapsed failed Tool shows one failure state");
    assert.doesNotMatch(renderedText(semanticFailure), /明确失败原因/u);
    for (const action of [
      searchAction,
      createAction,
      moveAction,
      deleteAction,
      commandAction,
      unknownAction,
      semanticFailure
    ]) {
      action.open = true;
      action.ontoggle?.({ isTrusted: false });
    }
    assert.match(renderedText(searchAction), /查询EchoInk/u);
    assert.match(renderedText(searchAction), /1 条结果/u);
    assert.match(renderedText(searchAction), /projects\/EchoInk\.mdmatched/u);
    assert.doesNotMatch(renderedText(createAction), /已创建/u,
      "the file-diff icon replaces the repeated create verb prefix");
    assert.match(renderedText(createAction), /目标outputs\/Result\.md/u);
    const createPreviewText = createAction.findByClass("codex-action-preview-content")?.textContent ?? "";
    assert.match(createPreviewText, /line 1[\s\S]*line 6[\s\S]*…/u);
    assert.doesNotMatch(createPreviewText, /line 7/u,
      "the file body is a bounded preview with a real full-note exit");
    assert.equal(createAction.findAllByClass("codex-action-open-note").length, 1);
    assert.equal(createAction.findAllByClass("codex-smooth-ai-diff").length, 1,
      "the direct file Diff appears once inside the ToolContent");
    assert.match(renderedText(moveAction), /原路径Old\.md新路径New\.md/u);
    assert.match(renderedText(deleteAction), /Trash\.md已移到 Obsidian 回收站，可恢复/u);
    assert.match(renderedText(commandAction), /终端\$ npm run typecheck[\s\S]*typecheck passed/u);
    assert.match(renderedText(unknownAction), /third_party_create_everything/u);
    assert.doesNotMatch(renderedText(unknownAction), /已调用/u);
    assert.match(renderedText(unknownAction), /参数摘要pathUnknown\.md结果done/u);
    assert.match(renderedText(semanticFailure), /失败原因明确失败原因/u);
    const userFacingText = renderedText(userFacingRoot);
    for (const hiddenProtocol of [
      "PROTOCOL_OPERATION_IDENTITY",
      "HIDDEN_FAILURE_ID",
      "readbackVerified",
      "operationIdentity",
      "READ_PROTOCOL_BODY",
      "输入",
      "输出",
      "原始输出"
    ]) {
      assert.doesNotMatch(userFacingText, new RegExp(hiddenProtocol, "u"),
        `${hiddenProtocol} stays out of ordinary ToolContent`);
    }
    createAction.findByClass("codex-action-open-note")?.onclick?.({
      preventDefault: () => undefined,
      stopPropagation: () => undefined
    } as never);

    const sourcedToolProjection = buildAgentTurnProjection([{
      id: "sourced-tool-user",
      role: "user",
      text: "检索来源",
      runId: "run-sourced-tool",
      turnId: "run-sourced-tool",
      createdAt: 6_000
    }, {
      id: "sourced-tool",
      role: "tool",
      itemType: "dynamicToolCall",
      processKind: "search",
      title: "vault_search",
      text: "matched",
      status: "completed",
      citations: {
        status: "strong",
        counts: { wiki: 1, journal: 0, outputs: 0 },
        citations: [{
          bucket: "wiki",
          title: "Foo",
          path: "Foo.md",
          excerptLines: ["matched"],
          relevance: "strong",
          reason: "matched",
          score: 1
        }]
      },
      runId: "run-sourced-tool",
      turnId: "run-sourced-tool",
      createdAt: 6_100,
      completedAt: 6_200
    }, {
      id: "sourced-tool-answer",
      role: "assistant",
      text: "找到来源",
      status: "completed",
      runId: "run-sourced-tool",
      turnId: "run-sourced-tool",
      createdAt: 6_300,
      completedAt: 6_400
    }]);
    const sourcedToolTurn = sourcedToolProjection[1]?.kind === "assistantTurn"
      ? sourcedToolProjection[1].turn
      : null;
    assert.ok(sourcedToolTurn);
    const sourcedToolSurface = new FakeElement("div");
    (ledgerRenderer as unknown as {
      renderAssistantTurn(
        container: unknown,
        turn: NonNullable<typeof sourcedToolTurn>,
        showAgentHeader: boolean
      ): void;
    }).renderAssistantTurn(sourcedToolSurface, sourcedToolTurn!, false);
    assert.equal(sourcedToolSurface.findAllByClass("codex-action-item").length, 1);
    assert.equal(sourcedToolSurface.findAllByClass("codex-ai-elements-sources").length, 1,
      "a Sources node derived from the same Tool message keeps its own chronological projection");

    const englishProjection = buildAgentTurnProjection(siblingMessages, "en");
    const englishTurn = englishProjection[1]?.kind === "assistantTurn"
      ? englishProjection[1].turn
      : null;
    assert.ok(englishTurn, "the English projection retains the unified Assistant Turn");
    const englishRenderer = new CodexMessageListRenderer();
    bindRenderer(englishRenderer, context, "en");
    const englishSurface = new FakeElement("div");
    (englishRenderer as unknown as {
      renderAssistantTurn(
        container: unknown,
        turn: NonNullable<typeof englishTurn>,
        showAgentHeader: boolean
      ): void;
    }).renderAssistantTurn(englishSurface, englishTurn!, false);
    const englishRoot = englishSurface.findByClass("codex-message-type-assistantTurn")!;
    assert.equal(
      englishRoot.findAllByClass("codex-assistant-turn-summary-copy").length,
      0
    );
    assert.deepEqual(
      new Set(
        englishRoot.findAllByClass("codex-assistant-turn-section-primary")
          .map((label) => label.textContent)
      ),
      new Set(["Final Answer"])
    );
    assert.deepEqual(
      new Set(
        englishRoot.findAllByClass("codex-assistant-turn-section-secondary")
          .map((label) => label.textContent)
      ),
      new Set()
    );
    assert.ok(
      englishRoot.findAllByClass("codex-ai-elements-sources-label")
        .some((label) => label.textContent === "Used 1 document"),
      "English source chrome uses the Turn's single-source count"
    );
    assert.match(renderedText(englishRoot), /Thought for 2s/u);
    assert.doesNotMatch(renderedText(englishRoot), /Searched/u,
      "English ChainOfThought rows also omit action verb prefixes");
    assert.equal(
      englishRoot.findAllByClass("codex-action-item")
        .find((action) => action.dataset.messageId === "tool-separated")
        ?.findByClass("codex-action-item-title")?.textContent,
      "vault_search",
      "English action chrome strips a persisted Chinese Tool prefix without rewriting the tool name"
    );
    assert.doesNotMatch(renderedText(englishRoot), /使用工具/u,
      "English action chrome does not inherit the persisted Chinese Tool prefix");
    assert.equal(
      englishRoot.findAllByClass("codex-assistant-turn-action-ledger-summary").length,
      0,
      "English Tool ledgers also omit repeated quantities"
    );
    assert.ok(
      englishRoot.findAllByClass("codex-action-item-head")
        .some((head) => head.attributes.get("title") === "View file changes"),
      "English action details expose English accessible chrome"
    );
    assert.equal(englishRoot.findAllByClass("codex-assistant-turn-node-marker").length, 0,
      "English history also omits the status ring and completion check");
    for (const action of englishRoot.findAllByClass("codex-action-item-expandable")) {
      action.open = true;
      action.ontoggle?.({ isTrusted: false });
    }
    for (const canary of visibleTurnCanaries) {
      assert.match(renderedText(englishRoot), new RegExp(canary, "u"),
        `${canary} remains byte-for-byte visible in the English Turn`);
    }
    assert.doesNotMatch(
      renderedText(englishRoot),
      new RegExp(siblingCanaries.privateReasoning, "u"),
      "the English Turn does not expose private reasoning"
    );
  } finally {
    Date.now = originalDateNow;
    platform.isDesktopApp = previousDesktopApp;
    if (previousDocument === undefined) delete (globalThis as unknown as { document?: unknown }).document;
    else Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    if (previousHTMLElement === undefined) delete (globalThis as unknown as { HTMLElement?: unknown }).HTMLElement;
    else Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: previousHTMLElement });
    if (previousWindow === undefined) delete (globalThis as unknown as { window?: unknown }).window;
    else Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
  }

  assert.deepEqual(context.openedPaths, [
    "projects/Alpha.md",
    "outputs/Result.md",
    "outputs/Result.md",
    "projects/Alpha.md",
    "outputs/Result.md"
  ]);

  // Keep accessibility and overflow behavior; visual dimensions are not contracts.
  const styles = readFileSync("styles.css", "utf8");
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.codex-smooth-blur-out-up-unit \{[\s\S]*?animation:\s*none;/u);
  assert.match(styles, /\.codex-message-attachment-preview img\s*\{[^}]*object-fit:\s*contain;/u);
  assert.match(styles, /\.codex-assistant-turn-action-node > \.codex-action-item-head:focus-visible\s*\{[^}]*outline:/u);
  assert.match(styles, /\.codex-action-open-note:focus-visible,[\s\S]*?outline:/u);
  assert.match(styles, /\.codex-interaction-question-card\s*\{[^}]*overflow:\s*hidden;/u);
  assert.match(styles, /\.codex-interaction-question\s*\{[^}]*overflow-y:\s*auto;/u);
  assert.match(styles, /\.codex-interaction-actions\s*\{[^}]*flex:\s*0\s+0\s+auto;/u,
    "the Question controls stay visible while its body scrolls");

  const notices = readFileSync("THIRD_PARTY_NOTICES.md", "utf8");
  assert.match(notices, /Copyright \(c\) 2024 Eduardo Calvo/u);
  assert.match(notices, /Blur Out Up.*AI Message.*AI Reasoning.*AI Tool Call.*AI Artifact.*AI Task List/su);
  assert.match(notices, /## Vercel AI Elements[\s\S]*?6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/u);
  assert.match(notices, /Vercel AI Elements[\s\S]*?`Task`[\s\S]*?task\.tsx/u);
  assert.match(notices, /Vercel AI Elements[\s\S]*?`Question`[\s\S]*?`Confirmation`[\s\S]*?`Attachments`/u);
  assert.match(notices, /question\.tsx[\s\S]*?confirmation\.tsx[\s\S]*?attachments\.tsx/u);
  assert.match(notices, /Vercel AI Elements[\s\S]*?`Shimmer`[\s\S]*?shimmer\.tsx/u);
  assert.match(notices, /Copyright 2023 Vercel, Inc\.[\s\S]*?Apache License, Version 2\.0/u);
  assert.match(notices, /## AnimateIcons[\s\S]*?`Send Horizontal`[\s\S]*?`Circle Stop`/u);
  assert.match(notices, /send-horizontal-icon\.tsx[\s\S]*?circle-stop-icon\.tsx/u);
  assert.match(notices, /Copyright \(c\) 2025 Avijit Dey/u);

  console.log("PASS conversation-ui: one Assistant Turn, structured interaction Dock, durable Attachments, and truthful Provider Reasoning");
}
