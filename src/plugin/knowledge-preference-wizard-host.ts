import type CodexForObsidianPlugin from "../main";
import type { KnowledgePreferenceWizardHost } from "../knowledge-base/knowledge-preference-wizard";
import {
  getActiveApiProviderModel,
  validateApiProvider,
} from "../settings/settings";

export function knowledgePreferenceWizardHost(
  plugin: CodexForObsidianPlugin,
): KnowledgePreferenceWizardHost {
  return {
    read: () => plugin.getEchoInkKnowledgeMaintenancePreferenceState(),
    save: (content, expectedRevision) =>
      plugin.saveEchoInkKnowledgeMaintenancePreferences(
        content,
        expectedRevision,
      ),
    available: () => {
      const active = getActiveApiProviderModel(plugin.settings);
      return !!active && validateApiProvider(active.provider).length === 0;
    },
    generate: (prompt, signal) =>
      plugin.generateLifestyleText(
        "你负责按用户用途生成可预览的知识整理偏好。只返回请求的JSON，不执行操作。",
        prompt,
        3000,
        signal,
      ),
  };
}
