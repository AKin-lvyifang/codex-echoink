import { repairXiaoechoModelSelection } from "../membership/xiaoecho-catalog-state";
import type { CodexForObsidianSettings } from "../settings/settings";
import { resolveComposerReasoningState } from "./composer-reasoning";
import type { QueuedTurnItem } from "./turn-queue";

/** Revalidate only unsent choices; an accepted run keeps its original model. */
export function repairQueuedXiaoechoModelSelection(
  settings: Pick<CodexForObsidianSettings, "apiProviders" | "activeApiProviderId" | "defaultModel">,
  item: Pick<QueuedTurnItem, "turnOptions" | "piUserEntryAccepted">
): boolean {
  if (item.piUserEntryAccepted) return false;
  const options = item.turnOptions;
  const selection = repairXiaoechoModelSelection(settings, {
    providerSettingsId: options.providerSettingsId,
    modelId: options.model
  });
  if (selection.providerSettingsId === options.providerSettingsId && selection.modelId === options.model) return false;
  const provider = settings.apiProviders.find(candidate => candidate.id === selection.providerSettingsId);
  if (!provider || !selection.modelId) return false;
  options.providerSettingsId = provider.id;
  options.runtimeProviderId = provider.runtimeProviderId;
  options.model = selection.modelId;
  options.reasoning = resolveComposerReasoningState(settings, provider.id, selection.modelId)?.effort ?? "none";
  return true;
}
