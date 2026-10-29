import { installObsidianDom } from "./obsidian-dom";
import assert from "node:assert/strict";
import { TFile } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { DesktopNotifications, type DesktopNotificationMessage, type DesktopNotificationPermission, type DesktopNotificationResult } from "../plugin/desktop-notifications";
import { todoDueAt, todoReminderKey } from "../home/todo-due";
import { parseTodoMarkdown } from "../home/todo-markdown";
import { dueTodoReminders, normalizeTodoReminders, TodoReminderScheduler, type TodoReminderFailure } from "../home/todo-reminders";
import { TodoReminderService, type TodoDesktopNotifications } from "../home/todo-reminder-service";
import { EchoInkTodoStore, TODO_SOURCE_PATH } from "../home/todo-store";
import { normalizeSettingsData } from "../settings/settings";
import { JSDOM } from "jsdom";
import { renderTodoReminderSettings, todoReminderStatusText } from "../settings/todo-reminder-settings";
import { disposeOriginControls } from "../settings/origin-controls";

async function runReminderSettingsTests(): Promise<void> {
  const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
  installObsidianDom(dom.window);
  const names = ["window", "document", "Element", "Node", "Event", "CustomEvent", "MutationObserver", "DocumentFragment", "navigator", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame",
    ...Object.getOwnPropertyNames(dom.window).filter((name) => /^(HTML|SVG)\w*Element$/u.test(name))];
  const previous = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) {
    const value = (dom.window as unknown as Record<string, unknown>)[name];
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: typeof value === "function" && /^(getComputedStyle|requestAnimationFrame|cancelAnimationFrame)$/u.test(name) ? value.bind(dom.window) : value });
  }
  Object.assign(dom.window.HTMLElement.prototype, {
    createEl(this: HTMLElement, tag: string, options: { cls?: string; text?: string; attr?: Record<string, string> } = {}) {
      const child = this.ownerDocument.createElement(tag);
      if (options.cls) child.className = options.cls;
      if (options.text) child.textContent = options.text;
      for (const [name, value] of Object.entries(options.attr ?? {})) child.setAttribute(name, value);
      this.appendChild(child);
      return child;
    },
    createDiv(this: HTMLElement, options: unknown) { return this.createEl("div", options as never); },
    createSpan(this: HTMLElement, options: unknown) { return this.createEl("span", options as never); },
    setText(this: HTMLElement, text: string) { this.textContent = text; },
    addClass(this: HTMLElement, ...names: string[]) { this.classList.add(...names); }
  });
  const base = { enabled: false, permission: "default" as const, busy: false, error: "" as const };
  assert.match(todoReminderStatusText(base, false), /尚未授权/u);
  assert.match(todoReminderStatusText({ ...base, permission: "denied" }, false), /被拒绝/u);
  assert.match(todoReminderStatusText({ ...base, error: "persistence" }, true), /may repeat after restarting/u);
  const fixture = serviceFixture();
  fixture.notifications.current = "default";
  fixture.plugin.getTodoReminderService = () => fixture.service;
  const page = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(page);
  const dispose = renderTodoReminderSettings(page, fixture.plugin);
  const toggle = page.querySelector<HTMLButtonElement & { checked: boolean }>("[data-todo-reminder-toggle]")!;
  const button = page.querySelector<HTMLButtonElement>("[data-todo-reminder-test]")!;
  const status = page.querySelector<HTMLElement>("[data-todo-reminder-status]")!;
  try {
    assert.equal(toggle.getAttribute("role"), "switch");
    assert.equal(toggle.classList.contains("echoink-origin-control"), true);
    assert.equal(button.classList.contains("echoink-origin-control"), true);
    assert.equal(toggle.checked, false); assert.equal(button.disabled, false);
    assert.equal(fixture.notifications.requests, 0, "rendering never requests permission");
    fixture.notifications.current = "denied";
    toggle.click(); await tick();
    assert.equal(toggle.checked, false); assert.match(status.textContent!, /被拒绝/u);
    fixture.notifications.current = "granted";
    fixture.notifications.permissionGate = deferred<DesktopNotificationPermission>();
    button.click(); await tick();
    assert.equal(button.disabled, true); assert.equal(toggle.disabled, true);
    assert.equal(button.getAttribute("aria-busy"), "true");
    fixture.notifications.permissionGate.resolve("granted"); await tick();
    assert.equal(button.disabled, false); assert.equal(toggle.checked, false);
    assert.equal(fixture.notifications.messages.length, 1, "test works with reminders off");
    assert.deepEqual(fixture.plugin.settings.todoReminders.sent, {});
    dispose();
    const before = status.textContent;
    fixture.notifications.current = "denied";
    await fixture.service.setEnabled(true);
    assert.equal(status.textContent, before, "removed settings do not receive stale updates");
  } finally {
    dispose(); fixture.service.dispose(); fixture.store.dispose();
    disposeOriginControls(page);
    dom.window.close();
    for (const name of names) {
      const descriptor = previous.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
  console.log("To-do reminder settings: PASS (real Origin controls, permission feedback, busy state and disposal)");
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class Clock {
  now = new Date(2026, 9, 12, 9, 0).getTime();
  private sequence = 0;
  tasks = new Map<number, { at: number; callback: () => void }>();
  setTimeout = (callback: () => void, delay: number): number => {
    const id = ++this.sequence;
    this.tasks.set(id, { at: this.now + delay, callback });
    return id;
  };
  clearTimeout = (id: number): void => { this.tasks.delete(id); };
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      const next = [...this.tasks.entries()].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.now = next[1].at;
      this.tasks.delete(next[0]);
      next[1].callback();
      await tick();
    }
    this.now = end;
    await tick();
  }
}

