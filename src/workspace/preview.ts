import { WORKSPACE_MAX_BYTES, workspaceDependencyPath, workspacePath, type WorkspaceService } from "./service";
import { ownedDiv, ownedEl } from "../ui/owned-dom";

export const WORKSPACE_PREVIEW_SANDBOX = "allow-scripts";
export const WORKSPACE_PREVIEW_CSP = [
  "default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'", "img-src data:",
  "connect-src 'none'", "font-src 'none'", "media-src 'none'", "object-src 'none'", "frame-src 'none'",
  "worker-src 'none'", "base-uri 'none'", "form-action 'none'", "navigate-to 'none'"
].join("; ");

export class WorkspacePreviewError extends Error {
  constructor(message: string) { super(message); this.name = "WorkspacePreviewError"; }
}
export interface WorkspacePreviewDocument {
  path: string;
  contentRevision: string;
  srcdoc: string;
  dependencies: { path: string; contentRevision: string }[];
}
function unsupported(message: string): never { throw new WorkspacePreviewError(message); }
function checkedCss(content: string): string {
  const normalized = content.replace(/\/\*[\s\S]*?\*\//gu, "");
  if (/\\|@import\b|\burl\s*\(|\bimage-set\s*\(|<\//iu.test(normalized))
    unsupported("预览暂不支持 CSS 的 url、@import、转义资源地址或 image-set；请使用内联样式和纯色图形。");
  return content;
}
function checkedScript(content: string): string {
  // Deliberately small classic-script surface. A module loader would need its
  // own dependency graph, URL rules, and errors; it is not enabled implicitly.
  if (/\b(?:import|export)\b/u.test(content)) unsupported("预览暂不支持 JavaScript 模块 import/export；请使用普通脚本或相对路径的 .js 文件。");
  return content.replace(/<\/script/giu, "<\\/script");
}
const navigationGuard = `document.addEventListener('click',function(event){var target=event.target;var link=target&&target.closest?target.closest('a,area'):null;if(link){var href=link.getAttribute('href')||'';if(!href.startsWith('#'))event.preventDefault();}},true);document.addEventListener('submit',function(event){event.preventDefault();},true);`;

/** Reads relative text dependencies in the plugin, never inside the iframe. */
export async function buildWorkspacePreview(document: Document, service: WorkspaceService, value: string, signal?: AbortSignal): Promise<WorkspacePreviewDocument> {
  const path = workspacePath(value);
  if (!/\.html$/iu.test(path)) unsupported("请选择工作区内的 HTML 文件进行预览。");
  const source = await service.read({ path }, undefined, signal);
  const Parser = document.defaultView?.DOMParser;
  if (!Parser) unsupported("当前窗口无法创建 HTML 预览。");
  const preview = new Parser().parseFromString(source.content, "text/html");
  const dependencies: WorkspacePreviewDocument["dependencies"] = [];
  let totalBytes = new TextEncoder().encode(source.content).length;
  const dependency = async (reference: string, extension: "css" | "js") => {
    const target = workspaceDependencyPath(path, reference);
    if (!target.toLocaleLowerCase().endsWith(`.${extension}`)) unsupported(`相对资源必须是 .${extension} 文件。`);
    if (dependencies.length >= 64) unsupported("此页面引用的工作区文件过多，请合并样式或脚本后预览。");
    const result = await service.read({ path: target }, undefined, signal);
    totalBytes += new TextEncoder().encode(result.content).length;
    if (totalBytes > WORKSPACE_MAX_BYTES * 2) unsupported("预览页面及其依赖合计不能超过 2 MiB。");
    dependencies.push({ path: target, contentRevision: result.contentRevision });
    return result.content;
  };
  // A preview is a document, not a container for other browsing contexts or
  // host plugins. Remove navigation policy supplied by the generated page.
  if (preview.querySelector("iframe,frame,frameset,object,embed,portal")) unsupported("预览暂不支持嵌套页面或插件，请把交互放在当前 HTML 中。");
  preview.querySelectorAll("base,meta[http-equiv]").forEach(element => element.remove());
  for (const link of Array.from(preview.querySelectorAll("link"))) {
    if (link.rel.toLocaleLowerCase() !== "stylesheet" || !link.getAttribute("href")) unsupported("预览只支持相对路径的 CSS 样式引用。");
    const style = ownedEl(document, "style");
    style.textContent = checkedCss(await dependency(link.getAttribute("href")!, "css"));
    if (link.media) style.media = link.media;
    link.replaceWith(style);
  }
  for (const script of Array.from(preview.querySelectorAll("script"))) {
    const type = script.getAttribute("type")?.trim().toLocaleLowerCase();
    if (type && !["text/javascript", "application/javascript"].includes(type)) unsupported("预览只支持普通 JavaScript 脚本，不支持模块或导入映射。");
    const reference = script.getAttribute("src");
    const content = reference === null ? script.textContent ?? "" : await dependency(reference, "js");
    for (const attribute of Array.from(script.attributes)) script.removeAttribute(attribute.name);
    script.textContent = checkedScript(content);
  }
  for (const style of Array.from(preview.querySelectorAll("style"))) checkedCss(style.textContent ?? "");
  for (const element of Array.from(preview.querySelectorAll("*"))) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLocaleLowerCase(), text = attribute.value;
      if (name === "style") checkedCss(text);
      if (name.startsWith("on")) checkedScript(text);
      if (["action", "formaction", "target", "ping", "download", "srcdoc"].includes(name)) element.removeAttribute(attribute.name);
      if (name === "srcset") unsupported("预览暂不支持 srcset，请使用内联 data 图片。");
      if (name === "src" && element.tagName !== "SCRIPT" && !(element.tagName === "IMG" && /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml);/iu.test(text)))
        unsupported("预览不加载网络或本机资源；图片请使用内联 data 图片。");
      if (["href", "xlink:href"].includes(name) && !text.startsWith("#") && !/^data:image\//iu.test(text)) element.removeAttribute(attribute.name);
    }
  }
  const policy = ownedEl(document, "meta");
  policy.httpEquiv = "Content-Security-Policy"; policy.content = WORKSPACE_PREVIEW_CSP;
  const guard = ownedEl(document, "script"); guard.textContent = navigationGuard;
  const charset = ownedEl(document, "meta"); charset.setAttribute("charset", "utf-8");
  preview.head.prepend(charset, policy, guard);
  // Never copy host CSS, Node objects, postMessage handlers, or write callbacks
  // into the opaque-origin document.
  return { path, contentRevision: source.contentRevision, dependencies, srcdoc: `<!doctype html>\n${preview.documentElement.outerHTML}` };
}

export interface WorkspacePreviewController { refresh(): Promise<void>; destroy(): void }
export interface WorkspacePreviewRenderOptions {
  /** Desktop can supply Origin; mobile can retain its native DOM button. */
  createButton?(toolbar: HTMLElement, label: string): HTMLButtonElement;
  disposeButtons?(toolbar: HTMLElement): void;
}
/** Toolbar contains only refresh and the optional desktop external-open action. */
export function renderWorkspacePreview(document: Document, container: HTMLElement, service: WorkspaceService, value: string,
  openExternal?: (path: string) => void | Promise<void>, options: WorkspacePreviewRenderOptions = {}): WorkspacePreviewController {
  const path = workspacePath(value);
  const root = ownedDiv(document); root.className = "echoink-workspace-preview echoink-theme-boundary";
  const toolbar = ownedDiv(document); toolbar.className = "echoink-workspace-preview__toolbar";
  const error = ownedDiv(document); error.className = "echoink-workspace-preview__error"; error.setAttribute("role", "alert"); error.hidden = true;
  const frame = ownedEl(document, "iframe"); frame.className = "echoink-workspace-preview__frame";
  frame.title = path.split("/").pop() ?? "HTML 预览";
  frame.setAttribute("sandbox", WORKSPACE_PREVIEW_SANDBOX);
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.setAttribute("allow", "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; payment 'none'; usb 'none'; serial 'none'");
  const button = (label: string) => {
    const control = options.createButton?.(toolbar, label) ?? ownedEl(document, "button");
    control.type = "button"; control.textContent = label; control.classList.add("echoink-workspace-preview__button");
    if (control.parentElement !== toolbar) toolbar.append(control);
    return control;
  };
  const refreshButton = button("刷新");
  const externalButton = openExternal ? button("在浏览器打开") : undefined;
  root.append(toolbar, error, frame); container.append(root);
  let destroyed = false, generation = 0, active: AbortController | undefined;
  const fail = (reason: unknown) => { error.textContent = reason instanceof Error ? reason.message : String(reason); error.hidden = false; };
  const refresh = async () => {
    if (destroyed) return;
    active?.abort(); const current = ++generation; active = new AbortController();
    refreshButton.disabled = true; refreshButton.setAttribute("aria-busy", "true");
    error.hidden = true;
    // A failed refresh must not leave stale executable content on screen.
    frame.removeAttribute("srcdoc");
    try {
      const preview = await buildWorkspacePreview(document, service, path, active.signal);
      if (!destroyed && current === generation) frame.srcdoc = preview.srcdoc;
    } catch (reason) { if (!destroyed && current === generation) fail(reason); }
    finally { if (!destroyed && current === generation) { refreshButton.disabled = false; refreshButton.removeAttribute("aria-busy"); } }
  };
  refreshButton.onclick = () => { void refresh(); };
  if (externalButton && openExternal) externalButton.onclick = () => {
    if (destroyed || externalButton.disabled) return;
    externalButton.disabled = true;
    void service.read({ path }).then(() => { if (!destroyed) return openExternal(path); }).catch(reason => { if (!destroyed) fail(reason); })
      .finally(() => { if (!destroyed) externalButton.disabled = false; });
  };
  void refresh();
  return { refresh, destroy() { destroyed = true; generation++; active?.abort(); refreshButton.onclick = null; if (externalButton) externalButton.onclick = null; options.disposeButtons?.(toolbar); frame.removeAttribute("srcdoc"); root.remove(); } };
}
