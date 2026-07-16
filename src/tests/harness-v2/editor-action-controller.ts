import * as assert from "node:assert/strict";
import { EditorState, type Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { EditorActionController } from "../../editor-actions/controller";
import { editorActionCandidateField } from "../../editor-actions/editor-extension";
import type { EditorActionStatusView } from "../../editor-actions/types";
import { DEFAULT_SETTINGS, type CodexForObsidianSettings } from "../../settings/settings";
import { CodexRichAgentAdapter } from "../../harness/agents/adapters/codex-rich-adapter";
import { CodexRichNotificationHub } from "../../harness/agents/adapters/codex-rich-notification-hub";
import { EchoInkHarnessKernel } from "../../harness/kernel/harness-kernel";
import { InMemoryRunLedger } from "../../harness/ledger/run-ledger";
import { NoopMemoryProvider } from "../../harness/memory/noop-provider";
import { runEditorActionPromptTurn } from "../../ui/codex-view/editor-action-runner";

export async function runEditorActionControllerTests(): Promise<void> {
  await assertCandidateConfirmReplacesBodyAndClearsState();
  await assertEscapeCancelsCandidateAndKeepsBodyUntouched();
  await assertDocumentChangeInvalidatesActiveCandidate();
  await assertFileSwitchCancelsActiveCandidate();
  await assertEditorActionUsesAwaitResultInsteadOfRawDeltaWaiter();
}

async function assertCandidateConfirmReplacesBodyAndClearsState(): Promise<void> {
  const setup = createEditorActionHarness({
    text: "前文旧句子后文",
    selectionText: "旧句子",
    candidateReply: "<codex-candidate>新句子</codex-candidate>"
  });

  await setup.controller.runEditorActionById(setup.editor as any, setup.info as any, "rewrite");
  const candidate = readCandidate(setup.editor);
  assert.equal(candidate?.candidateText, "新句子");
  assert.equal(setup.editor.focusCalls, 1);
  assert.deepEqual(setup.view.statuses.map((status) => status.status), ["preparing", "awaiting-confirm"]);

  assert.deepEqual(setup.editor.pressWindowKey("Enter"), { defaultPrevented: true, immediatePropagationStopped: true });
  assert.equal(setup.editor.getValue(), "前文新句子后文");
  assert.equal(readCandidate(setup.editor), null);
  assert.equal(setup.view.lastStatus()?.status, "confirmed");
  assert.equal(setup.view.lastStatus()?.message, "已替换");
}

async function assertEscapeCancelsCandidateAndKeepsBodyUntouched(): Promise<void> {
  const setup = createEditorActionHarness({
    text: "前文旧句子后文",
    selectionText: "旧句子",
    candidateReply: "<codex-candidate>新句子</codex-candidate>"
  });
  await setup.controller.runEditorActionById(setup.editor as any, setup.info as any, "rewrite");

  assert.deepEqual(setup.editor.pressWindowKey("Escape"), { defaultPrevented: true, immediatePropagationStopped: true });
  assert.equal(setup.editor.getValue(), "前文旧句子后文");
  assert.equal(readCandidate(setup.editor), null);
  assert.equal(setup.view.lastStatus()?.status, "canceled");
  assert.equal(setup.view.lastStatus()?.message, "已取消");
}

async function assertDocumentChangeInvalidatesActiveCandidate(): Promise<void> {
  const setup = createEditorActionHarness({
    text: "前文旧句子后文",
    selectionText: "旧句子",
    candidateReply: "<codex-candidate>新句子</codex-candidate>"
  });
  await setup.controller.runEditorActionById(setup.editor as any, setup.info as any, "rewrite");

  setup.editor.replaceRange("！", setup.editor.offsetToPos(setup.editor.getValue().length), setup.editor.offsetToPos(setup.editor.getValue().length));
  setup.workspace.emit("editor-change", setup.editor);
  assert.equal(readCandidate(setup.editor), null);
  assert.equal(setup.editor.getValue(), "前文旧句子后文！");
  assert.equal(setup.view.lastStatus()?.status, "canceled");
  assert.equal(setup.view.lastStatus()?.message, "正文已变化，候选已取消");
  assert.equal(pressEditorActionKey(setup.editor, "Enter"), false);
}

async function assertFileSwitchCancelsActiveCandidate(): Promise<void> {
  const setup = createEditorActionHarness({
    text: "前文旧句子后文",
    selectionText: "旧句子",
    candidateReply: "<codex-candidate>新句子</codex-candidate>"
  });
  await setup.controller.runEditorActionById(setup.editor as any, setup.info as any, "rewrite");

  setup.workspace.activeFile = { path: "notes/other.md" };
  setup.workspace.emit("active-leaf-change");
  assert.equal(readCandidate(setup.editor), null);
  assert.equal(setup.editor.getValue(), "前文旧句子后文");
  assert.equal(setup.view.lastStatus()?.status, "canceled");
  assert.equal(setup.view.lastStatus()?.message, "已切换文件，候选已取消");
}

async function assertEditorActionUsesAwaitResultInsteadOfRawDeltaWaiter(): Promise<void> {
  const notificationHub = new CodexRichNotificationHub();
  const kernel = new EchoInkHarnessKernel({
    ledger: new InMemoryRunLedger(),
    memoryProvider: new NoopMemoryProvider()
  });
  const terminalCalls: string[] = [];
  let capturedRequest: any = null;
  const view: any = {
    plugin: {
      settings: structuredClone(DEFAULT_SETTINGS),
      getVaultPath: () => "/vault",
      getNativeExecutionRefContext: () => ({ deviceKey: "test-device", vaultId: "/vault" }),
      runHarnessWithAdapter: async (input: any) => {
        capturedRequest = input.request;
        return await kernel.runWithAdapter(input);
      },
      createCodexRichAgentAdapter: (options: any) => new CodexRichAgentAdapter({
        ...options,
        notificationHub,
        resumeThread: async () => undefined,
        startTurn: async (threadId: string) => {
          queueMicrotask(() => {
            notificationHub.dispatch({
              method: "item/completed",
              params: {
                item: {
                  id: "editor-item-1",
                  threadId,
                  turnId: "editor-turn-1",
                  type: "agentMessage",
                  text: "<codex-candidate>新句子</codex-candidate>"
                }
              }
            } as any);
            notificationHub.dispatch({
              method: "turn/completed",
              params: { threadId, turn: { id: "editor-turn-1", threadId, status: "completed" } }
            } as any);
          });
          return "editor-turn-1";
        },
        interruptTurn: async () => undefined
      }),
      settleHarnessRunTerminal: async (input: { status: string }) => {
        terminalCalls.push(input.status);
      }
    },
    selectedServiceTier: "auto",
    running: false,
    activeRunId: "",
    activeRunKind: "",
    activeRunSessionId: "",
    activeTurnId: "",
    editorActionThreadId: "",
    editorActionThreadIds: new Set<string>(),
    editorActionTurnIds: new Set<string>(),
    editorActionItemIds: new Set<string>(),
    editorActionCurrentItemIds: new Set<string>(),
    editorActionActiveTimeoutMs: 0,
    editorActionRun: null,
    takeEditorActionThread: async () => "editor-thread-1",
    releaseEditorActionRunLock: () => undefined,
    clearTurnWatchdog: () => undefined,
    clearActiveRun: () => undefined,
    applyStatus: () => undefined,
    setEditorActionStatus: () => undefined,
    armTurnWatchdog: () => undefined,
    prewarmEditorActionThread: () => undefined,
    effectiveEditorActionModel: (_available: string[], configured: string) => configured,
    withEditorActionTimeout: async (_promise: Promise<string>, _timeoutMs: number, message: string) => {
      throw new Error(message);
    }
  };
  view.plugin.settings.agentBackend = "codex-cli";

  const result = await runEditorActionPromptTurn(view, {
    prompt: "请改写这一句",
    actionLabel: "改写",
    qualityMode: "fast",
    modeLabel: "快速",
    model: "gpt-test",
    phase: "generating",
    statusMessage: "正在生成",
    timeoutMs: 50,
    startedAt: 1
  });

  assert.equal(result, "新句子");
  assert.deepEqual(terminalCalls, ["completed"]);
  assert.equal(capturedRequest.surface, "editor");
  assert.equal(capturedRequest.outputContract.kind, "editor-candidate");
  assert.equal(capturedRequest.permissions.mode, "read-only");
  assert.deepEqual(capturedRequest.permissions.writableRoots, []);
}

function createEditorActionHarness(input: {
  text: string;
  selectionText: string;
  candidateReply: string;
  filePath?: string;
}) {
  const filePath = input.filePath ?? "notes/test.md";
  const selectionStart = input.text.indexOf(input.selectionText);
  assert.notEqual(selectionStart, -1, "selectionText must exist in test document");
  const selectionEnd = selectionStart + input.selectionText.length;
  const workspace = new FakeWorkspace(filePath);
  const view = new FakeCodexView(input.candidateReply);
  const plugin = new FakePlugin(workspace, view);
  const controller = new EditorActionController(plugin as any);
  controller.register();
  const editor = new FakeEditor(input.text, plugin.editorExtensions);
  editor.setSelection(selectionStart, selectionEnd);
  return {
    controller,
    editor,
    info: { file: { path: filePath, name: "test.md", stat: { mtime: 1, size: input.text.length } } },
    view,
    workspace
  };
}

function readCandidate(editor: FakeEditor) {
  return editor.cm.state.field(editorActionCandidateField, false);
}

function pressEditorActionKey(editor: FakeEditor, key: string): boolean {
  const rawBindings = editor.cm.state.facet(keymap) as ReadonlyArray<any>;
  const bindings = rawBindings.flatMap((binding) => Array.isArray(binding) ? binding : [binding]);
  const binding = bindings.find((item) => item?.key === key);
  assert.ok(binding?.run, `Missing key binding: ${key}`);
  return binding.run({ state: editor.cm.state } as any);
}

class FakeWorkspace {
  activeFile: { path: string } | null;
  private readonly listeners = new Map<string, Array<(...args: any[]) => void>>();

  constructor(activeFilePath: string) {
    this.activeFile = { path: activeFilePath };
  }

  updateOptions(): void {}

  on(event: string, handler: (...args: any[]) => void): { event: string; handler: (...args: any[]) => void } {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), handler]);
    return { event, handler };
  }

  emit(event: string, ...args: any[]): void {
    for (const handler of this.listeners.get(event) ?? []) handler(...args);
  }

  getActiveFile(): { path: string } | null {
    return this.activeFile;
  }
}

