import { ownedDiv } from "./owned-dom";
import { attachNativeTooltip } from "./native-tooltip";
import { Component, MarkdownRenderer, normalizePath, TFile, type App } from "obsidian";
import { mapMarkdownInlineCode, mapMarkdownOutsideFences, normalizeMarkdownMath } from "../core/markdown-math";
import { splitVaultNoteLinkSegments } from "../core/vault-note-links";
import { renderRichText, splitMessageTableRow } from "./render-message";

function resolveNote(app: App, target: string, sourcePath: string): TFile | null {
  const path = normalizePath(target.split("#")[0]);
  const exact = app.vault.getAbstractFileByPath(path);
  if (exact instanceof TFile) return exact;
  const resolved = app.metadataCache.getFirstLinkpathDest(path, sourcePath);
  return resolved instanceof TFile ? resolved : null;
}

/** Native links carry the canonical path; their label is set after rendering.
 * Omitting an alias also avoids introducing an unescaped pipe into a table. */
export function prepareAnswerMarkdown(app: App, text: string, sourcePath: string): string {
  const adapter = app.vault.adapter as { getBasePath?: () => string };
  const base = adapter.getBasePath?.() ?? "";
  const rewrite = (plain: string): string => splitVaultNoteLinkSegments(plain, base).map(segment => {
    if (segment.kind === "text") return segment.text;
    const file = resolveNote(app, segment.targetPath, sourcePath);
    return file ? `[[${file.path}${segment.heading ? `#${segment.heading}` : ""}]]` : segment.original;
  }).join("");
  const inline = (block: string): string => mapMarkdownInlineCode(block, (plain) => {
    // Keep external links and embeds intact, including note-looking labels.
    const tokens = /!?\[[^\]\n]*\]\([^\n)]*\)|!\[\[[^\]\n]*\]\]/gu;
    let result = "";
    let cursor = 0;
    for (const match of plain.matchAll(tokens)) {
      result += rewrite(plain.slice(cursor, match.index));
      result += match[0].startsWith("!") || /\]\(\s*<?(?:[a-z][a-z\d+.-]*:|#)/iu.test(match[0]) ? match[0] : rewrite(match[0]);
      cursor = match.index + match[0].length;
    }
    return result + rewrite(plain.slice(cursor));
  }, (code, original) => {
    const segments = splitVaultNoteLinkSegments(code, base);
    return segments.length === 1 && segments[0].kind === "noteLink" && resolveNote(app, segments[0].targetPath, sourcePath)
      ? rewrite(code) : original;
  });
  return mapMarkdownOutsideFences(normalizeMarkdownMath(text), (block) => {
    const lines = block.split("\n");
    const result: string[] = [];
    let start = 0;
    for (let i = 0; i < lines.length - 1; i += 1) {
      if (!lines[i].includes("|") || !/^\s*\|?\s*:?-{3,}/u.test(lines[i + 1])) continue;
      const columns = splitMessageTableRow(lines[i]).map(cell => /^(保存路径|完整路径|Save path|Path)$/iu.test(cell.trim()));
      if (!columns.some(Boolean)) continue;
      result.push(inline(lines.slice(start, i).join("\n")), inline(lines[i]), lines[i + 1]);
      i += 2;
      for (; i < lines.length && lines[i].trim().startsWith("|"); i += 1) {
        const cells = splitMessageTableRow(lines[i]).map((cell, index) => {
          if (!columns[index]) return inline(cell);
          const literal = cell.trim().replace(/^`|`$/gu, "").replace(/&#96;/gu, "`");
          const ticks = "`".repeat(Math.max(0, ...Array.from(literal.matchAll(/`+/gu), match => match[0].length)) + 1);
          return `${ticks} ${literal} ${ticks}`;
        });
        result.push(`| ${cells.join(" | ")} |`);
      }
      start = i;
      i -= 1;
    }
    result.push(inline(lines.slice(start).join("\n")));
    return result.filter((part, index) => part || index > 0).join("\n");
  });
}

function decorateNoteLinks(app: App, root: HTMLElement, component: Component, sourcePath: string): void {
  for (const link of Array.from(root.querySelectorAll<HTMLAnchorElement>("a.internal-link"))) {
    const target = link.dataset.href ?? link.getAttribute("href") ?? "";
    const file = resolveNote(app, target, sourcePath);
    if (!file) {
      link.replaceWith(root.ownerDocument.createTextNode(link.textContent ?? target));
      continue;
    }
    const name = file.basename ?? file.path.split("/").pop()!.replace(/\.md$/iu, "");
    link.textContent = name;
    link.addClass("codex-message-note-link");
    link.setAttribute("aria-label", `打开笔记 ${name}`);
    component.register(attachNativeTooltip(link, file.path).dispose);
    component.registerDomEvent(link, "click", async event => {
      event.preventDefault();
      event.stopPropagation();
      const current = app.vault.getAbstractFileByPath(file.path);
      if (!(current instanceof TFile)) return;
      const heading = target.includes("#") ? target.slice(target.indexOf("#")) : "";
      if (heading) await app.workspace.openLinkText(`${file.path}${heading}`, sourcePath, true);
      else await app.workspace.getLeaf("tab").openFile(current, { active: true });
    });
  }
}

interface AnswerMarkdownSlot {
  root: HTMLElement;
  request: string;
  revision: number;
  component: Component | null;
  pending: Component | null;
}

export interface AnswerMarkdownInput {
  app: App;
  container: HTMLElement;
  key: string;
  text: string;
  sourcePath: string;
  streaming: boolean;
  mutate: (root: HTMLElement, change: () => void) => void;
  onCommit: () => void;
}

/** Own only visible answer/reasoning slots. Stream with the measured fast path,
 * then stage native Markdown once; reuse its DOM across virtual row rebuilds. */
export class AnswerMarkdownRenderer {
  private slots = new Map<string, AnswerMarkdownSlot>();
  private visible = new Set<string>();

  beginRender(): void { this.visible.clear(); }

  endRender(): void {
    for (const [key, slot] of this.slots) {
      if (!this.visible.has(key)) { this.release(slot); this.slots.delete(key); }
    }
  }

  clear(): void {
    for (const slot of this.slots.values()) this.release(slot);
    this.slots.clear();
    this.visible.clear();
  }

  render(input: AnswerMarkdownInput): void {
    const { app, container, key, text, sourcePath, streaming, mutate, onCommit } = input;
    this.visible.add(key);
    let slot = this.slots.get(key);
    if (!slot || slot.root.ownerDocument !== container.ownerDocument) {
      if (slot) this.release(slot);
      slot = { root: ownedDiv(container.ownerDocument), request: "", revision: 0, component: null, pending: null };
      this.slots.set(key, slot);
    }
    if (slot.root.parentElement !== container) container.replaceChildren(slot.root);
    const request = JSON.stringify([text, sourcePath, streaming]);
    if (slot.request === request) return;
    slot.request = request;
    const revision = ++slot.revision;
    // In-flight processors may still register children. Their own finally
    // unloads them after rendering settles, even when this revision is stale.
    slot.pending = null;
    // A first render is readable immediately; subsequent async native updates
    // keep the previous committed content until the new content is ready.
    if (streaming || !slot.component) {
      const legacy = new Component();
      legacy.load();
      mutate(slot.root, () => {
        slot.root.className = "echoink-answer-markdown-stream";
        renderRichText(app, legacy, slot.root, text);
      });
      slot.component?.unload();
      slot.component = legacy;
    }
    if (streaming) return;
    const staged = ownedDiv(container.ownerDocument);
    staged.className = "echoink-answer-markdown markdown-rendered";
    const component = new Component();
    component.load();
    slot.pending = component;
    const currentSlot = slot;
    void (async () => {
      try {
        await MarkdownRenderer.render(app, prepareAnswerMarkdown(app, text, sourcePath), staged, sourcePath, component);
        if (this.slots.get(key) !== currentSlot || revision !== currentSlot.revision) return;
        decorateNoteLinks(app, staged, component, sourcePath);
        for (const table of Array.from(staged.querySelectorAll("table"))) {
          if (table.parentElement?.hasClass("table-wrapper")) continue;
          const scroll = ownedDiv(staged.ownerDocument);
          scroll.className = "codex-message-table-scroll";
          table.replaceWith(scroll);
          scroll.append(table);
        }
        mutate(currentSlot.root, () => {
          currentSlot.root.className = "echoink-answer-markdown-host";
          currentSlot.root.replaceChildren(staged);
        });
        currentSlot.component?.unload();
        currentSlot.component = component;
        currentSlot.pending = null;
        onCommit();
      } catch (error) {
        if (this.slots.get(key) === currentSlot && revision === currentSlot.revision) {
          const fallback = new Component();
          fallback.load();
          mutate(currentSlot.root, () => {
            currentSlot.root.className = "echoink-answer-markdown-stream";
            renderRichText(app, fallback, currentSlot.root, text);
          });
          currentSlot.component?.unload();
          currentSlot.component = fallback;
          onCommit();
          console.warn("EchoInk: Markdown rendering failed", error);
        }
      } finally {
        if (currentSlot.component !== component) component.unload();
        if (currentSlot.pending === component) currentSlot.pending = null;
      }
    })();
  }

  private release(slot: AnswerMarkdownSlot): void {
    slot.revision += 1;
    slot.component?.unload();
    slot.root.remove();
  }
}
