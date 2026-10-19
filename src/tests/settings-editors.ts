import assert from "node:assert/strict";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { App, installProviderBrowserHost } from "./provider-discovery-dom-host";
import { ProviderModelModal, type ProviderModelModalOptions } from "../settings/provider-model-modal";
import { McpServerModal, type McpServerModalOptions } from "../settings/mcp-server-modal";
import { mountSettingsEditor } from "../settings/inline-editor";
import { renderProviderServicePicker } from "../settings/provider-service-picker";
import { API_PROVIDER_PRESETS } from "../settings/provider-presets";
import { createApiProviderConfig, createApiProviderModelConfig, type ApiProviderConfig } from "../settings/settings";
import { settingsCopy } from "../settings/i18n";
import { disposeOriginControls, type OriginSelectElement } from "../settings/origin-controls";
import type { PiProviderModelListResult, PiProviderConnectionTestResult } from "../plugin/pi-provider-configuration-service";
import type { OpenAICodexAuthStatus } from "../plugin/openai-codex-oauth-service";
import type { EchoInkMcpServerDraft } from "../plugin/mcp-settings-service";

const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const app = () => new App() as never;
function host(aligned = true): HTMLElement { return document.body.createDiv(aligned ? { cls: "echoink-settings-demo echoink-settings-aligned" } : {}); }
function detachedHost(): HTMLElement { const root = document.createElement("div"); root.classList.add("echoink-settings-aligned"); return root; }
function field<T extends HTMLElement>(root: HTMLElement, key: string, mcp = false): T {
  const result = root.querySelector<T>(`[data-${mcp ? "mcp-" : ""}modal-focus-key="${key}"]`);
  assert(result, `Missing real editor field: ${key}`); return result;
}
function input(root: HTMLElement, key: string, value: string, mcp = false): void {
  const element = field<HTMLInputElement>(root, key, mcp);
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
}
function select(root: HTMLElement, key: string, value: string, mcp = false): void {
  const element = field<OriginSelectElement>(root, key, mcp);
  element.value = value;
  element.dispatchEvent(new Event("change", { bubbles: true }));
}
function click(root: HTMLElement, key: string, mcp = false): void { field<HTMLButtonElement>(root, key, mcp).click(); }
function draft(): ApiProviderConfig {
  const result = createApiProviderConfig("custom", "p11-fixture");
  result.baseUrl = "https://provider.invalid/v1";
  result.models = [createApiProviderModelConfig("custom", "fixture-model")];
  result.defaultModelId = "fixture-model";
  result.apiKey = "fixture-stored-key";
  return result;
}
function provider(overrides: Partial<ProviderModelModalOptions> = {}, aligned = true, mountHost?: HTMLElement) {
  const modal = new ProviderModelModal({ app: app(), draft: draft(), editing: true, language: "zh-CN", copy: settingsCopy("zh-CN"),
    preflight: { listModels: async () => ({ status: "unsupported", models: [] }), testConnection: async () => ({ status: "available" }) },
    save: async () => ({ saved: true }), ...overrides });
  const root = mountHost ?? host(aligned); let returned = 0, closed = 0;
  const handle = mountSettingsEditor(modal, root, "返回", () => { closed++; }, { onNavigateBack: () => { returned++; } });
  return { modal, root, handle, get returned() { return returned; }, get closed() { return closed; } };
}