class FakeCodexView {
  readonly requests: any[] = [];
  readonly statuses: EditorActionStatusView[] = [];

  constructor(private readonly candidateReply: string) {}

  async sendEditorActionRequest(request: any): Promise<string> {
    this.requests.push(request);
    return this.candidateReply;
  }

  setEditorActionStatus(status: EditorActionStatusView): void {
    this.statuses.push(status);
  }

  lastStatus(): EditorActionStatusView | undefined {
    return this.statuses.at(-1);
  }
}

class FakePlugin {
  readonly app: { workspace: FakeWorkspace };
  readonly settings: CodexForObsidianSettings;
  readonly editorExtensions: Extension[] = [];

  constructor(workspace: FakeWorkspace, private readonly view: FakeCodexView) {
    this.app = { workspace };
    this.settings = structuredClone(DEFAULT_SETTINGS);
    this.settings.editorActions.enabled = true;
    this.settings.editorActions.qualityMode = "fast";
  }

  registerEditorExtension(extension: Extension): void {
    this.editorExtensions.push(extension);
  }

  registerEvent(): void {}
  async activateView(): Promise<void> {}

  getCodexView(): FakeCodexView {
    return this.view;
  }
}

class FakeEditor {
  readonly cm: { state: EditorState; dispatch: (spec: any) => void; contentDOM: any };
  private readonly keyWindow = new FakeKeyWindow();
  private readonly contentTarget = {};
  focusCalls = 0;
  private selectionStart = 0;
  private selectionEnd = 0;

