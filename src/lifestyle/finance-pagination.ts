import { createOriginPagination } from "../settings/origin-controls";

export const FINANCE_PAGE_SIZE = 20;
/** Clamp after deletions without changing the full filtered collection. */
export function financePage<T>(items: readonly T[], requested: number) {
  const pages = Math.max(1, Math.ceil(items.length / FINANCE_PAGE_SIZE));
  const page = Math.max(1, Math.min(pages, Math.trunc(requested) || 1));
  const start = (page - 1) * FINANCE_PAGE_SIZE;
  return { page, pages, start, items: items.slice(start, start + FINANCE_PAGE_SIZE), total: items.length };
}
export function financePagination(parent: HTMLElement, page: number, pages: number, total: number, onChange: (page: number) => void): HTMLElement {
  const footer = parent.createDiv({ cls: "echoink-finance-pagination" });
  footer.createSpan({ text: `共 ${total} 笔 · 每页 20 笔 · ${page} / ${pages} 页`, attr: { role: "status" } });
  createOriginPagination(footer, page, pages, onChange);
  return footer;
}

/** Only rows scroll; short panes may scroll the page to reach their controls. */
export function fitFinanceList(list: HTMLElement, footer: HTMLElement, maximum = 560, mode: "remaining" | "viewport" = "remaining"): () => void {
  const viewport = list.closest<HTMLElement>(".echoink-lifestyle-view"); const win = list.ownerDocument.defaultView;
  if (!viewport || !win || typeof list.getBoundingClientRect !== "function") return () => {};
  const fit = () => {
    const bounds = viewport.getBoundingClientRect();
    const height = Math.min(bounds.height, win.innerHeight);
    // Keep offsets in scroll-content coordinates so scrolling cannot resize rows.
    const top = list.getBoundingClientRect().top - bounds.top + viewport.scrollTop;
    let trailing = 0;
    const gap = Number.parseFloat(win.getComputedStyle(list.parentElement!).rowGap) || 0;
    for (let next = list.nextElementSibling; next; next = next.nextElementSibling) {
      const style = win.getComputedStyle(next);
      trailing += next.getBoundingClientRect().height + (Number.parseFloat(style.marginTop) || 0) + (Number.parseFloat(style.marginBottom) || 0) + gap;
    }
    if (!trailing) trailing = footer.getBoundingClientRect().height + 16;
    const available = mode === "viewport" ? height * .65 - trailing : height - top - trailing - 16;
    list.style.maxHeight = `${Math.floor(Math.max(144, Math.min(maximum, height * .65, available)))}px`;
  };
  fit();
  const Observer = win.ResizeObserver; const observer = Observer ? new Observer(fit) : null; observer?.observe(viewport);
  win.addEventListener("resize", fit);
  return () => { observer?.disconnect(); win.removeEventListener("resize", fit); };
}
