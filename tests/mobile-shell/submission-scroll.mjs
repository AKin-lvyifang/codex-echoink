import assert from "node:assert/strict";

/** Real DOM adapter, with deterministic transcript geometry (no iOS claims). */
export function submissionScrollScenarios(api, window, resizeRow) {
  const originalFrame = window.requestAnimationFrame, originalCancel = window.cancelAnimationFrame;
  const originalNow = window.performance.now;
  let clock = 0, nextFrame = 0, passed = 0;
  const frames = new Map();
  window.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame; };
  window.cancelAnimationFrame = id => frames.delete(id);
  window.performance.now = () => clock;
  const advance = elapsed => { clock += elapsed; const batch = [...frames.values()]; frames.clear(); batch.forEach(callback => callback(clock)); };
  const settle = () => { advance(0); advance(100); advance(180); };
  const rect = (top, height) => ({ top, bottom: top + height, height, left: 0, right: 390, width: 390, x: 0, y: top });
  function fixture(name, { owner = "task-a", targetOwner = owner, userHeight = 100, historyHeight = 3000 } = {}) {
    const scroller = window.document.body.appendChild(window.document.createElement("div"));
    scroller.className = name; scroller.style.paddingBottom = "20px";
    const content = name === "em-messages" ? scroller : scroller.appendChild(window.document.createElement("div"));
    let viewport = 600, target, sequence = 0;
    const size = node => node.hasAttribute("data-composer-reading-spacer") || node.hasAttribute("data-composer-reading-leading") ? Number.parseFloat(node.style.height) || 0 : node._height ?? 0;
    const top = node => [...content.children].slice(0, [...content.children].indexOf(node)).reduce((sum, item) => sum + size(item), 0);
    Object.defineProperty(scroller, "clientHeight", { get: () => viewport });
    Object.defineProperty(scroller, "scrollHeight", { get: () => [...content.children].reduce((sum, node) => sum + size(node), 20) });
    scroller.getBoundingClientRect = () => rect(80, viewport);
    const row = (height, tag = "div") => {
      const node = content.appendChild(window.document.createElement(tag)); node._height = height;
      node.getBoundingClientRect = () => rect(80 + top(node) - scroller.scrollTop, size(node)); return node;
    };
    row(historyHeight);
    const pending = row(userHeight + 60, "section"); pending.dataset.composerTransfer = "turn-1";
    const user = pending.appendChild(window.document.createElement("article"));
    user.getBoundingClientRect = () => rect(pending.getBoundingClientRect().top, userHeight);
    const runtime = { composerScrollTarget: () => target, pauseComposerScroll: () => { target.paused = true; }, clearComposerScroll: () => { target = undefined; } };
    const scroll = new api.MobileSubmissionScroller(runtime, () => owner, () => content, () => scroller, window.document);
    return { runtime, scroller, content, scroll, row, pending, user, get target() { return target; },
      start() { target = { sequence: ++sequence, owner: targetOwner, taskId: "task-a", turnId: "turn-1", paused: false }; scroll.refresh(); },
      resize(height) { viewport = height; window.dispatchEvent(new window.Event("resize")); advance(0); },
      close() { scroll.dispose(); scroller.remove(); frames.clear(); } };
  }
  try {
    for (const name of ["eis-scroll", "echoink-ipad-content", "em-messages"]) {
      const f = fixture(name);
      try {
        f.scroller.scrollTop = 1100; f.start(); settle();
        assert.equal(f.user.getBoundingClientRect().top - 80, 150, `${name}: send from history lands at a quarter of the message viewport`);
        const unused = new api.MobileSubmissionScroller(f.runtime, () => "task-a", () => window.document.createElement("div"), () => null, window.document);
        unused.dispose(); assert.ok(f.target, `${name}: disposing an unused route factory must not clear the mounted page's target`);
        const landing = f.scroller.scrollTop;
        f.scroll.capture(); f.pending._height += 40; f.scroll.refresh(); advance(0);
        assert.equal(f.scroller.scrollTop, landing, `${name}: process growth consumes the same space`);
        f.scroll.capture(); f.pending.remove(); const formal = f.row(100, "article"); formal.dataset.submissionTurn = "turn-1";
        f.row(100); f.scroll.refresh(); advance(0);
        assert.equal(formal.getBoundingClientRect().top - 80, 150, `${name}: formal user entry replaces the temporary message without jumping`);
        assert.equal(frames.size, 0, `${name}: acceptance does not replay the animation`);
        f.scroll.capture(); f.content.querySelector("[data-composer-reading-spacer]").remove();
        f.scroller.scrollTop = Math.min(f.scroller.scrollTop, f.scroller.scrollHeight - f.scroller.clientHeight);
        f.scroll.refresh(); advance(0);
        assert.equal(formal.getBoundingClientRect().top - 80, 150, `${name}: an equal-height transcript rebuild restores browser-clamped scrolling`);
        f.content.firstElementChild._height += 160; resizeRow(f.content.firstElementChild); advance(0);
        assert.equal(formal.getBoundingClientRect().top - 80, 150, `${name}: delayed host Markdown layout preserves the same landing without a new viewport resize`);
        f.scroll.capture(); const answer = f.row(20); f.scroll.refresh(); advance(0);
        assert.equal(formal.getBoundingClientRect().top - 80, 150, `${name}: first token does not move the user again`);
        f.scroll.capture(); answer._height = 800; f.scroll.refresh(); advance(0);
        assert.equal(f.scroller.scrollTop, f.scroller.scrollHeight - f.scroller.clientHeight, `${name}: a growing answer follows normally`);
        f.resize(360);
        assert.equal(f.scroller.scrollTop, f.scroller.scrollHeight - 360, `${name}: active following survives a smaller keyboard viewport`);
        f.scroller.dispatchEvent(new window.WheelEvent("wheel", { deltaY: -30 }));
        f.scroller.scrollTop = 1200; f.scroll.capture(); answer._height += 100; f.scroll.refresh(); advance(0);
        assert.equal(f.scroller.scrollTop, 1200, `${name}: upward reader input pauses following`);
        f.resize(600); assert.equal(f.scroller.scrollTop, 1200, `${name}: hiding the keyboard cannot resume a paused reader`);
        f.start(); settle(); assert.equal(f.target.paused, false, `${name}: a retry starts a fresh follow request`);
        f.scroll.leave(); assert.equal(f.target, undefined); assert.equal(f.content.querySelector("[data-composer-reading-spacer]"), null);
        passed++;
      } finally { f.close(); }
    }
    const controlled = fixture("eis-scroll");
    try {
      let nativeTop = 0, writes = 0;
      Object.defineProperty(controlled.scroller, "scrollTop", { get: () => nativeTop, set: value => { writes++; nativeTop = value; } });
      controlled.start(); settle();
      const answer = controlled.row(900); answer.dataset.messageRole = "assistant"; controlled.scroll.refresh(); advance(0);
      // A delayed event for our last actual position must not pause a growing answer.
      controlled.scroller.dispatchEvent(new window.Event("scroll")); answer._height += 100;
      writes = 0; controlled.scroll.refresh(); controlled.scroll.refresh(); resizeRow(answer); advance(0);
      assert.equal(writes, 1, "runtime/resize/native scroll coalesce into one target write");
      assert.equal(controlled.target.paused, false);
      const touch = (name, y) => { const event = new window.Event(name); Object.defineProperty(event, "touches", { value: [{ clientY: y }] }); controlled.scroller.dispatchEvent(event); };
      touch("touchstart", 200); touch("touchmove", 230); nativeTop = 1200; writes = 0;
      answer._height += 100; controlled.scroll.refresh(); advance(0); assert.equal(writes, 0, "held finger never restores a captured top");
      touch("touchend", 230); advance(0); nativeTop = 1100; controlled.scroller.dispatchEvent(new window.Event("scroll"));
      answer._height += 100; controlled.scroll.refresh(); advance(0); assert.equal(writes, 0, "post-release reader/inertia never receives a program scroll");
      nativeTop = controlled.scroller.scrollHeight - controlled.scroller.clientHeight - 20;
      controlled.scroller.dispatchEvent(new window.Event("scroll")); advance(0);
      nativeTop = controlled.scroller.scrollHeight - 700; controlled.resize(700);
      controlled.scroller.dispatchEvent(new window.Event("scroll")); advance(0);
      answer._height += 100; controlled.scroll.refresh(); advance(0);
      assert.equal(writes, 0, "viewport clamping at bottom is not a reader return and cannot resume following");
      controlled.resize(600);
      nativeTop = controlled.scroller.scrollHeight - controlled.scroller.clientHeight;
      controlled.scroller.dispatchEvent(new window.Event("scroll")); advance(0);
      answer._height += 100; controlled.scroll.refresh(); advance(0);
      assert.equal(writes, 1, "a real return to bottom resumes following despite the persisted pause receipt");
      assert.equal(nativeTop, controlled.scroller.scrollHeight - controlled.scroller.clientHeight); passed++;
    } finally { controlled.close(); }
    const long = fixture("eis-scroll", { userHeight: 1600 });
    try {
      long.start(); settle(); assert.equal(long.user.getBoundingClientRect().top - 80, 150, "a long user message keeps its beginning visible");
      long.scroll.capture(); long.pending._height += 40; long.scroll.refresh(); advance(0);
      assert.equal(long.user.getBoundingClientRect().top - 80, 150, "process growth cannot skip a long submitted question");
      long.scroll.capture(); long.pending.remove(); const formal = long.row(1600, "article"); formal.dataset.submissionTurn = "turn-1";
      long.row(100); long.scroll.refresh(); advance(0);
      assert.equal(formal.getBoundingClientRect().top - 80, 150, "acceptance keeps a long question's beginning");
      const output = long.row(20); output.dataset.messageRole = "assistant"; long.scroll.refresh(); advance(0);
      assert.equal(formal.getBoundingClientRect().top - 80, 150, "first output keeps a long question's beginning");
      output._height = 80; long.scroll.refresh(); advance(0);
      assert.equal(long.scroller.scrollTop, long.scroller.scrollHeight - long.scroller.clientHeight, "subsequent answer growth resumes normal following"); passed++;
    } finally { long.close(); }
    const handoff = fixture("echoink-ipad-content", { targetOwner: "agent:sol", historyHeight: 0 });
    try { handoff.start(); advance(0); assert.equal(handoff.user.getBoundingClientRect().top - 80, 150); assert.equal(frames.size, 0, "list-to-detail handoff positions once before paint without a second animation"); passed++; } finally { handoff.close(); }
    const interrupted = fixture("eis-scroll");
    try {
      interrupted.start(); advance(0); advance(60);
      const touch = (name, y) => { const event = new window.Event(name); Object.defineProperty(event, "touches", { value: [{ clientY: y }] }); interrupted.scroller.dispatchEvent(event); };
      touch("touchstart", 200); touch("touchmove", 230);
      assert.equal(frames.size, 0, "upward finger movement cancels an in-flight send animation");
      assert.equal(interrupted.target.paused, true); passed++;
    } finally { interrupted.close(); }
    console.log(`Mobile submission scroll: ${passed} geometry scenarios passed (simulated).`);
  } finally { window.requestAnimationFrame = originalFrame; window.cancelAnimationFrame = originalCancel; window.performance.now = originalNow; }
}
