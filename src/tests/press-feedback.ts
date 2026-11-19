import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { bindPressFeedback } from "../ui/press-feedback";

export async function runPressFeedbackTests(): Promise<void> {
  const first = new JSDOM("<body><main></main></body>", { pretendToBeVisual: true });
  const second = new JSDOM("<body><main><button>Action</button><button disabled>Disabled</button><button class='echoink-amicro-button'>Existing</button></main></body>", { pretendToBeVisual: true });
  const root = second.window.document.querySelector("main")!, button = root.querySelector("button")!;
  const pointer = (win: typeof second.window, target: EventTarget, type: string, id = 1, relatedTarget: EventTarget | null = null) => {
    const event = new win.MouseEvent(type, { bubbles: true, button: 0, relatedTarget });
    Object.defineProperty(event, "pointerId", { value: id }); target.dispatchEvent(event);
  };
  const cleanup = bindPressFeedback(root);
  let activations = 0; button.onclick = () => { activations++; };
  try {
    pointer(second.window, button, "pointerdown");
    assert.equal(button.dataset.echoinkPressed, "true", "press feedback is synchronous");
    assert.equal(activations, 0, "press feedback never submits an action");
    pointer(first.window, first.window.document, "pointerup");
    assert.equal(button.dataset.echoinkPressed, "true", "another document cannot release this window's press");
    pointer(second.window, second.window.document, "pointerup", 2);
    assert.equal(button.dataset.echoinkPressed, "true", "an unrelated pointer cannot release it");
    pointer(second.window, button, "pointerout", 1, second.window.document.body);
    assert.equal(button.hasAttribute("data-echoink-pressed"), false);
    pointer(second.window, button, "pointerover");
    assert.equal(button.dataset.echoinkPressed, "true", "moving back restores the same press");
    pointer(second.window, second.window.document, "pointerup");button.click();
    assert.equal(button.hasAttribute("data-echoink-pressed"), false); assert.equal(activations, 1);
    for (const type of ["pointercancel", "lostpointercapture"]) {
      pointer(second.window, button, "pointerdown");pointer(second.window, second.window.document, type);
      assert.equal(button.hasAttribute("data-echoink-pressed"), false);
    }
    button.dispatchEvent(new second.window.KeyboardEvent("keydown", { key: " ", bubbles: true }));
    assert.equal(button.dataset.echoinkPressed, "true");
    second.window.document.dispatchEvent(new second.window.KeyboardEvent("keyup", { key: " ", bubbles: true }));
    assert.equal(button.hasAttribute("data-echoink-pressed"), false);
    pointer(second.window, root.querySelector("button[disabled]")!, "pointerdown");
    pointer(second.window, root.querySelector(".echoink-amicro-button")!, "pointerdown");
    assert.equal(root.querySelectorAll("[data-echoink-pressed]").length, 0);
    first.window.document.querySelector("main")!.append(root);
    pointer(first.window, button, "pointerdown");pointer(first.window, first.window.document, "pointerup");
    assert.equal(button.hasAttribute("data-echoink-pressed"), false, "an adopted view binds release to its current document");
    const outerCleanup = bindPressFeedback(root.parentElement!);
    pointer(first.window, button, "pointerdown");pointer(first.window, first.window.document, "pointerup");outerCleanup();
    assert.equal(button.hasAttribute("data-echoink-pressed"), false, "overlapping scopes cannot leave a pressed marker behind");
    pointer(first.window, button, "pointerdown");cleanup();
    assert.equal(button.hasAttribute("data-echoink-pressed"), false);
    pointer(first.window, button, "pointerdown");assert.equal(button.hasAttribute("data-echoink-pressed"), false);
  } finally { cleanup(); first.window.close();second.window.close(); }
  console.log("PASS press feedback: one activation, document/pointer identity, drag cancellation, keyboard, existing feedback and lifecycle");
}
