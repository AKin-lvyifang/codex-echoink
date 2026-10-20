import { dateKey, journalDateFromPath, type HomeVaultFileRecord } from "./home-workbench-model";
import { formatHomeFullDate } from "./home-i18n";
import type { SettingsLanguage } from "../settings/settings";

export interface PhotoCalendarOptions {
  days: HTMLElement; weekdays: HTMLElement; month: Date; selected: string | null;
  records: readonly HomeVaultFileRecord[]; folder: string; format: string;
  language: SettingsLanguage; activity?: ReadonlyMap<string, number>;
  onSelect?: (date: string) => void;
}

/** Shared with the original home: selecting a date never opens or creates a file. */
export function renderPhotoCalendar(options: PhotoCalendarOptions): { recordDays: number; photoDays: number } {
  const { days, weekdays, month, selected, language } = options;
  weekdays.empty(); days.empty();
  for (let index = 0; index < 7; index++) { const label = weekdays.ownerDocument.createElement("span"); label.textContent = new Intl.DateTimeFormat(language, { weekday: "narrow" }).format(new Date(2024, 0, index + 1)); weekdays.appendChild(label); }
  const dates = new Set<string>(), photos = new Map<string, string>();
  for (const record of options.records) {
    const date = journalDateFromPath(record.path, options.folder, options.format);
    if (!date) continue;
    dates.add(date);
    if (record.firstImageUrl && !photos.has(date)) photos.set(date, record.firstImageUrl);
  }
  const first = new Date(month.getFullYear(), month.getMonth(), 1), offset = (first.getDay() + 6) % 7;
  const cells = Math.ceil((new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate() + offset) / 7) * 7;
  for (let index = 0; index < cells; index++) {
    const date = new Date(first.getFullYear(), first.getMonth(), index - offset + 1), key = dateKey(date);
    const outside = date.getMonth() !== first.getMonth(), photo = !outside && photos.get(key);
    const count = options.activity?.get(key) ?? 0;
    const day = days.ownerDocument.createElement("button");
    day.type = "button"; day.dataset.date = key; day.setAttribute("aria-pressed", String(key === selected));
    day.setAttribute("aria-label", `${formatHomeFullDate(date, language)} · ${count}${photo ? language === "en" ? " · With photo" : " · 含照片" : ""}`);
    days.appendChild(day);
    for (const [name, active] of [["outside", outside], ["today", key === dateKey(new Date())], ["selected", key === selected], ["has-record", count > 0 || dates.has(key)], ["has-photo", Boolean(photo)]] as const) day.classList.toggle(name, active);
    if (key === dateKey(new Date())) day.setAttribute("aria-current", "date");
    const number = day.ownerDocument.createElement("span"); number.className = "calendar-day-number"; number.textContent = String(date.getDate()); day.appendChild(number);
    if (photo) {
      const image = day.ownerDocument.createElement("img");
      image.className = "echoink-calendar-photo"; image.alt = ""; image.loading = "lazy";
      image.addEventListener("error", () => { image.remove(); day.classList.remove("has-photo"); }, { once: true });
      image.src = photo; day.prepend(image);
    }
    if (options.onSelect) day.onclick = () => options.onSelect!(key);
  }
  const prefix = dateKey(first).slice(0, 7);
  return { recordDays: [...new Set([...(options.activity?.keys() ?? []), ...dates])].filter(date => date.startsWith(prefix)).length,
    photoDays: [...photos.keys()].filter(date => date.startsWith(prefix)).length };
}
