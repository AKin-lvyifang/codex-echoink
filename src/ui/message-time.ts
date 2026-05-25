const MESSAGE_HEADER_TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  weekday: "long",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
});

export function formatMessageHeaderTime(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "";
  return MESSAGE_HEADER_TIME_FORMATTER.format(new Date(value)).replace(/\s+/g, "");
}
