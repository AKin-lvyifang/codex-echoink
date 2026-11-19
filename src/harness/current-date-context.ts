/** Request-local environment data. Keep the stable system prefix unchanged. */
export function appendCurrentDateContext(systemPrompt: string | undefined, now = Date.now()): string {
  const timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const parts = new Intl.DateTimeFormat("zh-CN-u-ca-gregory-nu-latn", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "long"
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)!.value;
  const date = `${part("year")}-${part("month")}-${part("day")}`;
  const environment = `<echoink_current_date>\n当前本地日期：${date}，${part("weekday")}；时区：${timeZone}。今天、明天等相对日期以此为准。\n</echoink_current_date>`;
  return [systemPrompt, environment].filter(Boolean).join("\n\n");
}
