export interface MaintenanceTextRange {
  start: number;
  end: number;
}

export interface MaintenanceSourceSegment extends MaintenanceTextRange {
  sourceRevision: string;
}

export interface MaintenanceReadSlice extends MaintenanceSourceSegment {
  totalLength: number;
  bodyFingerprint: string;
  path: string;
}

export interface MaintenanceReadCoverage {
  sourceRevision: string;
  bodyFingerprint: string;
  totalLength: number;
  ranges: readonly MaintenanceTextRange[];
}

export function addMaintenanceRange(ranges: readonly MaintenanceTextRange[], range: MaintenanceTextRange): MaintenanceTextRange[] {
  const merged: MaintenanceTextRange[] = [];
  for (const item of [...ranges, range].sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && last.end >= item.start) last.end = Math.max(last.end, item.end);
    else merged.push({ start: item.start, end: item.end });
  }
  return merged;
}

export function hasMaintenanceRange(ranges: readonly MaintenanceTextRange[], range: MaintenanceTextRange): boolean {
  return ranges.some(item => item.start <= range.start && item.end >= range.end);
}

export function maintenanceReadSlice(value: unknown): MaintenanceReadSlice | undefined {
  if (!value || typeof value !== "object") return undefined;
  const slice = value as MaintenanceReadSlice;
  if (typeof slice.path !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(slice.sourceRevision)
    || !/^sha256:\d+:[a-f0-9]{64}$/u.test(slice.bodyFingerprint)
    || ![slice.start, slice.end, slice.totalLength].every(Number.isSafeInteger)
    || slice.start < 0 || slice.end < slice.start || slice.end > slice.totalLength) return undefined;
  return slice;
}

/** Original UTF-16 positions, including CRLF and an optional final empty line. */
export function maintenanceLineOffsets(content: string): number[] {
  const offsets = [0];
  for (const match of content.matchAll(/\r\n|\n|\r/gu)) offsets.push(match.index + match[0].length);
  return offsets;
}
