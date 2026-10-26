import { galleryOptions } from "./model";
/** Native widgets may hydrate after Markdown postprocessing. Only semantic
 * attributes are added: no image is moved/replaced and src/width/height stay intact. */
const gallerySelector = '.callout[data-callout="gallery"]';
const pluginBoundary = '[class^="echoink-"],[class*=" echoink-"],.codex-container';
const chromeSelector = '.embed-actions,.edit-block-button,.image-resize-corner,.image-resize-handle';
const owned = ['data-ei-gallery-wrapper', 'data-ei-gallery-item', 'data-ei-gallery-chrome', 'data-ei-gallery-buffer', 'data-ei-gallery-grid'];
function set(node: Element, name: string, value: string): void {
  if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}
function groupsIn(root: HTMLElement): HTMLElement[] {
  const groups = Array.from(root.querySelectorAll<HTMLElement>(gallerySelector));
  const owner = root.closest<HTMLElement>(gallerySelector);
  if (owner && !groups.includes(owner)) groups.unshift(owner);
  return groups.filter(group => !group.closest(pluginBoundary));
}
function clearItems(group: HTMLElement): void {
  for (const node of Array.from(group.querySelectorAll(owned.map(name => `[${name}]`).join(',')))) for (const name of owned) node.removeAttribute(name);
}
export function clearGalleryMarkup(root: HTMLElement): void {
  for (const group of groupsIn(root)) {
    clearItems(group); group.style.removeProperty("--ei-gallery-height");
    for (const name of ['data-ei-gallery-count', 'data-ei-gallery-invalid', 'data-ei-gallery-view', 'data-ei-gallery-checked', 'data-ei-gallery-state', 'data-ei-gallery-layout', 'data-ei-gallery-label', 'data-ei-gallery-error', 'data-ei-gallery-hidden']) group.removeAttribute(name);
  }
}
export function validateGalleryMarkup(root: HTMLElement, editing?: boolean): void {
  for (const group of groupsIn(root)) {
    const content = group.querySelector<HTMLElement>('.callout-content');
    if (content && content.closest(gallerySelector) !== group) continue;
    const photos: HTMLImageElement[] = [], wrappers = new Set<Element>(), chrome = new Set<Element>(), buffers = new Set<Element>();
    let invalid = false, pending = false, source = false;
    const visit = (node: Node) => {
      if (node.nodeType === 3) { if (node.textContent?.trim()) invalid = true; return; }
      if (node.nodeType !== 1) return;
      const element = node as HTMLElement;
      // CM cursor anchors are images too, but are never photos or gallery cells.
      if (element.matches('.cm-widgetBuffer')) { buffers.add(element); return; }
      if (element.matches(chromeSelector)) { chrome.add(element); return; }
      if (element.matches('.cm-content,.cm-line')) { source = true; return; }
      if (element.matches('.markdown-embed,.pdf-embed,.audio-embed,.video-embed,iframe,object,video,audio,ul,ol,table')) { invalid = true; return; }
      if (element.tagName === 'IMG') { photos.push(element as HTMLImageElement); return; }
      if (element.tagName === 'BR') { chrome.add(element); return; }
      if (!element.matches('p,div,span,a,picture,figure,source')) { invalid = true; return; }
      if (element.tagName === 'SOURCE') { chrome.add(element); return; }
      if (element.matches('.internal-embed,.image-embed') && !element.querySelector('img:not(.cm-widgetBuffer)')) pending = true;
      wrappers.add(element);
      for (const child of Array.from(element.childNodes)) visit(child);
    };
    for (const child of Array.from(content?.childNodes ?? [])) visit(child);
    set(group, 'data-ei-gallery-checked', '3');
    set(group, 'data-ei-gallery-view', (editing ?? !!group.closest('.markdown-source-view,.cm-callout,.cm-embed-block')) ? 'editing' : 'reading');
    const valid = !invalid && !pending && !source && photos.length > 0 && photos.length <= 3;
    if (!valid || !content) {
      clearItems(group); group.style.removeProperty('--ei-gallery-height');
      for (const name of ['data-ei-gallery-count', 'data-ei-gallery-layout', 'data-ei-gallery-label', 'data-ei-gallery-error', 'data-ei-gallery-hidden']) group.removeAttribute(name);
      set(group, 'data-ei-gallery-invalid', '');
      // Never conceal the source editor or an embed still hydrating.
      if (!source && !pending) {
        set(group, 'data-ei-gallery-error', invalid ? '组里夹了文字，图片组里只能放图片' : photos.length > 3 ? `图片组最多放 3 张，现在有 ${photos.length} 张` : '组里还没有图片');
        set(group, 'data-ei-gallery-hidden', `这里有 ${photos.length} 张图暂不显示`);
      }
      set(group, 'data-ei-gallery-state', source ? 'source' : pending ? 'pending' : 'invalid');
      continue;
    }
    for (const name of ['data-ei-gallery-invalid', 'data-ei-gallery-error', 'data-ei-gallery-hidden']) group.removeAttribute(name); set(group, 'data-ei-gallery-state', 'ready');
    set(group, 'data-ei-gallery-count', String(photos.length));
    const options = galleryOptions(group.getAttribute('data-callout-metadata') ?? '');
    const layout = photos.length === 1 ? 'single' : photos.length === 2 ? 'pair' : options.row ? 'row' : 'mosaic';
    const height = options.height ?? (layout === 'mosaic' ? 360 : layout === 'row' ? 220 : 280);
    set(group, 'data-ei-gallery-layout', layout);
    set(group, 'data-ei-gallery-label', `图片组 · ${{ single: '单张', pair: '并排', mosaic: '一大两小', row: '一排三张' }[layout]} · 高 ${height}${options.height === undefined ? '' : '（手动）'}`);
    if (group.style.getPropertyValue('--ei-gallery-height') !== `${height}px`) group.style.setProperty('--ei-gallery-height', `${height}px`);
    // Reconcile only our attributes, leaving native classes and dimension attributes untouched.
    const desired = new Map<Element, [string, string]>([[content, ['data-ei-gallery-grid', '']]]);
    for (const wrapper of wrappers) desired.set(wrapper, ['data-ei-gallery-wrapper', '']);
    photos.forEach((photo, index) => desired.set(photo, ['data-ei-gallery-item', String(index)]));
    for (const node of chrome) desired.set(node, ['data-ei-gallery-chrome', '']);
    for (const node of buffers) desired.set(node, ['data-ei-gallery-buffer', '']);
    for (const node of Array.from(group.querySelectorAll(owned.map(name => `[${name}]`).join(',')))) for (const name of owned) if (desired.get(node)?.[0] !== name) node.removeAttribute(name);
    for (const [node, [name, value]] of desired) set(node, name, value);
  }
}
/** Scoped, coalesced hydration observer. Own data attributes are not observed,
 * so validation cannot trigger a loop or interfere with CodeMirror's image DOM. */
export function observeGalleryMarkup(root: HTMLElement, enabled: () => boolean): () => void {
  const Observer = root.ownerDocument.defaultView?.MutationObserver;
  let disposed = false, queued = false;
  const refresh = () => { if (!disposed) { if (enabled()) validateGalleryMarkup(root); else clearGalleryMarkup(root); } };
  refresh();
  if (!Observer) return () => { disposed = true; clearGalleryMarkup(root); };
  const observer = new Observer(records => {
    const relevant = records.some(record => {
      const target = record.target.nodeType === 1 ? record.target as Element : record.target.parentElement;
      if (target?.closest(pluginBoundary)) return false;
      if (target?.closest(gallerySelector)) return true;
      return Array.from(record.addedNodes).some(node => node.nodeType === 1 && ((node as Element).matches(gallerySelector) || (node as Element).querySelector(gallerySelector)));
    });
    if (!relevant || queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; refresh(); });
  });
  observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'src', 'data-callout', 'data-callout-metadata'] });
  return () => { disposed = true; observer.disconnect(); clearGalleryMarkup(root); };
}
