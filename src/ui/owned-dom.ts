interface DomFactories {
  createEl: typeof createEl;
  createDiv: typeof createDiv;
  createSpan: typeof createSpan;
  createSvg: typeof createSvg;
  createFragment: typeof createFragment;
}

// Document's Node helpers append to the document itself. Window helpers create
// detached nodes; adopt also retains the owner of DOMParser/detached documents.
function factories(document: Document): DomFactories {
  return document.win as Window & DomFactories;
}
export function ownedEl<K extends keyof HTMLElementTagNameMap>(document: Document, tag: K): HTMLElementTagNameMap[K] {
  return document.adoptNode(factories(document).createEl(tag));
}
export function ownedDiv(document: Document): HTMLDivElement { return document.adoptNode(factories(document).createDiv()); }
export function ownedSpan(document: Document): HTMLSpanElement { return document.adoptNode(factories(document).createSpan()); }
export function ownedSvg<K extends keyof SVGElementTagNameMap>(document: Document, tag: K): SVGElementTagNameMap[K] {
  return document.adoptNode(factories(document).createSvg(tag));
}
export function ownedFragment(document: Document): DocumentFragment { return document.adoptNode(factories(document).createFragment()); }
