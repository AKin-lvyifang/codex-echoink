import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Platform, TFile, type App } from "obsidian";
import { openTestNoticeMessages } from "./obsidian-shim";
import type { EchoInkResource } from "../resources/types";
import {
  renderComposerAttachments,
  renderComposerNoteMentionMenu,
  renderComposerResourcePanel,
  renderComposerToolbar,
  refreshComposerShellCopy,
  labelFor,
  type ComposerToolbarCallbacks,
  type ComposerToolbarState
} from "../ui/codex-view/composer";
import {
  attachmentPresentationIcon,
  attachmentPresentationKind,
  createAttachmentResourceResolver
} from "../ui/codex-view/attachment-resource";
import { buildNoteMentionCatalog } from "../ui/codex-view/note-mentions";
import {
  currentDisplayedMarkdownFile,
  openComposerAttachment
} from "../ui/codex-view/attachments";
import {
  composerModelMenuState,
  composerProviderModelOptions,
  selectComposerModel,
  selectComposerReasoning
} from "../ui/codex-view/composer-controller";
import {
  closeComposerParameterMenu,
  openModelMenu
} from "../ui/codex-view/menus";
import {
  createApiProviderConfig,
  createApiProviderModelConfig,
  DEFAULT_SETTINGS,
  normalizeSettingsData
} from "../settings/settings";

