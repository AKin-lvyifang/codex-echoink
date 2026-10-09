import type { App } from "obsidian";
import { createOriginButton, createOriginCheck, createOriginInput, createOriginRadioGroup, createOriginSelect, createOriginSlider, createOriginSwitch, disposeOriginControls, type OriginCheckElement, type OriginSelectElement } from "../settings/origin-controls";
import { createOriginSelectHostFixture } from "./origin-obsidian-dom-shim";
import type { ApiProviderConfig, CodexForObsidianSettings } from "../settings/settings";
import { getApiProviderPreset, type ApiProviderId } from "../settings/provider-presets";
import { renderProviderBrandIcon } from "../settings/provider-brand-icons";
import { KnowledgeNotePickerModal } from "../settings/knowledge-note-picker-modal";
import { installProviderBrowserHost } from "./provider-discovery-dom-host";

type AsyncFixture = {
  activations: number;
  renderCurrentModel(parent: HTMLElement, settings: CodexForObsidianSettings, app: Pick<App, "keymap" | "scope">): OriginSelectElement;
  runMcpToggleAction(toggle: OriginCheckElement, action: (checked: boolean) => Promise<void>): Promise<void>;
};
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const settleControl = async (element: HTMLElement) => {
  await frame();
  await Promise.all(element.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
};
const key = (element: HTMLElement, value: string, modifiers: KeyboardEventInit = {}) => element.dispatchEvent(new (element.ownerDocument.defaultView!.KeyboardEvent)("keydown", { key: value, bubbles: true, cancelable: true, ...modifiers }));
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };

