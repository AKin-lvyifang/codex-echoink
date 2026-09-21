import { Component, normalizePath, setIcon, TFile } from "obsidian";
import type { App } from "obsidian";
import { splitVaultNoteLinkSegments, type VaultNoteLinkSegment } from "../core/vault-note-links";

export function renderRichText(app: App, component: Component, container: HTMLElement, text: string): void {
  container.empty();
  const lines = text.split(/\r?\n/);
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const fence = line.match(/^```(\w+)?/);
    if (fence) {
      const language = fence[1] || "";
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith("```")) {
        codeLines.push(lines[index]);
        index += 1;
      }
      index += 1;
      renderCodeBlock(container, codeLines.join("\n"), language);
      continue;
    }

    if (line.trim().startsWith("|") && index + 1 < lines.length && lines[index + 1].includes("---")) {
      const tableLines: string[] = [line, lines[index + 1]];
      index += 2;
      while (index < lines.length && lines[index].trim().startsWith("|")) {
        tableLines.push(lines[index]);
        index += 1;
      }
      renderTable(app, component, container, tableLines);
      continue;
    }

    if (!line.trim()) {
      container.createDiv({ cls: "codex-message-spacer" });
      index += 1;
      continue;
    }

    renderLine(app, component, container, line);
    index += 1;
  }
}

export function renderPreformattedVaultNoteText(app: App, component: Component, container: HTMLElement, text: string): void {
  container.empty();
  const pre = container.createEl("pre", { cls: "codex-process-fulltext" });
  renderLinkedText(app, component, pre, text);
}

function renderLine(app: App, component: Component, container: HTMLElement, line: string): void {
  const trimmed = line.trim();
  if (/^>\s+/.test(trimmed)) {
    const callout = container.createDiv({ cls: "codex-message-callout" });
    renderInline(app, component, callout, trimmed.replace(/^>\s+/, ""));
    return;
  }

  if (trimmed.startsWith("#")) {
    const level = Math.min(4, trimmed.match(/^#+/)?.[0].length ?? 2);
    const heading = container.createEl(`h${level}` as keyof HTMLElementTagNameMap, { cls: "codex-message-heading" });
    renderInline(app, component, heading, trimmed.replace(/^#+\s*/, ""));
    return;
  }

  if (/^[-*]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
    const row = container.createDiv({ cls: "codex-message-list-row" });
    const task = trimmed.match(/^[-*]\s+\[([ xX])]\s+(.*)$/);
    if (task) {
      const box = row.createSpan({ cls: `codex-message-checkbox ${task[1].trim() ? "is-checked" : ""}` });
      if (task[1].trim()) box.setText("✓");
      renderInline(app, component, row.createSpan(), task[2]);
    } else if (/^\d+\.\s+/.test(trimmed)) {
      const number = trimmed.match(/^(\d+)\.\s+/)?.[1] ?? "1";
      row.createSpan({ cls: "codex-message-number", text: `${number}.` });
      renderInline(app, component, row.createSpan(), trimmed.replace(/^\d+\.\s+/, ""));
    } else {
      row.createSpan({ cls: "codex-message-bullet", text: "•" });
      renderInline(app, component, row.createSpan(), trimmed.replace(/^[-*]\s+/, ""));
    }
    return;
  }

  const imageMatch = trimmed.match(/!\[\[([^\]]+)\]\]|!\[[^\]]*]\(([^)]+)\)/);
  if (imageMatch) {
    const path = imageMatch[1] || imageMatch[2];
    const wrapper = container.createDiv({ cls: "codex-embedded-image" });
    const img = wrapper.createEl("img");
    img.src = resolveImageSrc(app, path);
    img.onclick = () => openImageOverlay(img.src);
    return;
  }

  for (const paragraphText of splitReadableParagraphs(line)) {
    const paragraph = container.createEl("p");
    renderInline(app, component, paragraph, paragraphText);
  }
}

function resolveImageSrc(app: App, rawPath: string): string {
  const cleaned = rawPath.split("|")[0].split("#")[0].trim();
  if (/^https?:\/\//i.test(cleaned) || cleaned.startsWith("data:") || cleaned.startsWith("file://")) return cleaned;
  if (cleaned.startsWith("/")) return `file://${encodeURI(cleaned)}`;

  const file = app.vault.getAbstractFileByPath(normalizePath(cleaned));
  if (file instanceof TFile) return app.vault.getResourcePath(file);
  return cleaned;
}

function renderInline(app: App, component: Component, container: HTMLElement, text: string): void {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith("`") && part.endsWith("`")) {
      const code = part.slice(1, -1);
      if (!renderSingleVaultNoteLink(app, component, container, code)) container.createEl("code", { text: code });
    } else if (part.startsWith("**") && part.endsWith("**")) {
      const strong = container.createEl("strong");
      renderLinkedText(app, component, strong, part.slice(2, -2));
    } else {
      renderLinkedText(app, component, container, part);
    }
  }
}

