import { money } from "./finance-domain";

export interface FinanceDonutItem { category: string; amountCents: number; color: string }
export function financeCategoryDonut(parent: HTMLElement, items: readonly FinanceDonutItem[], options: {
  label: string; selected: () => string | null; onSelect: (category: string | null) => void; bill?: boolean;
}) {
  const total = items.reduce((sum, item) => sum + item.amountCents, 0);
  const ring = parent.createDiv({ cls: `echoink-finance-donut-wrap${options.bill ? " echoink-finance-bill-donut" : ""}` });
  const svg = parent.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 200 200"); svg.setAttribute("class", "echoink-finance-donut-svg"); svg.setAttribute("role", "group"); svg.setAttribute("aria-label", options.label); ring.appendChild(svg);
  const center = ring.createDiv({ cls: "echoink-finance-donut-center" });
  const name = center.createEl("small"); const amount = center.createEl("strong"); const percent = center.createEl("small");
  const tooltip = ring.createSpan({ cls: options.bill ? "echoink-finance-bill-tooltip" : "echoink-finance-donut-tooltip", attr: { role: "tooltip" } }); tooltip.hidden = true;
  const legend = parent.createDiv({ cls: `echoink-finance-chart-legend${options.bill ? " echoink-finance-bill-ranking" : ""}` });
  const rows = new Map<string, HTMLButtonElement>(); const sectors = new Map<string, SVGCircleElement>();
  const show = (key: string | null, transient = false) => {
    const item = items.find(item => item.category === key);
    name.setText(item ? item.category || "未分类" : options.label); amount.setText(`¥ ${money(item?.amountCents ?? total)}`);
    percent.setText(`${item && total ? (item.amountCents / total * 100).toFixed(1) : "100.0"}%`);
    tooltip.hidden = !transient; tooltip.setText(`${name.textContent} · ${amount.textContent} · ${percent.textContent}`);
    for (const [category, sector] of sectors) sector.classList.toggle("is-hovered", transient && category === key);
    for (const [category, row] of rows) row.classList.toggle("is-hovered", transient && category === key);
  };
  const sync = () => {
    const selected = options.selected(); svg.classList.toggle("has-selection", selected !== null);
    for (const [key, control] of [...rows, ...sectors]) { control.setAttribute("aria-pressed", String(key === selected)); control.classList.toggle("is-selected", key === selected); }
    show(selected);
  };
  const choose = (key: string | null) => { options.onSelect(key === options.selected() ? null : key); sync(); };
  let offset = 0;
  for (const item of items) {
    const portion = total ? item.amountCents / total * 100 : 0;
    const sector = parent.ownerDocument.createElementNS(svg.namespaceURI, "circle") as SVGCircleElement;
    for (const [key, value] of Object.entries({ cx: 100, cy: 100, r: 78, pathLength: 100, "stroke-dasharray": `${portion} ${100 - portion}`, "stroke-dashoffset": -offset, stroke: item.color,
      class: `echoink-finance-donut-sector${options.bill ? " echoink-finance-bill-category-target" : ""}`, role: "button", tabindex: 0, "data-category": item.category,
      "aria-label": `${item.category || "未分类"}，¥ ${money(item.amountCents)}，占 ${portion.toFixed(1)}%` })) sector.setAttribute(key, String(value));
    const middle = (offset + portion / 2) / 100 * 2 * Math.PI;
    sector.style.setProperty("--sector-x", `${Math.cos(middle) * 4}px`); sector.style.setProperty("--sector-y", `${Math.sin(middle) * 4}px`);
    svg.appendChild(sector); sectors.set(item.category, sector); offset += portion;
    const row = legend.createEl("button", { cls: `echoink-finance-chart-row${options.bill ? " echoink-finance-bill-category-row" : ""}`, attr: { type: "button", "data-category": item.category } });
    row.style.setProperty("--finance-chart-color", item.color);
    row.createSpan({ text: item.category || "未分类", cls: "echoink-finance-chart-name" }); row.createSpan({ text: `¥ ${money(item.amountCents)}`, cls: "echoink-finance-chart-amount" }); row.createSpan({ text: `${portion.toFixed(1)}%`, cls: "echoink-finance-chart-percent" }); rows.set(item.category, row);
    for (const control of [sector, row]) {
      control.onclick = () => choose(item.category);
      control.onkeydown = event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(item.category); } else if (event.key === "Escape") { event.preventDefault(); choose(null); } };
      control.onmouseenter = control.onfocus = () => show(item.category, true);
      control.onmouseleave = control.onblur = () => show(options.selected());
    }
  }
  sync();
  return { sync, clear: () => choose(null), focus: (key: string) => rows.get(key)?.focus({ preventScroll: true }) };
}
