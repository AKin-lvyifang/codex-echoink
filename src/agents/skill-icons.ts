/** Stable product IDs only; custom Skills keep the generic Skill icon. */
const SKILL_ICONS: Readonly<Record<string, string>> = Object.freeze({
  "clarify-real-question": "circle-help", "two-layer-explanation": "layers", "deep-understanding": "microscope",
  "evidence-freshness-audit": "badge-check", "multi-lens-problem-solving": "shapes", "minimum-real-world-experiment": "flask-conical",
  "knowledge-review": "graduation-cap", "self-discovery-life-design": "sprout", "daily-journal": "book-open",
  "english-diary": "languages", "finance-bill-import": "receipt", "finance-analysis": "chart-pie", "finance-operations": "wallet",
  "obsidian-markdown": "hash", "obsidian-bases": "table", "json-canvas": "layout-dashboard", "obsidian-cli": "terminal",
  "todo-operations": "list-todo"
});
export function skillIcon(id: string): string { return SKILL_ICONS[id] ?? "sparkles"; }
