const paths: Record<string, string> = {
  "arrow-up": '<path d="m5 12 7-7 7 7M12 5v14"/>',
  "chevron-left": '<path d="m15 18-6-6 6-6"/>', "chevron-right": '<path d="m9 18 6-6-6-6"/>', "chevron-down": '<path d="m6 9 6 6 6-6"/>',
  check: '<path d="m4 12 5 5L20 6"/>', square: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  "shield-check": '<path d="M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7l-9-4Z"/><path d="m8 12 3 3 5-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', x: '<path d="m6 6 12 12M6 18 18 6"/>',
  "file-text": '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6ZM14 2v6h6M8 13h8M8 17h6"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2"/>',
  "settings-2": '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
  bot: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 3v5M8 13v2M16 13v2M1 12v4M23 12v4"/>',
  "square-pen": '<path d="M21 14v6H4V3h9M14 5l4 4M10 15l1-5L19 2l4 4-8 8-5 1Z"/>',
  "notebook-pen": '<rect x="4" y="3" width="15" height="18" rx="2"/><path d="M8 3v18M11 14l5-5 3 3-5 5-3 1Z"/>',
  brain: '<path d="M12 5c-4-6-11 1-7 5-6 2-3 11 3 9 1 4 4 2 4-1V5Zm0 0c4-6 11 1 7 5 6 2 3 11-3 9-1 4-4 2-4-1"/>',
  ellipsis: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'
};
export function setIcon(element: HTMLElement, name: string) {
  const parsed = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">${paths[name] ?? '<circle cx="12" cy="12" r="8"/>'}</svg>`, "image/svg+xml");
  const svg = document.importNode(parsed.documentElement, true); svg.setAttribute("data-icon", name); element.replaceChildren(svg);
}
