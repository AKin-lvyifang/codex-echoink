import type { Capability, CapabilityAccess } from "../membership/types";
import type { ProPluginAccess } from "../membership/access";

type Control = HTMLButtonElement | HTMLInputElement;
interface WriteControlOptions {
  /** Component-owned pending and validation state; never read control.disabled. */
  readonly businessDisabled?: () => boolean;
  /** Stop/close controls may stop being write actions after an operation begins. */
  readonly needsWrite?: () => boolean;
  readonly capability?: Capability;
}

/** Small UI owner that combines current business state with current authorization. */
export class ProPluginControls {
  private readonly bindings = new Map<Control, WriteControlOptions>();
  private readonly unsubscribe: () => void;
  constructor(private readonly access: CapabilityAccess, private readonly readPolicy: () => ProPluginAccess) {
    this.unsubscribe = access.subscribe(() => this.refresh());
  }
  bind(control: Control, options: WriteControlOptions = {}): void {
    this.bindings.set(control, options);
    this.refresh();
  }
  refresh(): void {
    const policy = this.readPolicy();
    for (const [control, options] of this.bindings) {
      const needsWrite = options.needsWrite?.() ?? true;
      const denied = needsWrite && (!policy.canWrite || !!options.capability && !this.access.checkCapability(options.capability));
      const disabled = !!options.businessDisabled?.() || denied;
      if (control.disabled !== disabled) control.disabled = disabled;
      if (denied) control.setAttribute("title", policy.reason ?? "此操作需要有效 PRO 权限。");
      else control.removeAttribute("title");
    }
  }
  dispose(): void { this.unsubscribe(); this.bindings.clear(); }
}
