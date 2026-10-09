import type { App } from "obsidian";
import { createOriginButton, createOriginCheck, createOriginInput, createOriginRadioGroup, createOriginSelect, createOriginSlider, createOriginSwitch, disposeOriginControls, type OriginCheckElement, type OriginSelectElement } from "../settings/origin-controls";
import { createOriginSelectHostFixture } from "./origin-obsidian-dom-shim";
import type { ApiProviderConfig, CodexForObsidianSettings } from "../settings/settings";
import { getApiProviderPreset, type ApiProviderId } from "../settings/provider-presets";
import { renderProviderBrandIcon } from "../settings/provider-brand-icons";

type AsyncFixture = {
  activations: number;
  renderCurrentModel(parent: HTMLElement, settings: CodexForObsidianSettings, app: Pick<App, "keymap" | "scope">): OriginSelectElement;
  runMcpToggleAction(toggle: OriginCheckElement, action: (checked: boolean) => Promise<void>): Promise<void>;
};
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const key = (element: HTMLElement, value: string, modifiers: KeyboardEventInit = {}) => element.dispatchEvent(new (element.ownerDocument.defaultView!.KeyboardEvent)("keydown", { key: value, bubbles: true, cancelable: true, ...modifiers }));
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };

export async function runOriginControlsDom(Fixture: new () => AsyncFixture) {
  const results: string[] = [];
  const main = document.querySelector<HTMLElement>("#fixture")!;
  const report = document.querySelector<HTMLElement>("#report")!;
  // Match the production page/group/row hierarchy so legacy action selectors
  // participate in the cascade, just as they do in Obsidian Settings.
  const body = document.createElement("div"); body.className = "codex-settings-body"; main.append(body);
  const page = document.createElement("div"); page.className = "echoink-settings-page"; body.append(page);
  const card = document.createElement("section"); card.className = "echoink-settings-section is-group settings-card"; page.append(card);
  const group = document.createElement("div"); group.className = "echoink-settings-group settings-stack"; card.append(group);
  const errors: string[] = [];
  window.addEventListener("error", (event) => errors.push(event.message));
  const section = (label: string) => {
    const row = document.createElement("div"); row.className = "setting-item echoink-settings-row setting-row";
    const copy = document.createElement("span"); copy.className = "setting-item-info setting-copy"; copy.textContent = label; row.append(copy);
    const controls = document.createElement("div"); controls.className = "setting-item-control setting-controls"; row.append(controls); group.append(row); return controls;
  };
  const run = async (name: string, test: () => void | Promise<void>) => {
    try { await test(); results.push(`PASS ${name}`); }
    catch (error) { results.push(`FAIL ${name}: ${String(error)}`); }
    report.textContent = results.join("\n");
  };
  await run("switch callback, authoritative rollback, disabled", async () => {
    const toggle = createOriginSwitch(section("Switch"), { attr: { "aria-label": "Switch" } });
    let calls = 0;
    toggle.onchange = () => { calls++; };
    toggle.click(); await frame();
    assert(toggle.checked && toggle.getAttribute("aria-checked") === "true" && calls === 1, "click did not update state/callback");
    toggle.checked = false;
    assert(toggle.getAttribute("aria-checked") === "false", "rollback did not update primitive");
    toggle.disabled = true; toggle.click();
    assert(calls === 1 && toggle.hasAttribute("disabled"), "disabled control changed");
    toggle.disabled = false;
  });
  await run("checkbox label click", async () => {
    const label = document.createElement("label"); label.textContent = "Choose model "; section("Checkbox").append(label);
    const check = createOriginCheck(label, { attr: { "aria-label": "Choose model" } });
    label.click(); await frame(); assert(check.checked, "label did not activate checkbox");
    check.checked = false; check.indeterminate = true;
    assert(check.getAttribute("aria-checked") === "mixed" && check.dataset.state === "indeterminate", "partial selection did not reach the real checkbox");
    assert(Boolean(check.querySelector("[data-slot=checkbox-indicator] svg")), "partial selection indicator is missing");
    label.click(); await frame();
    assert(check.checked && !check.indeterminate && check.getAttribute("aria-checked") === "true", "selecting a mixed checkbox did not select all");
  });
  await run("one radio Root, arrow navigation, disabled item", async () => {
    let selected = "a";
    const group = createOriginRadioGroup(section("Default model"), "a", "Default model", (value) => { selected = value; });
    const targets = ["a", "b", "c"].map((value) => { const row = document.createElement("label"); row.textContent = value; group.element.append(row); return row; });
    const a = group.addItem(targets[0], "a", false);
    group.addItem(targets[1], "b", true);
    const c = group.addItem(targets[2], "c", false);
    a.focus(); key(a, "ArrowDown"); await frame();
    assert(selected === "c" && document.activeElement === c && c.getAttribute("aria-checked") === "true" && a.getAttribute("aria-checked") === "false", "radio collection did not skip disabled item or keep mutual exclusion");
  });
  await run("select empty label, arrow selection, Escape focus", async () => {
    const controls = section("Language / empty model");
    const empty = createOriginSelect(controls, { attr: { "aria-label": "No models" } }, [{ value: "", label: "No saved models" }]).element;
    await frame(); assert(empty.textContent?.includes("No saved models"), "empty option label disappeared");
    let selected = "zh";
    const select = createOriginSelect(controls, { attr: { "aria-label": "Language" } }, [{ value: "zh", label: "中文" }, { value: "en", label: "English" }], "zh").element;
    select.onchange = () => { selected = select.value; };
    select.focus(); key(select, "Enter"); await frame();
    const popup = document.getElementById(select.getAttribute("aria-controls")!)!;
    const option = popup?.querySelector<HTMLElement>('[role=option][data-state=checked]')!;
    assert(option && popup.ownerDocument === select.ownerDocument, "popup not mounted in owning document");
    const bounds = option.getBoundingClientRect();
    assert(bounds.width > 0 && bounds.height > 0 && popup.contains(document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)), "popup option is clipped or visually covered by the native settings hierarchy");
    key(option, "ArrowDown"); await frame();
    key(document.activeElement as HTMLElement, "Enter"); await frame();
    assert(selected === "en" && select.value === "en", "selected value did not reach callback");
    select.focus(); key(select, "Enter"); await frame();
    key(document.activeElement as HTMLElement, "Escape"); await frame();
    assert(!document.querySelector('[data-slot=select-content]') && document.activeElement === select, "Escape failed to close and restore focus");
  });
  await run("slider continuous keyboard commits and focus", async () => {
    const controls = section("Runs per day"); controls.classList.add("general-range");
    const output = document.createElement("output"); output.textContent = "3/day";
    const values: number[] = []; const commits: number[] = [];
    const slider = createOriginSlider(controls, { value: 3, min: 1, max: 6, step: 1, label: "Runs per day",
      onValueChange: (value) => { values.push(value); output.textContent = `${value}/day`; }, onValueCommit: (value) => commits.push(value) });
    controls.append(output);
    const thumb = slider.querySelector<HTMLElement>('[role=slider]')!; thumb.focus();
    for (const direction of ["ArrowRight", "ArrowRight", "ArrowLeft"]) { key(thumb, direction); await frame(); }
    assert(values.join() === "4,5,4" && commits.join() === "4,5,4" && document.activeElement === thumb, "continuous update/commit/focus failed");
  });
  await run("Input composition retains node, selection and value", async () => {
    const input = createOriginInput(section("Journal folder"), { attr: { "aria-label": "Journal folder" } });
    input.focus(); input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    input.value = "zhong"; input.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true })); await frame();
    assert(input.isConnected && document.activeElement === input && input.value === "zhong", "composition detached input");
    input.value = "中文"; input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中文" }));
  });
  await run("production MCP async failure after page disposal", async () => {
    const page = document.createElement("div"); main.append(page);
    const toggle = createOriginSwitch(page); toggle.checked = true;
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, onReject) => { reject = onReject; });
    const work = new Fixture().runMcpToggleAction(toggle, () => pending);
    disposeOriginControls(page); page.remove(); reject(new Error("expected save failure"));
    await work;
    assert(!toggle.checked && !toggle.disabled, "production rollback did not settle after unmount");
  });
  await run("select outside pointer cancels in main document even if bubbling stops", async () => {
    await assertSelectPointerCancellation(document, main, true);
  });
  await run("select outside pointer cancels in independent ownerDocument", async () => {
    const iframe = document.createElement("iframe"); main.append(iframe);
    await new Promise<void>((resolve) => { iframe.onload = () => resolve(); iframe.srcdoc = "<main></main>"; });
    try {
      const other = iframe.contentDocument!;
      assert(!(other.body instanceof Node), "fixture must exercise another DOM realm");
      await assertSelectPointerCancellation(other, other.querySelector<HTMLElement>("main")!, false);
    } finally { iframe.remove(); }
  });
  await run("production current model: brand icons, text, typeahead, selection, disabled and empty", async () => {
    await assertCurrentModelIcons(Fixture, document, group);
  });
  await run("production current model icons in independent ownerDocument", async () => {
    const iframe = document.createElement("iframe"); main.append(iframe);
    await new Promise<void>((resolve) => { iframe.onload = () => resolve(); iframe.srcdoc = '<link rel="stylesheet" href="styles.css"><main class="echoink-settings-demo"></main>'; });
    try {
      await assertCurrentModelIcons(Fixture, iframe.contentDocument!, iframe.contentDocument!.querySelector<HTMLElement>("main")!);
    } finally { disposeOriginControls(iframe.contentDocument!.body); iframe.remove(); }
  });
  await run("independent ownerDocument and Select portal cleanup", async () => {
    const iframe = document.createElement("iframe"); iframe.title = "Independent document"; main.append(iframe);
    await new Promise<void>((resolve) => { iframe.onload = () => resolve(); iframe.srcdoc = '<main class="echoink-settings-demo"></main>'; });
    const other = iframe.contentDocument!; const host = other.querySelector<HTMLElement>("main")!;
    const keyboardHost = createOriginSelectHostFixture(other.defaultView!);
    const toggle = createOriginSwitch(host); toggle.click();
    const select = createOriginSelect(host, { attr: { "aria-label": "Independent select" } }, [{ value: "a", label: "A" }, { value: "b", label: "B" }], "a", keyboardHost.app).element;
    select.focus(); key(select, "Enter"); await frame();
    assert(toggle.checked && other.querySelector('[data-slot=select-content]'), "control or portal used the wrong document");
    assert(keyboardHost.depth === 1, "popup did not activate an Obsidian Scope");
    assert(other.activeElement?.getAttribute("role") === "option", "popup focus did not enter the owning document");
    key(other.activeElement as HTMLElement, "ArrowDown"); await frame();
    key(other.activeElement as HTMLElement, "Enter"); await frame();
    assert(select.value === "b", "owning document keyboard selection failed");
    assert(keyboardHost.depth === 0, "selection left the popup Scope active");
    select.focus(); key(select, "Enter"); await frame();
    key(other.activeElement as HTMLElement, "Escape"); await frame();
    assert(!other.querySelector('[data-slot=select-content]') && other.activeElement === select, "owning document Escape/focus failed");
    assert(keyboardHost.escapes === 0 && keyboardHost.depth === 0, "popup Escape closed the host or left its Scope active");
    key(select, "Escape");
    assert(keyboardHost.escapes === 1, "closed popup still intercepted the host Escape");
    let selected = "a";
    const radios = createOriginRadioGroup(host, "a", "Default model", (value) => { selected = value; });
    const radioItems = ["a", "b", "c"].map((value) => {
      const row = other.createElement("div"); row.className = "codex-provider-model-choice"; radios.element.append(row);
      const selection = other.createElement("div"); selection.className = "codex-provider-model-choice-selection"; row.append(selection);
      const label = other.createElement("label"); label.className = "codex-provider-model-choice-default"; label.textContent = value; selection.append(label);
      return radios.addItem(label, value, value === "b");
    });
    radioItems[0].focus(); key(radioItems[0], "ArrowDown"); await frame();
    assert(selected === "c" && other.activeElement === radioItems[2] && radioItems[2].getAttribute("aria-checked") === "true" && radioItems[0].getAttribute("aria-checked") === "false", "owning document radio ArrowDown/disabled skip failed");
    key(radioItems[2], "ArrowUp"); await frame();
    assert(selected === "a" && other.activeElement === radioItems[0] && radioItems[0].getAttribute("aria-checked") === "true" && radioItems[2].getAttribute("aria-checked") === "false", "owning document radio ArrowUp/mutual exclusion failed");
    const modelRow = radioItems[0].closest<HTMLElement>(".codex-provider-model-choice")!;
    const context = createOriginInput(modelRow, { value: "8192", attr: { "aria-label": "Context window" } });
    const enabled = createOriginCheck(modelRow.querySelector<HTMLElement>(".codex-provider-model-choice-selection")!);
    for (const control of [context, enabled]) {
      control.focus();
      for (const direction of ["ArrowDown", "Home", "End"]) {
        assert(key(control, direction), "radio group intercepted a model field key"); await frame();
        assert(selected === "a" && other.activeElement === control, "model field key changed default model or focus");
      }
    }
    radioItems[0].focus();
    for (const modifier of ["metaKey", "ctrlKey", "altKey", "shiftKey"] as const) {
      assert(key(radioItems[0], "ArrowDown", { [modifier]: true }), "radio group intercepted a modified key"); await frame();
      assert(selected === "a" && other.activeElement === radioItems[0], "modified radio key changed default model or focus");
    }
    select.focus(); key(select, "Enter"); await frame();
    disposeOriginControls(host);
    assert(!host.querySelector('[data-slot]') && !other.querySelector('[data-slot=select-content]'), "root cleanup left controls or popup");
    key(host, "Escape");
    assert(keyboardHost.escapes === 2 && keyboardHost.depth === 0, "disposed popup left its Obsidian Scope active");
    keyboardHost.dispose();
    iframe.remove();
  });
  createOriginButton(section("Button"), { text: "Save", cls: "echoink-amicro-button mod-cta" });
  const failed = results.some((item) => item.startsWith("FAIL")) || errors.length > 0;
  report.dataset.result = failed ? "failed" : "passed";
  report.textContent = [...results, ...errors.map((error) => `ERROR ${error}`), "Boundary: native browser DOM, synthetic input; no Obsidian, OS IME, Provider or Vault."].join("\n");
}

