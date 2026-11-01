import type { DrawingStyle } from "./elements";
export const DRAWING_TEMPLATE_DIRECTORY = "EchoInk/手绘模板";
export const drawingStyleLabel = (style: DrawingStyle): string => style === "blackboard" ? "黑板" : "手绘白底";
export function drawingTemplatePath(style: DrawingStyle): string { return `${DRAWING_TEMPLATE_DIRECTORY}/${drawingStyleLabel(style)}.excalidraw.md`; }
/** File-local export-dark takes precedence over matchThemeAlways on load. No global setting changes. */
export function drawingTemplateContent(style: DrawingStyle): string {
  const dark = style === "blackboard";
  return `---\nexcalidraw-plugin: parsed\nexcalidraw-export-dark: ${dark}\nechoink-drawing-template: true\n---\n\n# Excalidraw Data\n\n## Text Elements\n\n%%\n## Drawing\n\`\`\`json\n${JSON.stringify({ type: "excalidraw", version: 2, source: "https://excalidraw.com", elements: [], appState: { theme: dark ? "dark" : "light", viewBackgroundColor: "#ffffff", currentItemFontFamily: 5, currentItemRoughness: 1 }, files: {} })}\n\`\`\`\n%%\n`;
}
