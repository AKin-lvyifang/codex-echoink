import assert from "node:assert/strict";
import { AccountService, MembershipApiError } from "../membership/account-service";
import { createMembershipTransport } from "../membership/transport";
import { WorkbenchCheckinService, workbenchCheckin, workbenchDate } from "../home/workbench-checkin";
import { WorkbenchWeatherStage } from "../home/workbench-weather";
import type { LocalAccountState } from "../membership/types";

const date = () => workbenchDate();
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function until(test: () => boolean) { for (let i = 0; i < 100 && !test(); i++) await new Promise(done => setTimeout(done, 5)); assert.ok(test(), "asynchronous check-in settled"); }
function fixture(authenticated = true) {
  let state: LocalAccountState = authenticated ? { token: "offline-token" } : {};
  const requests: { path: string; method: string; body: any; headers: Record<string, string> }[] = [];
  const server = { checkedIn: false, total: 3, already: false, error: "", status: 400, retryAfter: undefined as number | undefined,
    postGate: null as ReturnType<typeof gate<void>> | null, getGate: null as ReturnType<typeof gate<void>> | null, getError: false, malformed: false };
  const account = { id: "offline-account", email: "offline@example.invalid", name: "验收", joinedAt: "2026-01-01", avatar: null, passwordSet: true };
  const request = async (options: { url: string; method: string; body?: string; headers: Record<string, string> }) => {
    const url = new URL(options.url), path = url.pathname;
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ path: url.pathname + url.search, method: options.method, body, headers: options.headers });
    let json: unknown, status = 200;
    if (path === "/api/account") json = account;
    else if (path === "/api/membership") json = { state: "free", serverTime: Date.now(), capabilities: [] };
    else if (path === "/api/products") json = { products: [], salesOpen: false };
    else if (path === "/api/auth/login") json = { token: "next-offline-token" };
    else if (path === "/api/auth/logout") json = {};
    else if (path === "/api/check-ins" && options.method === "GET") {
      if (server.getError) throw Error("offline");
      json = { total: server.total, today: { date: url.searchParams.get("date"), checkedIn: server.checkedIn, source: server.checkedIn ? "manual" : null }, recent: server.checkedIn ? [date()] : [], serverTime: Date.now() };
      if (server.getGate) await server.getGate.promise;
    } else if (path === "/api/check-ins") {
      if (server.postGate) await server.postGate.promise;
      if (server.error === "NETWORK") throw Error("offline");
      if (server.error) { status = server.status; json = { error: server.error, retryAfter: server.retryAfter }; }
      else {
        const alreadyCheckedIn = server.already || server.checkedIn;
        server.checkedIn = true; if (!alreadyCheckedIn) server.total++;
        json = server.malformed ? { total: -1 } : { date: body.date, alreadyCheckedIn, source: "manual", checkedInAt: Date.now(), summary: { total: server.total, recent: [body.date], serverTime: Date.now() } };
      }
    } else throw Error("unexpected membership path " + path);
    return { status, headers: {}, json };
  };
  const service = new AccountService({ persistent: false, read: async () => state, write: async next => { state = next; }, identity: async () => { throw Error("check-in cannot require a device identity"); } },
    createMembershipTransport("http://127.0.0.1:8787", request as never), "http://127.0.0.1:8787", () => {}, "https://example.invalid", () => "unknown");
  const legacy = { signedDates: ["2026-10-01"], agentDates: ["2026-10-01"] };
  let saves = 0, logins = 0;
  const plugin = { accountService: service, settings: { settingsLanguage: "zh-CN", workbenchCheckin: legacy }, saveSettings: async () => { saves++; }, openEchoInkAccountSettings: async (target: string) => { assert.equal(target, "login"); logins++; } };
  return { service, plugin, server, requests, legacy, posts: () => requests.filter(r => r.path === "/api/check-ins" && r.method === "POST"), saves: () => saves, logins: () => logins };
}

