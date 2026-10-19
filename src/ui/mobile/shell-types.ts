/** Data and slots only. Each device owns its own page renderer and route stack. */
export interface MobileShellPage {
  id: string;
  title: string;
  subtitle?: string;
  content: HTMLElement;
  footer?: HTMLElement;
  actions?: HTMLElement;
  /** Workbench headings belong to the page content, not a second pane header. */
  header?: "standard" | "content";
  /** A saving form can refuse navigation without losing its DOM or draft. */
  canLeave?: () => boolean | Promise<boolean>;
  dispose?: () => void;
}

export interface MobileShellOptions {
  onError?: (error: unknown) => void;
  onRootBack?: () => void;
}

export interface MobileShellSheet {
  title: string;
  content: HTMLElement;
  footer?: HTMLElement;
  onClose?: () => void;
}

export interface MobileShellCategory {
  id: string;
  label: string;
  icon: string;
  /** May prepare a real page asynchronously; rejection must preserve the old page. */
  createPage: () => MobileShellPage | Promise<MobileShellPage>;
}