async function assertCurrentModelIcons(Fixture: new () => AsyncFixture, owner: Document, parent: HTMLElement) {
  const fixture = new Fixture();
  // Only the Obsidian DOM convenience method is shimmed; actual row adapter,
  // production dropdown callback, SVG renderer and Origin/Radix remain real.
  owner.defaultView!.HTMLElement.prototype.setAttr = function (name, value) { this.setAttribute(name, String(value)); };
  const host = owner.createElement("div"); parent.append(host);
  const keyboardHost = createOriginSelectHostFixture(owner.defaultView!);
  const provider = (id: ApiProviderId): ApiProviderConfig => ({
    ...getApiProviderPreset(id), id: `${id}-fixture`, providerId: id, apiKey: "",
    models: [{ id: `${id}-model`, displayName: `${id} model` }], defaultModelId: `${id}-model`
  } as ApiProviderConfig);
  const deepseek = provider("deepseek"); deepseek.apiKey = "fixture-only";
  const qwen = provider("qwen-token-plan"); qwen.name = "Qwen team"; qwen.apiKey = "fixture-only";
  const disabled = provider("kimi");
  const settings = { settingsLanguage: "zh-CN", openAICodexCredential: null,
    apiProviders: [deepseek, qwen, disabled], activeApiProviderId: deepseek.id, defaultModel: deepseek.models[0].id
  } as CodexForObsidianSettings;
  const select = fixture.renderCurrentModel(host, settings, keyboardHost.app);
  const popup = () => owner.querySelector<HTMLElement>('[data-slot=select-content]');
  try {
    await frame();
    const expectedLabel = `深度求索 · ${deepseek.models[0].displayName}`;
    assert(select.textContent?.trim() === expectedLabel && select.getAttribute("aria-label") === "EchoInk 当前模型", "selected text or accessible name changed");
    const selectedIcon = select.querySelector<SVGSVGElement>('svg[data-provider-brand="deepseek"]')!;
    assert(selectedIcon?.ownerDocument === owner && selectedIcon.getAttribute("aria-hidden") === "true", "selected brand missing, exposed or in the wrong document");
    const reference = owner.createElement("span");
    const providerIcon = renderProviderBrandIcon(reference, "deepseek");
    const artwork = (svg: Element | null) => svg?.innerHTML.replace(/echoink-provider-deepseek-\d+-/gu, "instance-");
    assert(artwork(selectedIcon) === artwork(providerIcon), "selected DeepSeek artwork differs from Provider renderer");
    const bounds = selectedIcon.getBoundingClientRect();
    assert(bounds.width === 16 && bounds.height === 16, "brand icon is missing its fixed size");
    select.focus(); key(select, "Enter"); await frame();
    const options = Array.from(popup()!.querySelectorAll<HTMLElement>('[role=option]'));
    assert(options.length === 3, "production model options changed");
    assert(options[0].textContent?.trim() === expectedLabel && artwork(options[0].querySelector("svg[data-provider-brand=deepseek]")) === artwork(providerIcon), "option text or artwork differs from selected value");
    const paint = (svg: Element) => Array.from(svg.querySelectorAll("path")).map((path) => {
      const style = owner.defaultView!.getComputedStyle(path);
      return [style.fill.replace(/echoink-provider-(?:deepseek|qwen-token-plan)-\d+-/gu, "instance-"), style.stroke, style.strokeWidth];
    });
    assert(JSON.stringify(paint(select.querySelector("svg[data-provider-brand=deepseek]")!)) === JSON.stringify(paint(options[0].querySelector("svg[data-provider-brand=deepseek]")!)), "trigger and portal apply different brand fill/stroke");
    assert(options[1].querySelector("svg[data-provider-brand=qwen]"), "Qwen token plan did not reuse Qwen artwork");
    assert(options[2].getAttribute("aria-disabled") === "true" && options[2].textContent?.endsWith("（需重新保存 API Key）") && options[2].querySelector("svg[data-provider-brand=kimi]"), "disabled option label or icon changed");
    for (const option of options) {
      const text = option.querySelector(".echoink-origin-select-text")!;
      assert(owner.getElementById(option.getAttribute("aria-labelledby")!)?.textContent?.trim() === text.textContent, "icon altered option accessible name");
    }
    key(owner.activeElement as HTMLElement, "q"); await frame();
    assert(owner.activeElement === options[1] && fixture.activations === 0, "typeahead failed or committed on hover/focus");
    key(owner.activeElement as HTMLElement, "Enter"); await frame();
    assert(fixture.activations === 1 && settings.activeApiProviderId === qwen.id && settings.defaultModel === qwen.models[0].id, "production onChange did not activate the original model value once");
    assert(select.value === JSON.stringify([qwen.id, qwen.models[0].id]) && select.querySelector("svg[data-provider-brand=qwen]") && !popup(), "committed icon/value did not reach trigger or close");
    select.focus(); key(select, "Enter"); await frame();
    const qwenTrigger = select.querySelector("svg[data-provider-brand=qwen]")!;
    const qwenOption = popup()!.querySelector("svg[data-provider-brand=qwen]")!;
    assert(JSON.stringify(paint(qwenTrigger)) === JSON.stringify(paint(qwenOption)) && paint(qwenTrigger).every((path) => path[1] === "none"), "Qwen trigger inherited an extra outline");
    key(owner.activeElement as HTMLElement, "Escape"); await frame();
    // Leave the normal model control mounted for actual pointer/visual review.
    const emptyHost = owner.createElement("div"); host.append(emptyHost);
    for (const providers of [[], [disabled]]) {
      const emptySettings = { ...settings, apiProviders: providers };
      const empty = new Fixture().renderCurrentModel(emptyHost, emptySettings, keyboardHost.app);
      await frame();
      assert(empty.value === "" && empty.disabled && !empty.querySelector("svg[data-provider-brand]"), "empty state gained a brand or enabled value");
      assert(empty.textContent === (providers.length ? "无可用模型" : "尚无已保存模型"), "empty label changed");
      disposeOriginControls(emptyHost); emptyHost.replaceChildren();
    }
    emptyHost.remove();
  } finally {
    if (popup()) key(owner.activeElement as HTMLElement, "Escape");
    keyboardHost.dispose();
  }
}

