import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { bindCssParentStates, CSS_PARENT_STATES } from "../ui/css-parent-states";

export async function runCssParentStateTests(): Promise<void> {
  const first = new JSDOM('<body><label class="echoink-theme-choice"><input type="checkbox"></label><div class="codex-messages"><div data-message-tail hidden></div></div><div id="rows"><div class="ip-settings-row"></div><div class="ip-settings-row"></div></div><div class="status-bar"></div></body>');
  const second = new JSDOM('<body><label class="echoink-theme-choice"><input type="checkbox" checked></label></body>');
  const a = first.window.document, b = second.window.document;
  const stopA = bindCssParentStates(a), stopB = bindCssParentStates(b);
  const settle = () => new Promise<void>(resolve => first.window.setTimeout(resolve, 20));
  try {
    const label = a.querySelector("label")!, input = a.querySelector("input")!;
    assert.equal(label.classList.contains("has-echoink-checked-input"), false);
    assert.ok(b.querySelector("label")!.classList.contains("has-echoink-checked-input"));
    assert.ok(a.body.classList.contains("has-echoink-host-status-bar"));
    assert.ok(a.querySelector(".ip-settings-row")!.classList.contains("has-echoink-later-iphone-row"));
    input.checked = true; input.dispatchEvent(new first.window.Event("change", { bubbles: true }));
    await settle(); assert.ok(label.classList.contains("has-echoink-checked-input"));
    input.disabled = true;
    a.querySelector<HTMLElement>("[data-message-tail]")!.hidden = false;
    a.querySelector(".status-bar")!.remove();
    a.querySelector("#rows")!.lastElementChild!.remove();
    await settle();
    assert.ok(label.classList.contains("has-echoink-disabled-input"));
    assert.equal(label.classList.contains("has-echoink-enabled-input"), false);
    assert.ok(a.querySelector(".codex-messages")!.classList.contains("has-echoink-message-tail"));
    assert.equal(a.body.classList.contains("has-echoink-host-status-bar"), false);
    assert.equal(a.querySelector(".ip-settings-row")!.classList.contains("has-echoink-later-iphone-row"), false);
    // Re-renderers can replace className without changing the base classes.
    label.className = "echoink-theme-choice";
    await settle(); assert.ok(label.classList.contains("has-echoink-checked-input"));
    const detached = a.createElement("section"); detached.className = "codex-provider-modal-content";
    const combobox = a.createElement("div"); combobox.className = "codex-provider-combobox is-open";
    detached.append(combobox); a.body.append(detached);
    await settle(); assert.ok(detached.classList.contains("has-echoink-open-combobox"));
    detached.remove(); await settle();
    assert.equal(detached.classList.contains("has-echoink-open-combobox"), false);
    a.body.append(detached); await settle();
    assert.ok(detached.classList.contains("has-echoink-open-combobox"));
    stopA(); stopA();
    for (const state of CSS_PARENT_STATES) assert.equal(a.querySelector(`.${state.className}`), null);
    input.checked = false; input.dispatchEvent(new first.window.Event("change", { bubbles: true }));
    await settle(); assert.equal(label.classList.contains("has-echoink-checked-input"), false);
    assert.ok(b.querySelector("label")!.classList.contains("has-echoink-checked-input"), "one document's disposal does not stop another");
  } finally { stopA(); stopB(); first.window.close(); second.window.close(); }
  console.log("CSS parent states: initial/native property/attribute/tree/sibling/rerender/reinsert/two-window/disposal checks passed");
}
