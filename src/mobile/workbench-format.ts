/** Shared date text only; each device owns its layout and typography. */
export function formatMobileWorkbenchDate(date = new Date()): string {
  const weekday = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"][date.getDay()];
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${weekday}`;
}
