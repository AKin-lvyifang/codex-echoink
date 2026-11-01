import { setIcon } from "obsidian";
import type { GenerationOutputKind } from "./types";
export function setGenerationIcon(element: HTMLElement, kind: GenerationOutputKind): void {
  setIcon(element, kind === "excalidraw" ? "excalidraw-icon" : kind === "canvas" ? "layout-dashboard" : "file-text");
  if (kind === "excalidraw" && !element.querySelector("svg")) setIcon(element, "pencil");
}
