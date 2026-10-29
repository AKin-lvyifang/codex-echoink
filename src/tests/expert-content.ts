import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { ExpertContentService } from "../experts/service";
import { MAX_EXPERT_PACKAGE_BYTES, parseExpertCatalog, parseExpertDelivery, parseExpertPackage } from "../experts/contracts";
import { selectExpertSkills } from "../experts/prompt";
import { createExpertAccountFixture, expertFixtureBody, expertFixtureFiles, fixtureExpertId } from "./expert-delivery-fixture";
import { JSDOM } from "jsdom";
import { installObsidianDom } from "./obsidian-dom";
import { renderExpertHall, type ExpertHallOptions } from "../experts/hall";
import { ExpertHallView } from "../experts/view";
import type { AgentDefinition } from "../agents/types";

export async function runExpertContentTests(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "echoink-expert-content-"));
  const accounts: Awaited<ReturnType<typeof createExpertAccountFixture>>[] = [];
  const account = async (options?: Parameters<typeof createExpertAccountFixture>[0]) => { const fixture = await createExpertAccountFixture(options); accounts.push(fixture); return fixture; };
  let passed = 0;
  const test = async (name: string, run: () => void | Promise<void>) => { await run(); ++passed; console.log(`OK expert content: ${name}`); };
  try {
    await test("catalog accepts new dynamic IDs and only public fields", () => {
      const { schema: _schema, persona: _persona, skills: _skills, avatar: _avatar, licenses: _licenses, ...meta } = expertFixtureBody();
      const catalog = parseExpertCatalog({ catalogVersion: "new", experts: [{ ...meta, id: "another-new-expert" }] }, "https://fixture.invalid");
      assert.equal(catalog.experts[0].id, "another-new-expert");
      assert.equal("persona" in catalog.experts[0], false);
    });
    await test("optional public detail fields preserve content and tolerate absent or empty older metadata", () => {
      const body = expertFixtureBody(), examples = ["公开问题一", "公开问题二", "公开问题三"];
      const full = parseExpertCatalog({ catalogVersion: "new", experts: [{ ...body, description: "公开用途说明", story: "公开人物故事", examples }] }, "https://fixture.invalid").experts[0];
      assert.equal(full.description, "公开用途说明"); assert.equal(full.story, "公开人物故事"); assert.deepEqual(full.examples, examples);
      for (const optional of [{}, { description: "", story: "  ", examples: [] }, { description: null, story: null, examples: ["", " "] }]) {
        const old = parseExpertCatalog({ catalogVersion: "old", experts: [{ ...body, ...optional }] }, "https://fixture.invalid").experts[0];
        assert.equal(old.description, undefined); assert.equal(old.story, undefined); assert.equal(old.examples, undefined);
      }
    });
    await test("hash uses original UTF-8 bytes and envelope includes escaping and avatar overhead", () => {
      const content = JSON.stringify(expertFixtureBody());
      const delivery = { id: fixtureExpertId, version: "fixture-1", content, sha256: createHash("sha256").update(content, "utf8").digest("hex"), issuedAt: Date.now(), maxOfflineSeconds: 604800 };
      assert.equal(parseExpertDelivery(delivery, fixtureExpertId).version, "fixture-1");
      assert.throws(() => parseExpertDelivery({ ...delivery, content: content.replace(/,/u, ", ") }, fixtureExpertId), /校验/u);
      assert.throws(() => parseExpertDelivery({ ...delivery, content: "😀".repeat(Math.floor(MAX_EXPERT_PACKAGE_BYTES / 3)) }, fixtureExpertId), /大小/u);
      const body = expertFixtureBody(); body.persona = "😀".repeat(4000);
      const valid = { ...delivery, content: JSON.stringify(body) };
      assert.equal(Array.from(parseExpertPackage(valid, "https://fixture.invalid").persona).length, 4000);
      body.persona += "😀";
      assert.throws(() => parseExpertPackage({ ...valid, content: JSON.stringify(body) }, "https://fixture.invalid"), /内容无效/u);
      assert.throws(() => parseExpertPackage({ ...valid, content: "PRIVATE SECRET MALFORMED JSON" }, "https://fixture.invalid"), error => error instanceof Error && !error.message.includes("PRIVATE"));
    });
    const free = await account({ pro: false });
    const make = (f: typeof free, name = "paid", platform: "desktop" | "ios" | "android" = "desktop") => new ExpertContentService({
      files: expertFixtureFiles(path.join(root, name)), cacheRoot: ".custom/plugins/echoink/expert-cache", account: () => f.service,
      pluginVersion: "2.8.8", platform, now: f.now });
    await test("free can browse without credentials and cannot request or reuse private packages", async () => {
      const service = make(free, "free"); assert.equal((await service.publicCatalog()).experts.length, 1);
      await assert.rejects(service.resolve(fixtureExpertId), /PRO/u);
      assert.equal(free.calls.some(call => call.path.endsWith("/package")), false);
    });
    const f = await account(); let service = make(f);
    const initial = await service.resolve(fixtureExpertId), issuedAt = f.now();
    await test("resolved handle serializes only public data and injects only relevant preconfigured skills", () => {
      const serialized = JSON.stringify(initial);
      assert.doesNotMatch(serialized, /PRIVATE|SYNTHETIC LICENSE/u);
      const plain = initial.buildTransientPrompt({ text: "你好" });
      assert.match(plain, /PRIVATE PERSONA/u); assert.doesNotMatch(plain, /PRIVATE PLAN|PRIVATE REVIEW|PRIVATE BUDGET/u);
      const selected = initial.buildTransientPrompt({ text: "请帮我拟定项目计划" });
      assert.match(selected, /PRIVATE PLAN/u); assert.doesNotMatch(selected, /PRIVATE REVIEW|PRIVATE BUDGET/u);
      assert.ok(selectExpertSkills(expertFixtureBody().skills, { text: "项目计划、审稿和预算" }).length <= 2);
      assert.equal(initial.licenseTexts()[0].text, "SYNTHETIC LICENSE FULL TEXT");
      assert.equal(initial.avatar.kind, "custom");
    });
    await test("private cache contains JSON only and notModified never renews issue time", async () => {
      f.at(issuedAt + 86400000); await f.service.refresh(true);
      const same = await service.resolve(fixtureExpertId); assert.equal(same.revision, initial.revision);
      const files = await readdir(path.join(root, "paid"), { recursive: true });
      assert.equal(files.some(file => file.endsWith(".md")), false);
      const pointer = files.find(file => file.endsWith("current.json"))!;
      const raw = JSON.parse(await readFile(path.join(root, "paid", pointer), "utf8"));
      assert.equal(raw.issuedAt, issuedAt);
      assert.equal((f.calls.filter(call => call.path.endsWith("/package")).at(-1)!.body as { knownVersion: string }).knownVersion, "fixture-1");
      f.offline(true); service = make(f); (await service.resolve(fixtureExpertId)).assertAvailable();
      assert.equal(service.deliveryState(fixtureExpertId)?.kind, "offline"); f.offline(false);
    });
    await test("expired caches request full body and reject forged notModified even with a renewed lease", async () => {
      f.at(issuedAt + 6 * 86400000); await f.service.refresh(true);
      f.at(issuedAt + 7 * 86400000 + 1);
      assert.throws(() => initial.assertAvailable(), /到期/u);
      f.offline(true); await assert.rejects(make(f).resolve(fixtureExpertId)); f.offline(false);
      f.notModified(true); await assert.rejects(service.resolve(fixtureExpertId), /完整包/u); f.notModified(false);
      await service.resolve(fixtureExpertId);
      assert.equal("knownVersion" in (f.calls.filter(call => call.path.endsWith("/package")).at(-1)!.body as object), false);
    });
    await test("bad new checksum leaves the previous valid immutable package untouched", async () => {
      const before = await service.resolve(fixtureExpertId);
      f.version("fixture-2"); f.corrupt(true); await assert.rejects(service.resolve(fixtureExpertId), /校验/u);
      before.assertAvailable(); f.corrupt(false);
      const updated = await service.resolve(fixtureExpertId); assert.notEqual(updated.revision, before.revision);
      assert.match(before.buildTransientPrompt({ text: "你好" }), /fixture-1/u);
      assert.match(updated.buildTransientPrompt({ text: "你好" }), /fixture-2/u);
    });
    await test("all platforms resolve through the same account/device request contract", async () => {
      for (const platform of ["desktop", "ios", "android"] as const) {
        await make(f, `platform-${platform}`, platform).resolve(fixtureExpertId);
        assert.equal((f.calls.filter(call => call.path.endsWith("/package")).at(-1)!.body as { platform: string }).platform, platform);
      }
    });
    await test("online device refusal invalidates live handles and never falls back to valid cache", async () => {
      const before = await service.resolve(fixtureExpertId); f.refusal("DEVICE_REVOKED");
      await assert.rejects(service.resolve(fixtureExpertId)); assert.equal(f.service.skillAuthorization(), null);
      assert.throws(() => before.assertAvailable()); f.refusal(null); await f.service.refresh(true);
      assert.throws(() => before.assertAvailable(), "renewed session cannot revive an old handle");
    });
    await test("account switch during download cancels before publishing any cache pointer", async () => {
      const switched = await account(), resolver = make(switched, "switch");
      let release!: () => void, entered!: () => void;
      const blocked = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
      switched.block(async () => { entered(); await blocked; });
      const pending = resolver.resolve(fixtureExpertId), rejected = assert.rejects(pending);
      await started; await switched.service.actions.signIn!({ email: "B@example.test", method: "password", credential: "synthetic" });
      release(); await rejected;
      const files = await readdir(path.join(root, "switch"), { recursive: true }); assert.equal(files.some(file => file.endsWith("current.json")), false);
    });
    await test("another signed-in account cannot read an earlier account's cached package offline", async () => {
      await service.resolve(fixtureExpertId);
      await f.service.actions.signIn!({ email: "B@example.test", method: "password", credential: "synthetic" });
      f.offline(true); await assert.rejects(make(f).resolve(fixtureExpertId)); f.offline(false);
    });
    await test("a shorter signed device lease stops an otherwise fresh seven-day cache", async () => {
      const short = await account({ leaseDurationMs: 86400000 }), resolver = make(short, "short-lease");
      const selected = await resolver.resolve(fixtureExpertId), expires = short.service.skillAuthorization()!.validUntil;
      short.at(expires + 1); short.offline(true);
      assert.throws(() => selected.assertAvailable()); await assert.rejects(resolver.resolve(fixtureExpertId));
    });
    console.log(`Expert content: ${passed} scenarios passed.`);
  } finally { accounts.forEach(f => f.service.dispose()); await rm(root, { recursive: true, force: true }); }
}

