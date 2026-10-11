import type { AnimatedSettingsTabIconName } from "./animated-settings-tab-icon";

/** Shared desktop/mobile settings navigation; SVGs live in the existing renderer. */
export const SETTINGS_TAB_ICONS = {
  general: "settings",
  layout: "blocks",
  providers: "key-round",
  resources: "layout-list",
  knowledgeBase: "book-open-check",
  review: "clipboard-check",
  todos: "list-todo",
  account: "feather"
} as const satisfies Record<string, AnimatedSettingsTabIconName>;