function renderLinkedText(app: App, component: Component, container: HTMLElement, text: string): void {
  for (const segment of splitVaultNoteLinkSegments(text, vaultBasePath(app))) {
    if (segment.kind === "text") {
      container.appendText(segment.text);
      continue;
    }
    if (!renderVaultNoteLink(app, component, container, segment)) container.appendText(segment.original);
  }
}

function renderSingleVaultNoteLink(app: App, component: Component, container: HTMLElement, text: string): boolean {
  const segments = splitVaultNoteLinkSegments(text, vaultBasePath(app));
  if (segments.length !== 1 || segments[0].kind !== "noteLink") return false;
  return renderVaultNoteLink(app, component, container, segments[0]);
}

function renderVaultNoteLink(app: App, component: Component, container: HTMLElement, segment: Extract<VaultNoteLinkSegment, { kind: "noteLink" }>): boolean {
  const resolved = resolveVaultNoteFile(app, segment.targetPath);
  if (!resolved) return false;
  const targetPath = resolved.targetPath;
  const noteName = vaultNoteName(targetPath);
  const link = container.createEl("a", {
    cls: "codex-message-note-link",
    text: noteName,
    attr: {
      href: "#",
      title: segment.title,
      "aria-label": `打开笔记 ${noteName}`,
      "data-path": targetPath
    }
  });
  component.registerDomEvent(link, "click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const current = app.vault.getAbstractFileByPath(targetPath);
    if (current instanceof TFile) await app.workspace.getLeaf("tab").openFile(current, { active: true });
  });
  return true;
}

function vaultNoteName(targetPath: string): string {
  return targetPath.split("/").pop()?.replace(/\.md$/iu, "") || targetPath;
}

function resolveVaultNoteFile(app: App, targetPath: string): { file: TFile; targetPath: string } | null {
  for (const candidate of knowledgeBaseLinkTargetCandidates(targetPath)) {
    const normalized = normalizePath(candidate);
    const file = app.vault.getAbstractFileByPath(normalized);
    if (file instanceof TFile) return { file, targetPath: normalized };
  }
  const linkpath = normalizePath(targetPath).replace(/\.md$/i, "");
  const linkedFile = app.metadataCache.getFirstLinkpathDest(linkpath, "");
  if (linkedFile instanceof TFile) return { file: linkedFile, targetPath: linkedFile.path };
  return null;
}

function knowledgeBaseLinkTargetCandidates(targetPath: string): string[] {
  const normalized = normalizePath(targetPath);
  const candidates = [normalized];
  const basename = normalized.split("/").pop() ?? "";
  if (/^outputs\/kb-maintenance-.+\.md$/i.test(normalized)) candidates.push(`outputs/maintenance/${basename}`);
  if (/^outputs\/knowledge-base-review-.+\.md$/i.test(normalized)) candidates.push(`outputs/reviews/${basename}`);
  if (/^outputs\/old-wiki-merge-.+\.md$/i.test(normalized)) candidates.push(`outputs/migrations/${basename}`);
  if (/^outputs\/[^/]+instructions[^/]*\.md$/i.test(normalized)) candidates.push(`outputs/instructions/${basename}`);
  if (/^outputs\/[^/]*xhs[^/]*\.md$/i.test(normalized)) candidates.push(`outputs/publishing/xiaohongshu/${basename}`);
  return candidates;
}

