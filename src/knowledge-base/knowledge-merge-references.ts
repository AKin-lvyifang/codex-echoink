import { knowledgeBodyLinkSpans } from "./knowledge-relations";
import { createMaintenanceSectionSnapshot } from "./maintenance-section-patch";
import type { MergeSection } from "./knowledge-merge-content";

export interface MergeReferenceContext {
  primaryPath: string;
  secondaryPath: string;
  resolve(target: string, sourcePath: string): string | null;
}

interface ReferenceEntry {
  key: string;
  text: string;
  linked: boolean;
  calibrated: boolean;
}

const BEGIN = "<!-- echoink-related:BEGIN -->";
const END = "<!-- echoink-related:END -->";

function entries(body: string, sourcePath: string, context: MergeReferenceContext): ReferenceEntry[] {
  const result: ReferenceEntry[] = [];
  for (const line of body.split(/\r?\n/u)) {
    const text = line.trim();
    if (!text || text === BEGIN || text === END) continue;
    // A calibration belongs to the source entry immediately before it.
    if (/^<!--\s*echoink-source\s*:/u.test(text) && result.at(-1)?.linked) {
      result.at(-1)!.text += "\n" + line;
      result.at(-1)!.calibrated = true;
      continue;
    }
    const link = knowledgeBodyLinkSpans(line)[0];
    let target = link?.target ?? "";
    if (link?.kind === "markdown") {
      try { target = decodeURIComponent(target); } catch { /* Native unresolved text stays unchanged. */ }
    }
    target = target.split("#")[0];
    const path = link && !/^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(target)
      ? context.resolve(target || sourcePath, sourcePath) : null;
    result.push({
      key: path ?? (link ? `link:${target}` : `text:${text}`),
      text: line,
      linked: !!link,
      calibrated: false,
    });
  }
  return result;
}

/** Metadata is merged by native file identity; ordinary section facts stay with the content validator. */
export function mergeReferenceSections(
  primary: string,
  sections: readonly MergeSection[],
  context: MergeReferenceContext,
): { content: string; additions: { title: string; body: string }[] } {
  let content = primary;
  const eol = primary.includes("\r\n") ? "\r\n" : "\n";
  const additions: { title: string; body: string }[] = [];
  for (const kind of ["sources", "related"] as const) {
    const region = createMaintenanceSectionSnapshot(content).regions.find(item => item.kind === kind);
    const incoming = sections.filter(section => section.kind === kind);
    if (!region && !incoming.length) continue;
    const retained = new Map<string, ReferenceEntry>();
    const oldBody = region ? content.slice(region.contentStart, region.end) : "";
    const previous = entries(oldBody, context.primaryPath, context);
    const added = incoming.flatMap(section => entries(section.body, context.secondaryPath, context));
    const newEntries: ReferenceEntry[] = [];
    for (const item of [...previous, ...added]) {
      if (kind === "related" && [context.primaryPath, context.secondaryPath].includes(item.key)) continue;
      const prior = retained.get(item.key);
      // First entry is the primary's wording; sources may upgrade to a calibrated entry.
      if (prior && !(kind === "sources" && item.calibrated && !prior.calibrated)) continue;
      retained.set(item.key, item);
      if (added.includes(item)) newEntries.push(item);
    }
    const kept = [...retained.values()];
    const lines = (items: ReferenceEntry[]) => items.map(item => item.text.replace(/\r?\n/gu, eol)).join(eol);
    const body = kind === "related"
      ? [lines(kept.filter(item => !item.linked)), BEGIN, lines(kept.filter(item => item.linked)), END]
        .filter(Boolean).join(eol)
      : lines(kept);
    const title = region?.title ?? (kind === "sources" ? "来源" : "相关条目");
    if (region) {
      content = content.slice(0, region.contentStart) + eol + body + eol + eol + content.slice(region.end);
    } else {
      content = content.trimEnd() + `${eol}${eol}## ${title}${eol}${eol}${body}${eol}`;
    }
    const newlyRetained = newEntries.filter(item => retained.get(item.key) === item);
    if (newlyRetained.length) additions.push({ title, body: lines(newlyRetained) });
  }
  return { content, additions };
}
