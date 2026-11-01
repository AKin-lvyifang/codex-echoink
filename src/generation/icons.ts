import { getIcon, setIcon } from "obsidian";
import type { GenerationOutputKind } from "./types";
export function excalidrawIconName(): string { return getIcon("excalidraw-icon") ? "excalidraw-icon" : "pencil"; }
export function setGenerationIcon(element: HTMLElement, kind: GenerationOutputKind): void {
  setIcon(element, kind === "excalidraw" ? excalidrawIconName() : kind === "canvas" ? "layout-dashboard" : "file-text");
  if (kind === "excalidraw" && !element.querySelector("svg")) setIcon(element, "pencil");
}
