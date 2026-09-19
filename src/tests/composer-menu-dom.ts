import { closeComposerParameterMenu, openModelMenu, type ModelMenuState } from "../ui/codex-view/menus";
import { installComposerMenuDomHelpers } from "./composer-menu-dom-host";

const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

export async function runComposerMenuDom(): Promise<void> {
  const report = document.querySelector<HTMLElement>("#report")!;
  const results: string[] = [];
  const errors: string[] = [];
  window.addEventListener("error", (event) => errors.push(event.message));
  const run = async (name: string, owner: Document) => {
    try { await assertComposerMenu(owner); results.push(`PASS ${name}`); }
    catch (error) { results.push(`FAIL ${name}: ${String(error)}`); }
    finally { closeComposerParameterMenu(); }
  };
  await run("production menu in main document", document);
  const iframe = document.querySelector<HTMLIFrameElement>("#independent")!;
  await new Promise<void>((resolve) => {
    iframe.onload = () => resolve();
    iframe.srcdoc = '<meta charset="utf-8"><link rel="stylesheet" href="styles.css"><style>body{padding:24px;font:14px sans-serif}button{margin:8px}output{display:block}</style><main id="fixture"></main>';
  });
  const owner = iframe.contentDocument!;
  assert(!(owner.body instanceof HTMLElement) && !(owner.body instanceof Node), "independent document must use another realm");
  owner.defaultView!.addEventListener("error", (event) => errors.push(event.message));
  await run("production menu in independent ownerDocument", owner);
  report.dataset.result = results.some((result) => result.startsWith("FAIL")) || errors.length ? "failed" : "passed";
  report.textContent = [...results, ...errors.map((error) => `ERROR ${error}`),
    "Checks per document: open; internal pointer; hover/submenu; outside cancellation; model/reasoning selection; ArrowLeft/Escape; disabled; trigger toggle; detached-anchor cleanup.",
    "Boundary: real browser DOM and production menu, synthetic input; no Obsidian, Provider or Vault."
  ].join("\n");
}

async function assertComposerMenu(owner: Document): Promise<void> {
  installComposerMenuDomHelpers(owner);
  const host = owner.querySelector<HTMLElement>("#fixture")!;
  const anchor = owner.createElement("button"); anchor.textContent = "模型和参数";
  const outside = owner.createElement("button"); outside.textContent = "外部区域（取消菜单）";
  // Exercise the existing capture listener even if host bubbling is stopped.
  outside.addEventListener("pointerdown", (event) => event.stopPropagation());
  const output = owner.createElement("output");
  host.append(anchor, outside, output);
  const selected: string[] = [];
  const state: ModelMenuState = {
    language: "zh-CN", selectedProviderSettingsId: "provider-a", selectedModel: "model-a",
    providerModels: [
      { providerSettingsId: "provider-a", providerName: "Provider A", modelId: "model-a", modelName: "Model A" },
      { providerSettingsId: "provider-b", providerName: "Provider B", modelId: "model-b", modelName: "Model B" }
    ],
    selectedReasoning: "low", reasoningCurrentValue: "低", reasoningDisabledReason: "", reasoningAdjustable: true,
    reasoningOptions: [{ effort: "low", label: "低" }, { effort: "high", label: "高" }], selectedMode: "agent"
  };
  const record = (value: string) => { selected.push(value); output.textContent = `提交次数：${selected.length}；最近：${value}`; };
  output.textContent = "提交次数：0";
  anchor.onclick = (event) => openModelMenu(event, state, {
    onSelectModel: (value) => { state.selectedProviderSettingsId = value.providerSettingsId; state.selectedModel = value.modelId; record(`${value.providerSettingsId}/${value.modelId}`); },
    onSelectReasoning: (value) => {
      state.selectedReasoning = value;
      state.reasoningCurrentValue = state.reasoningOptions.find((option) => option.effort === value)!.label;
      record(value);
    },
    onSelectMode: (value) => { state.selectedMode = value; record(value); }
  });
  const root = () => owner.querySelector<HTMLElement>(".codex-composer-parameter-menu");
  const submenu = () => owner.querySelector<HTMLElement>(".codex-composer-parameter-submenu");
  const trigger = (index: number) => root()!.querySelectorAll<HTMLButtonElement>(".codex-parameter-menu-trigger")[index];
  const pointer = (element: Element) => element.dispatchEvent(new owner.defaultView!.PointerEvent("pointerdown", { bubbles: true, composed: true, pointerType: "mouse", button: 0 }));
  const key = (element: HTMLElement, value: string) => element.dispatchEvent(new owner.defaultView!.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
  const open = async () => { anchor.click(); await frame(); assert(root()?.ownerDocument === owner, "native trigger did not open production menu in its ownerDocument"); };

  await open();
  pointer(root()!); assert(root(), "inside pointer closed root");
  trigger(0).dispatchEvent(new owner.defaultView!.MouseEvent("mouseenter"));
  assert(submenu()?.ownerDocument === owner && selected.length === 0, "hover did not open submenu without submitting");
  pointer(submenu()!); assert(root() && submenu(), "submenu pointer closed menu");
  pointer(outside); await frame();
  assert(!root() && !submenu(), "one outside pointerdown did not close production menu");
  assert(selected.length === 0 && state.selectedModel === "model-a" && anchor.getAttribute("aria-expanded") === "false", "cancellation submitted or left anchor open");

  await open(); trigger(0).click();
  const option = submenu()!.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]")[1];
  pointer(option); assert(root() && submenu(), "option pointer dismissed before click"); option.click();
  assert(selected.join() === "provider-b/model-b" && !root() && !submenu(), "model option did not submit once and close");
  await open(); trigger(1).click(); submenu()!.querySelectorAll<HTMLButtonElement>("button")[1].click();
  assert(selected.join() === "provider-b/model-b,high" && state.selectedReasoning === "high" && !root(), "reasoning option did not submit and close");

  await open(); trigger(2).click();
  key(submenu()!, "ArrowLeft"); assert(root() && !submenu() && owner.activeElement === trigger(2), "ArrowLeft did not return to the root trigger");
  trigger(0).click(); key(owner.activeElement as HTMLElement, "Escape");
  assert(root() && !submenu() && owner.activeElement === trigger(0), "first Escape did not close only submenu");
  key(owner.activeElement as HTMLElement, "Escape");
  assert(!root() && owner.activeElement === anchor && selected.length === 2, "second Escape did not cancel and restore focus");
  state.reasoningAdjustable = false; state.reasoningDisabledReason = "测试禁用";
  await open(); pointer(trigger(1)); trigger(1).click();
  assert(root() && !submenu() && trigger(1).getAttribute("aria-disabled") === "true", "disabled reasoning opened or closed the menu");
  anchor.click(); assert(!root(), "anchor second click did not toggle closed");
  state.reasoningAdjustable = true; state.reasoningDisabledReason = "";
  await open(); anchor.remove(); await frame();
  assert(!root() && !submenu(), "detaching anchor left the menu mounted");
  host.prepend(anchor); pointer(outside);
  assert(selected.length === 2, "cleanup left a selection handler active");
}

void runComposerMenuDom().catch((error) => {
  const report = document.querySelector<HTMLElement>("#report")!;
  report.dataset.result = "failed"; report.textContent = String(error);
});
