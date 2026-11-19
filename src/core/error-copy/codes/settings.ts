import { CAUSE } from "../causes";
import { NEXT } from "../next";
import type { ErrorCopy } from "../types";

/** Scene sentences shared by several settings and mobile exits; each caller adds a NEXT or CAUSE tail. */
export const SETTINGS_SCENE = {
  settingNotSaved: ["设置未能保存，已恢复原设置。", "The setting could not be saved, and the previous value was restored."],
  actionIncomplete: ["操作未完成。", "The operation could not be completed."],
  actionIncompleteKept: ["本次操作未完成，内容已保留。", "The operation could not be completed; your text has been kept."],
  settingNotApplied: ["该设置未生效。", "The setting could not be applied."],
  providerSaveFailed: ["未能保存。", "Could not save."]
} as const satisfies Record<string, ErrorCopy>;

/** Scene + tail as one bilingual pair, for exits that need an ErrorCopy fallback. */
export function joinCopyPair(lead: ErrorCopy, tail: ErrorCopy): ErrorCopy {
  return [`${lead[0]}${tail[0]}`, `${lead[1]} ${tail[1]}`];
}

/** Fallbacks for exits that cannot tell the reason. */
export const SETTINGS_FALLBACK = {
  /** Desktop settings switches and fields. */
  settingSave: joinCopyPair(SETTINGS_SCENE.settingNotSaved, NEXT.retryOrReload),
  /** iPhone / iPad task page and composer. */
  mobileTask: joinCopyPair(SETTINGS_SCENE.actionIncompleteKept, NEXT.retryOrReopen),
  /** iPhone / iPad workbench, agent pane and page actions. */
  mobilePage: joinCopyPair(SETTINGS_SCENE.actionIncomplete, NEXT.retryOrReopen),
  /** iPhone / iPad settings pages. */
  mobileSettings: joinCopyPair(SETTINGS_SCENE.settingNotApplied, NEXT.retryOrReopen),
  /** iPhone / iPad workbench reads. */
  workbenchRead: joinCopyPair(["暂时无法读取。", "This could not be read."], ["请稍后刷新。", "Refresh later."])
} as const satisfies Record<string, ErrorCopy>;

/** settings area codes → sentence. */
export const SETTINGS_CODES: Readonly<Record<string, ErrorCopy>> = {};

/** HTTP status from a model service (iPhone / iPad direct calls) → root cause. Upstream wording stays in the run report. */
export function providerStatusCopy(status: number): ErrorCopy {
  if (status === 401 || status === 403) return CAUSE.providerAuthMobile;
  if (status === 404) return CAUSE.providerNotFound;
  if (status === 429) return CAUSE.providerRateLimit;
  if (status >= 500) return CAUSE.providerUnavailable;
  return CAUSE.providerNotRespondingMobile;
}
