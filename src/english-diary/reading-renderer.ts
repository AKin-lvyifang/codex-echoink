import type { DiaryAlignment } from "./types";

export interface DiaryReadingBlock {
  start: number;
  end: number;
  markdown: string;
  element: HTMLElement | null;
  exactText: boolean;
}

/** Keep offsets in the saved result; only the visible frontmatter is omitted. */
export function diaryReadingBody(text: string): { markdown: string; start: number } {
  const frontmatter = /^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/u.exec(text);
  const start = frontmatter?.[0].length ?? 0;
  return { markdown: text.slice(start), start };
}

/** These are source envelopes, not a Markdown parser. The host renders every envelope. */
function sourceBlocks(markdown: string, start: number): DiaryReadingBlock[] {
  const blocks: DiaryReadingBlock[] = [];
  const separator = /\r?\n[\t ]*\r?\n(?:[\t ]*\r?\n)*/gu;
  let cursor = 0;
  const append = (end: number) => {
    const text = markdown.slice(cursor, end);
    const leading = text.length - text.trimStart().length;
    const content = text.trim();
    if (content) blocks.push({ start: start + cursor + leading, end: start + cursor + leading + content.length, markdown: content, element: null, exactText: false });
  };
  for (const match of markdown.matchAll(separator)) { append(match.index); cursor = match.index + match[0].length; }
  append(markdown.length);
  return blocks;
}

function shape(node: Node): string {
  if (node.nodeType === 3) return JSON.stringify(node.nodeValue);
  if (node.nodeType !== 1) return "";
  const element = node as HTMLElement;
  return `<${element.tagName}>${Array.from(element.childNodes, shape).join("")}</${element.tagName}>`;
}

/**
 * All Markdown is rendered by Obsidian. A source envelope is associated with a
 * rendered block only when the complete ordered sequence agrees, or when both
 * the source envelope and rendered structure are unique. No substring search
 * is used to recover a range inside rendered text.
 */