export async function runWorkbenchCheckinTests(): Promise<void> {
  const f = fixture(); await f.service.initialize();
  assert.equal(f.service.read().membership.state, "free");
  let now = Date.now();
  const checkins = new WorkbenchCheckinService(f.plugin as never, () => now, () => "Asia/Shanghai");
  await checkins.refresh(); assert.equal(checkins.snapshot().checkedIn, false); assert.equal(checkins.snapshot().total, 3);
  const read = f.requests.find(r => r.path.startsWith("/api/check-ins?"))!;
  assert.equal(read.path, "/api/check-ins?date=" + date()); assert.equal(read.body, undefined);
  assert.equal(read.headers.Authorization, "Bearer offline-token"); assert.equal(read.headers["X-EchoInk-Client"], "plugin"); assert.equal(read.headers.Origin, undefined);
  f.server.postGate = gate<void>();
  const first = checkins.record(), second = checkins.record(); await until(() => f.posts().length === 1);
  assert.deepEqual(f.posts()[0].body, { date: date(), timezone: "Asia/Shanghai", source: "manual" });
  f.server.postGate.resolve(); assert.equal((await first).alreadyCheckedIn, false); await second;
  assert.equal(checkins.snapshot().total, 4); assert.equal(checkins.snapshot().checkedIn, true);
  assert.equal((await checkins.record()).alreadyCheckedIn, true); assert.equal(f.posts().length, 1);
  assert.equal(f.saves(), 0); assert.equal(f.plugin.settings.workbenchCheckin, f.legacy); assert.deepEqual(f.legacy, { signedDates: ["2026-10-01"], agentDates: ["2026-10-01"] });
  f.service.dispose();

  for (const [code, status] of [["NETWORK", 0], ["AUTH_REQUIRED", 401], ["CHECKIN_DATE_OUT_OF_RANGE", 400], ["ACCOUNT_DISABLED", 403], ["INVALID_INPUT", 400]] as const) {
    const f = fixture(); await f.service.initialize(); const c = workbenchCheckin(f.plugin as never); await c.refresh(); f.server.error = code; f.server.status = status;
    await assert.rejects(c.record(), error => code === "NETWORK" ? error instanceof Error : error instanceof MembershipApiError && error.code === code);
    assert.equal(c.snapshot().checkedIn, false); assert.equal(f.saves(), 0); f.service.dispose();
  }
  const limited = fixture(); await limited.service.initialize();
  const rate = new WorkbenchCheckinService(limited.plugin as never, () => now);
  limited.server.error = "RATE_LIMITED"; limited.server.status = 429; limited.server.retryAfter = 17;
  await assert.rejects(rate.record(), error => error instanceof MembershipApiError && error.retryAfter === 17);
  await assert.rejects(rate.record()); assert.equal(limited.posts().length, 1, "honor retryAfter without another POST");
  await rate.refresh(true); assert.equal(limited.posts().length, 1, "GET and POST quotas are independent");
  now += 18_000; limited.server.error = ""; await rate.record(); assert.equal(limited.posts().length, 2); limited.service.dispose();

  for (const [body, header, expected] of [[{}, "23", 23], [{ retryAfter: 7 }, "23", 7], [{ retryAfter: -1 }, "23", 23], [{ retryAfter: 0 }, "invalid", undefined]] as const) {
    const transport = createMembershipTransport("http://localhost", (async () => ({ status: 429, json: { error: "RATE_LIMITED", ...body }, headers: { "Retry-After": header } })) as never);
    await assert.rejects(transport("/api/check-ins", "POST", {}, "stub"), error => error instanceof MembershipApiError && error.retryAfter === expected);
  }
  const anonymous = fixture(false); await anonymous.service.initialize(); const anon = workbenchCheckin(anonymous.plugin as never); await anon.refresh();
  await assert.rejects(anon.record(), error => error instanceof MembershipApiError && error.code === "AUTH_REQUIRED"); assert.equal(anonymous.posts().length, 0); anonymous.service.dispose();

  for (const operation of ["GET", "POST"] as const) {
    const f = fixture(); await f.service.initialize(); const c = workbenchCheckin(f.plugin as never);
    const pending = gate<void>(); if (operation === "GET") f.server.getGate = pending; else f.server.postGate = pending;
    const flight = operation === "GET" ? c.refresh() : c.record();
    await until(() => f.requests.some(r => r.path.startsWith("/api/check-ins") && r.method === operation));
    await f.service.actions.signOut!(); pending.resolve(); await assert.rejects(flight, error => error instanceof MembershipApiError && error.code === "OPERATION_CANCELLED");
    assert.equal(c.snapshot().total, null); assert.equal(c.snapshot().checkedIn, false); f.service.dispose();
  }
  const racing = fixture(); await racing.service.initialize(); const c = workbenchCheckin(racing.plugin as never);
  racing.server.getGate = gate<void>(); const reading = c.refresh(); await until(() => racing.requests.some(r => r.path.startsWith("/api/check-ins?")));
  await c.record(); racing.server.getGate.resolve(); await reading; assert.equal(c.snapshot().checkedIn, true, "a late GET cannot undo POST success"); racing.service.dispose();
  const malformed = fixture(); await malformed.service.initialize(); malformed.server.malformed = true;
  await assert.rejects(workbenchCheckin(malformed.plugin as never).record(), error => error instanceof MembershipApiError && error.code === "CHECKIN_RESPONSE_INVALID"); malformed.service.dispose();

  for (const [error, expected, authenticated] of [["", "签到成功 · 第 4 天", true], ["NETWORK", "没联网，签不了", true], ["AUTH_REQUIRED", "登录后才能签到", false], ["RATE_LIMITED", "签得太快了，稍后再试", true], ["CHECKIN_DATE_OUT_OF_RANGE", "设备时间不对，签不了", true]] as const) {
    const f = fixture(authenticated); await f.service.initialize();
    const parent = document.body.createDiv(); const stage = new WorkbenchWeatherStage(parent, f.plugin as never, () => {}); stage.update("still", "一切安静");
    await workbenchCheckin(f.plugin as never).refresh(); f.server.error = error; f.server.status = error === "RATE_LIMITED" ? 429 : 400;
    const button = parent.querySelector<HTMLButtonElement>(".wb-weather-stage")!;
    const pointer = (type: string, y: number) => { const event = new Event(type); Object.assign(event, { button: 0, pointerId: 1, clientY: y }); button.dispatchEvent(event); };
    pointer("pointerdown", 0); pointer("pointermove", 9); pointer("pointerup", 9); assert.equal(f.posts().length, 0);
    f.server.postGate = gate<void>(); pointer("pointerdown", 0); pointer("pointermove", 10); pointer("pointerup", 10);
    assert.equal(button.getAttribute("aria-busy"), "true"); assert.equal(parent.querySelector('[data-layer="tag-text"]')?.textContent, "签到中");
    pointer("pointerdown", 0); pointer("pointermove", 20); pointer("pointerup", 20); button.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    if (authenticated) await until(() => f.posts().length === 1);
    f.server.postGate.resolve(); await until(() => parent.querySelector(".wb-checkin-message")?.textContent === expected);
    assert.equal(button.disabled, false); assert.equal(f.saves(), 0);
    if (!error) {
      button.click(); assert.equal(parent.querySelector(".wb-checkin-popover")?.textContent, "累计签到 4 天");
      assert.doesNotMatch(parent.textContent ?? "", /用 Agent|自动签到/u);
      await f.service.actions.signOut!(); assert.equal(parent.querySelector(".wb-checkin-popover"), null);
      assert.equal(parent.querySelector('[data-layer="tag-text"]')?.textContent, "签到");
    } else {
      assert.equal(parent.querySelector('[data-layer="tag-text"]')?.textContent, "签到", "failure never flips the tag");
      if (!authenticated) { parent.querySelector<HTMLButtonElement>(".wb-checkin-login")!.click(); await until(() => f.logins() === 1); }
    }
    stage.dispose(); parent.remove(); f.service.dispose();
  }
  const already = fixture(); await already.service.initialize(); already.server.already = true;
  const parent = document.body.createDiv(), stage = new WorkbenchWeatherStage(parent, already.plugin as never, () => {}); stage.update("still", "一切安静"); await workbenchCheckin(already.plugin as never).refresh();
  parent.querySelector(".wb-weather-stage")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" })); await until(() => workbenchCheckin(already.plugin as never).snapshot().checkedIn);
  assert.equal(parent.querySelector(".wb-checkin-message")?.textContent, "", "already-checked-in never celebrates"); assert.equal(parent.querySelector('[data-layer="tag-text"]')?.textContent, "3 天");
  stage.dispose(); parent.remove(); already.service.dispose();
  console.log("PASS server check-in: membership transport/token, manual-only data, server totals, exact pull threshold, dedup, errors, Retry-After, stale account responses, GET/POST race, no PRO/device requirement, no local persistence or auto check-in");
}
