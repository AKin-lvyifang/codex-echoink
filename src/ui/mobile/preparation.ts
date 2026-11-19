import { renderMobileMemoryReceipt } from "./memory-feedback";
import { preparationText, uniqueNotePaths, type PreparationUpdate } from "../../types/composer-submission";
import type { MobileTaskRun } from "../../mobile/store";
import { ownedEl } from "../owned-dom";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function mobileSearchNotePaths(result: unknown): string[] {
  if (!result || typeof result !== "object") return [];
  const outer = record(result), details = record(outer?.details) ?? outer;
  const hits: readonly unknown[] = Array.isArray(details?.hits) ? details.hits : Array.isArray(outer?.details) ? outer.details : Array.isArray(result) ? result : [];
  return uniqueNotePaths(hits.flatMap(hit => { const value = record(hit), path = value?.vaultRelativePath ?? value?.path; return typeof path === "string" ? [path] : []; }));
}

/** The accepted run takes over the exact preparation result, once per user turn. */
export function renderMobilePreparation(parent: HTMLElement, run: MobileTaskRun | undefined, language: string, openNote: (path: string) => void | Promise<void>): void {
  renderMobileMemoryReceipt(parent, run, language);
  for (const stage of run?.preparation ?? []) {
    if (stage.stage !== "knowledge" || stage.status !== "completed") continue;
    const paths = uniqueNotePaths(stage.notePaths ?? []);
    if (!paths.length) {
      const row = ownedEl(parent.ownerDocument, "div"); row.className = "echoink-preparation-result";
      row.textContent = preparationText(stage, language); parent.append(row); continue;
    }
    const row = ownedEl(parent.ownerDocument, "details"); row.className = "echoink-preparation-result";
    const summary = ownedEl(parent.ownerDocument, "summary"); summary.textContent = preparationText(stage, language); row.append(summary);
    const list = ownedEl(parent.ownerDocument, "div"); list.className = "echoink-preparation-notes";
    appendNoteLinks(list, paths, openNote); row.append(list); parent.append(row);
  }
}

export function renderMobileSearchResult(parent: HTMLElement, result: unknown, language: string, openNote: (path: string) => void | Promise<void>): void {
  const paths = mobileSearchNotePaths(result), stage: PreparationUpdate = { stage: "knowledge", status: "completed", notePaths: paths };
  const count = ownedEl(parent.ownerDocument, "div"); count.textContent = preparationText(stage, language); parent.append(count);
  appendNoteLinks(parent, paths, openNote);
}

function appendNoteLinks(parent: HTMLElement, paths: readonly string[], openNote: (path: string) => void | Promise<void>): void {
  for (const path of uniqueNotePaths(paths)) {
    const button = ownedEl(parent.ownerDocument, "button"); button.type = "button"; button.className = "echoink-preparation-note";
    button.textContent = path.split("/").at(-1)?.replace(/\.md$/iu, "") ?? path;
    button.addEventListener("click", () => { void openNote(path); }); parent.append(button);
  }
}