function vaultBasePath(app: App): string {
  const adapter = app.vault.adapter as any;
  const basePath = typeof adapter.getBasePath === "function" ? adapter.getBasePath() : "";
  return typeof basePath === "string" ? normalizeFsPath(basePath) : "";
}

function normalizeFsPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function renderCodeBlock(container: HTMLElement, code: string, language: string): void {
  const wrapper = container.createDiv({ cls: "codex-code-wrapper" });
  if (language) wrapper.createSpan({ cls: "codex-code-lang", text: language });
  const button = wrapper.createEl("button", { cls: "codex-code-copy", attr: { type: "button" } });
  setIcon(button, "copy");
  button.onclick = async () => {
    await navigator.clipboard.writeText(code);
    button.empty();
    button.setText("已复制");
    window.setTimeout(() => {
      button.empty();
      setIcon(button, "copy");
    }, 1200);
  };
  wrapper.createEl("pre").createEl("code", { text: code });
}

function renderTable(app: App, component: Component, container: HTMLElement, lines: string[]): void {
  const scroll = container.createDiv({ cls: "codex-message-table-scroll" });
  const table = scroll.createEl("table", { cls: "codex-message-table" });
  const headerCells = splitMessageTableRow(lines[0]);
  const thead = table.createEl("thead").createEl("tr");
  for (const cell of headerCells) renderInline(app, component, thead.createEl("th"), cell);
  const tbody = table.createEl("tbody");
  for (const line of lines.slice(2)) {
    const tr = tbody.createEl("tr");
    for (const cell of splitMessageTableRow(line)) renderInline(app, component, tr.createEl("td"), cell);
  }
}

export function splitMessageTableRow(line: string): string[] {
  const trimmed = line.trim();
  const content = trimmed.startsWith("|")
    ? trimmed.slice(1)
    : trimmed;
  const cells: string[] = [];
  let current = "";
  let insideWikiLink = false;
  let insideCode = false;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    const next = content[index + 1] ?? "";
    if (!insideCode && character === "[" && next === "[") {
      insideWikiLink = true;
      current += "[[";
      index += 1;
      continue;
    }
    if (!insideCode && insideWikiLink && character === "]" && next === "]") {
      insideWikiLink = false;
      current += "]]";
      index += 1;
      continue;
    }
    if (!insideWikiLink && character === "`") {
      insideCode = !insideCode;
      current += character;
      continue;
    }
    if (!insideWikiLink && !insideCode && character === "\\" && next === "|") {
      current += "|";
      index += 1;
      continue;
    }
    if (!insideWikiLink && !insideCode && character === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }

  if (current.trim() || !content.endsWith("|")) cells.push(current.trim());
  return cells;
}

function splitReadableParagraphs(line: string): string[] {
  if (line.length < 180) return [line];
  const pieces = line.split(/([。！？；])\s*/u);
  const chunks: string[] = [];
  for (let index = 0; index < pieces.length; index += 2) {
    const chunk = `${pieces[index]}${pieces[index + 1] ?? ""}`.trim();
    if (chunk) chunks.push(chunk);
  }
  if (chunks.length <= 1) return [line];
  const paragraphs: string[] = [];
  let current = "";
  for (const chunk of chunks) {
    if (current && `${current}${chunk}`.length > 120) {
      paragraphs.push(current);
      current = chunk;
    } else {
      current = current ? `${current}${chunk}` : chunk;
    }
  }
  if (current) paragraphs.push(current);
  return paragraphs;
}

export function openImageOverlay(src: string): void {
  const overlay = document.body.createDiv({ cls: "codex-image-overlay" });
  const img = overlay.createEl("img");
  img.src = src;
  overlay.onclick = () => overlay.remove();
}
