import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { clearGalleryMarkup, observeGalleryMarkup, validateGalleryMarkup } from '../gallery/markup';
import { galleryNativeMarkup } from './fixtures/gallery-native-markup';
import { nativeGalleryPair, nativeGalleryEmpty } from './fixtures/gallery-live-callout';
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
export async function runGalleryMarkupTests(): Promise<void> {
  const dom = new JSDOM('<body><div class="markdown-source-view"></div></body>'), doc = dom.window.document, root = doc.querySelector<HTMLElement>('.markdown-source-view')!;
  try {
    // Actual native structures: span-based photos and a title-only empty Callout.
    root.innerHTML = nativeGalleryPair; validateGalleryMarkup(root);
    assert.equal(root.querySelector<HTMLElement>('.callout')!.dataset.eiGalleryCount, '2');
    assert.equal(root.querySelector<HTMLElement>('.callout')!.dataset.eiGalleryView, 'editing');
    root.innerHTML = nativeGalleryEmpty;
    assert.equal(root.querySelector('.callout-content'), null);
    const stopNative = observeGalleryMarkup(root, () => true);
    const native = root.querySelector<HTMLElement>('.callout')!;
    assert.equal(native.dataset.eiGalleryState, 'invalid');
    assert.equal(native.dataset.eiGalleryError, '组里还没有图片');
    assert.equal(native.dataset.eiGalleryHidden, '这里有 0 张图暂不显示');
    const hydrated = doc.createElement('div'); hydrated.className = 'callout-content';
    hydrated.innerHTML = '<p><span class="internal-embed image-embed"><img src="one.svg"></span><br><span class="internal-embed image-embed"><img src="two.svg"></span></p>';
    native.append(hydrated); await settle();
    assert.equal(native.dataset.eiGalleryState, 'ready'); assert.equal(native.dataset.eiGalleryLayout, 'pair');
    hydrated.remove(); await settle(); assert.equal(native.dataset.eiGalleryError, '组里还没有图片');
    stopNative(); assert.ok(!native.hasAttribute('data-ei-gallery-state'));
    for (const options of [
      { count: 1, buffers: true },
      { count: 2, buffers: true, format: 'inline' as const },
      { count: 2, buffers: true, format: 'adjacent' as const },
      { count: 2, buffers: true, format: 'lines' as const },
      { count: 2, buffers: true, format: 'blank' as const },
      { count: 2, row: true },
      { count: 2, metadata: '300' },
      { count: 3, metadata: '300|row' },
      { count: 3, metadata: 'row|300' },
      { count: 3, metadata: 'row|999' },
      { count: 1, metadata: '0' },
      { count: 2, width: 508, buffers: true, wrapped: true },
      { count: 3, wrapped: true },
      { count: 3, row: true, buffers: true, wrapped: true }
    ]) {
      root.innerHTML = galleryNativeMarkup(options);
      const originals = Array.from(root.querySelectorAll<HTMLImageElement>('img:not(.cm-widgetBuffer)'), image => [image.getAttribute('src'), image.getAttribute('width'), image.getAttribute('height'), image.getAttribute('style')]);
      validateGalleryMarkup(root);
      const group = root.querySelector<HTMLElement>('.callout')!;
      assert.equal(group.dataset.eiGalleryCount, String(options.count));
      assert.equal(group.dataset.eiGalleryChecked, '3'); assert.equal(group.dataset.eiGalleryView, 'editing');
      assert.equal(group.dataset.eiGalleryLayout, options.count === 1 ? 'single' : options.count === 2 ? 'pair' : options.row || options.metadata?.includes('row') ? 'row' : 'mosaic');
      const height = options.metadata?.includes('999') ? 800 : options.metadata === '0' ? 120 : options.metadata?.includes('300') ? 300 : options.count === 3 ? (options.row ? 220 : 360) : 280;
      assert.equal(group.style.getPropertyValue('--ei-gallery-height'), `${height}px`);
      assert.ok(group.dataset.eiGalleryLabel?.includes(`高 ${height}`));
      assert.equal(group.querySelectorAll('[data-ei-gallery-item]').length, options.count);
      assert.equal(group.querySelectorAll('img.cm-widgetBuffer[data-ei-gallery-item]').length, 0);
      assert.ok(group.querySelector('[data-ei-gallery-grid]'));
      assert.deepEqual(Array.from(root.querySelectorAll<HTMLImageElement>('img:not(.cm-widgetBuffer)'), image => [image.getAttribute('src'), image.getAttribute('width'), image.getAttribute('height'), image.getAttribute('style')]), originals, 'Dimensions and image nodes are preserved; the theme overrides their visual size');
      const previousPhotos = Array.from(root.querySelectorAll('img:not(.cm-widgetBuffer)'));
      validateGalleryMarkup(root);
      assert.deepEqual(Array.from(root.querySelectorAll('img:not(.cm-widgetBuffer)')), previousPhotos);
      const text = doc.createTextNode('正文必须保留'); group.querySelector('.callout-content')!.append(text);
      validateGalleryMarkup(root);
      assert.ok(group.hasAttribute('data-ei-gallery-invalid')); assert.ok(!group.querySelector('[data-ei-gallery-grid]')); assert.equal(text.parentElement?.className, 'callout-content');
      assert.equal(group.dataset.eiGalleryState, 'invalid'); assert.equal(group.dataset.eiGalleryError, '组里夹了文字，图片组里只能放图片');
      assert.equal(group.dataset.eiGalleryHidden, `这里有 ${options.count} 张图暂不显示`);
      text.remove(); validateGalleryMarkup(root); assert.equal(group.dataset.eiGalleryState, 'ready'); assert.ok(!group.hasAttribute('data-ei-gallery-error'));
    }
    root.className = 'cm-callout'; root.innerHTML = galleryNativeMarkup({ count: 2 }); validateGalleryMarkup(root); assert.equal(root.querySelector<HTMLElement>('.callout')!.dataset.eiGalleryView, 'editing');
    root.innerHTML = galleryNativeMarkup({ count: 4, buffers: true, wrapped: true }); validateGalleryMarkup(root);
    assert.ok(root.querySelector('[data-ei-gallery-invalid]')); assert.equal(root.querySelectorAll('img:not(.cm-widgetBuffer)').length, 4);
    assert.equal(root.querySelector<HTMLElement>('.callout')!.dataset.eiGalleryError, '图片组最多放 3 张，现在有 4 张');
    root.innerHTML = galleryNativeMarkup({ count: 0 }); validateGalleryMarkup(root);
    assert.equal(root.querySelector<HTMLElement>('.callout')!.dataset.eiGalleryError, '组里还没有图片');
    assert.equal(root.querySelector<HTMLElement>('.callout')!.dataset.eiGalleryHidden, '这里有 0 张图暂不显示');
    root.innerHTML = galleryNativeMarkup({ count: 2 }); root.querySelector('.callout-content')!.innerHTML = '<div class="cm-content"><div class="cm-line">> ![[one.svg]]</div></div>'; validateGalleryMarkup(root);
    assert.equal(root.querySelector<HTMLElement>('.callout')!.dataset.eiGalleryState, 'source'); assert.ok(!root.querySelector('[data-ei-gallery-error]'));
    // Postprocessing sees pending embeds first; the observer must revalidate hydration later.
    root.innerHTML = '<div class="callout" data-callout="gallery"><div class="callout-title">Gallery</div><div class="callout-content"><p><span class="internal-embed" src="one.svg"></span> <span class="internal-embed" src="two.svg"></span></p></div></div>';
    let active = true;
    const stop = observeGalleryMarkup(root, () => active);
    assert.equal(root.querySelector<HTMLElement>('.callout')!.dataset.eiGalleryState, 'pending');
    for (const embed of Array.from(root.querySelectorAll('.internal-embed'))) { embed.classList.add('image-embed'); embed.innerHTML = '<div class="image-wrapper"><img width="508" style="width:508px"></div><div class="embed-actions">native buttons</div>'; }
    await settle();
    assert.equal(root.querySelector<HTMLElement>('.callout')!.dataset.eiGalleryCount, '2');
    root.querySelector('.callout-content')!.appendChild(doc.createElement('img')); await settle();
    assert.equal(root.querySelector<HTMLElement>('.callout')!.dataset.eiGalleryLayout, 'mosaic');
    root.querySelector('.callout')!.setAttribute('data-callout-metadata', '300|row'); await settle();
    assert.equal(root.querySelector<HTMLElement>('.callout')!.style.getPropertyValue('--ei-gallery-height'), '300px');
    assert.equal(root.querySelector<HTMLElement>('.callout')!.dataset.eiGalleryLayout, 'row');
    const stray = doc.createTextNode('stray text'); root.querySelector('.callout-content')!.append(stray); await settle();
    assert.equal(root.querySelector<HTMLElement>('.callout')!.dataset.eiGalleryState, 'invalid');
    stray.remove(); await settle(); assert.equal(root.querySelector<HTMLElement>('.callout')!.dataset.eiGalleryState, 'ready');
    active = false; root.querySelector('img')!.setAttribute('src', 'changed.svg'); await settle();
    assert.ok(!root.querySelector('[data-ei-gallery-item]')); assert.equal(root.querySelector<HTMLElement>('.callout')!.style.getPropertyValue('--ei-gallery-height'), '');
    stop(); active = true; root.append(doc.createElement('p')); await settle();
    assert.ok(!root.querySelector('[data-ei-gallery-checked]'));
    clearGalleryMarkup(root);
    console.log('PASS gallery markup: captured native pair/title-only empty Callout and async recovery; historical image subtree + synthetic variants; 1/2/3, row, separate lines/adjacent/blank lines, manual/clamped heights, sized images, invalid messages/recovery, cursor buffers, hydration, source safety and cleanup');
  } finally { dom.window.close(); }
}
