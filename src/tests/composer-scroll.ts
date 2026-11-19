import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { CodexMessageListRenderer } from "../ui/codex-view/message-list";
import { MessageScrollFollowController } from "../ui/codex-view/message-scroll-follow";
import { installObsidianDom } from "./obsidian-dom";

/** Long transcript geometry, using the production tail layout and follow controller. */
export function runComposerScrollTests(): void {
  const dom = new JSDOM("<!doctype html><body><div id='messages'><div id='rows'></div></div></body>", { pretendToBeVisual: true });
  installObsidianDom(dom.window);
  try {
    const scheduled: (() => void)[] = [], passes: string[] = [];
    const scheduler = new MessageScrollFollowController();
    scheduler.recordAutomaticScroll(0, 31);
    scheduler.handleScroll(false, 31);
    assert.equal(scheduler.paused, false, "new content below an automatic scroll does not masquerade as the reader scrolling away");
    scheduler.handleScroll(false, 20);
    assert.equal(scheduler.paused, true, "a different scroll position still gives the reader control");
    scheduler.handleScroll(true, 31);
    assert.equal(scheduler.paused, false, "the reader can resume following at the bottom");
    scheduler.handleWheel({ deltaY: -1 });
    scheduler.handleScroll(false, 31);
    assert.equal(scheduler.paused, true, "an automatic scroll event cannot undo an upward wheel gesture");
    scheduler.reset();
    const frame = (callback: () => void) => scheduled.push(callback);
    scheduler.scheduleMeasure(true, frame, () => passes.push("measure"));
    scheduler.scheduleRender({}, frame, () => passes.push("render"));
    assert.equal(scheduled.length, 1, "content and viewport changes share one animation frame");
    scheduled.shift()!();
    assert.deepEqual(passes, ["render"], "a full render already measures its rows; no second layout pass follows it");
    scheduler.scheduleMeasure(false, frame, () => passes.push("incremental-measure"));
    scheduled.shift()!();
    assert.deepEqual(passes, ["render"], "incremental writes get one browser content frame before geometry is read");
    scheduler.scheduleMeasure(false, frame, () => passes.push("incremental-measure"));
    assert.equal(scheduled.length, 1, "increments merge into the pending measure rather than adding layout passes");
    scheduled.shift()!();
    assert.deepEqual(passes, ["render", "incremental-measure"], "an incremental patch still receives one layout pass");
    (dom.window.HTMLElement.prototype as any).setCssStyles = function(styles: Record<string, string>) { Object.assign(this.style, styles); };
    const messages = dom.window.document.getElementById("messages")!;
    const rows = dom.window.document.getElementById("rows")!;
    const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 600, width: 600, x: 0, y: top, toJSON() {} });
    Object.defineProperty(messages, "clientHeight", { value: 800 });
    messages.getBoundingClientRect = () => rect(0, 800);
    rows.getBoundingClientRect = () => rect(-messages.scrollTop, Number.parseFloat(rows.style.height) || 4000);
    let frameId = 0;
    const frames = new Map<number, FrameRequestCallback>();
    dom.window.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; };
    dom.window.cancelAnimationFrame = id => { frames.delete(id); };
    Object.defineProperty(messages, "scrollHeight", { get: () => [...messages.children].reduce((sum, child) => sum + (child === rows
      ? Number.parseFloat(rows.style.height) || 4000 : child.hasAttribute("data-composer-reading-spacer") ? Number.parseFloat((child as HTMLElement).style.height) || 0 : 100), 0) });
    const renderer: any = new CodexMessageListRenderer();
    renderer.env = { messagesEl: messages, virtualListEl: rows, messages: [] };
    renderer.currentRows = [{ id: "message:old", kind: "message", message: { role: "user" } },
      { id: "assistantTurn:old", kind: "assistantTurn", turn: { finalAnswer: { text: "上一轮回答" } } }];
    renderer.virtualRowHeights.set("message:old", 100);
    renderer.virtualRowHeights.set("assistantTurn:old", 3900);
    renderer.answerReadingTail = { rowId: "assistantTurn:old", height: 60 };
    renderer.refreshComposerLayout();
    const previousHeight = Number.parseFloat(rows.style.height);
    assert.ok(previousHeight > 4300, "completed answer initially has its reading whitespace");

    const pending = messages.appendChild(dom.window.document.createElement("section"));
    pending.dataset.composerTransfer = "send-1"; pending.dataset.messageTail = "true";
    const article = pending.appendChild(dom.window.document.createElement("article"));
    pending.getBoundingClientRect = () => rect(Number.parseFloat(rows.style.height) - messages.scrollTop, 100);
    article.getBoundingClientRect = pending.getBoundingClientRect;
    renderer.followComposerSubmission("send-1");
    assert.ok(Number.parseFloat(rows.style.height) < previousHeight - 300, "sending removes the previous answer spacer before its pending bubble");
    assert.equal(rows.classList.contains("has-composer-tail"), true);

    const follow = new MessageScrollFollowController(); follow.paused = true;
    messages.scrollTop = 1600;
    follow.followLatest(messages, options => {
      renderer.refreshComposerLayout();
      if (options.forceBottom) messages.scrollTop = messages.scrollHeight - messages.clientHeight;
    });
    assert.equal(follow.paused, false, "send resumes latest-follow after reading older history");
    follow.handleScroll(false);
    assert.equal(follow.paused, false, "programmatic animation is not a user scroll interruption");
    const started = dom.window.performance.now();
    for (const elapsed of [80, 180, 300]) {
      const batch = [...frames.values()]; frames.clear(); batch.forEach(callback => callback(started + elapsed));
    }
    const topBeforeAcceptance = article.getBoundingClientRect().top;
    assert.ok(Math.abs(topBeforeAcceptance - 200) <= 1, "new message lands a quarter viewport from the top even from mid-history");

    const formalId = "pi:fixture:leaf:branch:entry-1:message-1";
    renderer.env.messages = [{ id: formalId, role: "user", runId: "new-run" }];
    renderer.currentRows.push({ id: `message:${formalId}`, kind: "message", message: renderer.env.messages[0] });
    renderer.virtualRowHeights.set(`message:${formalId}`, 100);
    renderer.acceptComposerSubmission("send-1", { turnId: "new-run", userEntryId: "entry-1" });
    pending.remove(); renderer.refreshComposerLayout();
    messages.scrollTop = messages.scrollHeight - messages.clientHeight;
    const formalTop = renderer.rowTopForRowId(`message:${formalId}`) - messages.scrollTop;
    assert.ok(Math.abs(formalTop - topBeforeAcceptance) <= 24, "acceptance keeps the same reading position within ordinary transcript padding");
    const formalScrollTop = messages.scrollTop;
    renderer.refreshComposerLayout();
    assert.equal(messages.scrollHeight - messages.clientHeight, formalScrollTop, "repeated preparation layout never replays a jump");
    renderer.currentRows.push({ id: "assistantTurn:new", kind: "assistantTurn", turn: {
      runId: "new-run", status: "running", finalAnswer: { text: "首字" }
    } });
    renderer.virtualRowHeights.set("assistantTurn:new", 80);
    renderer.refreshComposerLayout();
    assert.equal(messages.scrollHeight - messages.clientHeight, formalScrollTop, "first output consumes the same landing whitespace instead of jumping again");
    renderer.currentRows.at(-1).turn.status = "completed";
    renderer.env.isTurnRunning = () => true;
    renderer.refreshComposerLayout();
    assert.equal(messages.scrollHeight - messages.clientHeight, formalScrollTop, "a terminal Entry arriving before runtime settlement cannot replay the landing");
    renderer.env.isTurnRunning = () => false;
    renderer.refreshComposerLayout();
    assert.equal(renderer.followingComposerSubmission, false, "completed answer returns to the existing answer-reading layout");

    follow.followLatest(messages, () => undefined);
    follow.handleWheel({ deltaY: -30 });
    assert.equal(follow.animating, false, "user scrolling cancels the send animation");
    assert.equal(follow.paused, true);
    renderer.resetVirtualWindow();
    assert.equal(messages.querySelector("[data-composer-reading-spacer]"), null, "switching tasks clears the display-only landing spacer");
  } finally { dom.window.close(); }
}
