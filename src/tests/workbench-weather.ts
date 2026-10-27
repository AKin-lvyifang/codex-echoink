import assert from "node:assert/strict";
import { createMembershipTransport } from "../membership/transport";
import { MembershipApiError } from "../membership/account-service";
import { WorkbenchWeatherService, WEATHER_REFRESH_MS } from "../home/weather-service";
import { normalizeWeatherCity, weatherLayer, type CurrentWeather } from "../home/weather-types";
import { dollPose, dollStringEndpoint, workbenchAgentState } from "../home/workbench-doll-motion";
import { WorkbenchWeatherStage } from "../home/workbench-weather";
import { renderWeatherCitySettings } from "../settings/weather-city-settings";
import { DEFAULT_SETTINGS, normalizeSettingsData } from "../settings/settings";

const tick = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const city = { id: "cn-310100", name: "上海市" };
const suggestion = { ...city, admin1: "上海市", admin2: "上海市", country: "CN", countryName: "China" };
const current = (category = "rain", description = "小雨") => ({ city, category, description, temperature: 18.4, updatedAt: 1000, fetchedAt: 2000, stale: false, source: "met-norway" });

export async function runWorkbenchWeatherTests(): Promise<void> {
  assert.equal(normalizeSettingsData({ ...DEFAULT_SETTINGS, weatherCity: undefined }).settings.weatherCity, null);
  assert.deepEqual(normalizeSettingsData({ ...DEFAULT_SETTINGS, weatherCity: { ...city, latitude: 1, token: "discard" } }).settings.weatherCity, city);
  assert.equal(normalizeWeatherCity({ id: 310100, name: "上海" }), null);
  assert.deepEqual(normalizeWeatherCity(city), city);
  const expected = { clear: "fair", cloudy: "cloudy", rain: "drizzle", thunder: "thunder", snow: "snow", fog: "fog", wind: "breeze", other: "still" };
  for (const [category, layer] of Object.entries(expected)) assert.equal(weatherLayer(current(category, category === "cloudy" ? "多云" : "天气") as CurrentWeather), layer);
  assert.equal(weatherLayer(current("cloudy", "阴") as CurrentWeather), "overcast");
  assert.equal(weatherLayer({ category: "future" as never, description: "新类别" }), "still");

  let now = 1000, requests = 0;
  const service = new WorkbenchWeatherService({ now: () => now, transport: async (_endpoint, method, body, token) => {
    requests++; assert.equal(method, "GET"); assert.equal(body, undefined); assert.equal(token, undefined); return current();
  } });
  const a = service.current(city.id, true), b = service.current(city.id, true); assert.equal(a, b); await a;
  now += WEATHER_REFRESH_MS - 1; await service.current(city.id); assert.equal(requests, 1);
  now++; await service.current(city.id); assert.equal(requests, 2);
  const anonymous = createMembershipTransport("https://echoink.cn", async options => {
    assert.equal(options.headers?.Authorization, undefined); assert.equal(options.headers?.Cookie, undefined);
    assert.equal(options.headers?.["X-EchoInk-Client"], "plugin"); assert.match(options.url, /\/api\/weather\/current\?city=cn-310100$/u);
    return { status: 200, json: current(), headers: {}, text: "", arrayBuffer: new ArrayBuffer(0) };
  });
  await new WorkbenchWeatherService({ transport: anonymous }).current(city.id);
  assert.equal((await new WorkbenchWeatherService({ transport: async () => current("future") }).current(city.id)).category, "other");
  await assert.rejects(new WorkbenchWeatherService({ transport: async () => ({ ...current(), temperature: "18" }) }).current(city.id), error => error instanceof MembershipApiError && error.code === "WEATHER_RESPONSE_INVALID");
  let searches = 0;
  const limited = new WorkbenchWeatherService({ now: () => now, transport: async endpoint => {
    if (endpoint.includes("/cities")) { searches++; if (searches === 1) throw new MembershipApiError("RATE_LIMITED", 10); return { cities: [] }; }
    return current();
  } });
  await assert.rejects(limited.searchCities("上海")); now += 9000; await assert.rejects(limited.searchCities("北京")); assert.equal(searches, 1);
  await limited.current(city.id); now += 1000; await limited.searchCities("上海"); assert.equal(searches, 2);
  await assert.rejects(limited.searchCities("界".repeat(33)), error => error instanceof MembershipApiError && error.code === "INVALID_INPUT");

  const groups = { interrupted: [] as number[], waiting: [] as number[], running: [] as number[], completed: [] as number[] };
  assert.equal(workbenchAgentState(groups), "idle"); groups.completed.push(1); assert.equal(workbenchAgentState(groups), "done");
  groups.running.push(1); assert.equal(workbenchAgentState(groups), "working"); groups.waiting.push(1); assert.equal(workbenchAgentState(groups), "waiting");
  groups.interrupted.push(1); assert.equal(workbenchAgentState(groups), "unfinished");
  for (const state of ["working", "waiting", "unfinished", "done", "idle"] as const) for (let i = 0; i <= 240; i++) {
    const pose = dollPose(state, i / 10), end = dollStringEndpoint(pose);
    assert.ok(Number.isFinite(end.x) && Number.isFinite(end.y)); assert.ok(end.y > 8 && end.y < 32, "rope endpoint stays on the animated head below the rod");
  }
  assert.ok(dollPose("working", 1.2).angle !== 0); assert.ok(dollPose("working", 9.2).scaleX < 0);
  assert.ok(dollPose("working", 17.2).scaleX > 0); assert.equal(dollPose("waiting").face, "curious"); assert.equal(dollPose("done").face, "laugh");

  await stageStates(); await refreshAndCityRace(); await citySettings();
  console.log("PASS real weather: anonymous transport, all layers/future enum, city persistence, 30-minute memory cache, rate limits, visibility, state priority, independent faces/motion/rope, city search and save/clear");
}

