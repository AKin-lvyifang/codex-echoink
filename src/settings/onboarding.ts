import {
  getActiveApiProvider,
  validateApiProvider,
  type CodexForObsidianSettings,
  type SetupSettings,
  type SettingsTab
} from "./settings";

export const ECHOINK_ONBOARDING_VERSION = "onboarding-v3";

export type EchoInkOnboardingStep =
  | "sidebar"
  | "settings"
  | "provider"
  | "knowledge"
  | "personality"
  | "colleague";

export const ECHOINK_ONBOARDING_STEPS: readonly EchoInkOnboardingStep[] = [
  "sidebar", "provider", "knowledge", "personality", "colleague"
];

function currentOnboardingStep(value: unknown): EchoInkOnboardingStep {
  return ECHOINK_ONBOARDING_STEPS.includes(value as EchoInkOnboardingStep)
    ? value as EchoInkOnboardingStep
    : "sidebar";
}

export interface EchoInkOnboardingTruth {
  readonly providerComplete: boolean;
  readonly knowledgeComplete: boolean;
  readonly personalityComplete: boolean;
}

/**
 * Product truth remains visible to the settings UI, but never drives the
 * tutorial cursor. The tutorial is an independent, explicit click-through.
 */
export function deriveEchoInkOnboardingTruth(
  settings: Pick<
    CodexForObsidianSettings,
    "activeApiProviderId" | "apiProviders" | "knowledgeBase"
  >,
  personalityTemplateId: string | null
): Readonly<EchoInkOnboardingTruth> {
  const provider = getActiveApiProvider(settings);
  const providerComplete = Boolean(
    provider
    && provider.id === settings.activeApiProviderId
    && validateApiProvider(provider).length === 0
  );
  const knowledgeComplete =
    settings.knowledgeBase.initialization.status === "initialized";
  const personalityComplete = personalityTemplateId !== null;
  return Object.freeze({
    providerComplete,
    knowledgeComplete,
    personalityComplete
  });
}

export function echoInkOnboardingTab(step: EchoInkOnboardingStep): SettingsTab {
  return step === "provider"
    ? "providers"
    : step === "knowledge" ? "knowledgeBase" : "general";
}

export interface EchoInkOnboardingAdvanceResult {
  readonly changed: boolean;
  readonly completed: boolean;
  readonly nextStep: EchoInkOnboardingStep | null;
}

export function shouldAutoStartEchoInkOnboarding(
  _emptyData: boolean,
  setup: Readonly<SetupSettings>,
  _enabledAfterLayoutReady = false
): boolean {
  // Completion and an explicit skip survive both version changes and enabling
  // the plugin after layout-ready. Only a user-requested replay resets them.
  return setup.completedAt <= 0 && !setup.dismissedVersion.trim();
}

export function prepareEchoInkOnboardingTutorial(
  setup: SetupSettings,
  options: Readonly<{ forceRestart: boolean }>
): boolean {
  if (!options.forceRestart) {
    if (!shouldAutoStartEchoInkOnboarding(false, setup)) return false;
    const step = currentOnboardingStep(setup.tutorialStep);
    if (setup.tutorialVersion === ECHOINK_ONBOARDING_VERSION && setup.tutorialStep === step) return false;
    setup.tutorialVersion = ECHOINK_ONBOARDING_VERSION;
    setup.tutorialStep = step;
    return true;
  }
  setup.completedAt = 0;
  setup.dismissedVersion = "";
  setup.tutorialVersion = ECHOINK_ONBOARDING_VERSION;
  setup.tutorialStep = "sidebar";
  return true;
}

export function dismissEchoInkOnboardingTutorial(setup: SetupSettings): void {
  setup.tutorialVersion = ECHOINK_ONBOARDING_VERSION;
  setup.dismissedVersion = ECHOINK_ONBOARDING_VERSION;
}

/** Advance only from an explicit control bound to the currently shown step. */
export function advanceEchoInkOnboardingTutorial(
  setup: SetupSettings,
  expectedStep: EchoInkOnboardingStep,
  now: number
): Readonly<EchoInkOnboardingAdvanceResult> {
  const index = ECHOINK_ONBOARDING_STEPS.indexOf(expectedStep);
  if (setup.tutorialStep !== expectedStep || index < 0) {
    return Object.freeze({
      changed: false,
      completed: false,
      nextStep: currentOnboardingStep(setup.tutorialStep)
    });
  }
  if (index < ECHOINK_ONBOARDING_STEPS.length - 1) {
    const nextStep = ECHOINK_ONBOARDING_STEPS[index + 1];
    setup.tutorialStep = nextStep;
    return Object.freeze({ changed: true, completed: false, nextStep });
  }
  setup.completedAt = now;
  // Each completed tutorial gets its own follow-up choice on the workbench.
  setup.paperGuideDismissedAt = 0;
  setup.lastCheckedAt = now;
  setup.tutorialVersion = ECHOINK_ONBOARDING_VERSION;
  setup.dismissedVersion = ECHOINK_ONBOARDING_VERSION;
  setup.tutorialStep = "sidebar";
  return Object.freeze({ changed: true, completed: true, nextStep: null });
}

