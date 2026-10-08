import { Scope, setIcon, type App } from "obsidian";
import { FINANCE_BRAND_ASSETS } from "./finance-brand-assets";
import { FINANCE_CATEGORY_ICON_CHOICES, FINANCE_CATEGORY_ICON_GROUPS } from "./finance-catalog";

export type FinanceIconScope = "entry" | "merchant" | "category";
export interface FinanceIconOption { id: string; name: string; group: string; aliases: readonly string[] }

const BRAND_GROUPS: readonly [string, readonly string[]][] = [
  ["餐饮与购物", ["meituan-takeout", "meituan", "eleme", "taobao", "amazon", "shopify", "douyin", "xiaohongshu"]],
  ["出行与住宿", ["airbnb", "tripadvisor", "foursquare", "geo", "strava"]],
  ["影音与游戏", ["youku", "netease-cloud-music", "bilibili", "dailymotion", "netflix", "nintendo", "playstation", "spotify", "steam", "tidal", "twitch", "vimeo", "xbox", "youtube"]],
  ["社交与通讯", ["discord", "facebook", "instagram", "line", "linkedin", "messenger", "qq", "reddit", "skype", "slack", "snapchat", "telegram", "twitter", "wechat", "weibo", "whatsapp", "zoom"]],
  ["办公与设计", ["adobe-illustrator", "adobe-photoshop", "adobe-xd", "atlassian", "behance", "confluence", "dribbble", "figma", "framer", "invision", "jira", "notion", "outlook", "sketch", "trello"]],
  ["软件与开发", ["android", "apple", "bitbucket", "codeopen", "github", "google-play", "html5", "ubuntu", "windows", "wordpress"]],
  ["支付与账户", ["bitcoin", "ethereum", "mastercard", "paypal", "visa"]]
];
const BRAND_GROUP_BY_ID = new Map(BRAND_GROUPS.flatMap(([name, ids]) => ids.map((id): [string, string] => [id, name])));
const GROUP_ORDER = ["自动与无图标", ...BRAND_GROUPS.map(([name]) => name), "银行", "其他品牌", ...FINANCE_CATEGORY_ICON_GROUPS.map(([name]) => name)];
const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

export function financeIconOptions(scope: FinanceIconScope): FinanceIconOption[] {
  const options: FinanceIconOption[] = [];
  if (scope !== "category") {
    options.push({ id: "auto", name: "自动匹配", group: "自动与无图标", aliases: [] },
      { id: "none", name: "无品牌图标", group: "自动与无图标", aliases: [] });
    options.push(...FINANCE_BRAND_ASSETS.map((asset) => ({ id: asset.id, name: asset.displayName,
      group: asset.group || BRAND_GROUP_BY_ID.get(asset.id) || "其他品牌", aliases: asset.aliases })));
  }
  if (scope !== "merchant") options.push(...FINANCE_CATEGORY_ICON_CHOICES.map(([id, name, group]) => ({ id, name, group, aliases: [] })));
  return options.sort((left, right) => GROUP_ORDER.indexOf(left.group) - GROUP_ORDER.indexOf(right.group)
    || collator.compare(left.name, right.name) || collator.compare(left.id, right.id));
}

export function renderFinanceIcon(parent: HTMLElement, id: string): void {
  parent.empty();
  const asset = FINANCE_BRAND_ASSETS.find((item) => item.id === id);
  parent.toggleClass("has-light-backdrop", !!asset?.lightBackdrop);
  if (asset) parent.createEl("img", { attr: { src: asset.dataUri, alt: "" } });
  else setIcon(parent, id === "auto" ? "sparkles" : id === "none" ? "ban" : id);
}

