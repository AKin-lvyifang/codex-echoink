import assert from 'node:assert/strict';

// Geometry is supplied because jsdom cannot lay out the host. CSS cascade and
// real host transitions are separately exercised in the Obsidian simulation.
export async function viewportScenarios(api, window, test) {
  const { document } = window;
  const wait = () => new Promise(resolve => setTimeout(resolve, 45));
  const previousHit = document.elementFromPoint;
  const previousHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
  try {
    for (const Shell of [api.IPhoneShell, api.IPadShell]) {
      await test(`${Shell.name}: navbar attach, detach and host style changes update without a pane resize`, async () => {
        const root = document.createElement('main'); document.body.append(root);
        root.getBoundingClientRect = () => ({ top: 100, bottom: 844, left: 0, right: 390 });
        const shell = new Shell(root);
        const navbar = document.createElement('div'); navbar.className = 'mobile-navbar';
        let top = 760;
        navbar.getBoundingClientRect = () => ({ top, bottom: top + 52, left: 37, right: 353, width: 316, height: 52 });
        document.elementFromPoint = () => navbar;
        const inset = () => root.style.getPropertyValue('--em-bottom-compensation');
        try {
          assert.equal(inset(), '0px');
          document.body.append(navbar); await wait(); assert.equal(inset(), '92px');
          navbar.remove(); await wait(); assert.equal(inset(), '0px', 'detaching the bar releases its space');
          document.body.append(navbar); await wait(); assert.equal(inset(), '92px');
          navbar.style.display = 'none'; await wait(); assert.equal(inset(), '0px');
          navbar.style.display = ''; await wait(); assert.equal(inset(), '92px');
          document.body.classList.add('is-hidden-nav'); await wait();
          assert.equal(inset(), '92px', 'the hide class must not release space while the bar is still visibly sliding');
          navbar.style.opacity = '0'; await wait(); assert.equal(inset(), '0px');
          top = 820; navbar.style.opacity = '1'; document.body.classList.remove('is-hidden-nav'); await wait();
          assert.equal(inset(), '32px', 'returning bar uses its current visible edge');
          const transition = type => { const event = new window.Event(type, { bubbles: true }); Object.defineProperty(event, 'propertyName', { value: 'transform' }); navbar.dispatchEvent(event); };
          transition('transitionrun'); await wait(); top = 760; await wait();
          assert.equal(inset(), '92px', 'transition frames keep tracking even though pane bounds stay unchanged');
          transition('transitionend');
          // Same live pane, now outside the bar horizontally (native iPad right sidebar).
          root.getBoundingClientRect = () => ({ top: 100, bottom: 844, left: 700, right: 1024 });
          window.dispatchEvent(new window.Event('resize')); await wait(); assert.equal(inset(), '0px');
        } finally {
          shell.dispose(); navbar.remove(); document.body.classList.remove('is-hidden-nav');
          await wait(); assert.equal(inset(), '', 'disposing disconnects host mutation listeners'); root.remove();
        }
      });
    }
    await test('host keyboard boundary protects a fixed iPad drawer without shrinking an already-contained pane twice', async () => {
      const host = document.createElement('div'); host.className = 'app-container'; document.body.append(host);
      host.getBoundingClientRect = () => ({ bottom: 544 });
      const root = document.createElement('main'); document.body.append(root);
      let bottom = 844;
      root.getBoundingClientRect = () => ({ top: 100, bottom, left: 0, right: 390 });
      document.documentElement.style.setProperty('--keyboard-height', '300px');
      const shell = new api.IPadShell(root);
      try {
        assert.equal(root.style.getPropertyValue('--em-bottom-compensation'), '300px', 'fixed drawer can extend beyond the already-shrunk host');
        bottom = 544; window.dispatchEvent(new window.Event('resize')); await wait();
        assert.equal(root.style.getPropertyValue('--em-bottom-compensation'), '0px', 'pinned/central pane already fits the host boundary');
      } finally { shell.dispose(); root.remove(); host.remove(); document.documentElement.style.removeProperty('--keyboard-height'); }
    });
    await test('floating phone host spacing keeps safe area but releases hidden navbar and keyboard space', async () => {
      const root = document.createElement('main'); document.body.append(root);
      root.getBoundingClientRect = () => ({ top: 100, bottom: 844, left: 0, right: 390 });
      const previousStyle = window.getComputedStyle;
      // Host phone --view-bottom-spacing = safe area (34) + navbar (52).
      window.getComputedStyle = element => element.classList.contains('echoink-mobile-bottom-probe')
        ? { height: element.style.height === '0px' ? '0px' : element.style.height ? '34px' : '86px' }
        : previousStyle.call(window, element);
      document.body.classList.add('is-phone', 'is-floating-nav');
      const shell = new api.IPhoneShell(root);
      try {
        assert.equal(root.style.getPropertyValue('--em-bottom-compensation'), '34px', 'detached bar leaves only safe area');
        document.documentElement.style.setProperty('--keyboard-height', '300px');
        await wait(); assert.equal(root.style.getPropertyValue('--em-bottom-compensation'), '0px', 'host keyboard does not retain phone safe area a second time');
        document.documentElement.style.removeProperty('--keyboard-height');
        await wait(); assert.equal(root.style.getPropertyValue('--em-bottom-compensation'), '34px');
      } finally {
        shell.dispose(); root.remove(); window.getComputedStyle = previousStyle;
        document.documentElement.style.removeProperty('--keyboard-height');
        document.body.classList.remove('is-phone', 'is-floating-nav');
      }
    });
  } finally {
    document.elementFromPoint = previousHit;
    Object.defineProperty(window, 'innerHeight', previousHeight);
  }
}