export async function runOriginControlsDom(Fixture: new () => AsyncFixture) {
  installProviderBrowserHost();
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
  await run("settings style boundary: external CSS before/after, four palettes, normal/enlarged narrow layout, unlabelled switches", async () => {
    for (const order of ["before", "after"] as const) {
      for (const theme of ["green", "violet"] as const) {
        for (const dark of [false, true]) {
          for (const size of [16, 24]) await assertSettingsStyleBoundary({ order, theme, dark, size });
        }
      }
    }
  });
  await run("settings note picker production search, selection, failure, Escape, focus and disposal", assertSettingsNotePicker);
  // Leave a compact production-control preview for visual review after tests.
  disposeOriginControls(main); main.replaceChildren();
  const params = new URLSearchParams(location.search);
  document.body.dataset.echoinkTheme = params.get("theme") ?? "green";
  document.body.classList.toggle("theme-dark", params.get("dark") === "1");
  main.style.setProperty("--font-interface", params.get("font") === "24" ? "Georgia, serif" : "system-ui, sans-serif");
  main.style.setProperty("--font-text-size", params.get("font") === "24" ? "24px" : "16px");
  const shell = main.closest<HTMLElement>(".modal.mod-settings")!;
  shell.style.height = "auto"; shell.style.width = params.get("narrow") === "1" ? "390px" : "736px";
  const preview = createSettingsStylePreview(document, main);
  createUnlabelledSwitchRows(document, main);
  const pickerTrigger = createOriginButton(preview.actions, { text: "Open note picker" });
  pickerTrigger.onclick = () => createSettingsPicker(document, pickerTrigger, () => {}).open();
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
    assert(bounds.width === 16 && bounds.height === 16, `brand icon is missing its fixed size: ${bounds.width}×${bounds.height}; CSS ${owner.defaultView!.getComputedStyle(selectedIcon).width}×${owner.defaultView!.getComputedStyle(selectedIcon).height}`);
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

const externalControlCss = `
  :root {--background-modifier-hover:#ff00ff;--interactive-accent:#ff0000;--background-modifier-border:#ff0000}
  body input, body button, body select {height:18px;padding:2px 24px;border:3px solid red;border-radius:99px;font:8px/1 serif;box-shadow:0 0 0 4px magenta}
  body :is(input,button,select,textarea):focus {outline:4px solid magenta;box-shadow:0 0 0 6px red;border-color:magenta;background:yellow}
  body [role=option] {display:block;min-height:50px;padding:20px;border:3px solid red;background:yellow;font:8px serif}
  body [role=option]:focus {outline:4px solid red;box-shadow:0 0 0 6px magenta}
`;
const styleOf = (element: HTMLElement) => element.ownerDocument.defaultView!.getComputedStyle(element);
const noRing = (element: HTMLElement) => {
  const style = styleOf(element);
  assert(style.outlineStyle === "none" && style.boxShadow === "none", `${element.getAttribute("aria-label") ?? element.className}: outline ${style.outline}, shadow ${style.boxShadow}`);
};
const structure = (element: HTMLElement) => {
  const s = styleOf(element);
  return [s.height, s.minHeight, s.padding, s.borderWidth, s.borderRadius, s.fontSize, s.fontFamily, s.lineHeight, s.display].join("|");
};

function createSettingsStylePreview(owner: Document, root: HTMLElement) {
  const page = owner.createElement("div"); page.className = "echoink-settings-page echoink-settings-inline-editor"; root.append(page);
  const nav = owner.createElement("div"); nav.className = "codex-settings-tabs"; page.append(nav);
  const tab = owner.createElement("button"); tab.className = "codex-settings-tab is-active"; tab.textContent = "Provider"; tab.setAttribute("aria-selected", "true"); nav.append(tab);
  const resourceManager = owner.createElement("div"); resourceManager.className = "codex-resource-manager"; page.append(resourceManager);
  const resourceTabs = owner.createElement("div"); resourceTabs.className = "codex-resource-tabs"; resourceManager.append(resourceTabs);
  const resourceTab = owner.createElement("button"); resourceTab.className = "codex-resource-tab is-active"; resourceTab.textContent = "MCP"; resourceTab.setAttribute("aria-selected", "true"); resourceTabs.append(resourceTab);
  const card = owner.createElement("section"); card.className = "echoink-settings-section settings-card provider-connection-card"; page.append(card);
  const grid = owner.createElement("div"); grid.className = "provider-connection-grid"; card.append(grid);
  const field = (label: string, type = "text") => {
    const parent = owner.createElement("div"); parent.className = "codex-provider-modal-field provider-field"; grid.append(parent);
    const copy = owner.createElement("label"); copy.textContent = label; parent.append(copy);
    return createOriginInput(parent, { value: type === "password" ? "fixture-only" : "Team Provider", attr: { type, "aria-label": label } });
  };
  const name = field("Provider name"), apiKey = field("API Key", "password");
  const mcp = field("MCP server URL"); mcp.parentElement!.classList.add("codex-mcp-server-form");
  const selectHost = owner.createElement("div"); selectHost.className = "codex-provider-modal-field"; grid.append(selectHost);
  const select = createOriginSelect(selectHost, { attr: { "aria-label": "Provider type" } }, [{value:"a",label:"Provider A"},{value:"b",label:"Provider B"}], "a").element;
  const controls = owner.createElement("div"); controls.className = "setting-item"; card.append(controls);
  const toggleLabel = owner.createElement("label"); toggleLabel.textContent = "Enabled "; controls.append(toggleLabel);
  const toggle = createOriginSwitch(toggleLabel, { attr: { "aria-label": "Enabled" } }); toggle.checked = true;
  const checkLabel = owner.createElement("label"); checkLabel.textContent = " Models "; controls.append(checkLabel);
  const check = createOriginCheck(checkLabel, { attr: { "aria-label": "Models" } }); check.indeterminate = true;
  const radioGroup = createOriginRadioGroup(card, "a", "Default model", () => {});
  const radioLabel = owner.createElement("label"); radioLabel.textContent = "Default model "; radioGroup.element.append(radioLabel);
  const radio = radioGroup.addItem(radioLabel, "a", false);
  const range = owner.createElement("div"); range.className = "general-range setting-item-control"; card.append(range);
  const slider = createOriginSlider(range, {value:3,min:1,max:6,step:1,label:"Range",onValueChange(){},onValueCommit(){}});
  const actions = owner.createElement("div"); actions.className = "echoink-settings-inline-actions"; card.append(actions);
  const save = createOriginButton(actions, { text: "Save", cls: "echoink-amicro-button mod-cta" });
  const help = owner.createElement("button"); help.className = "settings-help"; help.textContent = "?"; help.setAttribute("aria-label", "Provider help"); actions.append(help);
  const navigation = owner.createElement("button"); navigation.className = "echoink-settings-navigation-row"; navigation.textContent = "Provider details →"; page.append(navigation);
  return { name, apiKey, mcp, select, toggle, check, radio, slider, save, tab, resourceTab, help, navigation, actions };
}

async function assertSettingsStyleBoundary(options: {order:"before"|"after";theme:"green"|"violet";dark:boolean;size:number}) {
  const iframe = document.createElement("iframe"); iframe.title = "Settings style matrix";
  iframe.style.cssText = `width:${options.size === 24 ? 390 : 736}px;height:900px;border:0;max-width:100%`;
  document.body.append(iframe);
  const context = JSON.stringify(options);
  await new Promise<void>((resolve) => { iframe.onload = () => resolve(); iframe.srcdoc = `<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="styles.css"><style>body{margin:0}.setting-item{display:flex}main{padding:18px!important}</style><main class="echoink-settings-demo"></main>`; });
  const owner = iframe.contentDocument!;
  const root = owner.querySelector<HTMLElement>("main")!;
  owner.body.classList.toggle("theme-dark", options.dark); owner.body.dataset.echoinkTheme = options.theme;
  root.style.setProperty("--font-text-size", `${options.size}px`); root.style.setProperty("--font-interface", "Georgia, serif");
  try {
    const preview = createSettingsStylePreview(owner, root);
    const unlabelled = createUnlabelledSwitchRows(owner, root);
    const covered = [preview.name, preview.apiKey, preview.mcp, preview.select, preview.toggle, preview.check, preview.radio, preview.save, preview.tab, preview.resourceTab, preview.navigation, ...unlabelled.map(item=>item.toggle)];
    await frame();
    const original = covered.map(structure);
    for (const selected of [preview.tab,preview.resourceTab]) assert(styleOf(selected).backgroundColor === (options.dark ? "rgb(52, 52, 55)" : "rgb(237, 237, 238)"), `selected navigation lacks neutral background: ${context}`);
    const foreignStyle = owner.createElement("style"); foreignStyle.textContent = externalControlCss;
    if (options.order === "before") owner.head.prepend(foreignStyle); else owner.head.append(foreignStyle);
    await frame();
    assert(covered.every((element,index) => structure(element) === original[index]), `host CSS changed structure: ${context}; ${covered.map((el,i) => structure(el) === original[i] ? "" : `${el.className}: ${original[i]} -> ${structure(el)}`).join("\n")}`);
    const control = owner.createElement("input"); control.setAttribute("aria-label", "Host control"); owner.body.append(control);
    control.focus(); await frame();
    assert(styleOf(control).outlineWidth === "4px" && styleOf(control).borderTopWidth === "3px", `outside control lost host CSS: ${context}`);
    for (const input of [preview.name,preview.apiKey,preview.mcp]) {
      const border = styleOf(input).borderColor; const background = styleOf(input).backgroundColor;
      input.focus(); await frame(); noRing(input);
      assert(owner.activeElement === input && styleOf(input).borderColor === border && styleOf(input).backgroundColor !== background, `input focus missing or border changed: ${context}`);
      assert(styleOf(input).fontSize === `${options.size * .6875}px` && styleOf(input).fontFamily.includes("Georgia"), `input did not follow user font/size: ${context}`);
      assert(input.getBoundingClientRect().height >= parseFloat(styleOf(input).lineHeight) + 14, `input text clipped: ${context}`);
      input.value = "changed fixture"; input.setSelectionRange(2,5);
      assert(input.selectionStart === 2 && input.selectionEnd === 5 && styleOf(input).caretColor !== "rgba(0, 0, 0, 0)", "input selection/caret lost");
    }
    preview.name.setAttribute("aria-invalid","true"); preview.name.focus(); await frame();
    assert(styleOf(preview.name).borderColor !== styleOf(preview.apiKey).borderColor, `invalid input lost error border: ${context}`); noRing(preview.name);
    for (const target of [preview.save,preview.tab,preview.resourceTab,preview.navigation,preview.help,preview.toggle,preview.check,preview.radio,preview.slider.querySelector<HTMLElement>('[role=slider]')!]) {
      target.focus(); await settleControl(target); noRing(target);
      const foreground = styleOf(target).backgroundColor;
      const surface = target.closest<HTMLElement>("label,.setting-item,[data-slot=slider]");
      assert(foreground === (options.dark ? "rgb(58, 58, 62)" : "rgb(231, 231, 233)") || (surface && styleOf(surface).backgroundColor === (options.dark ? "rgb(58, 58, 62)" : "rgb(231, 231, 233)")), `focus background invisible: ${target.className}; focus-visible=${target.matches(":focus-visible")}; bg=${foreground}; ${context}`);
    }
    assert(preview.toggle.checked && preview.check.indeterminate && Boolean(preview.check.querySelector("svg")) && preview.radio.getAttribute("aria-checked") === "true", `checked/mixed semantics lost: ${context}`);
    for (const {row,toggle} of unlabelled) {
      assert(!toggle.closest("label,.setting-item"), "unlabelled production structure was accidentally wrapped in a standard focus host");
      for (const checked of [false,true]) {
        toggle.checked=checked;await settleControl(toggle);const track=styleOf(toggle).backgroundColor;
        toggle.focus();await settleControl(row);noRing(toggle);
        assert(toggle.matches(":focus-visible") && styleOf(row).backgroundColor === (options.dark ? "rgb(58, 58, 62)" : "rgb(231, 231, 233)"), `unlabelled switch has no focus surface: ${row.className}; ${context}`);
        assert(toggle.checked===checked && styleOf(toggle).backgroundColor===track,`unlabelled switch focus changed its checked track color: ${row.className}; ${track} -> ${styleOf(toggle).backgroundColor}; ${context}`);
        preview.name.focus();await settleControl(row);
      }
    }
    preview.select.focus(); key(preview.select,"Enter"); await frame();
    const popup = owner.querySelector<HTMLElement>('[data-slot=select-content]')!;
    assert(popup?.classList.contains("echoink-settings-overlay") && !root.contains(popup) && popup.ownerDocument === owner, `portal settings marker/owner wrong: ${context}`);
    assert(styleOf(popup).fontSize === styleOf(preview.select).fontSize && styleOf(popup).fontFamily === styleOf(preview.select).fontFamily && styleOf(popup).colorScheme === styleOf(root).colorScheme, `portal font/scheme drift: ${context}`);
    const checked = popup.querySelector<HTMLElement>('[data-state=checked]')!;
    assert(Boolean(checked.querySelector("svg")), `selected item indicator missing: ${context}`);
    const bounds = popup.getBoundingClientRect();
    assert(bounds.left >= 0 && bounds.right <= owner.documentElement.clientWidth + 1, `popup spills narrow window: ${context}`);
    noRing(checked); assert(styleOf(checked).fontSize === `${options.size * .6875}px` && styleOf(checked).paddingLeft === "28px", `option changed by host CSS: ${context}`);
    key(owner.activeElement as HTMLElement,"ArrowDown"); await frame(); key(owner.activeElement as HTMLElement,"Enter"); await frame();
    assert(preview.select.value === "b" && owner.activeElement === preview.select, `portal keyboard selection/focus failed: ${context}`);
    preview.select.focus(); key(preview.select,"Enter"); await frame(); key(owner.activeElement as HTMLElement,"Escape"); await frame();
    assert(!owner.querySelector('[data-slot=select-content]') && owner.activeElement === preview.select, `portal Escape/focus failed: ${context}`);
    assert(root.scrollWidth <= root.clientWidth + 1 && owner.documentElement.scrollWidth <= owner.documentElement.clientWidth + 1, `settings horizontal overflow: ${context}`);
    disposeOriginControls(root);
    // Shared Origin use outside settings must not acquire the settings marker.
    const outside = createOriginSelect(owner.body, {}, [{value:"a",label:"Outside settings"}], "a").element;
    outside.focus(); key(outside,"Enter"); await frame();
    assert(!owner.querySelector('[data-slot=select-content]')?.classList.contains("echoink-settings-overlay"), "outside Select was marked as settings");
    disposeOriginControls(owner.body);
  } finally { disposeOriginControls(owner.body); iframe.remove(); }
}

function createUnlabelledSwitchRows(owner: Document, root: HTMLElement) {
  const card=owner.createElement("section");card.className="echoink-settings-section settings-card";root.append(card);
  const mcp=owner.createElement("div");mcp.className="codex-mcp-server-toggle-row";card.append(mcp);
  const copy=owner.createElement("div");copy.className="codex-mcp-server-toggle-copy";mcp.append(copy);
  const title=owner.createElement("div");title.className="codex-mcp-server-toggle-title";title.textContent="MCP server enabled";copy.append(title);
  const header=owner.createElement("div");header.className="settings-card-header";card.append(header);
  const skill=owner.createElement("div");skill.className="resources-status-actions";header.append(skill);
  const status=owner.createElement("span");status.className="status healthy";status.textContent="Skill enabled";skill.append(status);
  const resource=owner.createElement("div");resource.className="codex-resource-row is-enabled";card.append(resource);
  const content=owner.createElement("div");content.className="codex-resource-row-content";content.textContent="Resource enabled";resource.append(content);
  return [mcp,skill,resource].map((row,index)=>{
    const toggle=createOriginSwitch(row,{cls:index ? "codex-resource-toggle" : "",attr:{"aria-label":["MCP toggle","Skill toggle","Resource toggle"][index]}});toggle.checked=true;
    return {row,toggle};
  });
}

function createSettingsPicker(owner: Document, trigger: HTMLElement, onConfirm: () => void | Promise<void>) {
  return new KnowledgeNotePickerModal({fixtureDocument:owner} as unknown as App, {
    zh:false,targetRole:"wiki",targetLabel:"Wiki",triggerEl:trigger,
    notes:[{sourcePath:"Raw/First note.md",role:"raw"},{sourcePath:"Reviews/Second note.md",role:"review"}],onConfirm
  });
}

async function assertSettingsNotePicker() {
  const iframe = document.createElement("iframe"); document.body.append(iframe);
  await new Promise<void>((resolve) => { iframe.onload=()=>resolve(); iframe.srcdoc='<link rel="stylesheet" href="styles.css"><style>body{margin:0}.modal-container{position:fixed;inset:0;display:flex;align-items:center;justify-content:center}</style><main class="echoink-settings-demo"></main>'; });
  const owner=iframe.contentDocument!;
  // Same host DOM conveniences, installed into the independent realm.
  const proto=owner.defaultView!.HTMLElement.prototype;
  for(const name of ["createEl","createDiv","createSpan","empty","addClass","removeClass","hasClass","toggleClass","setAttr","setText"]) Object.defineProperty(proto,name,Object.getOwnPropertyDescriptor(HTMLElement.prototype,name)!);
  owner.body.classList.add("theme-dark"); owner.body.dataset.echoinkTheme="violet";
  const root=owner.querySelector<HTMLElement>("main")!; root.style.setProperty("--font-interface","Georgia, serif");root.style.setProperty("--font-text-size","24px");
  iframe.style.cssText="width:390px;height:700px;border:0";
  const trigger=createOriginButton(root,{text:"Add notes"});
  const picker=createSettingsPicker(owner,trigger,async()=>{throw new Error("fixture save failure")});
  try {
    trigger.focus();picker.open();await frame();
    const modal=picker.modalEl, search=modal.querySelector<HTMLInputElement>("input")!;
    assert(modal.ownerDocument===owner && modal.classList.contains("echoink-settings-overlay") && owner.activeElement===search,"picker owner/initial focus wrong");
    noRing(search);noRing(search.parentElement!);
    assert(styleOf(search).fontFamily.includes("Georgia") && styleOf(search).fontSize==="18px" && styleOf(modal).getPropertyValue("--bg").trim()===styleOf(root).getPropertyValue("--bg").trim(),"picker theme/scale boundary drift");
    const first=modal.querySelector<OriginCheckElement>(".echoink-knowledge-note-picker-checkbox")!;first.click();await frame();
    assert(picker.selectedCount===1 && first.getAttribute("aria-checked")==="true","picker checkbox draft selection failed");
    first.focus();await frame();noRing(first);noRing(first.closest<HTMLElement>("label")!);
    search.value="Second";search.dispatchEvent(new owner.defaultView!.Event("input",{bubbles:true}));await frame();
    assert(picker.selectedCount===1 && modal.querySelectorAll(".echoink-knowledge-note-picker-row").length===1,"picker search lost draft");
    const confirm=modal.querySelector<HTMLButtonElement>(".echoink-knowledge-note-picker-confirm")!;confirm.click();await frame();
    assert(!picker.isSubmitting && modal.querySelector('[role=alert]')?.textContent?.includes("weren't saved") && picker.selectedCount===1,"picker failed save lost draft/error/retry");
    const bounds=modal.getBoundingClientRect();const footer=modal.querySelector<HTMLElement>(".echoink-knowledge-note-picker-footer")!.getBoundingClientRect();
    assert(modal.scrollWidth<=modal.clientWidth+1 && bounds.width<=390 && footer.bottom<=bounds.bottom+1,"picker narrow enlarged layout overflow");
    search.focus();key(search,"Tab");await frame();assert(modal.contains(owner.activeElement),"picker Tab escaped modal");
    key(owner.activeElement as HTMLElement,"Escape");await frame();
    assert(!modal.isConnected && owner.activeElement===trigger,"picker Escape did not close/restore focus");
    assert(!modal.querySelector("[data-slot]"),"picker close left Origin roots");
  } finally { if(picker.modalEl.isConnected)picker.close();disposeOriginControls(owner.body);iframe.remove(); }
}