/** Hide the existing form in place, so text, selection and scroll survive a picker round-trip. */
export function openFinanceIconPicker(host: HTMLElement, formView: HTMLElement, scope: FinanceIconScope,
  selected: string, onSelect: (id: string) => void, returnFocus: HTMLElement,
  app: Pick<App, "scope" | "keymap">): void {
  const options = financeIconOptions(scope);
  const scroll = new Map<HTMLElement, number>();
  for (let node: HTMLElement | null = host; node; node = node.parentElement) if (node.scrollHeight > node.clientHeight) scroll.set(node, node.scrollTop);
  const parentBack = host.querySelector<HTMLElement>(":scope > .echoink-life-settings-back");
  const parentHeading = host.querySelector<HTMLElement>(":scope > h2");
  if (parentBack) parentBack.hidden = true;
  if (parentHeading) parentHeading.hidden = true;
  formView.hidden = true;
  const picker = host.createDiv({ cls: "echoink-finance-icon-picker" });
  const back = picker.createEl("button", { cls: "echoink-finance-icon-picker-back", text: "‹ 返回编辑", attr: { type: "button" } });
  picker.createEl("h3", { text: "选择图标" });
  const search = picker.createEl("input", { cls: "echoink-finance-icon-search", attr: { type: "search", placeholder: "搜索图标名称或品牌", "aria-label": "搜索图标" } });
  const body = picker.createDiv({ cls: "echoink-finance-icon-picker-body" });
  let group = "";
  let closed = false;
  const escapeScope = new Scope(app.scope);
  const observer = new MutationObserver(() => { if (!picker.isConnected) cleanup(); });
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    observer.disconnect();
    app.keymap.popScope(escapeScope);
  };
  const close = (): void => {
    cleanup();
    picker.remove(); formView.hidden = false;
    if (parentBack) parentBack.hidden = false;
    if (parentHeading) parentHeading.hidden = false;
    for (const [node, top] of scroll) node.scrollTop = top;
    returnFocus.focus({ preventScroll: true });
  };
  const match = (option: FinanceIconOption, query: string): boolean => [option.name, option.id, ...option.aliases]
    .some((value) => value.toLocaleLowerCase().includes(query));
  const drawGrid = (shown: readonly FinanceIconOption[]): void => {
    const grid = body.createDiv({ cls: "echoink-finance-icon-grid" });
    if (!shown.length) body.createEl("p", { cls: "echoink-life-hint", text: "没有匹配的图标" });
    for (const option of shown) {
      const item = grid.createEl("button", { cls: "echoink-finance-icon-item", attr: { type: "button", "aria-pressed": String(selected === option.id), title: option.name } });
      renderFinanceIcon(item.createSpan({ cls: "echoink-finance-icon-art" }), option.id);
      item.createSpan({ text: option.name });
      item.onclick = () => { onSelect(option.id); close(); };
    }
  };
  const render = (): void => {
    body.empty();
    const query = search.value.trim().toLocaleLowerCase();
    back.setText(group ? "‹ 返回分组" : "‹ 返回编辑");
    if (group || query) {
      if (group) body.createEl("p", { cls: "echoink-life-hint", text: group });
      drawGrid(options.filter((option) => (!group || option.group === group) && (!query || match(option, query))));
      return;
    }
    for (const name of GROUP_ORDER) {
      const count = options.filter((option) => option.group === name).length;
      if (!count) continue;
      const row = body.createEl("button", { cls: "echoink-finance-icon-group", attr: { type: "button", "aria-label": `进入${name}，${count} 个图标`, "data-icon-group": name } });
      row.createSpan({ text: name }); row.createSpan({ text: `${count} ›` });
      row.onclick = () => { group = name; render(); search.focus({ preventScroll: true }); };
    }
  };
  back.onclick = () => {
    if (group) {
      const previousGroup = group;
      group = ""; search.value = ""; render();
      Array.from(body.querySelectorAll<HTMLButtonElement>(".echoink-finance-icon-group"))
        .find((row) => row.dataset.iconGroup === previousGroup)?.focus({ preventScroll: true });
    } else close();
  };
  search.oninput = render;
  picker.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault(); event.stopPropagation();
    back.click();
  }, true);
  escapeScope.register(null, "Escape", () => { back.click(); return false; });
  app.keymap.pushScope(escapeScope);
  observer.observe(host.ownerDocument, { childList: true, subtree: true });
  render(); picker.scrollIntoView({ block: "start" }); search.focus({ preventScroll: true });
}
