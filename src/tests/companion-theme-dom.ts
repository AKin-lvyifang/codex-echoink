import { galleryNativeMarkup } from "./fixtures/gallery-native-markup";
import { validateGalleryMarkup } from "../gallery/markup";
/** Run against the real Obsidian stylesheet in its native renderer, not JSDOM. */
export function runCompanionThemeDomChecks(themeSheet: CSSStyleSheet): string[] {
  const results: string[] = [];
  const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
  const originalClass = document.body.className;
  const originalSkin = document.body.getAttribute("data-echoink-theme");
  const originallyDisabled = themeSheet.disabled;
  const fixture = document.createElement("div");
  fixture.style.cssText = "position:fixed;left:-10000px;top:0;width:720px;visibility:hidden;pointer-events:none";
  fixture.innerHTML = `<div class="markdown-preview-view"><div class="markdown-preview-sizer">
    <h2>Notebook heading</h2><a class="internal-link" href="#">Resolved</a>
    <a class="internal-link is-unresolved" href="#missing">Unresolved</a><a class="footnote-link" href="#fn">1</a>
    <table><tbody><tr><td>First</td></tr><tr><td>Second</td></tr></tbody></table>
    <ul class="tasks"></ul><div class="echoink-workbench"><div class="wb-page"><div class="wb-section-heading"><h2>Ready for an Agent</h2></div>
      <div class="markdown-preview-view"><h2>Plugin Markdown</h2><strong><em>Plugin emphasis</em></strong><a href="#">Plugin link</a></div></div></div>
  </div></div><div class="markdown-source-view mod-cm6"><div class="cm-content">
    <div class="HyperMD-list-line HyperMD-list-line-1"><span class="cm-formatting-list"><span class="list-bullet">-</span></span> List</div>
  </div></div>`;
  document.body.append(fixture);
  const plugin = fixture.querySelector<HTMLElement>(".echoink-workbench")!;
  const note = fixture.querySelector<HTMLElement>(".markdown-preview-view")!;
  const source = fixture.querySelector<HTMLElement>(".cm-content")!;
  const states = ["x", " ", "/", "-", ">", "<", "?", "!", "*", "I", "i", "b", "f", '"', "l", "k", "p", "c", "w"];
  for (const state of states) {
    const li = document.createElement("li"); li.dataset.task = state; li.className = "task-list-item";
    const input = document.createElement("input"); input.type = "checkbox"; input.className = "task-list-item-checkbox"; input.checked = state !== " " && state !== "-";
    li.append(input); note.querySelector(".tasks")!.append(li);
    const line = document.createElement("div"); line.className = "HyperMD-task-line"; line.dataset.task = state;
    const label = document.createElement("span"); label.className = "task-list-label"; label.append(input.cloneNode()); line.append(label); source.append(line);
  }
  const galleries: HTMLElement[] = [];
  for (const count of [1, 2, 3, 4]) {
    const line = document.createElement("div"); line.className = "cm-line";
    for (let i = 0; i < count; i++) {
      const buffer = document.createElement("img"); buffer.className = "cm-widgetBuffer"; line.append(buffer);
      const image = document.createElement("div"); image.className = "image-embed";
      image.innerHTML = '<div class="image-wrapper"><img width="600" height="400"></div>'; line.append(image);
    }
    source.append(line); galleries.push(line);
  }
  const mixed = galleries[1].cloneNode(true) as HTMLElement;
  mixed.append(document.createElement("strong")); source.append(mixed);
  const readPlugin = () => Array.from(plugin.querySelectorAll<HTMLElement>("h2,a,em")).map(element => {
    const style = getComputedStyle(element), after = getComputedStyle(element, "::after");
    return [style.fontFamily, style.fontSize, style.fontWeight, style.fontStyle, style.textTransform, style.transform,
      style.backgroundImage, style.borderBottomWidth, style.textDecorationLine, after.content, after.maskImage].join("|");
  });
  try {
    for (const skin of ["minimal", "highlighter", "manifesto"]) for (const mode of ["theme-light", "theme-dark"]) {
      document.body.classList.remove("theme-light", "theme-dark"); document.body.classList.add(mode);
      document.body.dataset.echoinkTheme = skin;
      themeSheet.disabled = true; const baseline = readPlugin();
      themeSheet.disabled = false;
      assert(JSON.stringify(readPlugin()) === JSON.stringify(baseline), `${skin}/${mode}: companion formatting reached nested plugin UI`);
      const bullet = source.querySelector<HTMLElement>(".list-bullet")!;
      assert(getComputedStyle(bullet).color === "rgba(0, 0, 0, 0)", `${skin}/${mode}: raw Markdown hyphen is visible`);
      assert(parseFloat(getComputedStyle(bullet, "::after").width) > 0, "Native bullet disappeared");
      for (const input of fixture.querySelectorAll<HTMLInputElement>(".task-list-item-checkbox")) {
        const state = input.closest<HTMLElement>("[data-task]")!.dataset.task;
        if (state === " " || state === "/") continue;
        const style = getComputedStyle(input), glyph = getComputedStyle(input, "::after"), box = input.getBoundingClientRect();
        const transform = glyph.transform === "none" ? new DOMMatrixReadOnly() : new DOMMatrixReadOnly(glyph.transform);
        const x = parseFloat(style.borderLeftWidth) + parseFloat(glyph.left) + parseFloat(glyph.width) / 2 + transform.m41 - box.width / 2;
        const y = parseFloat(style.borderTopWidth) + parseFloat(glyph.top) + parseFloat(glyph.height) / 2 + transform.m42 - box.height / 2;
        assert(Math.abs(x) < .1 && Math.abs(y) < .1, `${skin}/${mode}/${state}: task glyph off-center (${x}, ${y})`);
        assert(glyph.clipPath !== "inset(0px 100% 0px 0px)", `${state}: only blank task characters hide the glyph`);
      }
      if (skin !== "minimal") {
        const cells = Array.from(note.querySelectorAll("td"), cell => getComputedStyle(cell).backgroundColor);
        assert(cells[0] === cells[1] && cells[0] !== "rgba(0, 0, 0, 0)", `${skin}/${mode}: body rows must share opaque paper`);
        for (const link of note.querySelectorAll<HTMLAnchorElement>(":scope>.markdown-preview-sizer>a:not(.is-unresolved)")) {
          const style = getComputedStyle(link);
          assert(style.borderBottomWidth === "1.5px" && style.borderBottomStyle === "solid" && style.backgroundImage === "none" && style.textDecorationLine === "none", "Resolved links need one yellow stroke");
        }
        assert(getComputedStyle(note.querySelector("a.is-unresolved")!).borderBottomStyle === "dashed", "Unresolved notes retain a dashed stroke");
      }
      assert(getComputedStyle(galleries[0]).display !== "grid" && getComputedStyle(galleries[3]).display !== "grid" && getComputedStyle(mixed).display !== "grid", "Ordinary image widgets stay outside implicit grids");
      assert(getComputedStyle(galleries[1]).display !== "grid" && getComputedStyle(galleries[2]).display !== "grid", "Ordinary image rows must not auto-group");
      results.push(`PASS ${skin}/${mode}: plugin isolation, bullets, 19 reading/editor task glyphs, tables, links, ordinary image separation`);
    }
  } finally {
    themeSheet.disabled = originallyDisabled;
    document.body.className = originalClass;
    if (originalSkin === null) document.body.removeAttribute("data-echoink-theme"); else document.body.setAttribute("data-echoink-theme", originalSkin);
    fixture.remove();
  }
  return results;
}