export async function runSettingsEditorTests(): Promise<void> {
  installProviderBrowserHost();
  {
    const root = host(); const selected: string[] = [];
    renderProviderServicePicker(root, { language: "zh-CN", addedProviderIds: ["deepseek"], onSelect: preset => { selected.push(preset.id); } });
    assert.equal(root.querySelectorAll("section").length, 5);
    assert.deepEqual([...root.querySelectorAll<HTMLElement>("[data-provider-service]")].map(node => node.dataset.providerService).sort(), API_PROVIDER_PRESETS.map(preset => preset.id).sort());
    assert.equal(root.querySelector('[data-provider-category="local"] [data-provider-service]')?.getAttribute("data-provider-service"), "ollama");
    assert.equal(root.querySelector('[data-provider-category="plan"] [data-provider-service]')?.getAttribute("data-provider-service"), "qwen-token-plan");
    assert.equal(selected.length, 0);
    assert.equal(root.querySelector('[data-provider-service="deepseek"] .echoink-provider-service-status')?.textContent, "已添加");
    assert.equal(root.querySelector('[data-provider-service="kimi"] .echoink-provider-service-status'), null, "unconfigured providers must not appear added");
    for (const card of root.querySelectorAll<HTMLButtonElement>("[data-provider-service]")) card.click();
    assert.equal(selected.length, API_PROVIDER_PRESETS.length);
    disposeOriginControls(root); root.remove();
    console.log("PASS five preset-backed service categories navigate without login, test or save");
  }
  {
    const f = provider({}, false);
    assert.equal(f.modal.titleEl.textContent, "编辑模型", "unscoped/mobile hosts keep their original model editor title");
    assert.equal(f.root.querySelector('[data-modal-focus-key="provider-delete"]'), null, "mobile keeps deletion on its original list");
    assert.ok(f.root.querySelector(".provider-connection-card > .provider-connection-header"), "the existing independent form keeps its own header");
    input(f.root, "name", "旧容器仍可编辑");
    f.handle.suspend(); f.handle.resume(document.body);
    assert.equal(field<HTMLInputElement>(f.root, "name").value, "旧容器仍可编辑");
    click(f.root, "cancel"); assert.equal(f.handle.disposed, true);
    console.log("PASS unscoped/mobile editor retains its original form and draft lifecycle");
  }
  {
    let saves = 0;
    const f = provider({ save: async () => { saves++; return { saved: true }; } }, true, detachedHost());
    assert.equal(f.root.isConnected, false, "production mounts the form before attaching its host to the settings shell");
    assert.ok(f.modal.titleEl.querySelector(".echoink-provider-form-brand svg"), "the first detached render already has the provider brand title");
    assert.equal(f.root.querySelectorAll(".provider-form-section > .provider-connection-header, .provider-form-section > .provider-model-header").length, 2, "both titles are outside the group before attachment");
    input(f.root, "name", "挂载前的连接草稿");
    document.body.appendChild(f.root);
    const help = f.root.querySelector<HTMLButtonElement>('[aria-label="自定义供应商名称说明"]')!;
    const helpPanel = help.querySelector<HTMLElement>(".echoink-settings-help-panel")!;
    assert.ok(helpPanel.hidden, "optional provider instructions start collapsed");
    help.focus(); assert.equal(helpPanel.hidden, false, "keyboard focus exposes the existing instructions");
    help.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(helpPanel.hidden, true); assert.equal(saves, 0, "reading help never submits the form");
    f.handle.suspend(); f.handle.resume(document.body);
    assert.equal(field<HTMLInputElement>(f.root, "name").value, "挂载前的连接草稿");
    assert.equal(f.modal.titleEl.querySelectorAll(".echoink-provider-form-brand").length, 1);
    assert.equal(saves, 0); f.handle();

    const root = detachedHost();
    const modal = new McpServerModal({ app: app(), language: "zh-CN", save: async () => { saves++; } });
    const handle = mountSettingsEditor(modal, root, "返回", () => {}, { onNavigateBack: () => {} });
    assert.equal(root.isConnected, false);
    assert.equal(root.querySelectorAll(".codex-mcp-server-form > .echoink-settings-section > .echoink-settings-group").length, 3, "MCP groups receive desktop presentation on the first detached render");
    assert.match(field(root, "endpoint", true).closest(".codex-mcp-server-field")!.querySelector(".codex-mcp-server-field-description")!.textContent!, /不要在 URL/);
    assert.ok(root.querySelector(".codex-mcp-credential-description"), "credential safety remains visible beside the fields");
    assert.match(field(root, "credential-secret", true).closest(".codex-mcp-server-field")!.querySelector(".codex-mcp-server-field-description")!.textContent!, /本次保存/);
    input(root, "name", "挂载前的 MCP 草稿", true);
    document.body.appendChild(root); handle.suspend(); handle.resume(document.body);
    assert.equal(field<HTMLInputElement>(root, "name", true).value, "挂载前的 MCP 草稿");
    assert.equal(saves, 0); handle();
    console.log("PASS detached Provider/MCP hosts get desktop groups before attachment and retain their original draft lifecycle");
  }
  {
    let saves = 0; const f = provider({ save: async () => { saves++; return { saved: true }; } });
    input(f.root, "name", "未保存连接"); input(f.root, "apiKey", "fixture-draft-key");
    input(f.root, "manual-model", "partially-typed-model");
    click(f.root, "model:fixture-model:parameters");
    input(f.root, "model:fixture-model:contextWindow", "900");
    const name = field<HTMLInputElement>(f.root, "name"); name.focus(); name.setSelectionRange(1, 4);
    f.root.querySelector<HTMLButtonElement>(".settings-back")!.focus();
    f.root.querySelector<HTMLButtonElement>(".settings-back")!.click();
    assert.equal(f.returned, 1); assert.equal(f.closed, 0); assert.equal(f.handle.suspended, true); assert.equal(f.root.isConnected, false);
    f.handle.resume(document.body);
    assert.equal(field<HTMLInputElement>(f.root, "name").value, "未保存连接");
    assert.equal(document.activeElement, field(f.root, "name"));
    assert.equal(field<HTMLInputElement>(f.root, "name").selectionStart, 1);
    assert.equal(field<HTMLInputElement>(f.root, "apiKey").value, "fixture-draft-key");
    assert.equal(field<HTMLInputElement>(f.root, "apiKey").type, "password");
    assert.equal(field<HTMLInputElement>(f.root, "manual-model").value, "partially-typed-model");
    assert.equal(field<HTMLInputElement>(f.root, "model:fixture-model:contextWindow").value, "900");
    assert.equal(field(f.root, "model:fixture-model:contextWindow").getAttribute("aria-invalid"), "true");
    click(f.root, "cancel"); assert.equal(f.handle.disposed, true); assert.equal(f.closed, 1); assert.equal(saves, 0);
    f.handle.resume(document.body); assert.equal(f.root.isConnected, false);
    console.log("PASS real Provider return preserves Key, partial text, invalid budget, expansion, focus and selection; cancel discards");
  }
  {
    let removals = 0, saves = 0;
    const gate = deferred<boolean>();
    const f = provider({ remove: { message: "删除此服务会切换当前模型。", action: async () => { removals++; return removals === 1 ? gate.promise : true; } },
      save: async () => { saves++; return { saved: true }; } });
    const remove = () => field<HTMLButtonElement>(f.root, "provider-delete");
    input(f.root, "name", "保留的删除草稿"); input(f.root, "apiKey", "fixture-delete-draft-key");
    select(f.root, "protocol", "openai-responses");
    assert.equal(f.root.querySelectorAll('[data-modal-focus-key="provider-delete"]').length, 1, "full form redraw retains exactly one removal action");
    assert.equal(remove().classList.contains("echoink-delete-button"), true);
    remove().click();
    const canceled = f.root.querySelector<HTMLElement>(".echoink-settings-inline-confirm")!;
    assert.match(canceled.textContent!, /切换当前模型/);
    canceled.querySelector<HTMLButtonElement>("button")!.click();
    assert.equal(removals, 0); assert.equal(saves, 0); assert.equal(f.closed, 0);
    assert.equal(document.activeElement, remove(), "cancel returns focus to the detail deletion action");
    remove().click();
    f.root.querySelector<HTMLButtonElement>(".echoink-settings-inline-confirm .settings-danger")!.click();
    click(f.root, "save"); remove().click();
    assert.equal(removals, 1); assert.equal(saves, 0, "pending deletion prevents another deletion or save");
    f.handle.suspend(); f.handle.resume(document.body);
    assert.equal(remove().disabled, true, "the redraw keeps deletion pending");
    gate.resolve(false); await settle();
    assert.equal(f.closed, 0); assert.equal(f.handle.disposed, false, "a rejected deletion cannot close the retained form");
    assert.equal(remove().disabled, false); assert.match(f.root.textContent!, /未删除/);
    assert.equal(field<HTMLInputElement>(f.root, "name").value, "保留的删除草稿");
    assert.equal(field<HTMLInputElement>(f.root, "apiKey").value, "fixture-delete-draft-key");
    remove().click(); f.root.querySelector<HTMLButtonElement>(".echoink-settings-inline-confirm .settings-danger")!.click(); await settle();
    assert.equal(removals, 2); assert.equal(f.closed, 1); assert.equal(f.handle.disposed, true);
    const fresh = provider({ editing: false, remove: { message: "unused", action: async () => { removals++; return true; } } });
    assert.equal(fresh.root.querySelector('[data-modal-focus-key="provider-delete"]'), null, "unsaved services have no deletion action"); fresh.handle();
    console.log("PASS real Provider detail deletion survives redraw; cancel writes nothing, failure keeps draft, pending blocks duplicates and success closes");
  }
  {
    const saved: { draft: ApiProviderConfig; key: string; verified: boolean }[] = [];
    const gate = deferred<{ saved: false; message: string }>();
    const f = provider({ save: async (value, key, verified) => {
      saved.push({ draft: structuredClone(value), key, verified });
      return saved.length === 1 ? gate.promise : { saved: true };
    } });
    input(f.root, "name", "完整字段连接"); input(f.root, "apiKey", "fixture-fresh-key");
    input(f.root, "endpoint", "https://changed.invalid/v1"); select(f.root, "protocol", "openai-responses");
    click(f.root, "model:fixture-model:parameters");
    click(f.root, "toggle:model:fixture-model:tool-calling"); click(f.root, "toggle:model:fixture-model:image-input"); click(f.root, "toggle:model:fixture-model:reasoning");
    input(f.root, "model:fixture-model:contextWindow", "64000");
    input(f.root, "model:fixture-model:modelMaxTokens", "8000"); input(f.root, "model:fixture-model:maxOutputTokens", "4000");
    click(f.root, "save"); click(f.root, "save"); assert.equal(saved.length, 1);
    f.handle.suspend(); f.handle.resume(document.body); gate.resolve({ saved: false, message: "fixture disk failure" }); await settle();
    assert.match(f.root.textContent!, /fixture disk failure/);
    assert.equal(field<HTMLButtonElement>(f.root, "save").disabled, false, "failed save must unlock the current mounted button");
    click(f.root, "save"); await settle(); assert.equal(saved.length, 2); assert.equal(f.handle.disposed, true);
    assert.equal(saved[1].draft.name, "完整字段连接"); assert.equal(saved[1].key, "fixture-fresh-key");
    assert.equal(saved[1].draft.baseUrl, "https://changed.invalid/v1"); assert.equal(saved[1].draft.apiProtocol, "openai-responses");
    assert.equal(saved[1].draft.defaultModelId, "fixture-model"); assert.equal(saved[1].draft.models.length, 1);
    assert.deepEqual(saved[1].draft.models[0].limitsOverride, { contextWindow: 64000, modelMaxTokens: 8000, maxOutputTokens: 4000 });
    assert.equal(saved[1].draft.models[0].capabilityOverrides?.toolCalling, !draft().models[0].toolCalling, "tool capability toggle must reach save unchanged");
    assert.deepEqual(saved[1].draft.models[0].input, ["text", "image"]); assert.equal(saved[1].draft.models[0].reasoningEnabled, !draft().models[0].reasoningEnabled);
    assert.equal(saved[1].verified, false);
    console.log("PASS complete Provider fields use original save callback; duplicate prevention and failed save survive suspend/resume");
  }
  {
    const lists = [deferred<PiProviderModelListResult>(), deferred<PiProviderModelListResult>()];
    const connection = deferred<PiProviderConnectionTestResult>(); let listCalls = 0;
    const f = provider({ preflight: { listModels: () => lists[listCalls++].promise, testConnection: () => connection.promise } });
    click(f.root, "model-discover"); input(f.root, "apiKey", "fixture-newer-key");
    lists[0].resolve({ status: "available", source: "remote", models: [{ id: "stale-model" }] }); await settle();
    assert.equal(field<HTMLInputElement>(f.root, "apiKey").value, "fixture-newer-key"); assert.doesNotMatch(f.root.textContent!, /stale-model/);
    click(f.root, "model-discover"); f.handle.suspend();
    lists[1].resolve({ status: "available", source: "remote", models: [{ id: "hidden-stale-model" }] }); await settle(); f.handle.resume(document.body);
    assert.doesNotMatch(f.root.textContent!, /hidden-stale-model/); assert.equal(field<HTMLButtonElement>(f.root, "model-discover").disabled, false);
    click(f.root, "provider-test-connection"); input(f.root, "endpoint", "https://latest.invalid/v1");
    connection.resolve({ status: "available" }); await settle();
    assert.equal(field<HTMLInputElement>(f.root, "endpoint").value, "https://latest.invalid/v1");
    assert.equal(f.root.querySelector(".codex-provider-model-status")?.classList.contains("is-available"), false);
    f.handle();
    console.log("PASS real Provider ignores late model/test responses after input changes and navigation");
  }
  {
    let reads = 0;
    const f = provider({ preflight: { listModels: async () => { reads++; return { status: "available", source: "remote", models: [{ id: "discovered-model" }] }; }, testConnection: async () => ({ status: "available" }) } });
    click(f.root, "model-discover"); await settle();
    input(f.root, "apiKey", "fixture-replacement-key");
    assert.equal(f.root.querySelectorAll('[data-modal-focus-key="model-discover"]').length, 1, "changing provider identity replaces the model section and its original discover control together");
    click(f.root, "model-discover"); await settle();
    assert.equal(reads, 2, "the remaining discover control still uses the live preflight session");
    f.handle();
    console.log("PASS aligned model section replacement releases the old header and retains one live discover action");
  }
  {
    const status = deferred<OpenAICodexAuthStatus>(); const refreshed = deferred<OpenAICodexAuthStatus>(); let reads = 0; const login = deferred<OpenAICodexAuthStatus>(); let interaction: AuthInteraction | undefined;
    const f = provider({ draft: createApiProviderConfig("openai-codex", "oauth-fixture"), editing: false, codexOAuth: {
      status: () => ++reads === 1 ? status.promise : reads === 2 ? refreshed.promise : Promise.resolve({ state: "disconnected" }), login: value => { interaction = value; return login.promise; }, logout: async () => {}, openExternal: async () => true
    } });
    f.handle.suspend(); status.resolve({ state: "connected" } as OpenAICodexAuthStatus); await settle(); f.handle.resume(document.body);
    assert.equal(f.root.querySelector(".codex-provider-oauth-card")?.classList.contains("is-disconnected"), true);
    assert.equal(reads, 2, "resuming must reread actual local OAuth status");
    refreshed.resolve({ state: "disconnected" }); await settle();
    click(f.root, "codex-oauth-login"); assert(interaction);
    f.handle.suspend(); assert.equal(interaction.signal?.aborted, true); f.handle.resume(document.body);
    login.resolve({ state: "connected" } as OpenAICodexAuthStatus); await settle();
    assert.equal(f.root.querySelector(".codex-provider-oauth-card")?.classList.contains("is-disconnected"), true);
    f.handle();
    console.log("PASS canceled OAuth status/login completions cannot overwrite the retained editor");
  }
  for (const transport of ["http", "stdio"] as const) {
    const saved: EchoInkMcpServerDraft[] = []; let closed = 0;
    const options: McpServerModalOptions = { app: app(), language: "zh-CN", save: async value => { saved.push(structuredClone(value)); } };
    const modal = new McpServerModal(options); const root = host();
    const handle = mountSettingsEditor(modal, root, "返回", () => { closed++; }, { onNavigateBack: () => {} });
    if (transport === "stdio") select(root, "transport", "stdio", true);
    input(root, "name", `${transport} fixture`, true); input(root, "description", "说明草稿", true);
    input(root, "endpoint", transport === "http" ? "https://mcp.invalid/mcp" : "npx", true);
    if (transport === "stdio") { input(root, "args", "-y\n@fixture/server", true); input(root, "cwd", "/fixture", true); }
    input(root, "public-values", transport === "http" ? "X-Fixture=value" : "LOG_LEVEL=info", true);
    input(root, "credential-target", transport === "http" ? "Authorization" : "API_TOKEN", true);
    input(root, "credential-prefix", "Bearer ", true); input(root, "credential-secret", "fixture-secret", true);
    root.querySelector<HTMLButtonElement>(".settings-back")!.click(); handle.resume(document.body);
    assert.equal(field<HTMLInputElement>(root, "name", true).value, `${transport} fixture`);
    assert.equal(field<HTMLInputElement>(root, "credential-secret", true).value, "fixture-secret");
    click(root, "save", true); await settle(); assert.equal(saved.length, 1); assert.equal(closed, 1); assert.equal(handle.disposed, true);
    const value = saved[0]; assert.equal(value.transport, transport); assert.equal(value.description, "说明草稿");
    assert.deepEqual(value.credential, { purpose: transport === "http" ? "mcp_header" : "mcp_env", targetName: transport === "http" ? "Authorization" : "API_TOKEN", prefix: "Bearer ", secret: "fixture-secret" });
    if (value.transport === "http") { assert.equal(value.url, "https://mcp.invalid/mcp"); assert.deepEqual(value.headers, { "X-Fixture": "value" }); }
    else { assert.equal(value.command, "npx"); assert.deepEqual(value.args, ["-y", "@fixture/server"]); assert.equal(value.cwd, "/fixture"); assert.deepEqual(value.env, { LOG_LEVEL: "info" }); }
  }
  {
    const saved: EchoInkMcpServerDraft[] = [];
    const modal = new McpServerModal({ app: app(), language: "zh-CN",
      resource: { id: "manual:mcp:fixture", name: "Existing MCP", description: "", enabled: true, kind: "mcp-server", source: "manual", bridgeMode: "structured-tools" },
      connection: { transport: "http", url: "https://mcp.invalid", trusted: false, toolPolicies: {}, tools: [], credential: { credentialRef: "fixture-ref", purpose: "mcp_header", targetName: "Authorization", prefix: "Bearer ", endpointRevision: 1 } },
      save: async value => { saved.push(value); }
    });
    const root = host(); const handle = mountSettingsEditor(modal, root, "返回", () => {}, { onNavigateBack: () => {} });
    assert.equal(field<HTMLInputElement>(root, "credential-secret", true).value, "");
    root.querySelector<HTMLButtonElement>(".settings-back")!.click(); handle.resume(document.body);
    click(root, "save", true); await settle();
    assert.equal(saved[0].resourceId, "manual:mcp:fixture");
    assert.deepEqual(saved[0].credential, { purpose: "mcp_header", targetName: "Authorization", prefix: "Bearer " });
    const fresh = new McpServerModal({ app: app(), language: "zh-CN", save: async value => { saved.push(value); } });
    const canceled = host(); const canceledHandle = mountSettingsEditor(fresh, canceled, "返回", () => {});
    input(canceled, "name", "discard me", true); input(canceled, "credential-secret", "fixture-cancel-secret", true);
    click(canceled, "cancel", true); assert.equal(canceledHandle.disposed, true); assert.equal(saved.length, 1);
  }
  {
    const gate = deferred<void>(); const modal = new McpServerModal({ app: app(), language: "zh-CN", save: () => gate.promise }); const root = host();
    const handle = mountSettingsEditor(modal, root, "返回", () => {});
    input(root, "name", "pending", true); input(root, "endpoint", "https://mcp.invalid", true); click(root, "save", true);
    handle(); gate.resolve(); await settle(); assert.equal(root.isConnected, false); assert.equal(modal.contentEl.childElementCount, 0);
  }
  assert.equal(document.querySelector(".modal-container"), null);
  console.log("PASS real MCP HTTP/stdio complete fields and credentials round-trip; disposed async save cannot remount a form");
}