function expertUiFixture() {
  const dom = new JSDOM("<!doctype html><main></main>"); installObsidianDom(dom.window);
  const document = dom.window.document, container = document.querySelector("main")!;
  const body = expertFixtureBody();
  let catalog = parseExpertCatalog({ catalogVersion: "public-details", experts: [{ ...body,
    description: "这是一段公开的用途说明。", story: "这是两句公开的故事。它与人格正文分开供给。", examples: ["公开问题一？", "公开问题二？", "公开问题三？"] }] }, "https://fixture.invalid");
  let pro = true, compatible = true, catalogFailure = false, privateRequests = 0, hireCalls = 0, dismissCalls = 0, upgradeCalls = 0;
  const hired = new Set<string>(), viewChanges: (string | undefined)[] = [];
  let hire: (id: string) => Promise<void> = async id => { hired.add(id); };
  const service = {
    async publicCatalog() { if (catalogFailure) throw new Error("公开目录暂时不可用"); return structuredClone(catalog); },
    async resolve() { privateRequests++; throw new Error("Browsing must never request a private package"); },
    hasRemoteAccess: () => pro, compatible: () => compatible, subscribe: () => () => {},
  } as unknown as ExpertContentService;
  const options: ExpertHallOptions = { document, service, getHiredIds: () => hired,
    onHire: async expert => { hireCalls++; await hire(expert.id); },
    onDismiss: async expert => { dismissCalls++; hired.delete(expert.id); },
    onUpgrade: async () => { upgradeCalls++; }, onViewChange: id => viewChanges.push(id) };
  const controls = () => [...container.querySelectorAll<HTMLButtonElement>(".echoink-expert-actions button")];
  return { dom, document, container, catalog: () => catalog, service, options, hired, viewChanges, controls,
    privateRequests: () => privateRequests, hireCalls: () => hireCalls, dismissCalls: () => dismissCalls, upgradeCalls: () => upgradeCalls,
    pro(value: boolean) { pro = value; }, compatible(value: boolean) { compatible = value; }, failCatalog(value: boolean) { catalogFailure = value; },
    setCatalog(value: typeof catalog) { catalog = value; }, setHire(value: typeof hire) { hire = value; } };
}
const uiTick = () => new Promise<void>(resolve => setImmediate(resolve));
export async function runExpertHallTests(): Promise<void> {
  let passed = 0;
  const test = async (name: string, run: () => Promise<void>) => { await run(); ++passed; console.log(`OK expert hall: ${name}`); };
  await test("cards retain quotes, expose one action and navigate to catalog-only detail in the requested order", async () => {
    const f = expertUiFixture(), hall = renderExpertHall(f.container, f.options); await hall.refresh();
    try {
      assert.equal(f.controls().length, 1); assert.equal(f.controls()[0].textContent, "聘请");
      assert.equal(f.container.querySelector(".echoink-expert-quote")?.textContent, `“${f.catalog().experts[0].quote}”`);
      const link = f.container.querySelector<HTMLAnchorElement>(".echoink-expert-card-link")!;
      assert.equal(link.tagName, "A"); assert.equal(link.tabIndex, 0); assert.ok(link.getAttribute("href"));
      f.container.querySelector<HTMLElement>(".echoink-expert-card")!.click(); await uiTick();
      const detail = f.container.querySelector<HTMLElement>(".echoink-expert-detail")!;
      assert.deepEqual([...detail.children].map(node => node.className), ["echoink-expert-card-top", "echoink-expert-detail-summary", "echoink-expert-tags",
        "echoink-expert-detail-description", "echoink-expert-detail-story", "echoink-expert-example-section", "echoink-expert-actions"]);
      assert.equal(detail.querySelectorAll("button").length, 1); assert.equal(detail.querySelectorAll(".echoink-expert-example").length, 3);
      assert.ok(detail.querySelector(".echoink-expert-actions button")!.classList.contains("is-primary"));
      assert.equal(detail.querySelector(".echoink-expert-detail-section-title")!.textContent, "你可以这样问他");
      assert.doesNotMatch(f.container.textContent!, /关于|去聊聊|版权|许可|MIT|PRIVATE/u); assert.equal(f.privateRequests(), 0);
      assert.equal(f.document.activeElement?.textContent, "返回专家");
    } finally { hall.dispose(); f.dom.window.close(); }
  });
  await test("the sole action never navigates, prevents duplicate submissions and recovers after a failed hire", async () => {
    const f = expertUiFixture(), hall = renderExpertHall(f.container, f.options); await hall.refresh();
    let reject!: (error: Error) => void;
    f.setHire(async () => await new Promise<void>((_resolve, fail) => { reject = fail; }));
    try {
      const control = f.controls()[0]; control.click(); control.click(); await uiTick();
      assert.equal(f.hireCalls(), 1); assert.equal(f.container.querySelector(".echoink-expert-detail"), null);
      assert.equal(f.controls()[0].textContent, "聘请"); assert.equal(f.controls()[0].disabled, true); assert.equal(f.controls()[0].getAttribute("aria-busy"), "true");
      reject(new Error("下载失败，请重试。")); await uiTick();
      assert.equal(f.controls()[0].disabled, false); assert.match(f.container.querySelector('[role="alert"]')!.textContent!, /下载失败/u);
      f.setHire(async id => { f.hired.add(id); }); f.controls()[0].click(); await uiTick();
      assert.equal(f.controls()[0].textContent, "解聘"); assert.equal(f.controls().length, 1); assert.equal(f.viewChanges.length, 0);
      f.controls()[0].click(); await uiTick(); assert.equal(f.dismissCalls(), 1); assert.equal(f.controls()[0].textContent, "聘请");
    } finally { hall.dispose(); f.dom.window.close(); }
  });
  await test("refresh preserves the selected detail, back restores card focus and old catalogs omit empty blocks", async () => {
    const f = expertUiFixture(), hall = renderExpertHall(f.container, f.options); await hall.refresh();
    try {
      await hall.showDetail(fixtureExpertId); await hall.refresh(true);
      assert.equal(f.container.querySelector<HTMLElement>(".echoink-expert-detail")!.dataset.expertId, fixtureExpertId);
      f.container.querySelector<HTMLButtonElement>(".echoink-expert-back")!.click(); await uiTick();
      assert.equal(f.viewChanges.at(-1), undefined); assert.equal(f.document.activeElement?.className, "echoink-expert-card-link");
      const { description: _description, story: _story, examples: _examples, ...old } = f.catalog().experts[0];
      f.setCatalog({ catalogVersion: "old", experts: [old] }); await hall.refresh(true); await hall.showAbout(fixtureExpertId);
      assert.equal(f.container.querySelector(".echoink-expert-detail-description"), null); assert.equal(f.container.querySelector(".echoink-expert-detail-story"), null);
      assert.equal(f.container.querySelector(".echoink-expert-examples"), null); assert.equal(f.privateRequests(), 0);
    } finally { hall.dispose(); f.dom.window.close(); }
  });
  await test("free and incompatible clients keep one accurate action and can browse without a package", async () => {
    const f = expertUiFixture(); f.pro(false); const hall = renderExpertHall(f.container, f.options); await hall.refresh();
    try {
      assert.equal(f.controls()[0].textContent, "开通 PRO"); f.controls()[0].click(); await uiTick(); assert.equal(f.upgradeCalls(), 1);
      assert.equal(f.container.querySelector(".echoink-expert-detail"), null); await hall.showDetail(fixtureExpertId);
      assert.equal(f.controls().length, 1); assert.equal(f.controls()[0].textContent, "开通 PRO"); assert.equal(f.privateRequests(), 0);
      f.pro(true); f.compatible(false); await hall.refresh();
      assert.equal(f.controls()[0].textContent, "聘请"); assert.equal(f.controls()[0].disabled, true); assert.match(f.controls()[0].title, /版本或设备/u);
      assert.equal(f.privateRequests(), 0);
    } finally { hall.dispose(); f.dom.window.close(); }
  });
  await test("catalog failures retry in the same detail route and late refreshes cannot discard the route", async () => {
    const f = expertUiFixture(); f.failCatalog(true); const hall = renderExpertHall(f.container, { ...f.options, initialExpertId: fixtureExpertId });
    try {
      await hall.refresh(); assert.match(f.container.querySelector('[role="alert"]')!.textContent!, /公开目录/u);
      f.failCatalog(false); [...f.container.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === "重试")!.click(); await uiTick();
      assert.equal(f.container.querySelector<HTMLElement>(".echoink-expert-detail")!.dataset.expertId, fixtureExpertId); assert.equal(f.privateRequests(), 0);
    } finally { hall.dispose(); f.dom.window.close(); }
  });
  await test("ItemView restores legacy routes, saves the new detail state and preserves it through refresh", async () => {
    const f = expertUiFixture(), saved: unknown[] = [];
    const view = new ExpertHallView({ contentEl: f.container } as never, { content: f.service, getAgents: () => [] as AgentDefinition[],
      hire: async () => {}, dismiss: async () => {}, open: async () => {}, upgrade: async () => {} });
    (view.app as unknown as { workspace: unknown }).workspace = { requestSaveLayout: () => saved.push(view.getState()) };
    try {
      await view.setState({ aboutId: fixtureExpertId }, {} as never); await view.onOpen();
      assert.deepEqual(view.getState(), { expertId: fixtureExpertId }); assert.ok(f.container.querySelector(".echoink-expert-detail"));
      await view.refresh(true); assert.ok(f.container.querySelector(".echoink-expert-detail"));
      f.container.querySelector<HTMLButtonElement>(".echoink-expert-back")!.click(); await uiTick();
      assert.deepEqual(view.getState(), {}); assert.deepEqual(saved.at(-1), {});
      f.container.querySelector<HTMLAnchorElement>(".echoink-expert-card-link")!.click(); await uiTick();
      assert.deepEqual(saved.at(-1), { expertId: fixtureExpertId }); assert.equal(f.privateRequests(), 0);
    } finally { await view.onClose(); f.dom.window.close(); }
  });
  console.log(`Expert hall: ${passed} scenarios passed.`);
}
