export function formatSyncUsedBytes(bytes: number): string {
  return bytes < 1_073_741_824 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${(bytes / 1_073_741_824).toFixed(2)} GB`;
}

/** Presentation only. The controller continues to own encryption, permissions and sync state. */
export function syncUsagePresentation(usedBytes: number, quotaBytes: number) {
  const available = quotaBytes > 0;
  return {
    available,
    label: available ? `${formatSyncUsedBytes(usedBytes)} / ${quotaBytes < 1_073_741_824 ? `${Number((quotaBytes / 1_048_576).toFixed(1))} MB` : `${Number((quotaBytes / 1_073_741_824).toFixed(2))} GB`}` : "—",
    percent: available ? Math.min(100, Math.max(0, Math.round(usedBytes / quotaBytes * 100))) : 0,
    warning: available && usedBytes / quotaBytes >= .9
  };
}

export function syncDeviceIcon(kind: string): string {
  return kind === "phone" || kind === "mobile" ? "smartphone" : kind === "tablet" ? "tablet" : "laptop";
}

export function syncLastSeen(at: number, zh: boolean, now = Date.now()): string {
  const prefix = zh ? "最近同步 " : "Last synced ";
  if (!Number.isFinite(at) || at <= 0) return zh ? "尚未同步" : "Not synced yet";
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (!minutes) return prefix + (zh ? "刚刚" : "just now");
  if (minutes < 60) return prefix + (zh ? `${minutes} 分钟前` : `${minutes} min ago`);
  return prefix + new Date(at).toLocaleString(zh ? "zh-CN" : "en-US", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
