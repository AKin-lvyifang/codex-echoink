import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { App } from "obsidian";
import { KnowledgeBaseCaptureService } from "../knowledge-base/capture";
import { emptyKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { registerKnowledgeFolderBindings } from "../knowledge-base/root-paths";
import { openTestModals, setRequestUrlForTests } from "./obsidian-shim";
import { confirmCaptureLinkForTest, waitForCaptureLinkModal } from "./knowledge-capture-link-helpers";

function checked(modal: { contentEl: HTMLElement }, kind: string): boolean {
  const control = modal.contentEl.querySelector<HTMLInputElement>(`[data-capture-link-kind="${kind}"]`)!;
  return control.getAttribute("aria-checked") === "true" || control.checked === true;
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail("Expected capture state did not arrive");
}

export async function runKnowledgeCaptureLinkTests(): Promise<void> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "echoink-capture-links-")));
  const bindings = emptyKnowledgeFolderBindings();
  Object.assign(bindings.roles.raw, { enabled: true, readPaths: ["网页", "公众号", "文档", "图片"], writePath: "网页" });
  Object.assign(bindings.roles.inbox, { enabled: true, readPaths: ["想法"], writePath: "想法" });
  bindings.collectionTargets = { web: "网页", wechat: "公众号", files: "文档", images: "图片" };
  for (const name of ["网页", "公众号", "文档", "图片", "想法"]) await fs.mkdir(path.join(root, name));
  const release = registerKnowledgeFolderBindings(root, () => bindings);
  const capture = new KnowledgeBaseCaptureService({ app: new App(), getVaultPath: () => root } as never);
  const requests: { url: string; wechat: boolean }[] = [];
  let failWeChat = false;
  let releaseFetch: (() => void) | undefined;
  let gate: Promise<void> | undefined;
  const restore = setRequestUrlForTests(async request => {
    assert.notEqual(typeof request, "string");
    const value = request as { url: string; headers?: Record<string, string> };
    const wechat = /MicroMessenger/u.test(value.headers?.["User-Agent"] ?? "");
    requests.push({ url: value.url, wechat });
    if (gate) await gate;
    if (failWeChat && wechat) throw new Error("公众号抓取失败，请修改类型后重试");
    return { status: 200, text: `<html><title>合成收藏${requests.length}</title><article><p>完整合成正文</p></article></html>`, headers: {}, json: {}, arrayBuffer: new ArrayBuffer(0) };
  });
  try {
    await assert.rejects(capture.captureChatInput("raw-articles", "只是想保存的一句话", []), /^Error: 收藏只支持网页和公众号链接$/u);
    assert.equal(requests.length, 0);
    for (const name of ["网页", "公众号", "文档", "图片", "想法"]) assert.deepEqual(await fs.readdir(path.join(root, name)), []);

    const empty = capture.captureLink();
    let modal = await waitForCaptureLinkModal();
    const input = modal.contentEl.querySelector<HTMLInputElement>("[data-capture-link-input]")!;
    assert.equal(input.value, ""); assert(checked(modal, "web"));
    input.value = "https://mp.weixin.qq.com/s/empty-paste";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    assert(checked(modal, "wechat"), "pasting a WeChat link automatically selects WeChat");
    assert.equal(requests.length, 0, "opening or pasting never fetches before confirmation");
    modal.close(); assert.deepEqual(await empty, []);

    for (const [url, automatic, selected, directory] of [
      ["https://example.invalid/web", "web", "web", "网页"],
      ["https://mp.weixin.qq.com/s/wechat", "wechat", "wechat", "公众号"],
      ["https://mp.weixin.qq.com/s/override-web", "wechat", "web", "网页"],
      ["https://example.invalid/override-wechat", "web", "wechat", "公众号"]
    ] as const) {
      const draft = `收藏 ${url} 保留链接外的说明文字`;
      const operation = capture.captureChatInput("raw-articles", draft, []);
      modal = await waitForCaptureLinkModal();
      assert.equal(modal.contentEl.querySelector<HTMLInputElement>("[data-capture-link-input]")!.value, draft);
      assert(checked(modal, automatic));
      const paths = await confirmCaptureLinkForTest(operation, selected);
      assert.equal(path.posix.dirname(paths[0]), directory);
      assert.equal(requests.at(-1)!.wechat, selected === "wechat", "fetch strategy follows the selection");
      const body = await fs.readFile(path.join(root, paths[0]), "utf8");
      assert.match(body, /完整合成正文/u);
      assert(body.includes(`source: ${selected === "wechat" ? "微信公众号" : "web"}`));
      if (selected === "web") assert(body.includes(draft), "web collection retains the draft's link description on the same article");
    }

    failWeChat = true;
    const retry = capture.captureChatInput("raw-articles", "https://mp.weixin.qq.com/s/retry", []);
    modal = await waitForCaptureLinkModal();
    const submit = modal.contentEl.querySelector<HTMLButtonElement>("[data-capture-link-submit]")!;
    const retryInput = modal.contentEl.querySelector<HTMLInputElement>("[data-capture-link-input]")!;
    submit.click();
    await until(() => !modal.contentEl.querySelector<HTMLElement>("[data-capture-link-error]")!.hidden);
    assert.match(modal.contentEl.textContent!, /公众号抓取失败/u);
    assert.equal(retryInput.value, "https://mp.weixin.qq.com/s/retry");
    assert(openTestModals.includes(modal)); assert.equal(submit.disabled, false);
    gate = new Promise(resolve => { releaseFetch = resolve; });
    modal.contentEl.querySelector<HTMLButtonElement>('[data-capture-link-kind="web"]')!.click();
    submit.click(); submit.click();
    await until(() => requests.at(-1)?.url.endsWith("/retry") === true && requests.at(-1)?.wechat === false);
    const count = requests.length;
    assert(submit.disabled); assert(retryInput.disabled);
    modal.close(); assert(openTestModals.includes(modal), "pending capture remains open");
    releaseFetch!();
    const retried = await retry;
    assert.equal(requests.length, count, "busy capture cannot be submitted twice");
    assert.equal(path.posix.dirname(retried[0]), "网页");
    gate = undefined;

    const beforeAttachments = requests.length;
    for (const [name, type, directory] of [["原文.md", "file", "文档"], ["原图.png", "image", "图片"]] as const) {
      const source = path.join(root, name); const bytes = Buffer.from(`original ${name}`); await fs.writeFile(source, bytes);
      const paths = await capture.captureChatInput("raw-articles", "附件边上的文字不生成收藏笔记", [{ name, type, path: source }]);
      assert.equal(paths.length, 1); assert.equal(path.posix.dirname(paths[0]), directory);
      assert.deepEqual(await fs.readFile(path.join(root, paths[0])), bytes);
    }
    assert.equal(requests.length, beforeAttachments);
    const idea = await capture.captureChatInput("inbox", "保留记录想法", []);
    assert.equal(path.posix.dirname(idea[0]), "想法");
    assert.match(await fs.readFile(path.join(root, idea[0]), "utf8"), /保留记录想法/u);
    console.log("PASS link capture: rejection, defaults, confirmation, selected routing, retained retry, busy guard, original attachments and inbox");
  } finally {
    restore(); release();
    for (const modal of [...openTestModals]) modal.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}
