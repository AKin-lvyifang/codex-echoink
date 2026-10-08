import { createHash } from "node:crypto";
import type { DiaryBlock, DiaryPrivacy, ProcessingMode } from "./types";

export class DiaryServiceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "DiaryServiceError";
  }
}

export function fingerprint(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Offsets address the unmodified input. Separators remain outside the blocks. */
export function splitDiaryBlocks(text: string): DiaryBlock[] {
  const lines = [...text.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/gu)]
    .filter((match) => match[0].length > 0)
    .map((match) => ({ start: match.index, raw: match[0], text: match[0].replace(/(?:\r\n|\n|\r)$/u, "") }));
  const blocks: DiaryBlock[] = [];
  const occurrences = new Map<string, number>();
  const append = (start: number, end: number, protectedBlock: boolean) => {
    const content = text.slice(start, end);
    if (!content.trim()) return;
    const hash = fingerprint(content);
    const occurrence = occurrences.get(hash) ?? 0;
    occurrences.set(hash, occurrence + 1);
    blocks.push({ id: `b_${hash}_${occurrence}`, text: content, start, end, protected: protectedBlock });
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (index === 0 && line.text.replace(/^\uFEFF/u, "") === "---") {
      let last = index + 1;
      while (last < lines.length && !/^(?:---|\.\.\.)\s*$/u.test(lines[last].text)) last++;
      last = Math.min(last, lines.length - 1);
      append(line.start, lines[last].start + lines[last].text.length, true);
      index = last;
      continue;
    }
    const fence = line.text.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1];
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`, "u");
      let last = index + 1;
      while (last < lines.length && !close.test(lines[last].text)) last++;
      last = Math.min(last, lines.length - 1);
      append(line.start, lines[last].start + lines[last].text.length, true);
      index = last;
      continue;
    }
    // Code, links, embeds and raw HTML are preserved locally by default. The
    // adjacent ordinary lines still participate in whole-diary context.
    const protectedBlock = /^(?: {4}|\t)/u.test(line.text)
      || /`|!?\[\[|!?\[[^\]]*\]\(|(?:https?:\/\/|www\.)|<\/?[A-Za-z!][^>]*>/u.test(line.text);
    append(line.start, line.start + line.text.length, protectedBlock);
  }
  return blocks;
}

function blockDigest(id: string): string {
  return /^b_([a-f0-9]{64})_\d+$/u.exec(id)?.[1] ?? id;
}

/** Never guess that an edited secret has become a newly permitted paragraph. */
export function normalizePrivacy(
  blocks: readonly DiaryBlock[],
  currentFingerprint: string,
  savedPrivacy: DiaryPrivacy | null | undefined
): DiaryPrivacy {
  const modes = new Map<string, ProcessingMode>();
  if (savedPrivacy) {
    if (!Array.isArray(savedPrivacy.rules)) {
      throw new DiaryServiceError("english_diary_privacy_review_required", "请重新确认本篇内容的发送范围。");
    }
    for (const rule of savedPrivacy.rules) {
      if (!rule || !["translate", "preserve", "exclude"].includes(rule.mode) || modes.has(rule.blockId)) {
        throw new DiaryServiceError("english_diary_privacy_review_required", "内容发送范围无效，请重新确认。");
      }
      modes.set(rule.blockId, rule.mode);
    }
    const currentIds = new Set(blocks.map((block) => block.id));
    const changed = savedPrivacy.sourceFingerprint !== currentFingerprint;
    for (const [id, mode] of modes) {
      if (!currentIds.has(id) && (!changed || mode !== "translate")) {
        throw new DiaryServiceError("english_diary_privacy_review_required", "原稿中的保留或不发送段落已改变，请重新确认发送范围。");
      }
    }
    if (changed) {
      // A newly duplicated excluded paragraph must not leak just because its
      // occurrence number changed. Exclude outranks preserve for equal text.
      for (const block of blocks) {
        const related = [...modes].filter(([id]) => blockDigest(id) === blockDigest(block.id)).map(([, mode]) => mode);
        if (related.includes("exclude")) modes.set(block.id, "exclude");
        else if (related.includes("preserve")) modes.set(block.id, "preserve");
      }
      const excludedTexts = blocks.filter((block) => modes.get(block.id) === "exclude").map((block) => block.text);
      for (const block of blocks) if (excludedTexts.some((excluded) => block.text.includes(excluded))) modes.set(block.id, "exclude");
    }
  }
  return {
    sourceFingerprint: currentFingerprint,
    rules: blocks.map((block) => ({ blockId: block.id, mode: modes.get(block.id) ?? (block.protected ? "exclude" : "translate") }))
  };
}
