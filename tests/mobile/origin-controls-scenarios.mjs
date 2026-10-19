import assert from "node:assert/strict";
import path from "node:path";
import vm from "node:vm";
import esbuild from "esbuild";
import { JSDOM } from "jsdom";
import { mobileBuildOptions } from "../../scripts/mobile-build.mjs";

export async function originControlScenarios(test) {
  const options = mobileBuildOptions();
  const probe = { name: "home-origin-select-probe", setup(build) {
    build.onResolve({ filter: /^origin-select-probe$/ }, () => ({ path: path.resolve("src/home/origin-select-probe.ts") }));
    build.onLoad({ filter: /[\\/]origin-select-probe\.ts$/ }, () => ({
      // Keep a value reference: a TS-only re-export can hide a missing export.
      contents: 'import { createOriginSelect, createOriginCheck } from "../settings/origin-controls"; export const categorySelect = createOriginSelect; export const nativeCheckbox = createOriginCheck;', loader: "ts"
    }));
  } };
  await test("Home Select virtual probe loads on Windows and POSIX paths", async () => {
    const loaders = [], resolvers = [];
    probe.setup({
      onLoad(options, run) { loaders.push({ ...options, run }); },
      onResolve(options, run) { resolvers.push({ ...options, run }); }
    });
    const resolver = resolvers.find(item => item.filter.test("origin-select-probe"));
    assert.deepEqual(await resolver.run({ path: "origin-select-probe" }), { path: path.resolve("src/home/origin-select-probe.ts") });
    for (const file of ["/repo/src/home/origin-select-probe.ts", "C:\\repo\\src\\home\\origin-select-probe.ts"]) {
      const loader = loaders.find(item => item.filter.test(file));
      assert.ok(loader, `virtual probe loader must match ${file}`);
      const loaded = await loader.run({ path: file });
      assert.equal(loaded.loader, "ts");
      assert.match(loaded.contents, /export const categorySelect = createOriginSelect;/u);
      assert.ok(!loaders.some(item => item.filter.test(`${file}.map`)));
    }
  });
  const built = await esbuild.build({ ...options, entryPoints: ["origin-select-probe"], plugins: [probe, ...options.plugins], metafile: true });
  const main = new JSDOM("<!doctype html><body></body>");
  const owner = new JSDOM("<!doctype html><body><div id=category></div><button>Next</button></body>", { pretendToBeVisual: true });
  const module = { exports: {} };
  try {
    vm.runInNewContext(built.outputFiles[0].text, { module, exports: module.exports, document: main.window.document, window: main.window });
    const createOriginSelect = module.exports.categorySelect;
    const parent = owner.window.document.getElementById("category");
    const choices = [{ value: "", label: "未分类" }, { value: "工作", label: "工作" }, { value: "归档", label: "归档", disabled: true }];
    const control = createOriginSelect(parent, { cls: "echoink-todo-category-select", attr: { "aria-label": "分类（选填）" } }, choices, "工作", {});

    await test("Home Select browser mapping preserves initial category, empty choice and owning document", () => {
      assert.ok(Object.keys(built.metafile.inputs).includes("src/ui/mobile/origin-controls.ts"));
      assert.ok(!Object.keys(built.metafile.inputs).some(input => input.includes("node_modules/react")));
      assert.equal(control.element.tagName, "SELECT");
      assert.equal(control.element.ownerDocument, owner.window.document);
      assert.ok([...control.element.options].every(option => option.ownerDocument === owner.window.document));
      assert.equal(control.element.getAttribute("aria-label"), "分类（选填）");
      assert.ok(control.element.classList.contains("echoink-todo-category-select"));
      assert.equal(control.element.value, "工作");
      assert.equal(control.element.selectedOptions[0].textContent, "工作");
      const empty = createOriginSelect(parent, {}, choices, "");
      assert.equal(empty.element.value, "");
      assert.equal(empty.element.selectedOptions[0].textContent, "未分类");
      assert.equal(empty.element.options[2].disabled, true);
      empty.addOption("新分类", "新分类");
      assert.equal(empty.element.value, "新分类");
    });

    await test("Home Select user change bubbles; new categories support assignment without synthetic change", () => {
      const changes = [], bubbled = [];
      control.element.onchange = () => changes.push(control.element.value);
      parent.addEventListener("change", event => bubbled.push(event.target.value));
      control.element.value = "";
      control.element.dispatchEvent(new owner.window.Event("change", { bubbles: true }));
      assert.deepEqual(changes, [""]);
      assert.deepEqual(bubbled, [""]);
      control.element.value = "工作";
      control.addOption("读书", "读书");
      assert.equal(control.element.value, "工作");
      control.element.value = "读书";
      assert.equal(control.element.selectedOptions[0].textContent, "读书");
      assert.deepEqual(changes, [""], "programmatic selection must not fire onchange");
      control.element.focus();
      assert.equal(owner.window.document.activeElement, control.element);
      assert.equal(main.window.document.activeElement, main.window.document.body);
    });

    await test("Home Select uses native disabled and focus behavior during saving", () => {
      const next = owner.window.document.querySelector("button");
      next.focus();
      control.element.disabled = true;
      assert.equal(control.element.matches(":disabled"), true);
      control.element.focus();
      assert.equal(owner.window.document.activeElement, next);
      control.element.disabled = false;
      control.element.focus();
      assert.equal(owner.window.document.activeElement, control.element);
      assert.equal(control.element.value, "读书");
    });

    await test("mobile Checkbox preserves its owning document, change event and disabled behavior", () => {
      const checkbox = module.exports.nativeCheckbox(parent, { attr: { "aria-label": "原生勾选" } });
      const changes = [];
      checkbox.onchange = () => changes.push(checkbox.checked);
      assert.equal(checkbox.ownerDocument, owner.window.document);
      assert.equal(checkbox.getAttribute("role"), "checkbox");
      assert.equal(checkbox.checked, false);
      checkbox.click();
      assert.equal(checkbox.checked, true); assert.equal(checkbox.getAttribute("aria-checked"), "true");
      assert.deepEqual(changes, [true]);
      checkbox.checked = false; assert.deepEqual(changes, [true], "programmatic rollback does not trigger another save");
      checkbox.disabled = true; checkbox.click(); assert.equal(checkbox.checked, false); assert.deepEqual(changes, [true]);
    });
  } finally {
    main.window.close();
    owner.window.close();
  }
}
