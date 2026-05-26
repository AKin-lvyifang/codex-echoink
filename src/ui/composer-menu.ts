export type ComposerMenuContainmentTarget = Pick<Node, "contains">;

export function shouldCloseComposerMenusForClick(
  target: Node | null,
  rootEl: ComposerMenuContainmentTarget,
  menuEls: readonly (ComposerMenuContainmentTarget | null | undefined)[]
): boolean {
  if (!target) return false;
  if (!rootEl.contains(target)) return true;
  return !menuEls.some((menuEl) => menuEl?.contains(target));
}