class Events {
  readonly listeners = new Map<string, Set<() => void>>();
  addEventListener(name: string, listener: () => void): void {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(listener);
  }
  removeEventListener(name: string, listener: () => void): void { this.listeners.get(name)?.delete(listener); }
  dispatch(name: string): void { for (const listener of [...this.listeners.get(name) ?? []]) listener(); }
  get listenerCount(): number { return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0); }
}

class NotificationPort implements TodoDesktopNotifications {
  current: DesktopNotificationPermission = "granted";
  messages: DesktopNotificationMessage[] = [];
  requests = 0;
  cancellations = 0;
  result: DesktopNotificationResult = { ok: true };
  permissionGate: ReturnType<typeof deferred<DesktopNotificationPermission>> | null = null;
  sendGate: ReturnType<typeof deferred<DesktopNotificationResult>> | null = null;
  permission = () => this.current;
  async requestPermission(): Promise<DesktopNotificationPermission> {
    this.requests++;
    return this.permissionGate ? this.permissionGate.promise : this.current;
  }
  async send(message: DesktopNotificationMessage): Promise<DesktopNotificationResult> {
    this.messages.push(message);
    return this.sendGate ? this.sendGate.promise : this.result;
  }
  cancelPending(): void { this.cancellations++; this.sendGate?.resolve({ ok: false, cancelled: true }); }
  dispose(): void { this.cancelPending(); }
}

function task(id: string, date = "2026-10-12", time?: string, done = false): string {
  return `- [${done ? "x" : " "}] ${id} <!-- echoink-todo-id: ${id} -->\n${date ? `  - 截止日期：${date}\n` : ""}${time ? `  - 截止时间：${time}\n` : ""}`;
}

function schedulerFixture(content = task("due"), enabled = true) {
  const clock = new Clock();
  const notifications = new NotificationPort();
  const settings = normalizeTodoReminders({ enabled });
  let source = content;
  let persisted = structuredClone(settings);
  let reads = 0;
  let saves = 0;
  let readFails = false;
  let saveFails = false;
  let readGate: ReturnType<typeof deferred<void>> | null = null;
  const errors: TodoReminderFailure[] = [];
  const scheduler = new TodoReminderScheduler({
    settings: () => settings,
    readRecords: async () => {
      reads++;
      if (readGate) await readGate.promise;
      if (readFails) throw new Error("read failed");
      return parseTodoMarkdown(source).records;
    },
    persist: async () => {
      saves++;
      if (saveFails) throw new Error("save failed");
      persisted = structuredClone(settings);
    },
    notifications,
    english: () => false,
    report: (error) => errors.push(error),
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  });
  return { clock, notifications, settings, scheduler, errors,
    reads: () => reads, saves: () => saves, persisted: () => persisted,
    edit: (next: string) => { source = next; scheduler.sourceChanged(); },
    failRead: (fail: boolean) => { readFails = fail; }, failSave: (fail: boolean) => { saveFails = fail; },
    gateRead: () => { readGate = deferred<void>(); return readGate; }
  };
}

