const testGlobal = globalThis as unknown as { window?: Window };
if (!testGlobal.window) {
  testGlobal.window = globalThis as unknown as Window;
}

export class Notice {
  constructor(public readonly message: string, public readonly timeout?: number) {}
}

export class TFile {
  constructor(public readonly path = "") {}
}

export class App {}

export class Component {
  registerDomEvent(): void {}
  registerEvent(): void {}
}

export class WorkspaceLeaf {
  view: unknown = null;
  async setViewState(): Promise<void> {}
  async openFile(): Promise<void> {}
}

export class ItemView extends Component {
  containerEl = {
    children: [
      { empty: () => undefined },
      { empty: () => undefined }
    ]
  } as any;
  app = new App() as any;
  constructor(public readonly leaf: WorkspaceLeaf) {
    super();
  }
  getViewType(): string { return "test-view"; }
  getDisplayText(): string { return "Test View"; }
  async onOpen(): Promise<void> {}
  async onClose(): Promise<void> {}
}

export class MarkdownView extends ItemView {}

export class Menu {
  addItem(callback: (item: any) => void): this {
    callback({
      setTitle: () => ({
        setIcon: () => ({
          setChecked: () => ({
            onClick: () => undefined
          }),
          onClick: () => undefined
        }),
        setIsLabel: () => undefined,
        onClick: () => undefined
      })
    });
    return this;
  }
  showAtMouseEvent(): void {}
}

export class Modal {
  contentEl = document.createElement("div");
  constructor(public readonly app: App) {}
  open(): void {}
  close(): void {}
  onOpen(): void {}
  onClose(): void {}
}

export class Setting {
  constructor(public readonly containerEl: HTMLElement) {}
  setName(): this { return this; }
  setDesc(): this { return this; }
  addText(callback: (component: { setPlaceholder: (value: string) => any; setValue: (value: string) => any; onChange: (handler: (value: string) => any) => any }) => any): this {
    callback({
      setPlaceholder: () => this,
      setValue: () => this,
      onChange: () => this
    });
    return this;
  }
  addButton(callback: (component: { setButtonText: (value: string) => any; setCta: () => any; onClick: (handler: () => any) => any }) => any): this {
    callback({
      setButtonText: () => this,
      setCta: () => this,
      onClick: () => this
    });
    return this;
  }
}

export function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/");
}

export const Platform = {
  isDesktopApp: false
};

export function setIcon(_element: Element, _icon: string): void {}

export async function requestUrl(): Promise<{ text: string }> {
  throw new Error("requestUrl is not available in unit tests");
}