async function refreshAndCityRace(): Promise<void> {
  const realNow = Date.now; let clock = 1000, requests = 0;
  Date.now = () => clock;
  const plugin = { settings: { settingsLanguage: "zh-CN", weatherCity: city }, async openWorkbenchSetup() {} };
  const service = new WorkbenchWeatherService({ now: () => clock, transport: async () => { requests++; return current(); } });
  const parent = document.body.createDiv(), stage = new WorkbenchWeatherStage(parent, plugin as never, () => {}, () => {}, service);
  const internal = stage as unknown as { refreshWeather(force?: boolean): Promise<void> };
  try {
    stage.update("idle", "一切安静"); await tick(); assert.equal(requests, 0, "a background restored stage must not request weather before activation");
    stage.setActive(true); await tick(); assert.equal(requests, 1);
    clock += WEATHER_REFRESH_MS - 1; await internal.refreshWeather(); assert.equal(requests, 1);
    clock++; await internal.refreshWeather(); assert.equal(requests, 2);
    stage.setActive(false); clock += WEATHER_REFRESH_MS; await internal.refreshWeather(); assert.equal(requests, 2);
    stage.setActive(true); await tick(); assert.equal(requests, 3, "visible pages refresh overdue weather once");
  } finally { stage.dispose(); parent.remove(); Date.now = realNow; }

  let release!: (data: unknown) => void;
  const held = new Promise<unknown>(resolve => { release = resolve; });
  const other = { id: "cn-330100", name: "杭州市" };
  const racePlugin = { settings: { settingsLanguage: "zh-CN", weatherCity: city }, async openWorkbenchSetup() {} };
  const race = new WorkbenchWeatherService({ transport: async endpoint => endpoint.endsWith(city.id) ? held : { ...current(), city: other } });
  const host = document.body.createDiv(), ui = new WorkbenchWeatherStage(host, racePlugin as never, () => {}, () => {}, race);
  try {
    ui.setActive(true);
    racePlugin.settings.weatherCity = other;
    await (ui as unknown as { refreshWeather(force?: boolean): Promise<void> }).refreshWeather(true);
    assert.match(host.textContent ?? "", /杭州市/u);
    release(current()); await tick(); assert.match(host.textContent ?? "", /杭州市/u); assert.doesNotMatch(host.textContent ?? "", /上海市/u);
  } finally { ui.dispose(); host.remove(); }
}