/** Back and progress clicks only move the tutorial cursor, never setup data. */
export function selectEchoInkOnboardingStep(
  setup: SetupSettings,
  expectedStep: EchoInkOnboardingStep,
  nextStep: EchoInkOnboardingStep
): boolean {
  if (setup.tutorialStep !== expectedStep || nextStep === expectedStep || !ECHOINK_ONBOARDING_STEPS.includes(expectedStep) || !ECHOINK_ONBOARDING_STEPS.includes(nextStep)) return false;
  setup.tutorialStep = nextStep;
  return true;
}

const ONBOARDING_COPY = {
  "colleague": { icon: "sparkles", tone: "purple", title: ["再请一位同事", "Invite a colleague"], description: ["从预设开始，也可以自己填写。什么都不填时，会按整理员创建。", "Start with a preset or fill in your own details. An untouched form creates an Organizer."], tip: ["", ""], action: ["创建并完成", "Create and finish"] },
  "sidebar": {
    "icon": "sparkles",
    "tone": "purple",
    "title": [
      "认识工作台和你的 Agent",
      "Meet your workspace and Agent"
    ],
    "description": [
      "中间看事情，右边点头像找同事；在列表里交代新事，在详情里接着聊。",
      "See your work in the center and choose a colleague by their avatar on the right. Start something in their task list and continue the conversation in its details."
    ],
    "tip": [
      "打开页面、切换头像和查看任务都不会执行任务。",
      "Opening a page, switching avatars, or viewing tasks does not start any work."
    ],
    "action": [
      "下一步",
      "Next"
    ]
  },
  "settings": {
    "icon": "settings",
    "tone": "purple",
    "title": [
      "让 EchoInk 适合你",
      "Make EchoInk your own"
    ],
    "description": [
      "侧栏右上角的齿轮是设置入口。模型、知识库和 Agent 风格，都在这里调整。",
      "The gear at the top of the sidebar opens settings. This is where you choose a model, organize knowledge, and personalize your Agent."
    ],
    "tip": [
      "先用五步认识这些入口，具体设置可以稍后完成。",
      "Explore the five steps first. You can finish the setup later."
    ],
    "action": [
      "进入设置",
      "Open settings"
    ]
  },
  "provider": {
    "icon": "key-round",
    "tone": "purple",
    "title": [
      "连接一个模型",
      "Connect a model"
    ],
    "description": [
      "添加你使用的模型服务，保存后就能开始对话。",
      "Add your model provider and save it to start chatting."
    ],
    "tip": [
      "你可以添加多个服务，之后随时切换。",
      "You can add more providers and switch between them later."
    ],
    "action": [
      "下一步",
      "Next"
    ]
  },
  "knowledge": {
    "icon": "book-open-check",
    "tone": "purple",
    "title": [
      "给知识库安个家",
      "Give your notes a home"
    ],
    "description": [
      "先选文件夹，再核对将新建和移动的内容。确认前不会动文件。",
      "Choose folders, then review what will be created or moved. Nothing changes before you confirm."
    ],
    "tip": [
      "",
      ""
    ],
    "action": [
      "下一步",
      "Next"
    ]
  },
  "personality": {
    "icon": "sparkles",
    "tone": "purple",
    "title": [
      "认识总助",
      "Meet your general assistant"
    ],
    "description": [
      "给你的总助挑个头像和风格。",
      "Choose an avatar and a style for your general assistant."
    ],
    "tip": [
      "这只是起点，之后可以随时调整。",
      "This is only a starting point. You can change it whenever you like."
    ],
    "action": [
      "下一步",
      "Next"
    ]
  }
} as const;

export function onboardingCoachmarkCopy(step: EchoInkOnboardingStep, zh: boolean) {
  step = currentOnboardingStep(step);
  const index = ECHOINK_ONBOARDING_STEPS.indexOf(step);
  const language = zh ? 0 : 1;
  const copy = ONBOARDING_COPY[step];
  return Object.freeze({
    step: `${zh ? "认识 EchoInk" : "MEET ECHOINK"} · ${String(index + 1).padStart(2, "0")} / 05`,
    title: copy.title[language],
    description: copy.description[language],
    tip: copy.tip[language],
    action: copy.action[language],
    icon: copy.icon,
    tone: copy.tone,
    dismissLabel: zh ? "跳过引导" : "Skip guide",
    previousLabel: index ? (zh ? "上一步" : "Back") : (zh ? "稍后再说" : "Maybe later"),
    progressLabel: zh ? "引导进度" : "Guide progress",
    steps: ECHOINK_ONBOARDING_STEPS.map((key, i) => ({
      key,
      label: `${zh ? `第 ${i + 1} 步` : `Step ${i + 1}`}: ${ONBOARDING_COPY[key].title[language]}`
    }))
  });
}

export function onboardingCompletionCopy(zh: boolean) {
  return Object.freeze({
    title: zh ? "准备好了，从一句话开始" : "You are ready. Start with one thought.",
    description: zh
      ? "你已经认识了 EchoInk 的几个重要入口。写下一个想法，或和 Agent 聊聊今天，让第一条记录自然发生。"
      : "You now know your way around EchoInk. Capture an idea or talk about your day, and let the first note take shape.",
    previousLabel: zh ? "再看一遍" : "Show me again",
    actionLabel: zh ? "回到工作台" : "Back to my workspace"
  });
}

export function isEmptyEchoInkPluginData(value: unknown): boolean {
  return value === null
    || value === undefined
    || (
      typeof value === "object"
      && !Array.isArray(value)
      && Object.keys(value).length === 0
    );
}
