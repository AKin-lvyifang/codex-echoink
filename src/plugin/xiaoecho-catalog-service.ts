import type { CodexForObsidianSettings } from "../settings/settings";
import { listXiaoechoModels, latestXiaoechoCatalog, subscribeXiaoechoCatalog, xiaoechoCatalogBaseUrl, type XiaoechoCatalogUpdate, type XiaoechoModelFetch } from "../membership/xiaoecho-catalog";
import { filterXiaoechoProviderDraft, publishXiaoechoCatalogChanges, rejectXiaoechoModel, repairSavedXiaoechoSelections } from "../membership/xiaoecho-catalog-state";
import { subscribeXiaoechoModelSignals, type XiaoechoModelSignal } from "../membership/xiaoecho-model-signal";

export interface XiaoechoCatalogHost {
  readonly settings: CodexForObsidianSettings;
  token(): string | null;
  persist(): Promise<void>;
  notifyModelRetired(): void;
}

/** Updates saved catalogs and future selections; never activates/replaces a Provider Runtime. */
export class XiaoechoCatalogService {
  private closed = false;
  private readonly stop: (() => void)[];
  private readonly notified = new Set<string>();
  private persistence: Promise<void> = Promise.resolve();

  constructor(private readonly host: XiaoechoCatalogHost, private readonly fetchImpl: XiaoechoModelFetch) {
    this.stop = [
      subscribeXiaoechoCatalog(update => this.accept(update)),
      subscribeXiaoechoModelSignals(signal => this.unavailable(signal))
    ];
  }
  dispose(): void { this.closed = true; this.stop.forEach(stop => stop()); }

  async refresh(force = false): Promise<void> {
    const token = this.host.token();
    if (this.closed || !token) return;
    const urls = new Set(this.host.settings.apiProviders.filter(provider => provider.providerId === "xiaoecho").map(provider => xiaoechoCatalogBaseUrl(provider.baseUrl)));
    await Promise.all([...urls].map(async baseUrl => {
      const result = await listXiaoechoModels({ baseUrl, token, fetchImpl: this.fetchImpl, timeoutMs: 10_000, force });
      if (result.status === "available") {
        const update = latestXiaoechoCatalog(baseUrl);
        if (update) await this.accept(update);
      }
    }));
  }

  private async accept(update: XiaoechoCatalogUpdate): Promise<void> {
    if (this.closed || this.host.token() !== update.token) return;
    await this.apply(update.baseUrl);
  }
  private unavailable(signal: XiaoechoModelSignal): void {
    if (this.closed || !this.host.token() || !this.host.settings.apiProviders.some(provider => provider.providerId === "xiaoecho" && xiaoechoCatalogBaseUrl(provider.baseUrl) === xiaoechoCatalogBaseUrl(signal.baseUrl))) return;
    rejectXiaoechoModel(signal.baseUrl, signal.requestedModelId);
    // The error/header itself is authoritative, even if the subsequent GET fails.
    void this.apply(signal.baseUrl, true).catch(error => console.error("EchoInk model catalog could not be saved", error));
    if (signal.kind === "fallback") this.notifyOnce(signal.baseUrl, [signal.requestedModelId]);
    void this.refresh(true).catch(error => console.error("EchoInk model catalog could not refresh", error));
  }
  private async apply(baseUrl: string, failureAlreadyVisible = false): Promise<void> {
    const settings = this.host.settings;
    const before = JSON.stringify({ providers: settings.apiProviders, defaultModel: settings.defaultModel, workspace: settings.taskWorkspace });
    const unavailableDefaults: string[] = [];
    const savedDrafts = [settings.taskWorkspace?.newTaskDrafts, settings.taskWorkspace?.replyDrafts].flatMap(drafts => Object.values(drafts ?? {}));
    const draftModels = savedDrafts.map(draft => ({ draft, model: draft.selectedModel, provider: draft.selectedProviderSettingsId }));
    for (const provider of settings.apiProviders) {
      if (provider.providerId !== "xiaoecho" || xiaoechoCatalogBaseUrl(provider.baseUrl) !== xiaoechoCatalogBaseUrl(baseUrl)) continue;
      const oldDefault = provider.defaultModelId;
      filterXiaoechoProviderDraft(provider);
      if (provider.defaultModelId !== oldDefault) unavailableDefaults.push(oldDefault);
    }
    const oldDefault = settings.defaultModel;
    const repaired = repairSavedXiaoechoSelections(settings);
    for (const previous of draftModels) {
      if (previous.model && previous.draft.selectedModel !== previous.model && settings.apiProviders.some(provider => provider.id === previous.provider && provider.providerId === "xiaoecho" && xiaoechoCatalogBaseUrl(provider.baseUrl) === xiaoechoCatalogBaseUrl(baseUrl))) unavailableDefaults.push(previous.model);
    }
    if (oldDefault !== settings.defaultModel) unavailableDefaults.push(oldDefault);
    const changed = before !== JSON.stringify({ providers: settings.apiProviders, defaultModel: settings.defaultModel, workspace: settings.taskWorkspace });
    if (!changed && !repaired) return;
    publishXiaoechoCatalogChanges();
    // Use the existing serialized settings writer, preserving concurrent unrelated edits.
    const persist = this.persistence.catch(() => undefined).then(() => this.closed ? undefined : this.host.persist());
    this.persistence = persist;
    await persist;
    if (!failureAlreadyVisible && !this.closed) this.notifyOnce(baseUrl, unavailableDefaults);
  }
  private notifyOnce(baseUrl: string, modelIds: readonly string[]): void {
    const keys = modelIds.filter(id => id !== "auto").map(id => `${xiaoechoCatalogBaseUrl(baseUrl)}\0${id}`);
    const fresh = keys.some(key => !this.notified.has(key));
    keys.forEach(key => this.notified.add(key));
    if (fresh && !this.closed) this.host.notifyModelRetired();
  }
}