function serviceFixture(enabled = false) {
  const clock = new Clock();
  const win = Object.assign(new Events(), { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  const doc = Object.assign(new Events(), { defaultView: win, visibilityState: "visible" });
  const notifications = new NotificationPort();
  const events = new Map<string, ((file: TFile, oldPath?: string) => void)[]>();
  let content = task("handwritten").replace(/ <!--.*?-->/u, "");
  let exists = true;
  let saved: unknown;
  let saveFails = false;
  const saveArgs: unknown[][] = [];
  const file = new TFile(TODO_SOURCE_PATH);
  const vault = {
    on: (name: string, listener: (file: TFile) => void) => { events.set(name, [...events.get(name) ?? [], listener]); return {}; },
    getAbstractFileByPath: (name: string) => name === "EchoInk" ? {} : exists && name === TODO_SOURCE_PATH ? file : null,
    cachedRead: async () => content,
    read: async () => content,
    process: async (_file: TFile, transform: (latest: string) => string) => { content = transform(content); return content; }
  };
  const settings = normalizeSettingsData({ todoReminders: { enabled } }).settings;
  const plugin = {
    app: { vault, workspace: { containerEl: { ownerDocument: doc } } }, settings,
    registerEvent: () => undefined,
    saveSettings: async (...args: unknown[]) => {
      saveArgs.push(args);
      if (saveFails) throw new Error("save failed");
      saved = structuredClone(settings);
    }
  } as unknown as CodexForObsidianPlugin;
  const store = new EchoInkTodoStore(plugin);
  plugin.getTodoStore = () => store;
  const service = new TodoReminderService(plugin, notifications, () => clock.now);
  return { clock, win, doc, notifications, plugin, store, service, saveArgs,
    saved: () => saved, source: () => content,
    failSave: (fail: boolean) => { saveFails = fail; },
    edit: (next: string) => { content = next; for (const cb of events.get("modify") ?? []) cb(file); },
    remove: () => { exists = false; for (const cb of events.get("delete") ?? []) cb(file); }
  };
}

async function runDesktopNotificationTests(): Promise<void> {
  const clock = new Clock();
  class FakeNotification {
    static permission: NotificationPermission = "default";
    static requests = 0;
    static mode: "show" | "error" | "throw" | "timeout" = "show";
    static instances: FakeNotification[] = [];
    static async requestPermission(): Promise<NotificationPermission> { this.requests++; return this.permission = "granted"; }
    onshow: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    closed = false;
    constructor(_title: string, _options: unknown) {
      if (FakeNotification.mode === "throw") throw new Error("unsupported renderer");
      FakeNotification.instances.push(this);
      queueMicrotask(() => {
        if (FakeNotification.mode === "show") this.onshow?.();
        else if (FakeNotification.mode === "error") this.onerror?.();
      });
    }
    close(): void { this.closed = true; this.onclose?.(); }
  }
  const win = { Notification: FakeNotification, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout } as unknown as Window;
  const api = new DesktopNotifications(win, true);
  assert.equal(api.permission(), "default");
  assert.equal((await api.send({ title: "blocked", body: "" })).ok, false);
  assert.equal(FakeNotification.requests, 0, "sending never asks for permission");
  assert.equal(await api.requestPermission(), "granted");
  assert.equal(FakeNotification.requests, 1);
  assert.equal((await api.send({ title: "shown", body: "" })).ok, true);
  assert.equal(clock.tasks.size, 0);
  FakeNotification.mode = "error";
  assert.equal((await api.send({ title: "failed", body: "" })).error, "send");
  FakeNotification.mode = "throw";
  assert.equal((await api.send({ title: "thrown", body: "" })).error, "send");
  FakeNotification.mode = "timeout";
  const timeout = api.send({ title: "no acknowledgement", body: "" });
  await clock.advance(5000);
  assert.equal((await timeout).error, "unconfirmed");
  assert.equal(FakeNotification.instances.at(-1)?.closed, true);
  const pending = api.send({ title: "pending", body: "" });
  api.dispose();
  assert.equal((await pending).cancelled, true);
  assert.equal(clock.tasks.size, 0);
  assert.equal(FakeNotification.instances.at(-1)?.onshow, null);
  assert.equal(new DesktopNotifications(win, false).permission(), "unavailable");
  assert.equal(new DesktopNotifications(null, true).permission(), "unavailable");
}

export async function runTodoReminderTests(): Promise<void> {
  assert.equal(todoDueAt({ dueDate: "2026-10-12" }), new Date(2026, 9, 12, 9).getTime());
  assert.equal(todoDueAt({ dueDate: "2026-10-12", dueTime: "00:00" }), new Date(2026, 9, 12).getTime());
  for (const value of ["25:00", "10:60", "9:00", "bad"]) assert.equal(todoDueAt({ dueDate: "2026-10-12", dueTime: value }), null);
  for (const value of ["2026-02-30", "2026-13-01", "", "bad"]) assert.equal(todoDueAt({ dueDate: value }), null);
  assert.deepEqual(normalizeSettingsData({}).settings.todoReminders, { enabled: false, sent: {} });
  assert.deepEqual(normalizeTodoReminders({ enabled: "true", sent: { bad: 1, '__proto__': 1 } }), { enabled: false, sent: {} });
  const records = parseTodoMarkdown(task("a") + task("b", "2026-10-11") + task("future", "2026-10-12", "10:00") + task("done", "2026-10-12", "08:00", true) + task("no-date", "") + task("invalid", "2026-10-12", "25:00")).records;
  const now = new Clock().now;
  assert.deepEqual(dueTodoReminders(records, {}, now).map((r) => r.id), ["a", "b"]);
  assert.equal(dueTodoReminders([records[0], records[0]], {}, now).length, 1);
  assert.equal(dueTodoReminders(records, { [todoReminderKey(records[0])!]: 1 }, now).length, 1);

  const disabled = schedulerFixture(task("due"), false);
  disabled.scheduler.start(); await disabled.scheduler.checkNow();
  assert.equal(disabled.reads(), 0); assert.equal(disabled.clock.tasks.size, 0);

  const merged = schedulerFixture(task("a") + task("b", "2026-10-11") + task("future", "2026-10-12", "10:00"));
  merged.scheduler.start(); await merged.scheduler.checkNow();
  assert.equal(merged.notifications.messages.length, 1);
  assert.match(merged.notifications.messages[0].title, /2 条/);
  assert.equal(Object.keys(merged.persisted().sent).length, 2);
  merged.settings.sent = normalizeSettingsData({ todoReminders: merged.persisted() }).settings.todoReminders.sent;
  merged.scheduler.stop(); merged.scheduler.start(); await merged.scheduler.checkNow();
  assert.equal(merged.notifications.messages.length, 1, "restart preserves sent deadline keys");
  await merged.clock.advance(60 * 60 * 1000);
  assert.equal(merged.notifications.messages.length, 2, "future deadline fires at its local time");
  merged.edit(task("a", "2026-10-12", "09:30")); await merged.scheduler.checkNow();
  assert.equal(merged.notifications.messages.length, 3, "changed deadline gets a new reminder");
  merged.edit(task("a", "2026-10-12", "09:30", true)); await merged.scheduler.checkNow();
  merged.edit(""); await merged.scheduler.checkNow();
  assert.equal(merged.notifications.messages.length, 3);
  merged.scheduler.stop(); assert.equal(merged.clock.tasks.size, 0);

  const fresh = schedulerFixture();
  const gate = fresh.gateRead(); fresh.scheduler.start();
  const checking = fresh.scheduler.checkNow();
  fresh.edit(task("due", "2026-10-12", "08:00", true)); gate.resolve(); await checking;
  assert.equal(fresh.notifications.messages.length, 0, "completion before the fresh read resolves cannot notify");
  fresh.scheduler.stop();

  const cancellation = schedulerFixture();
  const cancelledRead = cancellation.gateRead(); cancellation.scheduler.start();
  const scan = cancellation.scheduler.checkNow(); cancellation.scheduler.stop(); cancelledRead.resolve(); await scan;
  assert.equal(cancellation.notifications.messages.length, 0);
  assert.equal(cancellation.clock.tasks.size, 0);

  const permission = schedulerFixture(); permission.notifications.current = "denied";
  permission.scheduler.start(); await permission.scheduler.checkNow();
  assert.equal(permission.reads(), 0); assert.equal(permission.notifications.requests, 0);
  permission.scheduler.stop();

  const failed = schedulerFixture(); failed.notifications.result = { ok: false, error: "send" };
  failed.scheduler.start(); await failed.scheduler.checkNow();
  assert.deepEqual(failed.settings.sent, {}); assert.equal(failed.saves(), 0); assert.equal(failed.errors.at(-1), "send");
  failed.notifications.result = { ok: true }; await failed.scheduler.checkNow();
  assert.equal(failed.saves(), 1); failed.scheduler.stop();

  const persistence = schedulerFixture(); persistence.failSave(true);
  persistence.scheduler.start(); await persistence.scheduler.checkNow(); await persistence.scheduler.checkNow();
  assert.equal(persistence.notifications.messages.length, 1, "sent-but-unsaved is not sent again in this session");
  assert.equal(persistence.errors.at(-1), "persistence");
  assert.equal(Object.keys(persistence.persisted().sent).length, 0);
  persistence.failSave(false); await persistence.scheduler.checkNow();
  assert.equal(Object.keys(persistence.persisted().sent).length, 1);
  assert.equal(persistence.notifications.messages.length, 1); persistence.scheduler.stop();

  const concurrent = schedulerFixture(); concurrent.notifications.sendGate = deferred<DesktopNotificationResult>();
  concurrent.scheduler.start(); const first = concurrent.scheduler.checkNow(); const second = concurrent.scheduler.checkNow();
  assert.equal(first, second); await tick(); assert.equal(concurrent.notifications.messages.length, 1);
  concurrent.notifications.sendGate.resolve({ ok: true }); await first; concurrent.scheduler.stop();

  const unreadable = schedulerFixture(); unreadable.failRead(true);
  unreadable.scheduler.start(); await unreadable.scheduler.checkNow();
  assert.equal(unreadable.errors.at(-1), "read"); assert.deepEqual(unreadable.settings.sent, {}); unreadable.scheduler.stop();

  const service = serviceFixture(); service.service.start();
  assert.equal(service.win.listenerCount, 0); assert.equal(service.clock.tasks.size, 0); assert.equal(service.source().includes("echoink-todo-id"), false);
  service.notifications.current = "denied";
  assert.equal((await service.service.setEnabled(true)).error, "denied");
  assert.equal(service.plugin.settings.todoReminders.enabled, false);
  service.notifications.current = "granted";
  assert.equal((await service.service.setEnabled(true)).ok, true); await service.clock.advance(0);
  assert.match(service.source(), /echoink-todo-id:/u, "reminders use the store's stable ID assignment");
  assert.equal(service.notifications.messages.length, 1);
  assert.equal(service.win.listenerCount, 2); assert.equal(service.doc.listenerCount, 1);
  assert.ok(service.saveArgs.every((args) => args[0] === true && (args[1] as { flushConversationStore: boolean }).flushConversationStore === false));
  service.remove(); service.win.dispatch("focus"); await service.clock.advance(0);
  assert.equal(service.notifications.messages.length, 1, "source deletion is re-read and filtered");
  const ledger = structuredClone(service.plugin.settings.todoReminders.sent);
  assert.equal((await service.service.testNotification()).ok, true);
  assert.deepEqual(service.plugin.settings.todoReminders.sent, ledger, "test notifications do not consume deadlines");
  await service.service.setEnabled(false);
  assert.equal(service.win.listenerCount, 0); assert.equal(service.doc.listenerCount, 0);
  service.service.dispose(); service.store.dispose(); assert.equal(service.clock.tasks.size, 0);

  const late = serviceFixture(); late.notifications.permissionGate = deferred<DesktopNotificationPermission>();
  const enabling = late.service.setEnabled(true); late.service.dispose();
  late.notifications.permissionGate.resolve("granted");
  assert.equal((await enabling).cancelled, true); assert.equal(late.plugin.settings.todoReminders.enabled, false);
  assert.equal(late.clock.tasks.size, 0);

  const saveError = serviceFixture(); saveError.failSave(true);
  assert.equal((await saveError.service.setEnabled(true)).error, "settings");
  assert.equal(saveError.plugin.settings.todoReminders.enabled, false); assert.equal(saveError.clock.tasks.size, 0); saveError.service.dispose();

  await runDesktopNotificationTests();
  await runReminderSettingsTests();
  console.log("To-do reminder behavior: PASS (local deadlines, merged catch-up, persistent dedupe, failures and lifecycle)");
}