export async function runComposerActionTests(): Promise<void> {
  const originalDocument = globalThis.document;
  const originalHTMLElement = (globalThis as unknown as {
    HTMLElement?: unknown;
  }).HTMLElement;
  const originalMutationObserver = (globalThis as unknown as {
    MutationObserver?: unknown;
  }).MutationObserver;
  const testDocument = new ComposerTestDocument();
  (globalThis as unknown as { document: Document }).document = testDocument as unknown as Document;
  (globalThis as unknown as { HTMLElement: unknown }).HTMLElement = ComposerTestElement;
  (globalThis as unknown as { MutationObserver: unknown }).MutationObserver =
    ComposerTestMutationObserver;
  try {
    const send = renderAction();
    assert.equal(send.context.getAttribute("aria-label"), "查看上下文用量");
    assert.equal(send.context.hasClass("is-hidden"), false);
    send.context.onclick?.({
      preventDefault: () => undefined,
      stopPropagation: () => undefined
    });
    assert.equal(send.calls.context, 1, "Composer context meter remains available without a settings gate");
    assert.equal(send.primary.getAttribute("aria-label"), "发送");
    assert.equal(send.primary.hasClass("is-send-action"), true);
    assert.equal(send.primary.querySelectorAll(".echoink-animate-icon-send-horizontal").length, 1);
    assert.equal(
      send.primary.querySelector("path")?.getAttribute("d"),
      "M3.714 3.048a.498.498 0 0 0-.683.627l2.843 7.627a2 2 0 0 1 0 1.396l-2.842 7.627a.498.498 0 0 0 .682.627l18-8.5a.5.5 0 0 0 0-.904z"
    );
    assert.equal(send.primary.querySelectorAll("path")[1]?.getAttribute("d"), "M6 12h16");
    send.primary.click();
    assert.equal(send.calls.send, 1, "ordinary send keeps onSendMessage");
    send.mic.click();
    assert.equal(send.calls.mic, 1, "Mic keeps onMicInput");
    assert.equal(send.mic.getAttribute("aria-label"), "语音输入");
    assert.equal(send.mic.querySelectorAll(".echoink-animate-icon-mic").length, 1);
    assert.equal(send.mic.querySelector("rect")?.getAttribute("rx"), "3");

    const enqueue = renderAction({ running: true, hasDraft: true });
    assert.equal(enqueue.primary.hasClass("is-queue-action"), true);
    assert.equal(enqueue.primary.querySelector(".echoink-animate-icon-send-horizontal"), null);
    enqueue.primary.click();
    assert.equal(enqueue.calls.enqueue, 1);

    const stop = renderAction({ running: true, hasDraft: false });
    assert.equal(stop.primary.hasClass("is-stop-action"), true);
    assert.equal(stop.primary.querySelectorAll(".echoink-animate-icon-circle-stop").length, 1);
    assert.equal(stop.primary.querySelector("circle")?.getAttribute("r"), "10");
    assert.equal(stop.primary.querySelector("rect")?.getAttribute("rx"), "1");
    stop.primary.click();
    assert.equal(stop.calls.stop, 1);

    const resume = renderAction({ hasQueuedItems: true, hasDraft: false });
    assert.equal(resume.primary.getAttribute("aria-label"), "继续队列");
    resume.primary.click();
    assert.equal(resume.calls.resume, 1);

    const cancelKnowledge = renderAction({ knowledgeTaskRunning: true });
    cancelKnowledge.primary.click();
    assert.equal(cancelKnowledge.calls.cancelKnowledge, 1);

    const disabled = renderAction({ promptEnhancerRunning: true });
    assert.equal(disabled.primary.disabled, true);
    assert.equal(disabled.primary.getAttribute("aria-label"), "提示词增强中");

    const englishSend = renderAction({ language: "en" });
    assert.equal(englishSend.context.getAttribute("aria-label"), "View context usage");
    assert.equal(englishSend.primary.getAttribute("aria-label"), "Send");
    assert.equal(englishSend.mic.getAttribute("aria-label"), "Voice input");

    const persistentComposerShell = new ComposerTestElement("div");
    const persistentDraft = persistentComposerShell.createEl("textarea", {
      cls: "codex-input"
    });
    persistentDraft.value = "这段用户输入必须保持不变";
    const commandMenu = persistentComposerShell.createDiv({
      cls: "codex-knowledge-command-menu"
    });
    const persistentResourcePanel = persistentComposerShell.createDiv({
      cls: "codex-composer-resource-panel"
    });
    const noteMentionPanel = persistentComposerShell.createDiv({
      cls: "codex-composer-resource-panel codex-note-mention-menu"
    });
    refreshComposerShellCopy(persistentComposerShell as unknown as HTMLElement, "en");
    assert.equal(persistentDraft.value, "这段用户输入必须保持不变");
    assert.equal(persistentDraft.getAttribute("aria-label"), "Enter a message, command, or enabled Skill");
    assert.equal(commandMenu.getAttribute("aria-label"), "Commands and enabled Skills");
    assert.equal(persistentResourcePanel.getAttribute("aria-label"), "Add resources");
    assert.equal(noteMentionPanel.getAttribute("aria-label"), "Mention notes");

    const selectedBuiltinSkill: EchoInkResource = {
      id: "echoink-local:skill:knowledge-review", kind: "skill", source: "echoink-local",
      name: "knowledge-review", description: "", enabled: true, bridgeMode: "prompt-only",
      contentPath: ".echoink/resources/skills/knowledge-review/SKILL.md",
      metadata: { resourceId: "knowledge-review" }
    };
    const skillChips = new ComposerTestElement("div");
    const selectedSkillState = {
      selectedSkill: selectedBuiltinSkill, noteMentions: [], attachments: [], attachmentResolver: {} as never
    };
    const skillCallbacks = {
      onRemoveSkill: () => {}, onRemoveNoteMention: () => {}, onRemoveAttachment: () => {}, onOpenAttachment: () => {}
    };
    renderComposerAttachments(skillChips as unknown as HTMLElement, { ...selectedSkillState, language: "zh-CN" }, skillCallbacks);
    assert.equal(skillChips.querySelector(".codex-skill-token-name")?.textContent, "知识复盘");
    renderComposerAttachments(skillChips as unknown as HTMLElement, { ...selectedSkillState, language: "en" }, skillCallbacks);
    assert.equal(skillChips.querySelector(".codex-skill-token-name")?.textContent, "Knowledge Review");
    assert.equal(selectedSkillState.selectedSkill, selectedBuiltinSkill, "language changes preserve the selected Skill object");
    assert.equal(selectedBuiltinSkill.name, "knowledge-review", "display labels preserve the runtime Skill name");
    assert.equal(persistentDraft.value, "这段用户输入必须保持不变");

    const attachmentContainer = new ComposerTestElement("div");
    const removedAttachments: string[] = [];
    const removedNoteMentions: string[] = [];
    const openedAttachments: string[] = [];
    const vaultFile = Object.assign(Object.create(TFile.prototype), {
      path: "cover #1.png"
    }) as TFile;
    const meetingFile = Object.assign(Object.create(TFile.prototype), {
      path: "meeting.mp4"
    }) as TFile;
    const currentNote = Object.assign(Object.create(TFile.prototype), {
      path: "projects/当前笔记.md",
      name: "当前笔记.md"
    }) as TFile;
    const currentNoteApp = {
      workspace: {
        getActiveFile: () => currentNote,
        getLeavesOfType: () => [{
          view: {
            file: currentNote,
            containerEl: { isShown: () => true }
          }
        }]
      }
    } as unknown as App;
    assert.equal(currentDisplayedMarkdownFile(currentNoteApp)?.path, currentNote.path);
    const hiddenNoteApp = {
      workspace: {
        getActiveFile: () => currentNote,
        getLeavesOfType: () => [{
          view: {
            file: currentNote,
            containerEl: { isShown: () => false }
          }
        }]
      }
    } as unknown as App;
    assert.equal(currentDisplayedMarkdownFile(hiddenNoteApp), null,
      "a previously active Markdown note cannot be added after it stops displaying");
    const attachmentResolver = createAttachmentResourceResolver({
      vault: {
        getAbstractFileByPath: (path: string) => path === vaultFile.path
          ? vaultFile
          : path === meetingFile.path ? meetingFile : null,
        getResourcePath: (file: TFile) => `app://echoink-vault/${encodeURIComponent(file.path)}`
      }
    } as unknown as App, "/tmp/Echo Ink");
    const platform = Platform as { isDesktopApp: boolean };
    const originalDesktopApp = platform.isDesktopApp;
    const originalWindow = (globalThis as unknown as { window?: unknown }).window;
    const electronOpenedPaths: string[] = [];
    const electronShownPaths: string[] = [];
    platform.isDesktopApp = true;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
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
      const unindexedLocalImage = createAttachmentResourceResolver({
        vault: {
          adapter: {
            getResourcePath: (path: string) => `app://echoink-hidden/${path}`
          },
          getAbstractFileByPath: () => null,
          getResourcePath: () => ""
        }
      } as unknown as App, process.cwd()).resolve({
        type: "image",
        name: "clipboard-1720000000000-0.png",
        path: `${process.cwd()}/src/tests/composer-actions.ts`
      });
      assert.equal(unindexedLocalImage.availability, "available");
      assert.equal(unindexedLocalImage.vaultRelativePath, "src/tests/composer-actions.ts");
      assert.equal(
        unindexedLocalImage.resourceUri,
        "app://echoink-hidden/src/tests/composer-actions.ts",
        "hidden Vault resources use the adapter URI that Obsidian's renderer can load"
      );
      await openComposerAttachment({
        plugin: { getVaultPath: () => "/tmp/Echo Ink" }
      } as never, {
        type: "file",
        name: "meeting.mp4",
        path: "/tmp/Echo Ink/meeting.mp4",
        mimeType: "video/mp4"
      });
      assert.deepEqual(electronOpenedPaths, ["/tmp/Echo Ink/meeting.mp4"]);
      assert.deepEqual(
        electronShownPaths,
        [],
        "Composer FileCard opens with the system default app instead of revealing in Finder"
      );
    } finally {
      platform.isDesktopApp = originalDesktopApp;
      if (originalWindow === undefined) {
        delete (globalThis as unknown as { window?: unknown }).window;
      } else {
        Object.defineProperty(globalThis, "window", {
          configurable: true,
          value: originalWindow
        });
      }
    }
    for (const [attachment, kind, icon] of [
      [{ type: "file", name: "clip.mp4", path: "/tmp/clip.mp4", mimeType: "video/mp4" }, "video", "film"],
      [{ type: "file", name: "brief.pdf", path: "/tmp/brief.pdf" }, "pdf", "file-text"],
      [{ type: "file", name: "budget.xlsx", path: "/tmp/budget.xlsx" }, "spreadsheet", "table-2"],
      [{ type: "file", name: "proposal.docx", path: "/tmp/proposal.docx" }, "document", "file-pen-line"],
      [{ type: "file", name: "demo.pptx", path: "/tmp/demo.pptx" }, "presentation", "presentation"],
      [{ type: "file", name: "assets.zip", path: "/tmp/assets.zip" }, "archive", "archive"],
      [{ type: "file", name: "notes.txt", path: "/tmp/notes.txt" }, "text", "align-left"],
      [{ type: "file", name: "view.ts", path: "/tmp/view.ts" }, "code", "code"],
      [{ type: "file", name: "blob.bin", path: "/tmp/blob.bin" }, "unknown", "file"]
    ] as const) {
      assert.equal(attachmentPresentationKind(attachment), kind);
      assert.equal(attachmentPresentationIcon(attachment), icon);
    }
    renderComposerAttachments(
      attachmentContainer as unknown as HTMLElement,
      {
        selectedSkill: null,
        noteMentions: [{ vaultRelativePath: "projects/项目复盘.md", fileName: "项目复盘.md" }],
        attachments: [
          { type: "image", name: "cover #1.png", path: "/tmp/Echo Ink/cover #1.png" },
          { type: "file", name: "meeting.mp4", path: meetingFile.path, mimeType: "video/mp4" },
          { type: "image", name: "clipboard-1720000000000-1.png", path: "/tmp/Echo Ink/missing.png" }
        ],
        attachmentResolver
      },
      {
        onRemoveSkill: () => undefined,
        onRemoveNoteMention: (path) => removedNoteMentions.push(path),
        onRemoveAttachment: (path) => removedAttachments.push(path),
        onOpenAttachment: (attachment) => openedAttachments.push(attachment.path)
      }
    );
    const noteChip = attachmentContainer.querySelector(".codex-note-mention-chip")!;
    assert.equal(noteChip.querySelector(".codex-note-mention-chip-name")?.textContent, "项目复盘.md");
    assert.doesNotMatch(renderedComposerText(noteChip), /projects|全文|拼音/u);
    noteChip.querySelector(".codex-note-mention-chip-remove")?.click();
    assert.deepEqual(removedNoteMentions, ["projects/项目复盘.md"]);
    const thumbnail = attachmentContainer.querySelector(".codex-attachment-thumbnail")!;
    const image = thumbnail.querySelector("img")!;
    assert.equal(image.src, "app://echoink-vault/cover%20%231.png");
    assert.equal(thumbnail.getAttribute("title"), "cover #1.png");
    assert.equal(thumbnail.getAttribute("role"), "listitem");
    assert.equal(thumbnail.querySelector(".codex-attachment-thumbnail-name"), null,
      "a loadable image is only a real thumbnail; its filename remains in title and aria metadata");
    image.onerror?.();
    assert.equal(thumbnail.hasClass("is-broken"), true, "unsupported image switches to its fallback");
    assert.ok(thumbnail.querySelector(".codex-attachment-thumbnail-fallback"));
    assert.equal(thumbnail.getAttribute("aria-label"), "图片：cover #1.png，无法预览");
    const imageRemove = thumbnail.querySelector(".codex-attachment-thumbnail-remove")!;
    assert.equal(imageRemove.getAttribute("aria-label"), "移除图片：cover #1.png");
    imageRemove.click();

    const fileCard = attachmentContainer.querySelector(".codex-file-card-compact")!;
    assert.equal(fileCard.getAttribute("title"), "meeting.mp4");
    assert.equal(fileCard.getAttribute("data-attachment-kind"), "video");
    assert.ok(fileCard.querySelector(".codex-file-card-icon"));
    assert.equal(fileCard.querySelector(".codex-file-card-name")?.textContent, "meeting.mp4");
    assert.equal(fileCard.querySelector(".codex-file-card-meta")?.textContent, "大小未知");
    const fileOpen = fileCard.querySelector(".codex-file-card-open")!;
    assert.equal(fileOpen.getAttribute("aria-label"), "打开附件：meeting.mp4");
    fileOpen.onclick?.({
      preventDefault: () => undefined,
      stopPropagation: () => undefined
    } as never);
    assert.deepEqual(openedAttachments, [meetingFile.path]);
    const fileRemove = fileCard.querySelector(".codex-file-card-remove")!;
    assert.equal(fileRemove.getAttribute("aria-label"), "移除文件：meeting.mp4");
    fileRemove.onclick?.({
      preventDefault: () => undefined,
      stopPropagation: () => undefined
    } as never);
    const attachmentList = attachmentContainer.querySelector(".codex-ai-elements-attachments-list")!;
    assert.equal(attachmentList.getAttribute("data-ai-elements-pattern"), "attachments");
    assert.equal(attachmentList.getAttribute("data-attachment-variant"), "grid");
    assert.equal(attachmentList.getAttribute("role"), "list");
    const thumbnails = attachmentContainer.querySelectorAll(".codex-attachment-thumbnail");
    const missingThumbnail = thumbnails[1]!;
    assert.equal(missingThumbnail.hasClass("is-broken"), true);
    assert.equal(missingThumbnail.getAttribute("aria-label"), "图片：粘贴图片 2.png，无法预览");
    assert.equal(
      missingThumbnail.querySelector(".codex-attachment-thumbnail-name")?.textContent,
      "粘贴图片 2.png · 无法预览"
    );
    assert.doesNotMatch(renderedComposerText(attachmentContainer), /clipboard-/u);
    assert.deepEqual(removedAttachments, [
      "/tmp/Echo Ink/cover #1.png",
      meetingFile.path
    ]);

    const noteMenu = new ComposerTestElement("div") as ComposerTestElement & { id: string };
    noteMenu.id = "note-mention-menu";
    const noteInput = new ComposerTestElement("textarea");
    let selectedMention = "";
    const noteResults = buildNoteMentionCatalog([{
      vaultRelativePath: "projects/项目复盘.md",
      fileName: "项目复盘.md",
      aliases: ["周会总结"]
    }]);
    renderComposerNoteMentionMenu(
      noteMenu as unknown as HTMLElement,
      noteInput as unknown as HTMLTextAreaElement,
      { open: true, results: noteResults, activeIndex: 0 },
      { onSelect: (entry) => { selectedMention = entry.vaultRelativePath; } }
    );
    assert.equal(noteMenu.getAttribute("role"), null);
    assert.equal(noteMenu.querySelector(".codex-note-mention-option")?.getAttribute("role"), "option");
    assert.equal(noteInput.getAttribute("aria-activedescendant"), "note-mention-menu-option-0");
    assert.match(renderedComposerText(noteMenu), /项目复盘\.md/u);
    assert.doesNotMatch(renderedComposerText(noteMenu), /projects|周会总结|全文|拼音/u,
      "mention options expose the filename only");
    let pointerPrevented = false;
    (noteMenu.querySelector(".codex-note-mention-option") as unknown as {
      onpointerdown(event: { preventDefault(): void; stopPropagation(): void }): void;
    }).onpointerdown({
      preventDefault: () => { pointerPrevented = true; },
      stopPropagation: () => undefined
    });
    assert.equal(pointerPrevented, true, "mouse and touch pointer selection keeps textarea focus");
    assert.equal(selectedMention, "projects/项目复盘.md");

    const resourcePanel = new ComposerTestElement("div");
    renderComposerResourcePanel(
      resourcePanel as unknown as HTMLElement,
      {
        open: true,
        selectedSkill: null,
        selectedMode: "agent",
        resources: [],
        resourceSettings: { mcpConnections: {} },
        language: "zh-CN",
        canAttachActiveFile: false
      },
      {
        onDismiss: () => undefined,
        onPickFiles: () => undefined,
        onAttachActiveFile: () => undefined,
        onSelectPlanMode: () => undefined,
        onSelectSkill: () => undefined,
        onOpenMcpSettings: () => undefined
      }
    );
    const resourceRows = resourcePanel.querySelectorAll(".codex-composer-resource-row");
    assert.equal(resourceRows[1]?.disabled, true, "current note row is disabled without a displayed Markdown note");
    resourceRows[0]?.focus();
    resourcePanel.onkeydown?.(keyEvent("ArrowDown"));
    assert.equal(testDocument.activeElement, resourceRows[2],
      "resource panel ArrowDown skips the disabled current-note row");

    const missing = attachmentResolver.resolve({
      type: "image",
      name: "clipboard-1720000000000-0.png",
      path: "/tmp/Echo Ink/missing.png"
    });
    assert.equal(missing.displayName, "粘贴图片 1.png");
    assert.equal(missing.availability, "unavailable");
    assert.equal(missing.resourceUri, undefined);

    const composerSource = readFileSync("src/ui/codex-view/composer.ts", "utf8");
    const codexViewSource = readFileSync("src/ui/codex-view.ts", "utf8");
    const css = readFileSync("styles.css", "utf8");
    const turnRunnerSource = readFileSync("src/ui/codex-view/turn-runner.ts", "utf8");
    assert.match(composerSource, /renderAnimateIcon\(sendButton, "send-horizontal"\)/u);
    assert.match(composerSource, /renderAnimateIcon\(sendButton, "circle-stop"\)/u);
    assert.match(composerSource, /queueEl[\s\S]*workspaceEl[\s\S]*attachmentsEl[\s\S]*inputEl/u);
    const refreshLanguageSource = codexViewSource.match(
      /refreshLanguage\(\): void \{[\s\S]*?\n  \}/u
    )?.[0] ?? "";
    assert.match(refreshLanguageSource, /refreshViewShellCopy\(this\.shellHost\(\)\)/u);
    assert.match(refreshLanguageSource, /this\.renderMessages\(\{ preserveScroll: true \}\)/u);
    assert.match(refreshLanguageSource, /this\.renderToolbar\(\)/u);
    assert.doesNotMatch(refreshLanguageSource, /this\.render\(\)/u,
      "language refresh changes existing chrome instead of rebuilding the Composer and losing its draft");
    assert.match(css, /@keyframes echoink-animate-send-horizontal/u);
    assert.match(css, /@keyframes echoink-animate-circle-stop-ring/u);
    assert.match(css, /@keyframes echoink-animate-circle-stop-symbol/u);
    assert.match(css, /@keyframes echoink-animate-mic/u);
    assert.match(css, /prefers-reduced-motion:\s*no-preference/u);
    assert.match(css, /\.codex-attachment-thumbnail-image \{[\s\S]*?object-fit:\s*contain;/u);
    assert.match(css, /\.codex-ai-elements-attachments-list \{[\s\S]*?flex-wrap:\s*nowrap;[\s\S]*?overflow-x:\s*auto;/u);
    assert.match(css, /\.codex-message-attachments \{[\s\S]*?flex-wrap:\s*nowrap;[\s\S]*?justify-content:\s*safe\s+flex-end;[\s\S]*?overflow-x:\s*auto;/u);
    assert.match(css, /\.codex-composer-send-button\.codex-send-button\.is-stop-action:is\(:hover, :focus-visible\)[\s\S]*?--echoink-conversation-status-danger/u);
    assert.doesNotMatch(turnRunnerSource, /Pi Chat 的附件入口尚未完成切换，本轮没有发送/u);
    assert.match(turnRunnerSource, /preparePiChatImages/u);
    assert.match(turnRunnerSource, /preparedImages\.length/u);
    await assertExactComposerProviderModelSelection();
    assertAdaptiveComposerReasoning();
    assertDefaultSkillSettingsNormalization();
    console.log("PASS conversation-ui: composer actions, compact attachments, and exact Provider/model selection preserve send semantics");
  } finally {
    (globalThis as unknown as { document?: Document }).document = originalDocument;
    if (originalHTMLElement === undefined) {
      delete (globalThis as unknown as { HTMLElement?: unknown }).HTMLElement;
    } else {
      (globalThis as unknown as { HTMLElement: unknown }).HTMLElement = originalHTMLElement;
    }
    if (originalMutationObserver === undefined) {
      delete (globalThis as unknown as { MutationObserver?: unknown }).MutationObserver;
    } else {
      (globalThis as unknown as { MutationObserver: unknown }).MutationObserver =
        originalMutationObserver;
    }
  }
}

function assertDefaultSkillSettingsNormalization(): void {
  const normalized = normalizeSettingsData({
    ...structuredClone(DEFAULT_SETTINGS),
    productGeneration: "pi-agent-product-v1",
    sessions: [{
      id: "review-session",
      title: "Knowledge review",
      kind: "chat",
      defaultSkillId: "  knowledge-review  ",
      cwd: "/disposable-vault",
      messages: [],
      createdAt: 1,
      updatedAt: 1
    }],
    activeSessionId: "review-session"
  }).settings;
  assert.equal(normalized.sessions[0]?.defaultSkillId, "knowledge-review");
}

function assertAdaptiveComposerReasoning(): void {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const provider = createApiProviderConfig("deepseek", "adaptive-reasoning");
  provider.apiKey = "fixture-key";
  const alternate = createApiProviderModelConfig(
    "deepseek",
    "deepseek-v4-pro"
  );
  alternate.reasoningEnabled = false;
  alternate.reasoningEffort = "high";
  provider.models.push(alternate);
  settings.apiProviders = [provider];
  settings.activeApiProviderId = provider.id;
  settings.defaultModel = provider.defaultModelId;
  const primary = provider.models.find(
    (model) => model.id === provider.defaultModelId
  );
  assert.ok(primary);
  primary.reasoningEnabled = false;
  primary.reasoningEffort = "xhigh";

  let saveCount = 0;
  let renderCount = 0;
  const host: any = {
    plugin: {
      settings,
      saveSettings: async () => { saveCount += 1; }
    },
    selectedProviderSettingsId: provider.id,
    selectedModel: primary.id,
    selectedPermission: settings.defaultPermission,
    selectedMode: settings.defaultMode,
    effectiveModel: () => host.selectedModel,
    renderToolbar: () => { renderCount += 1; }
  };

  openTestNoticeMessages.length = 0;
  const disabledDeepSeek = composerModelMenuState(host);
  assert.equal(disabledDeepSeek.selectedReasoning, "none");
  assert.equal(disabledDeepSeek.reasoningCurrentValue, "关闭");
  assert.equal(disabledDeepSeek.reasoningAdjustable, false);
  assert.match(disabledDeepSeek.reasoningDisabledReason, /模型设置中开启深度思考/u);
  assert.deepEqual(disabledDeepSeek.reasoningOptions, []);
  assert.equal(primary.reasoningEffort, "xhigh", "disabled models retain their last strength");
  assert.equal(saveCount, 0);
  assert.deepEqual(openTestNoticeMessages, []);

  primary.reasoningEnabled = true;
  const deepSeek = composerModelMenuState(host);
  assert.equal(primary.reasoningEffort, "high");
  assert.equal(deepSeek.selectedReasoning, "high");
  assert.equal(deepSeek.reasoningCurrentValue, "高");
  assert.equal(deepSeek.reasoningAdjustable, true);
  assert.equal(deepSeek.reasoningDisabledReason, "");
  assert.deepEqual(
    deepSeek.reasoningOptions.map((option) => [option.effort, option.label]),
    [["high", "高"], ["max", "最高"]]
  );
  assert.equal(saveCount, 1);
  assert.match(openTestNoticeMessages.at(-1) ?? "", /原思考强度已不可用，已回落为高/u);
  assert.deepEqual(
    (["minimal", "low", "medium", "high", "xhigh", "max"] as const)
      .map((effort) => [effort, labelFor(effort)]),
    [
      ["minimal", "低"],
      ["low", "低"],
      ["medium", "中"],
      ["high", "高"],
      ["xhigh", "极高"],
      ["max", "最高"]
    ]
  );

  const invalidStoredProvider = createApiProviderConfig(
    "deepseek",
    "invalid-stored-reasoning"
  );
  invalidStoredProvider.apiKey = "fixture-key";
  const invalidStoredModel = invalidStoredProvider.models[0] as typeof primary & {
    reasoningEffort: string;
  };
  invalidStoredModel.reasoningEnabled = true;
  invalidStoredModel.reasoningEffort = "turbo";
  const invalidStoredSettings = structuredClone(
    normalizeSettingsData({
      ...structuredClone(DEFAULT_SETTINGS),
      settingsVersion: 53,
      activeApiProviderId: invalidStoredProvider.id,
      defaultModel: invalidStoredModel.id,
      apiProviders: [invalidStoredProvider]
    }).settings
  );
  const normalizedInvalidProvider = invalidStoredSettings.apiProviders[0];
  const normalizedInvalidModel = normalizedInvalidProvider?.models[0];
  assert.ok(normalizedInvalidProvider && normalizedInvalidModel);
  let invalidSaveCount = 0;
  const invalidHost: any = {
    plugin: {
      settings: invalidStoredSettings,
      saveSettings: async () => { invalidSaveCount += 1; }
    },
    selectedProviderSettingsId: normalizedInvalidProvider.id,
    selectedModel: normalizedInvalidModel.id,
    selectedPermission: invalidStoredSettings.defaultPermission,
    selectedMode: invalidStoredSettings.defaultMode,
    effectiveModel: () => invalidHost.selectedModel,
    renderToolbar: () => undefined
  };
  openTestNoticeMessages.length = 0;
  composerModelMenuState(invalidHost);
  assert.equal(normalizedInvalidModel.reasoningEffort, "high");
  assert.equal(invalidSaveCount, 1);
  assert.match(
    openTestNoticeMessages.at(-1) ?? "",
    /原思考强度已不可用，已回落为高/u
  );
  assert.doesNotMatch(JSON.stringify(invalidStoredSettings), /turbo/u);

  const missingProvider = createApiProviderConfig(
    "deepseek",
    "missing-stored-reasoning"
  );
  missingProvider.apiKey = "fixture-key";
  const missingModel = missingProvider.models[0];
  assert.ok(missingModel);
  missingModel.reasoningEnabled = true;
  const missingSettings = normalizeSettingsData({
    ...structuredClone(DEFAULT_SETTINGS),
    settingsVersion: 53,
    activeApiProviderId: missingProvider.id,
    defaultModel: missingProvider.defaultModelId,
    apiProviders: [missingProvider]
  }).settings;
  const normalizedMissingProvider = missingSettings.apiProviders[0];
  const normalizedMissingModel = normalizedMissingProvider?.models[0];
  assert.ok(normalizedMissingProvider && normalizedMissingModel);
  let missingSaveCount = 0;
  const missingHost: any = {
    plugin: {
      settings: missingSettings,
      saveSettings: async () => { missingSaveCount += 1; }
    },
    selectedProviderSettingsId: normalizedMissingProvider.id,
    selectedModel: normalizedMissingModel.id,
    selectedPermission: missingSettings.defaultPermission,
    selectedMode: missingSettings.defaultMode,
    effectiveModel: () => missingHost.selectedModel,
    renderToolbar: () => undefined
  };
  openTestNoticeMessages.length = 0;
  composerModelMenuState(missingHost);
  assert.equal(normalizedMissingModel.reasoningEffort, "high");
  assert.equal(missingSaveCount, 1);
  assert.deepEqual(openTestNoticeMessages, []);

  selectComposerReasoning(host, "max");
  assert.equal(primary.reasoningEffort, "max");
  assert.equal(saveCount, 2);
  assert.equal(renderCount, 1);

  host.selectedModel = alternate.id;
  const restored = composerModelMenuState(host);
  assert.equal(restored.selectedReasoning, "none");
  assert.equal(restored.reasoningCurrentValue, "关闭");
  assert.deepEqual(restored.reasoningOptions, []);
  assert.equal(alternate.reasoningEffort, "high");
  assert.equal(primary.reasoningEffort, "max");

  alternate.reasoningEnabled = true;
  const restoredEnabled = composerModelMenuState(host);
  assert.equal(restoredEnabled.selectedReasoning, "high");
  assert.equal(restoredEnabled.reasoningCurrentValue, "高");
  assert.deepEqual(
    restoredEnabled.reasoningOptions.map((option) => option.effort),
    ["high", "max"]
  );
  host.selectedModel = primary.id;
  assert.equal(composerModelMenuState(host).selectedReasoning, "max");

  const qwenProvider = createApiProviderConfig("custom", "qwen-adaptive");
  qwenProvider.runtimeProviderId = "qwen-token-plan";
  qwenProvider.baseUrl = "https://qwen.example/v1";
  qwenProvider.apiKey = "fixture-key";
  const qwenModel = createApiProviderModelConfig(
    "custom",
    "qwen3.8-max-preview",
    qwenProvider.runtimeProviderId
  );
  qwenModel.reasoningEnabled = false;
  qwenProvider.models = [qwenModel];
  qwenProvider.defaultModelId = qwenModel.id;
  settings.apiProviders.push(qwenProvider);
  host.selectedProviderSettingsId = qwenProvider.id;
  host.selectedModel = qwenModel.id;
  const qwenDisabled = composerModelMenuState(host);
  assert.equal(qwenDisabled.selectedReasoning, "none");
  assert.equal(qwenDisabled.reasoningCurrentValue, "关闭");
  assert.deepEqual(qwenDisabled.reasoningOptions, []);
  assert.match(qwenDisabled.reasoningDisabledReason, /模型设置中开启深度思考/u);

  qwenModel.reasoningEnabled = true;
  const qwen = composerModelMenuState(host);
  assert.equal(qwenModel.reasoningEffort, "xhigh");
  assert.equal(qwen.selectedReasoning, "xhigh");
  assert.equal(qwen.reasoningCurrentValue, "极高");
  assert.equal(qwen.reasoningAdjustable, true);
  assert.deepEqual(
    qwen.reasoningOptions.map((option) => [option.effort, option.label]),
    [
      ["low", "低"],
      ["medium", "中"],
      ["xhigh", "极高"]
    ]
  );
  assert.equal(qwen.reasoningDisabledReason, "");

  const manualQwenModel = createApiProviderModelConfig(
    "custom",
    "qwen3.8-max",
    qwenProvider.runtimeProviderId
  );
  manualQwenModel.reasoning = true;
  manualQwenModel.reasoningEnabled = true;
  qwenProvider.models.push(manualQwenModel);
  host.selectedModel = manualQwenModel.id;
  const manualQwen = composerModelMenuState(host);
  assert.equal(manualQwenModel.reasoningEffort, "xhigh");
  assert.equal(manualQwen.selectedReasoning, "xhigh");
  assert.equal(manualQwen.reasoningCurrentValue, "极高");
  assert.equal(manualQwen.reasoningAdjustable, true);
  assert.equal(manualQwen.reasoningDisabledReason, "");
  assert.deepEqual(
    manualQwen.reasoningOptions.map((option) => [option.effort, option.label]),
    [
      ["low", "低"],
      ["medium", "中"],
      ["xhigh", "极高"]
    ]
  );
  selectComposerReasoning(host, "low");
  assert.equal(manualQwenModel.reasoningEffort, "low");

  const nonReasoningProvider = createApiProviderConfig(
    "custom",
    "non-reasoning"
  );
  nonReasoningProvider.runtimeProviderId = "openai";
  nonReasoningProvider.baseUrl = "https://openai.example/v1";
  nonReasoningProvider.apiKey = "fixture-key";
  const nonReasoningModel = createApiProviderModelConfig(
    "custom",
    "gpt-4",
    nonReasoningProvider.runtimeProviderId
  );
  nonReasoningProvider.models = [nonReasoningModel];
  nonReasoningProvider.defaultModelId = nonReasoningModel.id;
  settings.apiProviders.push(nonReasoningProvider);
  host.selectedProviderSettingsId = nonReasoningProvider.id;
  host.selectedModel = nonReasoningModel.id;
  const nonReasoning = composerModelMenuState(host);
  assert.equal(nonReasoning.selectedReasoning, "none");
  assert.equal(nonReasoning.reasoningCurrentValue, "关闭");
  assert.equal(nonReasoning.reasoningAdjustable, false);
  assert.match(nonReasoning.reasoningDisabledReason, /不支持深度思考/u);
  assert.deepEqual(nonReasoning.reasoningOptions, []);
  assert.equal(nonReasoningModel.reasoningEffort, undefined);

  assertDisabledReasoningMenuRow(nonReasoning);
}

function assertDisabledReasoningMenuRow(
  state: ReturnType<typeof composerModelMenuState>
): void {
  closeComposerParameterMenu();
  const anchor = new ComposerTestElement("button");
  anchor.setConnected(true);
  anchor.ownerDocument.body.appendChild(anchor);
  openModelMenu({
    currentTarget: anchor,
    preventDefault: () => undefined,
    stopPropagation: () => undefined
  } as unknown as MouseEvent, state, {
    onSelectModel: () => undefined,
    onSelectReasoning: () => {
      assert.fail("disabled reasoning row must not select a fake strength");
    },
    onSelectMode: () => undefined
  });
  const menu = anchor.ownerDocument.body.querySelector(
    ".codex-composer-parameter-menu"
  );
  assert.ok(menu);
  const reasoningTrigger = menu
    .querySelectorAll(".codex-parameter-menu-trigger")
    .find((trigger) => trigger.querySelector(
      ".codex-parameter-menu-label"
    )?.textContent === "思考强度");
  assert.ok(reasoningTrigger);
  assert.equal(reasoningTrigger.getAttribute("aria-disabled"), "true");
  assert.equal(reasoningTrigger.getAttribute("aria-haspopup"), null);
  assert.equal(reasoningTrigger.querySelector(".codex-parameter-menu-chevron"), null);
  reasoningTrigger.onclick?.({
    preventDefault: () => undefined,
    stopPropagation: () => undefined
  });
  assert.equal(
    anchor.ownerDocument.body.querySelector(".codex-composer-parameter-submenu"),
    null
  );
  closeComposerParameterMenu();
  anchor.remove();
}

function renderedComposerText(root: ComposerTestElement): string {
  return [root.textContent, ...root.children.map(renderedComposerText)].join(" ");
}

async function assertExactComposerProviderModelSelection(): Promise<void> {
  const localizedSettings = structuredClone(DEFAULT_SETTINGS);
  const deepSeek = createApiProviderConfig("deepseek", "provider-deepseek");
  deepSeek.apiKey = "fixture-deepseek-key";
  const tokenPlan = createApiProviderConfig(
    "qwen-token-plan",
    "provider-token-plan"
  );
  tokenPlan.apiKey = "fixture-token-plan-key";
  tokenPlan.models = [createApiProviderModelConfig(
    "qwen-token-plan",
    "qwen3.8-max-preview",
    tokenPlan.runtimeProviderId
  )];
  tokenPlan.defaultModelId = tokenPlan.models[0].id;
  const namedTokenPlan = structuredClone(tokenPlan);
  namedTokenPlan.id = "provider-token-plan-work";
  namedTokenPlan.name = "工作 Token Plan";
  localizedSettings.apiProviders = [deepSeek, tokenPlan, namedTokenPlan];
  const localizedHost: any = { plugin: { settings: localizedSettings } };
  assert.deepEqual(
    composerProviderModelOptions(localizedHost).map(
      (option) => option.providerName
    ),
    ["深度求索", "通义千问 Token Plan", "工作 Token Plan"]
  );
  localizedSettings.settingsLanguage = "en";
  assert.deepEqual(
    composerProviderModelOptions(localizedHost).map(
      (option) => option.providerName
    ),
    ["DeepSeek", "Qwen Token Plan", "工作 Token Plan"]
  );

  const settings = structuredClone(DEFAULT_SETTINGS);
  const first = createApiProviderConfig("custom", "provider-first");
  first.name = "First Provider";
  first.baseUrl = "https://first.example/v1";
  first.apiKey = "fixture-first-key";
  first.models = [createApiProviderModelConfig("custom", "shared-model")];
  first.defaultModelId = "shared-model";
  const second = createApiProviderConfig("custom", "provider-second");
  second.name = "Second Provider";
  second.baseUrl = "https://second.example/v1";
  second.apiKey = "fixture-second-key";
  second.models = [createApiProviderModelConfig("custom", "shared-model")];
  second.defaultModelId = "shared-model";
  const missingCredential = createApiProviderConfig("custom", "provider-missing");
  missingCredential.name = "Missing Credential";
  missingCredential.baseUrl = "https://missing.example/v1";
  missingCredential.models = [createApiProviderModelConfig("custom", "hidden-model")];
  missingCredential.defaultModelId = "hidden-model";
  settings.apiProviders = [first, second, missingCredential];
  settings.activeApiProviderId = first.id;
  settings.defaultModel = "shared-model";

  let activationMode: "success" | "failure" | "busy" = "failure";
  let renderCount = 0;
  const host: any = {
    plugin: {
      settings,
      activateApiProviderSettings: async (applyCandidate: (candidate: typeof settings) => void) => {
        if (activationMode === "busy") {
          throw new Error("EchoInk 正在处理其他请求，请稍后再试。");
        }
        if (activationMode === "failure") throw new Error("runtime-create-failed");
        applyCandidate(settings);
      },
      saveSettings: async () => undefined
    },
    running: false,
    selectedProviderSettingsId: first.id,
    selectedModel: "shared-model",
    selectedPermission: settings.defaultPermission,
    selectedMode: settings.defaultMode,
    effectiveModel: () => host.selectedModel,
    renderToolbar: () => { renderCount += 1; }
  };

  const options = composerProviderModelOptions(host);
  assert.deepEqual(
    options.map((option) => [option.providerSettingsId, option.modelId]),
    [[first.id, "shared-model"], [second.id, "shared-model"]],
    "same model IDs must retain their Provider settings identity"
  );
  assert.deepEqual(
    composerModelMenuState(host).providerModels.map((option) => option.providerName),
    ["First Provider", "Second Provider"]
  );

  assert.equal(await selectComposerModel(host, {
    providerSettingsId: second.id,
    modelId: "shared-model"
  }), false);
  assert.equal(host.selectedProviderSettingsId, first.id);
  assert.equal(settings.activeApiProviderId, first.id);
  assert.equal(renderCount, 0);

  activationMode = "busy";
  host.running = true;
  assert.equal(await selectComposerModel(host, {
    providerSettingsId: second.id,
    modelId: "shared-model"
  }), false);
  assert.equal(host.selectedProviderSettingsId, first.id);
  assert.equal(settings.activeApiProviderId, first.id);
  assert.equal(renderCount, 0);

  activationMode = "success";
  host.running = false;
  assert.equal(await selectComposerModel(host, {
    providerSettingsId: second.id,
    modelId: "shared-model"
  }), true);
  assert.equal(host.selectedProviderSettingsId, second.id);
  assert.equal(host.selectedModel, "shared-model");
  assert.equal(settings.activeApiProviderId, second.id);
  assert.equal(settings.defaultModel, "shared-model");
  assert.equal(renderCount, 1);
  console.log("PASS conversation-ui: Composer preserves exact Provider/model identity and transactional rollback");
}

function renderAction(overrides: Partial<ComposerToolbarState> = {}) {
  const calls = { send: 0, mic: 0, context: 0, enqueue: 0, stop: 0, resume: 0, cancelKnowledge: 0 };
  const callbacks: ComposerToolbarCallbacks = {
    onOpenAddMenu: () => undefined,
    onEnhancePrompt: () => undefined,
    onCaptureKnowledgeSource: () => undefined,
    onPermissionChange: () => undefined,
    onOpenWorkspaceMenu: () => undefined,
    onOpenModelMenu: () => undefined,
    onToggleContextPanel: () => { calls.context += 1; },
    onMicInput: () => { calls.mic += 1; },
    onCancelKnowledgeTask: () => { calls.cancelKnowledge += 1; },
    onStopTurn: () => { calls.stop += 1; },
    onSteerPiChat: () => undefined,
    onEnqueueDraft: () => { calls.enqueue += 1; },
    onResumeQueue: () => { calls.resume += 1; },
    onSendMessage: () => { calls.send += 1; }
  };
  const state: ComposerToolbarState = {
    session: { id: "session-test" } as never,
    knowledgeTaskRunning: false,
    selectedSkill: null,
    selectedPermission: "workspace-write",
    selectedMode: "agent",
    running: false,
    promptEnhancerRunning: false,
    viewRunKind: "",
    activeRunSessionId: "",
    hasDraft: false,
    hasTextDraft: false,
    hasQueuedItems: false,
    currentComposerModel: "deepseek-chat",
    currentComposerProviderBrand: "custom",
    currentComposerSummaryTitle: "模型",
    workspacePath: "",
    workspaceDisplayName: "",
    workspaceValid: true,
    contextPanelOpen: false,
    ...overrides
  };
  const container = new ComposerTestElement("div");
  const workspace = new ComposerTestElement("div");
  renderComposerToolbar(container as unknown as HTMLElement, workspace as unknown as HTMLElement, state, callbacks);
  return {
    calls,
    context: container.querySelector(".codex-context-meter")!,
    primary: container.querySelector(".codex-composer-send-button")!,
    mic: container.querySelector(".codex-composer-mic-button")!
  };
}

class ComposerTestDocument {
  activeElement: ComposerTestElement | null = null;
  readonly body = new ComposerTestElement("body");
  readonly documentElement = { clientWidth: 1_280, clientHeight: 800 };
  readonly defaultView = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  };
  constructor() {
    this.body.setConnected(true);
  }
  createElement(tagName: string): ComposerTestElement {
    return new ComposerTestElement(tagName);
  }
  createElementNS(_namespace: string, tagName: string): ComposerTestElement {
    return new ComposerTestElement(tagName);
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

class ComposerTestElement {
  readonly children: ComposerTestElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style = { setProperty: () => undefined };
  readonly classList = {
    add: (...classNames: string[]) => this.addClass(...classNames),
    remove: (...classNames: string[]) => this.removeClass(...classNames)
  };
  className = "";
  disabled = false;
  onerror: (() => void) | null = null;
  onload: (() => void) | null = null;
  src = "";
  textContent = "";
  value = "";
  onclick: ((event?: unknown) => void) | null = null;
  onchange: (() => void) | null = null;
  onkeydown: ((event: KeyboardEvent) => void) | null = null;
  onmouseenter: (() => void) | null = null;
  parentElement: ComposerTestElement | null = null;
  private connected = false;
  private readonly attributes = new Map<string, string>();

  constructor(readonly tagName: string) {}

  get isConnected(): boolean { return this.connected; }
  empty(): void {
    for (const child of this.children) {
      child.parentElement = null;
      child.setConnected(false);
    }
    this.children.length = 0;
  }
  append(...children: ComposerTestElement[]): void {
    for (const child of children) this.appendChild(child);
  }
  appendChild(child: ComposerTestElement): ComposerTestElement {
    child.parentElement?.removeChild(child);
    child.parentElement = this;
    child.setConnected(this.connected);
    this.children.push(child);
    return child;
  }
  removeChild(child: ComposerTestElement): ComposerTestElement {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentElement = null;
    child.setConnected(false);
    return child;
  }
  remove(): void { this.parentElement?.removeChild(this); }
  replaceChildren(...children: ComposerTestElement[]): void { this.empty(); this.append(...children); }
  createDiv(options: Record<string, unknown> = {}): ComposerTestElement { return this.createEl("div", options); }
  createSpan(options: Record<string, unknown> = {}): ComposerTestElement { return this.createEl("span", options); }
  createEl(tagName: string, options: Record<string, any> = {}): ComposerTestElement {
    const element = new ComposerTestElement(tagName);
    if (options.cls) element.className = String(options.cls);
    if (options.text !== undefined) element.textContent = String(options.text);
    for (const [name, value] of Object.entries(options.attr ?? {})) element.setAttribute(name, String(value));
    this.append(element);
    return element;
  }
  addClass(...classNames: string[]): void {
    const classes = new Set(this.className.split(/\s+/u).filter(Boolean));
    for (const className of classNames) classes.add(className);
    this.className = [...classes].join(" ");
  }
  removeClass(...classNames: string[]): void {
    const remove = new Set(classNames);
    this.className = this.className.split(/\s+/u).filter((name) => name && !remove.has(name)).join(" ");
  }
  toggleClass(className: string, enabled: boolean): void {
    if (enabled) this.addClass(className); else this.removeClass(className);
  }
  hasClass(className: string): boolean { return this.className.split(/\s+/u).includes(className); }
  setAttr(name: string, value: string): void { this.setAttribute(name, value); }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "class") this.className = value;
    if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase())] = value;
  }
  getAttribute(name: string): string | null { return name === "class" ? this.className : this.attributes.get(name) ?? null; }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  get ownerDocument(): ComposerTestDocument { return globalThis.document as unknown as ComposerTestDocument; }
  setCssStyles(_styles: Partial<CSSStyleDeclaration>): void {}
  getBoundingClientRect(): DOMRect {
    return {
      x: 0,
      y: 100,
      top: 100,
      bottom: 132,
      left: 0,
      right: 240,
      width: 240,
      height: 32,
      toJSON: () => ({})
    } as DOMRect;
  }
  contains(element: ComposerTestElement): boolean {
    return element === this || this.children.some((child) => child.contains(element));
  }
  querySelector(selector: string): ComposerTestElement | null { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector: string): ComposerTestElement[] {
    const matches: ComposerTestElement[] = [];
    const visit = (node: ComposerTestElement): void => {
      for (const child of node.children) {
        if (child.matches(selector)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }
  matches(selector: string): boolean {
    const tag = selector.match(/^[a-z][a-z0-9-]*/iu)?.[0];
    if (tag && this.tagName.toLowerCase() !== tag.toLowerCase()) return false;
    const excludedClassNames = Array.from(
      selector.matchAll(/:not\(\.([a-z0-9_-]+)\)/giu),
      (match) => match[1]!
    );
    if (excludedClassNames.some((className) => this.hasClass(className))) return false;
    const requiredSelector = selector.replace(/:not\(\.[a-z0-9_-]+\)/giu, "");
    for (const className of requiredSelector.matchAll(/\.([a-z0-9_-]+)/giu)) {
      if (!this.hasClass(className[1])) return false;
    }
    return Boolean(tag || selector.includes("."));
  }
  click(): void { if (!this.disabled) this.onclick?.({}); }
  focus(): void { if (!this.disabled) this.ownerDocument.activeElement = this; }
  setConnected(connected: boolean): void {
    this.connected = connected;
    for (const child of this.children) child.setConnected(connected);
  }
}

class ComposerTestMutationObserver {
  constructor(_callback: MutationCallback) {}
  observe(): void {}
  disconnect(): void {}
}

function keyEvent(key: string): KeyboardEvent {
  return {
    key,
    preventDefault: () => undefined,
    stopPropagation: () => undefined
  } as unknown as KeyboardEvent;
}