  constructor(text: string, extensions: Extension[]) {
    let state = EditorState.create({ doc: text, extensions });
    this.cm = {
      get state() { return state; },
      dispatch(spec: any) { state = state.update(spec).state; },
      contentDOM: {
        ownerDocument: { defaultView: this.keyWindow },
        contains: (target: unknown) => target === this.contentTarget
      }
    };
  }

  pressWindowKey(key: "Enter" | "Escape"): { defaultPrevented: boolean; immediatePropagationStopped: boolean } {
    return this.keyWindow.press(key, this.contentTarget);
  }

  setSelection(from: number, to: number): void {
    this.selectionStart = Math.min(from, to);
    this.selectionEnd = Math.max(from, to);
    this.cm.dispatch({ selection: { anchor: this.selectionStart, head: this.selectionEnd } });
  }

  getSelection(): string {
    return this.getValue().slice(this.selectionStart, this.selectionEnd);
  }

  listSelections(): Array<{ anchor: number; head: number }> {
    return [{ anchor: this.selectionStart, head: this.selectionEnd }];
  }

  getCursor(which: "from" | "to"): { line: number; ch: number } {
    return this.offsetToPos(which === "from" ? this.selectionStart : this.selectionEnd);
  }

  getValue(): string {
    return this.cm.state.doc.toString();
  }

  posToOffset(position: { line: number; ch: number }): number {
    assert.equal(position.line, 0, "FakeEditor only supports single-line documents");
    return position.ch;
  }

  offsetToPos(offset: number): { line: number; ch: number } {
    return { line: 0, ch: offset };
  }

  replaceRange(text: string, from: { line: number; ch: number }, to?: { line: number; ch: number }): void {
    const fromOffset = this.posToOffset(from);
    const toOffset = this.posToOffset(to ?? from);
    this.cm.dispatch({ changes: { from: fromOffset, to: toOffset, insert: text } });
    const cursor = fromOffset + text.length;
    this.selectionStart = cursor;
    this.selectionEnd = cursor;
  }

  focus(): void {
    this.focusCalls += 1;
  }
}

class FakeKeyWindow {
  private readonly listeners = new Set<(event: any) => void>();

  addEventListener(type: string, listener: (event: any) => void): void {
    if (type === "keydown") this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    if (type === "keydown") this.listeners.delete(listener);
  }

  press(key: string, target: unknown): { defaultPrevented: boolean; immediatePropagationStopped: boolean } {
    const result = { defaultPrevented: false, immediatePropagationStopped: false };
    const event = {
      key,
      target,
      isComposing: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      preventDefault: () => { result.defaultPrevented = true; },
      stopImmediatePropagation: () => { result.immediatePropagationStopped = true; }
    };
    for (const listener of [...this.listeners]) {
      listener(event);
      if (result.immediatePropagationStopped) break;
    }
    return result;
  }
}
