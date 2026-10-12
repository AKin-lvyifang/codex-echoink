import {
  getActiveApiProvider,
  validateApiProvider,
  type CodexForObsidianSettings,
  type SetupSettings,
  type SettingsTab
} from "./settings";

export const ECHOINK_ONBOARDING_VERSION = "onboarding-v2";

export type EchoInkOnboardingStep =
  | "sidebar"
  | "settings"
  | "provider"
  | "knowledge"
  | "personality";

export const ECHOINK_ONBOARDING_STEPS = [
  "sidebar", "settings", "provider", "knowledge", "personality"
] as const satisfies readonly EchoInkOnboardingStep[];

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
  enabledAfterLayoutReady = false
): boolean {
  if (enabledAfterLayoutReady) return true;
  // dismissedVersion also acts as the last-seen tutorial version. Bumping the
  // onboarding version therefore shows the guide once after an update, while
  // the same version never reopens it in an existing Vault.
  return setup.dismissedVersion !== ECHOINK_ONBOARDING_VERSION;
}

export function prepareEchoInkOnboardingTutorial(
  setup: SetupSettings,
  options: Readonly<{ forceRestart: boolean }>
): boolean {
  const newVersion = setup.tutorialVersion !== ECHOINK_ONBOARDING_VERSION;
  if (!options.forceRestart && !newVersion) return false;
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
  if (setup.tutorialStep !== expectedStep) {
    return Object.freeze({
      changed: false,
      completed: false,
      nextStep: setup.tutorialStep
    });
  }
  if (expectedStep !== "personality") {
    const nextStep: EchoInkOnboardingStep = expectedStep === "sidebar"
      ? "settings"
      : expectedStep === "settings"
        ? "provider"
        : expectedStep === "provider"
          ? "knowledge"
          : "personality";
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
  if (setup.tutorialStep !== expectedStep || nextStep === expectedStep) return false;
  setup.tutorialStep = nextStep;
  return true;
}

const ONBOARDING_COPY = {
  "sidebar": {
    "icon": "sparkles",
    "tone": "purple",
    "title": [
      "先认识你的 Agent",
      "Meet your Agent"
    ],
    "description": [
      "点击左侧的对话图标，打开 EchoInk。右侧是你和 Agent 交流的地方，中间仍然留给笔记。",
      "Open EchoInk from the left ribbon. Talk with your Agent on the right while your notes stay in the center."
    ],
    "tip": [
      "首页随时可以切回，打开新笔记也不会打断对话。",
      "Open a note or return home whenever you like. Your conversation stays beside you."
    ],
    "action": [
      "打开 EchoInk",
      "Open EchoInk"
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
      "添加你使用的模型服务，填好连接信息，再选择模型。连接完成，EchoInk 就能和你对话。",
      "Add a model provider, enter its connection details, and choose a model. Once connected, EchoInk is ready to chat."
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
    "tone": "green",
    "title": [
      "给笔记一个归处",
      "Give your notes a home"
    ],
    "description": [
      "默认方案会先保留原始资料，再逐步提炼为 Wiki。想自己安排时，按目录搜索、多选笔记就好。",
      "The default plan preserves your source material and gradually builds a Wiki. Choose the custom plan to search and assign notes by folder."
    ],
    "tip": [
      "先看分配预览，再决定开始。引导不会替你移动笔记。",
      "Review your assignments before starting. This guide does not move any notes."
    ],
    "action": [
      "下一步",
      "Next"
    ]
  },
  "personality": {
    "icon": "sparkles",
    "tone": "gold",
    "title": [
      "选择一种相处方式",
      "Choose how you work together"
    ],
    "description": [
      "选一个起始风格，给 Agent 取名字、换头像。随着一次次对话，它会逐渐理解你的偏好。",
      "Choose a starting style, a name, and an avatar. Through your conversations, your Agent gradually learns how you like to work."
    ],
    "tip": [
      "这只是起点，之后可以随时调整。",
      "This is only a starting point. You can change it whenever you like."
    ],
    "action": [
      "开始积累",
      "Start exploring"
    ]
  }
} as const;

export function onboardingCoachmarkCopy(step: EchoInkOnboardingStep, zh: boolean) {
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
