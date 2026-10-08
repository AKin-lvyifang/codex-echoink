import { App, installProviderBrowserHost } from "./provider-discovery-dom-host";
import { ProviderModelModal } from "../settings/provider-model-modal";
// @ts-expect-error The browser adapter exports the exact production private normalizer.
import { createApiProviderConfig, normalizeStoredApiProviderModel, type ApiProviderConfig } from "../settings/settings";
import { settingsCopy } from "../settings/i18n";
import { deepSeekModelListFixture } from "./provider-model-discovery-fixtures";
import type { PiProviderConfigurationDraft, PiProviderModelListResult } from "../plugin/pi-provider-configuration-service";

export function runProviderDiscoveryDom(list: (draft: PiProviderConfigurationDraft, response: unknown, status: number) => Promise<PiProviderModelListResult>): void {
  installProviderBrowserHost();
  let saved: ApiProviderConfig | undefined;
  let modal: ProviderModelModal | undefined;
  let mode = "rich";
  const report = document.querySelector<HTMLElement>("#report")!;
  const app = new App();
  const open = (editing: boolean) => {
    modal?.close();
    const draft = editing && saved ? saved : createApiProviderConfig("deepseek", "browser-fixture");
    modal = new ProviderModelModal({ app: app as never, draft, editing, language: "zh-CN", copy: settingsCopy("zh-CN"),
      preflight: {
        listModels: async (draft) => {
          const body = mode === "empty" ? { data: [] } : mode === "partial" ? { ...deepSeekModelListFixture, has_more: true } : mode === "id-only" ? { data: [{ id: "future-id-only" }] } : deepSeekModelListFixture;
          return list(draft, body, mode === "failure" ? 503 : 200);
        },
        testConnection: async () => ({ status: "failed", failure: "request", detail: { status: 400, code: "invalid_request_error", param: "max_completion_tokens", reason: "unsupported" } })
      },
      save: async (draft, apiKey) => {
        saved = { ...structuredClone(draft), apiKey: apiKey || draft.apiKey, models: draft.models.map((model) => normalizeStoredApiProviderModel(JSON.parse(JSON.stringify(model)), draft.providerId!, draft.runtimeProviderId, false)) };
        report.textContent = `已保存 ${saved.defaultModelId}；可点击“重开已保存”检查。`;
        report.dataset.saved = "true";
        return { saved: true };
      }
    }); modal.open();
  };
  document.querySelector<HTMLSelectElement>("#fixture-response")!.onchange = (event) => { mode = (event.target as HTMLSelectElement).value; };
  document.querySelector<HTMLButtonElement>("#fixture-new")!.onclick = () => open(false);
  document.querySelector<HTMLButtonElement>("#fixture-reopen")!.onclick = () => { if (saved) open(true); };
  open(false);
}
