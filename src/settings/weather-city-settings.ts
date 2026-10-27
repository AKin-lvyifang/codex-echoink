import type CodexForObsidianPlugin from "../main";
import { MembershipApiError } from "../membership/account-service";
import { workbenchWeather, type WorkbenchWeatherService } from "../home/weather-service";
import type { WeatherCity } from "../home/weather-types";
import { OriginSetting } from "./origin-setting";
import { applySettingsRow, createSettingsGroup, createSettingsSection } from "./settings-v2";
import { createOriginButton, createOriginInput, disposeOriginControls } from "./origin-controls";

let selectorId = 0;
export function renderWeatherCitySettings(parent: HTMLElement, plugin: CodexForObsidianPlugin, service: WorkbenchWeatherService = workbenchWeather(plugin)): () => void {
  const t = (zh: string, en: string) => plugin.settings.settingsLanguage === "en" ? en : zh;
  const section = createSettingsSection(parent, { title: t("天气", "Weather"), surface: "group" });
  section.setAttribute("data-weather-city-settings", "");
  const row = applySettingsRow(new OriginSetting(createSettingsGroup(section)).setName(t("天气城市", "Weather city")));
  const control = row.controlEl.createDiv({ cls: "echoink-weather-city-control" });
  const input = createOriginInput(control, { attr: { "aria-label": t("搜索天气城市", "Search weather cities"), placeholder: t("搜索城市", "Search for a city"), role: "combobox", "aria-autocomplete": "list", "aria-expanded": "false", autocomplete: "off" } });
  input.setAttribute("data-echoink-focus-key", "general:weather");
  const clear = createOriginButton(control, { text: t("清除", "Clear"), cls: "is-tertiary", attr: { "aria-label": t("清除天气城市", "Clear weather city") } });
  const results = section.createDiv({ cls: "echoink-weather-cities", attr: { role: "listbox", id: `echoink-weather-cities-${++selectorId}`, "aria-label": t("城市搜索结果", "City search results") } });
  input.setAttribute("aria-controls", results.id);
  const status = section.createDiv({ cls: "echoink-weather-city-status", attr: { role: "status", "aria-live": "polite" } });
  const sources = section.createDiv({ cls: "echoink-weather-sources" });
  const link = (parent: HTMLElement, text: string, href: string) => parent.createEl("a", { text, attr: { href, target: "_blank", rel: "noopener noreferrer" } });
  const weatherSource = sources.createDiv(); weatherSource.append(t("近时天气估计：", "Near-term weather estimate: "));
  link(weatherSource, "MET Norway", "https://api.met.no/"); weatherSource.append(" · "); link(weatherSource, "CC BY 4.0", "https://creativecommons.org/licenses/by/4.0/");
  const citySource = sources.createDiv(); citySource.append(t("城市：", "Cities: "));
  link(citySource, "Wikidata", "https://www.wikidata.org/"); citySource.append(" · "); link(citySource, "CC0 1.0", "https://creativecommons.org/publicdomain/zero/1.0/"); citySource.append(" / ");
  link(citySource, t("GeoNames（海外）", "GeoNames (outside mainland China)"), "https://www.geonames.org/"); citySource.append(" · "); link(citySource, "CC BY 4.0", "https://creativecommons.org/licenses/by/4.0/");
  sources.createDiv({ text: t("天气类别与中文描述、城市中文名与拼音由 EchoInk 整理", "Weather categories and descriptions, Chinese city names and pinyin adapted by EchoInk") });
  let generation = 0, timer: ReturnType<typeof setTimeout> | undefined, disposed = false, saving = false;
  const close = () => { generation++; if (timer !== undefined) clearTimeout(timer); timer = undefined; disposeOriginControls(results); results.replaceChildren(); input.setAttribute("aria-expanded", "false"); };
  const reset = () => { input.value = plugin.settings.weatherCity?.name ?? ""; clear.hidden = !plugin.settings.weatherCity; };
  reset();
  const choose = async (city: WeatherCity | null) => {
    if (saving || disposed) return; saving = true; generation++;
    input.disabled = clear.disabled = true; control.setAttribute("aria-busy", "true");
    const previous = plugin.settings.weatherCity; plugin.settings.weatherCity = city;
    try {
      await plugin.saveSettings(true);
      plugin.notifyHomeSurfacesChanged();
      if (!disposed) { close(); reset(); status.textContent = ""; }
    } catch {
      plugin.settings.weatherCity = previous;
      if (!disposed) status.textContent = t("城市未保存，请重试", "City was not saved. Try again");
    } finally { saving = false; if (!disposed) { input.disabled = clear.disabled = false; control.removeAttribute("aria-busy"); } }
  };
  const search = async () => {
    if (saving || disposed) return;
    if (timer !== undefined) clearTimeout(timer); timer = undefined;
    close(); const query = input.value.trim(), version = generation;
    if (!query) { status.textContent = ""; return; }
    if ([...query].length > 32) { status.textContent = t("城市名称最多 32 个字", "Use up to 32 characters"); return; }
    status.textContent = t("正在搜索…", "Searching…");
    try {
      const cities = await service.searchCities(query);
      if (disposed || generation !== version) return;
      status.textContent = cities.length ? "" : t("没有匹配的城市", "No matching cities");
      for (const city of cities) {
        const label = [city.name, ...Array.from(new Set([city.admin1, city.admin2, city.country === "CN" ? "" : city.countryName])).filter(value => value && value !== city.name)].join(" · ");
        const option = createOriginButton(results, { text: label, cls: "is-tertiary echoink-weather-city-option", attr: { role: "option", "aria-selected": String(plugin.settings.weatherCity?.id === city.id) } });
        option.onclick = () => { void choose({ id: city.id, name: city.name }); };
      }
      input.setAttribute("aria-expanded", String(cities.length > 0));
    } catch (error) {
      if (disposed || generation !== version) return;
      status.textContent = error instanceof MembershipApiError && error.code === "RATE_LIMITED" ? t("搜索太快了，请稍后再试", "Too many searches. Try again later") : t("暂时搜不到城市，请重试", "City search is unavailable. Try again");
    }
  };
  clear.onclick = () => { void choose(null); };
  input.oninput = () => { close(); if (timer !== undefined) clearTimeout(timer); timer = setTimeout(() => { void search(); }, 300); };
  const keyboard = (event: KeyboardEvent) => {
    const buttons = Array.from(results.querySelectorAll<HTMLButtonElement>("button"));
    if (event.key === "Escape") { event.preventDefault(); close(); reset(); status.textContent = ""; input.focus(); }
    else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!buttons.length) return; event.preventDefault(); const index = buttons.indexOf(parent.ownerDocument.activeElement as HTMLButtonElement);
      buttons[index < 0 ? event.key === "ArrowDown" ? 0 : buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length].focus();
    } else if (event.key === "Enter" && event.target === input) { event.preventDefault(); if (buttons.length) buttons[0].click(); else void search(); }
  };
  section.addEventListener("keydown", keyboard);
  return () => { disposed = true; generation++; if (timer !== undefined) clearTimeout(timer); section.removeEventListener("keydown", keyboard); disposeOriginControls(section); };
}