export async function renderDiaryReading(
  root: HTMLElement,
  text: string,
  renderMarkdown: (markdown: string, container: HTMLElement) => Promise<void>,
  isCurrent: () => boolean = () => true
): Promise<DiaryReadingBlock[]> {
  const body = diaryReadingBody(text);
  await renderMarkdown(body.markdown, root);
  if (!isCurrent()) return [];
  const blocks: DiaryReadingBlock[] = [];
  const rendered = Array.from(root.children) as HTMLElement[];
  const shapes = rendered.map(shape);
  const candidateShapes: Array<string | null> = [];
  // Probe source line boundaries only when the host produced several blocks
  // from one envelope. Prefix + suffix must reproduce that entire structure.
  // The shared budget also caps compound-envelope probes below.
  let remainingProbes = 96;
  const inspect = async (block: DiaryReadingBlock, scratch: HTMLElement): Promise<Array<{ block: DiaryReadingBlock; signature: string | null }>> => {
    const expected = Array.from(scratch.children, shape);
    if (expected.length > 1) {
      for (const boundary of block.markdown.matchAll(/\r?\n/gu)) {
        if (remainingProbes < 2 || !isCurrent()) break;
        const cut = boundary.index;
        const rightStart = cut + boundary[0].length;
        if (!cut || rightStart === block.markdown.length) continue;
        remainingProbes -= 2;
        const left = root.ownerDocument.createElement("div");
        const right = root.ownerDocument.createElement("div");
        await renderMarkdown(block.markdown.slice(0, cut), left);
        if (!isCurrent()) return [];
        await renderMarkdown(block.markdown.slice(rightStart), right);
        if (!isCurrent()) return [];
        const actual = [...Array.from(left.children, shape), ...Array.from(right.children, shape)];
        if (!left.children.length || !right.children.length || actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) continue;
        const before: DiaryReadingBlock = { ...block, end: block.start + cut, markdown: block.markdown.slice(0, cut) };
        const after: DiaryReadingBlock = { ...block, start: block.start + rightStart, markdown: block.markdown.slice(rightStart) };
        return [...await inspect(before, left), ...await inspect(after, right)];
      }
    }
    return [{ block, signature: expected.length === 1 ? expected[0] : null }];
  };
  for (const block of sourceBlocks(body.markdown, body.start)) {
    const scratch = root.ownerDocument.createElement("div");
    await renderMarkdown(block.markdown, scratch);
    if (!isCurrent()) return [];
    for (const candidate of await inspect(block, scratch)) { blocks.push(candidate.block); candidateShapes.push(candidate.signature); }
    if (!isCurrent()) return [];
  }
  const ordered = blocks.length === rendered.length && candidateShapes.every((value, index) => value !== null && value === shapes[index]);
  blocks.forEach((block, index) => {
    const signature = candidateShapes[index];
    const unique = signature !== null && candidateShapes.filter((value) => value === signature).length === 1 && shapes.filter((value) => value === signature).length === 1;
    const element = ordered ? rendered[index] : unique ? rendered[shapes.indexOf(signature!)] : null;
    block.element = element ?? null;
  });
  // Fences and loose lists may contain blank lines. Re-render adjacent source
  // envelopes together rather than guessing which paragraph/code block they
  // belong to. Only a unique, complete rendered block is accepted.
  for (let index = 0; index < blocks.length; index++) {
    if (blocks[index].element) continue;
    for (let end = index + 1; end < blocks.length && !blocks[end].element && remainingProbes > 0; end++) {
      remainingProbes--;
      const scratch = root.ownerDocument.createElement("div");
      await renderMarkdown(text.slice(blocks[index].start, blocks[end].end), scratch);
      if (!isCurrent()) return [];
      if (scratch.children.length !== 1) continue;
      const signature = shape(scratch.children[0]);
      const matches = rendered.filter((element) => shape(element) === signature);
      if (matches.length !== 1 || blocks.some((block) => block.element === matches[0])) continue;
      for (let cursor = index; cursor <= end; cursor++) blocks[cursor].element = matches[0];
      break;
    }
  }
  // A proved compound block may absorb a repeated candidate inside a fence.
  // Account for those blocks before associating any remaining unique output.
  blocks.forEach((block, index) => {
    const signature = candidateShapes[index];
    if (block.element || signature === null) return;
    const candidates = blocks.filter((entry, cursor) => !entry.element && candidateShapes[cursor] === signature);
    const available = rendered.filter((element, cursor) => shapes[cursor] === signature && !blocks.some((entry) => entry.element === element));
    if (candidates.length === 1 && available.length === 1) block.element = available[0];
  });
  for (const block of blocks) {
    const element = block.element;
    block.exactText = !!element && element.textContent === block.markdown && !element.matches("h1,h2,h3,h4,h5,h6,pre,table") && !element.querySelector("a,code,pre,img,button,input,textarea");
  }
  return blocks;
}

/** An identity mapping over the whole block proves every text-node offset. */
export function markDiaryReadingBlock(
  block: DiaryReadingBlock,
  alignments: readonly DiaryAlignment[],
  decorate: (mark: HTMLElement, ids: string[], block: HTMLElement) => void
): Set<string> {
  const marked = new Set<string>();
  if (!block.element || !block.exactText) return marked;
  const element = block.element;
  const ranges = alignments.flatMap((alignment) => alignment.target
    .filter((range) => range.start >= block.start && range.end <= block.end && block.markdown.slice(range.start - block.start, range.end - block.start) === range.text)
    .map((range) => ({ ...range, id: alignment.id, kind: alignment.kind })));
  const walker = element.ownerDocument.createTreeWalker(element, 4);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  let offset = block.start;
  for (const node of nodes) {
    const text = node.data;
    const start = offset;
    offset += text.length;
    const matches = ranges.filter((range) => range.start < offset && range.end > start);
    if (!matches.length) continue;
    const points = [...new Set([start, offset, ...matches.flatMap((range) => [Math.max(start, range.start), Math.min(offset, range.end)])])].sort((a, b) => a - b);
    const fragment = element.ownerDocument.createDocumentFragment();
    for (let index = 0; index < points.length - 1; index++) {
      const from = points[index], to = points[index + 1];
      const active = matches.filter((range) => range.start <= from && range.end >= to);
      const value = text.slice(from - start, to - start);
      if (!active.length) { fragment.append(value); continue; }
      const mark = element.ownerDocument.createElement("span");
      mark.className = `echoink-diary-mark is-${active[0].kind}`;
      mark.textContent = value;
      const ids = [...new Set(active.map((range) => range.id))];
      decorate(mark, ids, element);
      ids.forEach((id) => marked.add(id));
      fragment.append(mark);
    }
    node.replaceWith(fragment);
  }
  return marked;
}