async function stageStates(): Promise<void> {
  let requests = 0, failed = false;
  let response = current();
  const plugin = { settings: { settingsLanguage: "zh-CN", weatherCity: null as typeof city | null }, async openWorkbenchSetup(target: string) { assert.equal(target, "weather"); }, async saveSettings() { throw Error("weather must not persist results"); } };
  const service = new WorkbenchWeatherService({ transport: async () => { requests++; if (failed) throw Error("offline"); return response; } });
  const parent = document.body.createDiv(); const jumps: string[] = [];
  const stage = new WorkbenchWeatherStage(parent, plugin as never, state => jumps.push(state), () => {}, service);
  const internals = stage as unknown as { refreshWeather(force?: boolean): Promise<void>; weatherTimer?: number };
  const layer = (name: string) => parent.querySelector<SVGElement>(`[data-layer="${name}"]`)!;
  try {
    stage.setActive(true);
    stage.update("working", "1 件在跑"); await tick(); assert.equal(requests, 0); assert.match(parent.textContent ?? "", /选个城市看天气/u);
    assert.equal(parent.querySelector('svg')?.dataset.weather, "still"); assert.equal(layer("face-happy").getAttribute("display"), "inline");
    parent.querySelector<HTMLButtonElement>(".wb-weather-count")!.click(); assert.deepEqual(jumps, ["working"]);
    plugin.settings.weatherCity = city; await internals.refreshWeather(true);
    assert.match(parent.textContent ?? "", /上海市 · 小雨 18°/u); assert.equal(layer("weather-drizzle").getAttribute("display"), "inline");
    for (const [category, description, expected] of [["clear", "晴", "fair"], ["cloudy", "多云", "cloudy"], ["cloudy", "阴", "overcast"], ["thunder", "雷雨", "thunder"], ["snow", "雪", "snow"], ["fog", "雾", "fog"], ["wind", "大风", "breeze"], ["other", "未知", "still"], ["future", "新类别", "still"]]) {
      response = current(category, description); await internals.refreshWeather(true);
      assert.equal(parent.querySelector('svg')?.dataset.weather, expected);
      assert.equal(layer("face-happy").getAttribute("display"), "inline");
    }
    response = current(); await internals.refreshWeather(true);
    stage.update("waiting", "1 件等你回应"); assert.equal(layer("face-curious").getAttribute("display"), "inline");
    assert.equal(layer("weather-drizzle").getAttribute("display"), "inline", "task state never changes real weather");
    assert.match(layer("head").getAttribute("transform") ?? "", /rotate\(12 /u);
    failed = true; await internals.refreshWeather(true); assert.match(parent.textContent ?? "", /拿不到天气/u);
    assert.equal(layer("weather-unknown").getAttribute("display"), "inline"); assert.equal(layer("face-curious").getAttribute("display"), "inline", "network failure never changes Agent expression");
    const navigator = parent.ownerDocument.defaultView!.navigator, descriptor = Object.getOwnPropertyDescriptor(navigator, "onLine");
    const animation = stage as unknown as { restart(): void }; const restart = animation.restart; let restarted = 0;
    animation.restart = () => { restarted++; restart.call(stage); };
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    try {
      stage.update("waiting", "1 件等你回应"); stage.update("waiting", "1 件等你回应");
      assert.equal(restarted, 0, "offline task refreshes must not repeatedly reset the Agent animation");
    } finally { animation.restart = restart; if (descriptor) Object.defineProperty(navigator, "onLine", descriptor); else Reflect.deleteProperty(navigator, "onLine"); }
    stage.setActive(false); assert.equal(internals.weatherTimer, undefined); const previous = requests; await internals.refreshWeather(true); assert.equal(requests, previous);
    failed = false; stage.setActive(true); await tick(); plugin.settings.weatherCity = null; stage.update("done", "今天做完 1 件"); await tick();
    assert.equal(parent.querySelector('svg')?.dataset.weather, "still"); assert.equal(layer("face-laugh").getAttribute("display"), "inline");
  } finally { stage.dispose(); parent.remove(); }
}

async function citySettings(): Promise<void> {
  const parent = document.body.createDiv({ cls: "echoink-settings-demo" }); let saves = 0, changes = 0, fail = false;
  const plugin = { settings: { settingsLanguage: "zh-CN", weatherCity: null as typeof city | null }, async saveSettings() { saves++; if (fail) throw Error("save failed"); }, notifyHomeSurfacesChanged() { changes++; } };
  const service = new WorkbenchWeatherService({ transport: async () => ({ cities: [suggestion] }) });
  const dispose = renderWeatherCitySettings(parent, plugin as never, service);
  const input = parent.querySelector<HTMLInputElement>("input")!;
  try {
    assert.ok(parent.textContent?.includes("MET Norway") && parent.textContent.includes("Wikidata") && parent.textContent.includes("GeoNames"), "attribution stays visible without a city or successful weather request");
    const search = async () => { input.value = "上海"; input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await tick(); };
    await search(); assert.equal(saves, 0); parent.querySelector<HTMLButtonElement>('[role="option"]')!.click(); await tick();
    assert.deepEqual(plugin.settings.weatherCity, city); assert.equal(saves, 1); assert.equal(changes, 1);
    parent.querySelector<HTMLButtonElement>('[aria-label="清除天气城市"]')!.click(); await tick(); assert.equal(plugin.settings.weatherCity, null); assert.equal(changes, 2);
    fail = true; await search(); parent.querySelector<HTMLButtonElement>('[role="option"]')!.click(); await tick();
    assert.equal(plugin.settings.weatherCity, null); assert.match(parent.textContent ?? "", /城市未保存/u); assert.equal(changes, 2);
  } finally { dispose(); parent.remove(); }
}