async function assertSelectPointerCancellation(owner: Document, parent: HTMLElement, stopBubbling: boolean) {
  const host = owner.createElement("div"); parent.append(host);
  const outside = owner.createElement("button"); outside.textContent = "Outside target"; host.append(outside);
  if (stopBubbling) outside.addEventListener("pointerdown", (event) => event.stopPropagation());
  const keyboardHost = createOriginSelectHostFixture(owner.defaultView!);
  const select = createOriginSelect(host, { attr: { "aria-label": "Pointer selection" } }, [
    { value: "a", label: "Alpha" }, { value: "b", label: "Beta" }, { value: "c", label: "Disabled", disabled: true }
  ], "a", keyboardHost.app).element;
  let changes = 0;
  select.onchange = () => { changes++; };
  const pointer = (target: Element, type: string) => {
    const bounds = target.getBoundingClientRect();
    target.dispatchEvent(new owner.defaultView!.PointerEvent(type, {
      bubbles: true, composed: true, cancelable: true, pointerType: "mouse", pointerId: 1, button: 0,
      clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2
    }));
  };
  const open = async () => { select.focus(); key(select, "Enter"); await frame(); };
  const popup = () => owner.querySelector<HTMLElement>('[data-slot=select-content]');
  try {
    await open();
    const beta = Array.from(popup()!.querySelectorAll<HTMLElement>('[role=option]'))[1];
    pointer(beta, "pointermove"); await frame();
    assert(beta.hasAttribute("data-highlighted"), "hover did not highlight the item");
    assert(select.value === "a" && changes === 0, "hover committed a value");
    pointer(popup()!, "pointerdown"); await frame();
    assert(popup(), "inside pointer dismissed the popup");
    pointer(outside, "pointerdown"); await frame();
    assert(!popup(), "one outside pointerdown did not close the popup");
    assert(select.value === "a" && changes === 0 && keyboardHost.depth === 0, "outside cancellation committed or leaked Scope");
    await open();
    const disabled = popup()!.querySelector<HTMLElement>('[data-disabled]')!;
    pointer(disabled, "pointerdown"); pointer(disabled, "pointerup"); await frame();
    assert(select.value === "a" && changes === 0 && popup(), "disabled option committed");
    const next = Array.from(popup()!.querySelectorAll<HTMLElement>('[role=option]'))[1];
    pointer(next, "pointerdown"); pointer(next, "pointerup"); await frame();
    assert(select.value === "b" && changes === 1 && !popup(), "item click failed to commit once and close");
    await open(); key(owner.activeElement as HTMLElement, "Escape"); await frame();
    assert(!popup() && changes === 1, "Escape cancellation changed the selection");
    select.disabled = true; key(select, "Enter"); await frame();
    assert(!popup(), "disabled select opened"); select.disabled = false;
    await open(); disposeOriginControls(host); pointer(outside, "pointerdown"); await frame();
    assert(!popup() && keyboardHost.depth === 0 && changes === 1, "disposal left popup or handlers active");
  } finally {
    disposeOriginControls(host); keyboardHost.dispose(); host.remove();
  }
}
