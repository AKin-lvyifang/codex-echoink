import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { App, ItemView, MarkdownView, Modal, PluginSettingTab, View } from "obsidian";
import { ownedDiv, ownedEl, ownedFragment, ownedSpan, ownedSvg } from "../ui/owned-dom";
import { isImeKeyEvent, watchImeComposition } from "../ui/ime-composition";
import { installObsidianDom } from "./obsidian-dom";
import { runNoteMentionTests } from "./note-mentions";

let checks = 0;
const check = async (name: string, run: () => unknown | Promise<unknown>) => { await run(); checks++; console.log(`PASS ${name}`); };
const first = new JSDOM("<!doctype html><body></body>");
const second = new JSDOM("<!doctype html><body></body>");

try {
  await check("shim constructors install factories when JSDOM was created after import", () => {
    Object.assign(globalThis, { window: first.window, document: first.window.document });
    new App();
    assert.equal(typeof first.window.createFragment, "function");
    assert.ok(MarkdownView.prototype instanceof ItemView);
    for (const construct of [() => new Modal({} as App), () => new PluginSettingTab({} as App, {}), () => new View({} as never)]) {
      Object.assign(globalThis, { window: second.window, document: second.window.document });
      construct();
      assert.equal(typeof second.window.createDiv, "function");
    }
  });

  await check("owned factories keep both windows and DOMParser documents detached and correctly owned", () => {
    installObsidianDom(first.window); installObsidianDom(second.window);
    const parsed = new second.window.DOMParser().parseFromString("<html><body></body></html>", "text/html");
    assert.equal(parsed.defaultView, null);
    assert.equal(parsed.win, second.window);
    for (const document of [first.window.document, second.window.document, parsed]) {
      const count = document.childNodes.length;
      const nodes = [ownedEl(document, "button"), ownedDiv(document), ownedSpan(document), ownedSvg(document, "svg"), ownedSvg(document, "path"), ownedFragment(document)];
      for (const node of nodes) {
        assert.equal(node.ownerDocument, document);
        assert.equal(node.parentNode, null);
        assert.equal(node.win, document.win);
      }
      assert.equal(document.childNodes.length, count, "factories must never append to the Document");
      assert.equal((nodes[3] as Element).namespaceURI, "http://www.w3.org/2000/svg");
      assert.equal((nodes[4] as Element).namespaceURI, "http://www.w3.org/2000/svg");
    }
    const foreign = ownedDiv(first.window.document);
    second.window.document.adoptNode(foreign);
    assert.equal(foreign.win, second.window, "Node.win follows adoption into another window");
  });

  await check("IME flags and host key names are recognized without deprecated numeric codes", () => {
    assert.equal(isImeKeyEvent({ key: "Enter", isComposing: true }), true);
    for (const key of ["Process", "Unidentified"]) assert.equal(isImeKeyEvent({ key, isComposing: false }), true);
    assert.equal(isImeKeyEvent({ key: "Enter", isComposing: false }), false);
  });

  const fixture = () => {
    const root = ownedDiv(first.window.document), input = ownedEl(first.window.document, "textarea"), other = ownedEl(first.window.document, "textarea");
    root.append(input, other); first.window.document.body.append(root);
    let result = false;
    root.addEventListener("keydown", event => { result = isImeKeyEvent(event); });
    const key = (key: string, target = input) => {
      const win = target.ownerDocument.defaultView!;
      target.dispatchEvent(new win.KeyboardEvent("keydown", { key, bubbles: true, isComposing: false }));
      return result;
    };
    const composition = (type: string, target = input) => target.dispatchEvent(new target.ownerDocument.defaultView!.CompositionEvent(type, { bubbles: true }));
    return { root, input, other, key, composition };
  };

  await check("active composition suppresses keys even when isComposing is false and stays field-local", () => {
    const f = fixture(), dispose = watchImeComposition(f.root);
    f.composition("compositionstart");
    for (const key of ["Enter", "Escape", "ArrowDown"]) assert.equal(f.key(key), true);
    assert.equal(f.key("Enter", f.other), false);
    dispose(); f.root.remove();
  });

  await check("compositionend suppresses Enter and Escape in the same turn; keyup restores immediately", () => {
    const f = fixture(), dispose = watchImeComposition(f.root);
    f.composition("compositionstart"); f.composition("compositionend");
    assert.equal(f.key("Enter"), true); assert.equal(f.key("Escape"), true);
    f.input.dispatchEvent(new first.window.KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
    assert.equal(f.key("Enter"), false); assert.equal(f.key("Escape"), false);
    dispose(); f.root.remove();
  });

  await check("compositionend allows the next event turn and blur clears active composition", async () => {
    const f = fixture(), dispose = watchImeComposition(f.root);
    f.composition("compositionstart"); f.composition("compositionend");
    assert.equal(f.key("Enter"), true);
    await new Promise(resolve => first.window.setTimeout(resolve, 0));
    assert.equal(f.key("Enter"), false);
    f.composition("compositionstart"); f.input.dispatchEvent(new first.window.FocusEvent("blur"));
    assert.equal(f.key("Enter"), false);
    dispose(); f.root.remove();
  });

  await check("reference-counted dispose releases pending state and permits a clean watcher", () => {
    const f = fixture(), firstDispose = watchImeComposition(f.root), secondDispose = watchImeComposition(f.root);
    f.composition("compositionstart"); firstDispose(); firstDispose();
    assert.equal(f.key("Enter"), true);
    f.composition("compositionend"); secondDispose();
    assert.equal(f.key("Enter"), false);
    const dispose = watchImeComposition(f.root);
    assert.equal(f.key("Enter"), false);
    f.composition("compositionstart"); assert.equal(f.key("Enter"), true);
    dispose(); f.composition("compositionstart"); assert.equal(f.key("Enter"), false);
    f.root.remove();
  });

  await check("watched subtree retains composition while moving to another window", async () => {
    const f = fixture(), dispose = watchImeComposition(f.root);
    f.composition("compositionstart");
    second.window.document.body.append(second.window.document.adoptNode(f.root));
    assert.equal(f.key("Enter"), true);
    f.composition("compositionend");
    assert.equal(f.key("Escape"), true);
    await new Promise(resolve => second.window.setTimeout(resolve, 0));
    assert.equal(f.key("Enter"), false);
    f.composition("compositionstart"); dispose();
    assert.equal(f.key("Enter"), false); f.root.remove();
  });

  await runNoteMentionTests();
  console.log(`${checks} owned DOM / IME checks passed`);
} finally {
  first.window.close(); second.window.close();
}