/** Layout measurements in the native CSS engine; this is not a screenshot fixture. */
export function runCompanionWidthChecks(themeSheet: CSSStyleSheet): unknown[] {
  const results: unknown[] = [];
  const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
  const root = document.createElement("section");
  root.style.cssText = "position:fixed;left:-20000px;top:0;width:2400px;height:600px;visibility:hidden;pointer-events:none";
  document.body.append(root);
  const originallyDisabled = themeSheet.disabled;
  try {
    for (const mode of ["reading", "editing"]) for (const [paneWidth, expected] of [[900, 720], [1400, 1120], [2000, 1200], [120, 88]]) {
      const pane = document.createElement("div");
      pane.className = "workspace-leaf-content"; pane.dataset.type = "markdown";
      pane.style.cssText = `position:relative;width:${paneWidth}px;height:500px;flex:none`;
      const body = `<div class="metadata-container" style="display:block"><span class="width-probe">Properties</span></div><div class="callout">Callout</div><table style="width:100%"><tbody><tr><td>Table</td></tr></tbody></table><pre>Code</pre><div class="markdown-embed" style="container-type:inline-size"><div class="markdown-preview-view width-probe">Embed</div></div><p class="width-gallery">Gallery</p>`;
      pane.innerHTML = mode === "reading"
        ? `<div class="view-content"><div class="markdown-reading-view"><div class="markdown-preview-view is-readable-line-width"><div class="markdown-preview-sizer">${body}</div></div></div></div>`
        : `<div class="view-content"><div class="markdown-source-view mod-cm6 is-readable-line-width"><div class="cm-editor"><div class="cm-scroller"><div class="cm-sizer">${body}<div class="cm-contentContainer"><div class="cm-content"><div class="cm-line">Editor line</div></div></div></div></div></div></div></div>`;
      root.append(pane);
      const view = pane.querySelector<HTMLElement>(".is-readable-line-width")!;
      const sizer = pane.querySelector<HTMLElement>(mode === "reading" ? ".markdown-preview-sizer" : ".cm-sizer")!;
      const contentWidth = sizer.getBoundingClientRect().width;
      const lineLimit = parseFloat(getComputedStyle(view).getPropertyValue("--file-line-width"));
      assert(Math.abs(lineLimit - expected) < 1, `${mode}/${paneWidth}: expected line limit ${expected}, got ${lineLimit}`);
      if (paneWidth >= 900) assert(Math.abs(contentWidth - expected) < 1, `${mode}/${paneWidth}: content is ${contentWidth}, expected ${expected}`);
      const components = Array.from(sizer.querySelectorAll<HTMLElement>(":scope>.metadata-container,:scope>.callout,:scope>table,:scope>pre,:scope>.markdown-embed,:scope>.width-gallery"), element => ({ element: element.className || element.tagName, width: element.getBoundingClientRect().width }));
      assert(components.every(component => component.width <= contentWidth + 1), "A note component exceeded its shared content width");
      for (const child of sizer.querySelectorAll(".width-probe")) {
        const inheritedLimit = parseFloat(getComputedStyle(child).getPropertyValue("--file-line-width"));
        assert(Math.abs(inheritedLimit - expected) < 1, "Nested metadata/embed containers recomputed the pane-relative width");
      }
      view.classList.remove("is-readable-line-width");
      const unrestricted = sizer.getBoundingClientRect().width;
      themeSheet.disabled = true;
      const nativeUnrestricted = sizer.getBoundingClientRect().width;
      themeSheet.disabled = false;
      assert(Math.abs(unrestricted - nativeUnrestricted) < 1, "Readable-off width differs from the native stylesheet");
      view.classList.add("is-readable-line-width");
      const plugin = document.createElement("div"); plugin.className = "echoink-workbench";
      pane.replaceWith(plugin); plugin.append(pane);
      const pluginLimit = getComputedStyle(view).getPropertyValue("--file-line-width");
      themeSheet.disabled = true;
      const nativePluginLimit = getComputedStyle(view).getPropertyValue("--file-line-width");
      themeSheet.disabled = false;
      assert(pluginLimit === nativePluginLimit, "Note width token reached a plugin container");
      results.push({ mode, paneWidth, expected, lineLimit, contentWidth, components, unrestricted, nativeUnrestricted, pluginUnaffected: true });
      plugin.remove();
    }
  } finally { themeSheet.disabled = originallyDisabled; root.remove(); }
  return results;
}

