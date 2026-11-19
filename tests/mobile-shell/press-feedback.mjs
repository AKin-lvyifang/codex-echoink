import assert from 'node:assert/strict';

export async function pressFeedbackScenarios(api, window, test) {
  const { document } = window;
  const pointer = (element, type, x = 10, y = 10) => {
    const event = new window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
    Object.defineProperties(event, { pointerType: { value: 'touch' }, pointerId: { value: 1 }, isPrimary: { value: true } });
    element.dispatchEvent(event);
  };
  await test('mobile touch delegation: synchronous feedback, movement/scroll/cancel release, no synthetic activation', () => {
    const root = document.createElement('main'); root.className = 'echoink-iphone'; document.body.append(root);
    const button = document.createElement('button'); root.append(button); let clicks = 0; button.onclick = () => clicks++;
    button.getBoundingClientRect = () => ({ left: 0, top: 0, right: 100, bottom: 44 });
    const release = api.bindMobilePressFeedback(root);
    pointer(button, 'pointerdown'); assert.equal(button.dataset.mobilePressed, 'true');
    pointer(button, 'pointermove', 18); assert.equal(button.dataset.mobilePressed, undefined);
    pointer(button, 'pointermove', 10); assert.equal(button.dataset.mobilePressed, undefined, 'a drag cannot re-arm feedback');
    pointer(button, 'pointerdown'); pointer(button, 'pointercancel'); assert.equal(button.dataset.mobilePressed, undefined);
    pointer(button, 'pointerdown'); root.dispatchEvent(new window.Event('scroll')); assert.equal(button.dataset.mobilePressed, undefined);
    pointer(button, 'pointerdown'); pointer(button, 'pointerup'); assert.equal(button.dataset.mobilePressed, undefined); assert.equal(clicks, 0);
    button.disabled = true; pointer(button, 'pointerdown'); assert.equal(button.dataset.mobilePressed, undefined); button.disabled = false;
    pointer(button, 'pointerdown'); release(); assert.equal(button.dataset.mobilePressed, undefined);
    pointer(button, 'pointerdown'); assert.equal(button.dataset.mobilePressed, undefined, 'disposed listeners do not revive'); root.remove();
  });
  await test('text inputs use native caret/focus without dimming themselves or an enclosing action', () => {
    const root = document.createElement('main'); root.className = 'echoink-ipad';
    const row = document.createElement('div'); row.setAttribute('role', 'button'); root.append(row); document.body.append(root);
    const release = api.bindMobilePressFeedback(root);
    try { for (const tag of ['input', 'textarea']) {
      const field = document.createElement(tag); row.append(field); pointer(field, 'pointerdown');
      assert.equal(field.dataset.mobilePressed, undefined); assert.equal(row.dataset.mobilePressed, undefined);
      field.focus(); assert.equal(document.activeElement, field); pointer(field, 'pointerup');
    } } finally { release(); root.remove(); }
  });
  await test('mobile touch delegation: nested scope owns one press and desktop root is inert', () => {
    const parent = document.createElement('main'), child = document.createElement('section'), button = document.createElement('button');
    parent.className = 'echoink-ipad'; child.className = 'echoink-ipad'; parent.append(child); child.append(button); document.body.append(parent);
    button.getBoundingClientRect = () => ({ left: 0, top: 0, right: 100, bottom: 44 });
    const outer = api.bindMobilePressFeedback(parent), inner = api.bindMobilePressFeedback(child);
    pointer(button, 'pointerdown'); outer(); assert.equal(button.dataset.mobilePressed, 'true', 'parent never owns a nested press'); inner();
    parent.className = 'desktop'; child.className = ''; const noOp = api.bindMobilePressFeedback(parent); pointer(button, 'pointerdown'); assert.equal(button.dataset.mobilePressed, undefined); noOp(); parent.remove();
  });
}
