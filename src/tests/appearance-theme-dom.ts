import { renderAppearancePicker } from "../settings/appearance-picker";
import { EchoInkAppearance, type EchoInkColorTheme } from "../ui/appearance-theme";

const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
async function run() {
  const secondary = (document.querySelector("iframe") as HTMLIFrameElement).contentDocument!;
  const host = {
    settings: { colorTheme: "green" as EchoInkColorTheme },
    saved: "green", fail: false,
    applyAppearanceTheme(ownerDocument?: Document) {
      if (ownerDocument) appearance.applyToDocument(ownerDocument);
      appearance.refresh();
    },
    async saveSettings() {
      if (this.fail) throw new Error("Test save failure");
      this.saved = this.settings.colorTheme;
    }
  };
  const app = { workspace: { containerEl: document.body, iterateAllLeaves(callback: Function) { callback({ view: { containerEl: secondary.body } }); } } };
  const appearance = new EchoInkAppearance(app as any, () => host.settings.colorTheme);
  appearance.refresh();
  renderAppearancePicker(document.querySelector("#picker")!, host, true);
  // A settings window may render before workspace leaves know about its document.
  const detached = document.implementation.createHTMLDocument("detached settings window");
  detached.body.classList.add("theme-light");
  const detachedPicker = detached.body.appendChild(detached.createElement("div"));
  renderAppearancePicker(detachedPicker, host, true);
  assert(detached.body.dataset.echoinkTheme === "green", "Rendering registers an otherwise undiscovered settings document");
  const violet = document.querySelector<HTMLInputElement>('input[value="violet"]')!;
  const green = document.querySelector<HTMLInputElement>('input[value="green"]')!;
  assert(violet.getAttribute("aria-label") === "雾紫石墨" && green.getAttribute("aria-label") === "暖白翠绿", "Color-only choices retain accessible names");
  assert(!document.querySelector(".echoink-theme-name, .echoink-theme-caption"), "Theme names and captions are not visible beside the color circles");
  violet.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert(host.saved === "violet", "Selection must persist");
  assert(violet.checked && !green.checked, "Exactly one choice is selected");
  assert(document.body.dataset.echoinkTheme === "violet" && secondary.body.dataset.echoinkTheme === "violet", "All open windows update");
  assert(detached.body.dataset.echoinkTheme === "violet", "Registered settings documents update even before they belong to a workspace leaf");
  assert(document.body.classList.contains("theme-dark"), "Theme choice must preserve host appearance mode");
  assert(detached.body.classList.contains("theme-light"), "Detached settings keep their own host appearance mode");
  host.fail = true;
  green.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert(host.settings.colorTheme === "violet" && violet.checked && !green.disabled, "Save failure restores selection and enables retry");
  const popup = document.implementation.createHTMLDocument("new window");
  appearance.applyToDocument(popup);
  assert(popup.body.dataset.echoinkTheme === "violet", "New windows inherit current theme");
  appearance.dispose();
  assert(!document.body.hasAttribute("data-echoink-theme") && !popup.body.hasAttribute("data-echoink-theme") && !detached.body.hasAttribute("data-echoink-theme"), "Unload removes theme metadata from every registered document");
  appearance.refresh();
  document.querySelector("#result")!.textContent = "PASS · 色圆无障碍名称、保存、失败恢复、多窗口及独立设置文档同步、明暗保留、卸载清理";
}
void run().catch(error => { document.querySelector("#result")!.textContent = `FAIL · ${String(error)}`; });