/** CSS-engine fixture regression, not a capture of the current native Callout.
 * Invoke in a native renderer only; bundle generation alone is not a pass. */
export function runExplicitGalleryChecks(): string[] {
  const results: string[] = [], previous = document.body.getAttribute("data-echoink-theme"), originalClass = document.body.className;
  const root = document.createElement("div"); root.style.cssText = "position:fixed;left:-20000px;width:720px;visibility:hidden"; document.body.append(root);
  const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
  try {
    for (const skin of ["minimal", "highlighter", "manifesto"]) for (const dark of [false, true]) for (const editing of [false, true]) {
      document.body.dataset.echoinkTheme = skin; document.body.classList.toggle("theme-dark", dark); document.body.classList.toggle("theme-light", !dark);
      root.className = editing ? "markdown-source-view mod-cm6" : "markdown-preview-view";
      for (const options of [{ count: 1 }, { count: 2, buffers: true }, { count: 2, format: "lines" as const }, { count: 2, format: "blank" as const }, { count: 2, format: "adjacent" as const }, { count: 2, row: true }, { count: 2, width: 508, buffers: true, wrapped: true }, { count: 3, wrapped: true }, { count: 3, row: true, buffers: true, wrapped: true }, { count: 3, metadata: "300|row" }, { count: 2, metadata: "900" }, { count: 1, metadata: "60" }]) {
        root.innerHTML = galleryNativeMarkup(options); validateGalleryMarkup(root, editing);
        const group = root.firstElementChild!, grid = group.querySelector<HTMLElement>('[data-ei-gallery-grid]')!, photos = Array.from(group.querySelectorAll<HTMLElement>('[data-ei-gallery-item]'));
        const bounds = photos.map(image => image.getBoundingClientRect()), area = grid.getBoundingClientRect();
        check(getComputedStyle(grid).display === 'grid', 'Native gallery grid did not activate');
        check(getComputedStyle(group.querySelector('.callout-title')!).display === 'none', 'Callout title leaked');
        check(editing ? getComputedStyle(group, '::after').borderStyle === 'dashed' : parseFloat(getComputedStyle(group).borderWidth) === 0, 'Reading/editor shell differs');
        check(bounds.every(image => image.width > 0 && image.height > 0 && image.left >= area.left - 1 && image.right <= area.right + 1), 'An image did not fill its grid cell');
        const height = options.metadata === "900" ? 800 : options.metadata === "60" ? 120 : options.metadata?.includes("300") ? 300 : options.count === 3 ? (options.row ? 220 : 360) : 280;
        check(Math.abs(area.height - height) < 1, `Gallery expected height ${height}, got ${area.height}`);
        if (options.count === 1 || options.count === 2 || options.row || options.metadata?.includes("row")) {
          check(bounds.every(image => Math.abs(image.top - bounds[0].top) < 1 && Math.abs(image.width - bounds[0].width) < 1 && Math.abs(image.height - bounds[0].height) < 1), 'Equal columns must have equal width and height');
        } else check(bounds[0].height > bounds[1].height * 1.8 && Math.abs(bounds[1].left - bounds[2].left) < 1 && bounds[2].top > bounds[1].top, 'Mosaic must have one tall image and two stacked images');
        if (options.width) check(photos[0].getAttribute('width') === '508' && photos[0].style.width === '508px' && bounds[0].width < 508, 'CSS must override the original width without altering it');
      }
      for (const count of [0, 2, 4]) {
        root.innerHTML = galleryNativeMarkup({count});
        if (count === 2) root.querySelector('.callout-content')!.append(document.createTextNode('extra text'));
        validateGalleryMarkup(root, editing);
        const group = root.firstElementChild!;
        check(getComputedStyle(group.querySelector('.callout-content')!).display === 'none', 'Malformed group content must be concealed');
        check(getComputedStyle(group, '::before').content.includes('图片组格式有误'), 'Malformed group needs a three-line message');
      }
      // No validator: only the theme's canonical Markdown fallback is active.
      for (const count of [1,2,3,4]) for (const row of [false,true]) for (const format of ['inline','lines','adjacent','blank'] as const) {
        root.innerHTML = galleryNativeMarkup({count,row,format,width:508});
        const group = root.firstElementChild!, content = group.querySelector('.callout-content')!;
        const area = content.getBoundingClientRect();
        check(getComputedStyle(content).display !== 'none', 'Theme-only fallback hid contents');
        if (count === 4) continue;
        const height = count === 3 ? row ? 220 : 360 : 280;
        check(getComputedStyle(content).display === 'grid' && Math.abs(area.height-height)<1, `Theme-only ${count}/${row}/${format}: expected ${height}, got ${area.height}`);
        const photos = Array.from(group.querySelectorAll('img:not(.cm-widgetBuffer)'), image => image.getBoundingClientRect());
        if (count === 2 || row) check(photos.every(image => Math.abs(image.height-height)<1 && Math.abs(image.top-photos[0].top)<1), 'Theme-only equal columns differ');
        else if (count === 3) check(photos[0].height>photos[1].height*1.8 && photos[2].top>photos[1].top, 'Theme-only mosaic differs');
      }
      results.push('PASS ' + skin + '/' + (dark ? 'dark' : 'light') + '/' + (editing ? 'editor' : 'reading') + ': grid geometry, sized images and shell');
    }
  } finally { root.remove(); document.body.className = originalClass; if (previous === null) document.body.removeAttribute('data-echoink-theme'); else document.body.setAttribute('data-echoink-theme', previous); }
  return results;
}

