export interface SelectionAskAction { id: string; name: string; template: string }
export interface SelectionAskSettings { enabled: boolean; actions: SelectionAskAction[] }
export function visibleCharacters(value: string): string[] {
  const Segmenter = (Intl as unknown as { Segmenter?: new (locale: string, options: { granularity: string }) => { segment(value: string): Iterable<{ segment: string }> } }).Segmenter;
  return Segmenter ? Array.from(new Segmenter("und", { granularity: "grapheme" }).segment(value), (part) => part.segment) : Array.from(value);
}
export function selectionActionNameError(name: string, others: readonly SelectionAskAction[], id: string): "empty" | "length" | "duplicate" | null {
  const trimmed = name.trim();
  return !trimmed ? "empty" : visibleCharacters(trimmed).length > 4 ? "length" : others.some((action) => action.id !== id && action.name === trimmed) || trimmed === "Ask" ? "duplicate" : null;
}
export function normalizeSelectionAskSettings(input: unknown): SelectionAskSettings {
  const root = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const raw = Array.isArray(root.actions) ? root.actions : [];
  const defaultItem = raw.find((value) => value && value.id === "default");
  const actions: SelectionAskAction[] = [{ id: "default", name: "提问", template: typeof defaultItem?.template === "string" ? defaultItem.template : "" }];
  for (const value of raw) {
    // Desktop supports the fixed question plus three custom actions. Keep all
    // persisted actions when any shared/mobile settings save is normalized.
    if (actions.length === 4) break;
    if (!value || typeof value.id !== "string" || !value.id.trim() || actions.some((action) => action.id === value.id)) continue;
    let name = typeof value.name === "string" ? visibleCharacters(value.name.trim()).slice(0, 4).join("") : "";
    if (selectionActionNameError(name, actions, value.id)) name = `选项${actions.length + 1}`;
    let fallback = 2;
    while (actions.some((action) => action.name === name)) name = `选项${fallback++}`;
    actions.push({ id: value.id, name, template: typeof value.template === "string" ? value.template : "" });
  }
  return { enabled: root.enabled !== false, actions };
}
