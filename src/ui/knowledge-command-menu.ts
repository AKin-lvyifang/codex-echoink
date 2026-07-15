const COMMAND_ITEM_SELECTOR = ".codex-command-item";

export function nextKnowledgeCommandSelectionIndex(
  currentIndex: number,
  itemCount: number,
  direction: -1 | 1
): number {
  if (itemCount <= 0) return -1;
  if (currentIndex < 0) return direction > 0 ? 0 : itemCount - 1;
  return (currentIndex + direction + itemCount) % itemCount;
}

export function setKnowledgeCommandMenuOpen(
  input: HTMLTextAreaElement,
  container: HTMLElement,
  open: boolean
): void {
  container.toggleClass("is-visible", open);
  input.setAttribute("aria-expanded", String(open));
  if (!open) input.removeAttribute("aria-activedescendant");
}

export function selectKnowledgeCommandItem(
  input: HTMLTextAreaElement,
  container: HTMLElement,
  nextIndex: number,
  scroll = false
): HTMLElement | null {
  const items = commandItems(container);
  const selected = nextIndex >= 0 && nextIndex < items.length ? items[nextIndex] : null;
  for (const item of items) {
    const active = item === selected;
    item.toggleClass("is-selected", active);
    item.setAttribute("aria-selected", String(active));
  }
  if (!selected) {
    input.removeAttribute("aria-activedescendant");
    return null;
  }
  input.setAttribute("aria-activedescendant", selected.id);
  if (scroll) selected.scrollIntoView({ block: "nearest" });
  return selected;
}

export function handleKnowledgeCommandMenuKeyDown(
  event: KeyboardEvent,
  input: HTMLTextAreaElement,
  container: HTMLElement
): boolean {
  if (!container.hasClass("is-visible")) return false;
  const items = commandItems(container);

  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    setKnowledgeCommandMenuOpen(input, container, false);
    return true;
  }

  if (event.key === "Tab") {
    setKnowledgeCommandMenuOpen(input, container, false);
    return false;
  }

  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    if (items.length === 0) return false;
    event.preventDefault();
    event.stopPropagation();
    const currentIndex = items.findIndex((item) => item.hasClass("is-selected"));
    const direction = event.key === "ArrowDown" ? 1 : -1;
    selectKnowledgeCommandItem(input, container, nextKnowledgeCommandSelectionIndex(currentIndex, items.length, direction), true);
    return true;
  }

  if (event.key === "Enter" && !event.shiftKey) {
    const selected = items.find((item) => item.hasClass("is-selected"));
    if (!selected) return false;
    event.preventDefault();
    event.stopPropagation();
    selected.click();
    return true;
  }

  return false;
}

function commandItems(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(COMMAND_ITEM_SELECTOR));
}