/** Installed CSS engine + synthetic native task markup. Not a live-vault measurement. */
export function runTaskAlignmentChecks(): unknown[] {
  const rows: unknown[] = [], oldSkin = document.body.getAttribute('data-echoink-theme'), oldClass = document.body.className;
  const host = document.createElement('div'); host.style.cssText = 'position:fixed;left:-20000px;width:720px'; document.body.append(host);
  try {
    for (const skin of ['minimal', 'highlighter', 'manifesto']) for (const dark of [false,true]) for (const editing of [false,true]) {
      document.body.dataset.echoinkTheme = skin; document.body.classList.toggle('theme-dark',dark); document.body.classList.toggle('theme-light',!dark);
      host.className = editing ? 'markdown-source-view mod-cm6' : 'markdown-preview-view';
      host.innerHTML = editing ? '<div class="cm-content"></div>' : '<div class="markdown-preview-sizer"><ul></ul></div>';
      const parent = host.querySelector(editing ? '.cm-content' : 'ul')!;
      for (const state of ['x',' ','/','-','>','<','?','!','*','I','i','b','f','"','l','k','p','c','w']) {
        const line = document.createElement(editing ? 'div':'li'); line.className = editing ? 'cm-line HyperMD-task-line':'task-list-item'; line.dataset.task = state;
        const input = document.createElement('input'); input.type='checkbox'; input.className='task-list-item-checkbox'; input.checked = state !== ' ';
        const label = editing ? document.createElement('span') : line; if (editing) {label.className='task-list-label'; line.append(label);} label.append(input);
        const text = document.createElement('span'); text.textContent='任务文字 Alignment'; line.append(text); parent.append(line);
        const box = input.getBoundingClientRect(), css = getComputedStyle(input), glyph = getComputedStyle(input,'::after');
        const transform = glyph.transform === 'none' ? new DOMMatrixReadOnly() : new DOMMatrixReadOnly(glyph.transform);
        const dx = parseFloat(css.borderLeftWidth)+parseFloat(glyph.left)+parseFloat(glyph.width)/2+transform.m41-box.width/2;
        const dy = parseFloat(css.borderTopWidth)+parseFloat(glyph.top)+parseFloat(glyph.height)/2+transform.m42-box.height/2;
        const lineRect = line.getBoundingClientRect();
        const lineCenterDy = box.top+box.height/2-lineRect.top-parseFloat(getComputedStyle(line).lineHeight)/2;
        if (state !== ' ' && state !== '/' && (Math.abs(dx)>.1 || Math.abs(dy)>.1)) throw new Error(`${skin}/${dark}/${editing}/${state}: glyph offset ${dx}/${dy}`);
        if (Math.abs(lineCenterDy)>.1) throw new Error(`${skin}/${dark}/${editing}/${state}: checkbox line center offset ${lineCenterDy}`);
        rows.push({skin,dark,editing,state,box:{width:box.width,height:box.height},glyphDx:state===' '||state==='/'?null:dx,glyphDy:state===' '||state==='/'?null:dy,lineCenterDy});
      }
    }
  } finally {host.remove();document.body.className=oldClass;if(oldSkin===null) document.body.removeAttribute('data-echoink-theme');else document.body.setAttribute('data-echoink-theme',oldSkin);}
  return rows;
}
