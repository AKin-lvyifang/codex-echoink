import type { DeepCheckupBatch, DeepCheckupDocument } from "./knowledge-deep-checkup";

export const DEEP_BATCH_SIZE = 8;
const PRIMARY_CHARS = 32_000;
const INPUT_CHARS = 64_000;
const CANDIDATES_PER_BATCH = 8;
const DOMAIN_SAMPLES_PER_SIDE = 8;

function terms(doc: DeepCheckupDocument): Set<string> {
  const body = doc.content.replace(/^---\r?\n[^]*?\r?\n---\r?\n/u, "");
  const text = [doc.path, doc.title ?? "", ...(doc.aliases ?? []), body].join("\n").toLowerCase();
  const result = new Set(text.match(/[a-z][a-z\d_-]{2,}/gu) ?? []);
  for (const match of text.matchAll(/[\p{Script=Han}]{2,}/gu)) {
    const chars = Array.from(match[0]);
    for (let i = 1; i < chars.length; i++) result.add(chars[i - 1] + chars[i]);
  }
  return result;
}

/** Sparse term postings shortlist neighbours; no whole-library pair matrix or pairwise model calls. */
export function planDeepCheckup(documents: DeepCheckupDocument[]): DeepCheckupBatch[] {
  const postings = new Map<string, number[]>();
  const features = documents.map(terms);
  features.forEach((set, index) => {
    for (const term of set) {
      const list = postings.get(term) ?? [];
      list.push(index);
      postings.set(term, list);
    }
  });
  const names = documents.map(doc => new Set([doc.title ?? doc.path.split("/").at(-1)!.replace(/\.md$/iu, ""),
    ...(doc.aliases ?? [])].map(name => name.normalize("NFKC").replace(/\s+/gu, "").toLowerCase()).filter(Boolean)));
  const namePostings = new Map<string, number[]>();
  names.forEach((values, index) => {
    for (const name of values) {
      const list = namePostings.get(name) ?? [];
      list.push(index);
      namePostings.set(name, list);
    }
  });
  const neighbours = (index: number) => {
    const scores = new Map<number, number>();
    const terms = [...features[index]]
      .filter((term) => postings.get(term)!.length > 1 &&
        postings.get(term)!.length <= Math.max(12, Math.min(256, documents.length / 5)))
      .sort((a, b) => postings.get(a)!.length - postings.get(b)!.length)
      .slice(0, 64);
    for (const term of terms) {
      const matches = postings.get(term)!;
      const weight = Math.log(1 + documents.length / matches.length);
      for (const candidate of matches) {
        if (candidate !== index) scores.set(candidate, (scores.get(candidate) ?? 0) + weight);
      }
    }
    // A shared explicit name ranks ahead of body terms; common names still have a bounded shortlist.
    const nameWeight = 64 * Math.log(1 + documents.length) + 1;
    for (const name of names[index]) for (const candidate of (namePostings.get(name) ?? []).slice(0, 256)) {
      if (candidate !== index) scores.set(candidate, (scores.get(candidate) ?? 0) +
        nameWeight * Math.sqrt(features[candidate].size || 1));
    }
    return [...scores].map(([i, score]) => ({ i, score: score / Math.sqrt(features[i].size || 1) }))
      .sort((a, b) => b.score - a.score || documents[a.i].path.localeCompare(documents[b.i].path));
  };
  const domains = new Map<string, DeepCheckupDocument[]>();
  for (const doc of documents) {
    const group = domains.get(doc.domain) ?? [];
    group.push(doc);
    domains.set(doc.domain, group);
  }
  const indexes = new Map(documents.map((doc, index) => [doc.path, index]));
  const batches: DeepCheckupBatch[] = [];
  const domainNeighbours = new Map<string, Map<string, number>>();
  for (const [domain, group] of domains) {
    let primary: DeepCheckupDocument[] = [];
    const flush = () => {
      if (!primary.length) return;
      const primaryPaths = primary.map((doc) => doc.path);
      const candidates = new Map<number, number>();
      for (const doc of primary) {
        const ranked = neighbours(indexes.get(doc.path)!);
        for (const sameDomain of [true, false]) {
          for (const item of ranked.filter((item) =>
            !primaryPaths.includes(documents[item.i].path) &&
            (documents[item.i].domain === domain) === sameDomain,
          ).slice(0, 2)) {
            candidates.set(item.i, Math.max(candidates.get(item.i) ?? 0, item.score));
            if (!sameDomain) {
              const scores = domainNeighbours.get(domain) ?? new Map<string, number>();
              const other = documents[item.i].domain;
              scores.set(other, (scores.get(other) ?? 0) + item.score);
              domainNeighbours.set(domain, scores);
            }
          }
        }
      }
      // Reserve half the shortlist for other domains so a large local cluster cannot crowd them out.
      const ranked = [...candidates].sort((a, b) => b[1] - a[1]);
      const chosen = [
        ...ranked.filter(([i]) => documents[i].domain !== domain).slice(0, 4),
        ...ranked.filter(([i]) => documents[i].domain === domain).slice(0, 4),
      ];
      let chars = primary.reduce((sum, doc) => sum + doc.content.length, 0);
      const paths = [...primaryPaths];
      for (const [index] of chosen.slice(0, CANDIDATES_PER_BATCH)) {
        if (chars + documents[index].content.length > INPUT_CHARS) continue;
        paths.push(documents[index].path);
        chars += documents[index].content.length;
      }
      batches.push({ id: `batch-${batches.length + 1}`, domain, primary: primaryPaths, paths, calls: 0 });
      primary = [];
    };
    for (const doc of group) {
      if (primary.length >= DEEP_BATCH_SIZE ||
          primary.reduce((sum, item) => sum + item.content.length, 0) + doc.content.length > PRIMARY_CHARS)
        flush();
      primary.push(doc);
    }
    flush();
  }
  const pairs = new Set<string>();
  for (const [domain, scores] of domainNeighbours) {
    if (domains.get(domain)!.length < 2) continue;
    for (const [other] of [...scores].filter(([name]) => domains.get(name)!.length >= 2)
      .sort((a, b) => b[1] - a[1]).slice(0, 2)) {
      const names = [domain, other].sort();
      const key = names.join("\0");
      if (pairs.has(key)) continue;
      pairs.add(key);
      const sample = names.flatMap((name) => {
        const group = domains.get(name)!;
        const chars = group.reduce((sum, doc) => sum + doc.content.length, 0);
        const count = Math.max(1, Math.min(DOMAIN_SAMPLES_PER_SIDE, group.length, Math.floor((INPUT_CHARS / 2) / (chars / group.length))));
        let used = 0;
        return Array.from({ length: count }, (_, i) => group[Math.floor(i * group.length / count)])
          .filter((doc) => {
            if (used && used + doc.content.length > INPUT_CHARS / 2) return false;
            used += doc.content.length;
            return true;
          });
      });
      const paths = sample.map((doc) => doc.path);
      batches.push({
        id: `batch-${batches.length + 1}`, domain: names[0], scope: "domains",
        primary: paths, paths, calls: 0,
        catalog: names.map((domain) => {
          const group = domains.get(domain)!;
          const size = Math.min(40, group.length);
          return {
            domain,
            count: group.length,
            titles: Array.from({ length: size }, (_, i) => group[Math.floor(i * group.length / size)].path),
          };
        }),
      });
    }
  }
  return batches;
}
