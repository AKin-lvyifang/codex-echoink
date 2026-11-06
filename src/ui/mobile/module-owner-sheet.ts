import { AGENT_MODULE_NAMES, GENERAL_ASSISTANT_ID, type AgentModuleId, type AgentDefinition } from "../../agents/types";
import { isAgentHired } from "../../agents/persona";
import type { MobileAgentRegistryService } from "../../mobile/agent-registry-service";
import { shellElement as el } from "./shell-controls";
import type { MobileShellSheet } from "./shell-types";

interface ModuleOwnerSheetHost {
  document: Document;
  prefix: "ip" | "pd";
  agents: MobileAgentRegistryService;
  roster: readonly AgentDefinition[];
  shell: { openSheet(sheet: MobileShellSheet): void; closeSheet(): boolean };
  avatar(agent: AgentDefinition): HTMLElement;
  button(text: string, click: () => void, variant?: string): HTMLButtonElement;
  create(): Promise<void>;
  start(): Promise<void>;
  error(failure: unknown): void;
}

/** Selection saves through the same versioned Registry writer as mobile Settings. */
export function openModuleOwnerSheet(host: ModuleOwnerSheetHost, module: AgentModuleId): void {
  const { document, prefix } = host, content = el(document, "div", `${prefix}-module-owner-list`), list = el(document, "fieldset", `${prefix}-module-owner-options`);
  const title = `${AGENT_MODULE_NAMES[module][0]}还没有负责人`, error = el(document, "div", `${prefix}-error`);
  error.setAttribute("role", "alert"); list.setAttribute("role", "radiogroup"); list.setAttribute("aria-label", title); content.append(list, error);
  let selected = "", busy = false, closed = false;
  const footer = el(document, "div", `${prefix}-module-owner-actions`);
  const create = host.button("新建 Agent", () => { if (busy) return; host.shell.closeSheet(); void host.create().catch(failure => host.error(failure)); }, "is-text");
  const start = host.button("交给 Ta", () => {
    if (!selected || busy) return; busy = true; list.disabled = create.disabled = start.disabled = true; error.textContent = "";
    void (async () => {
      try {
        const snapshot = await host.agents.snapshot();
        await host.agents.setOwner(module, selected, snapshot.version);
        if (closed) return;
        await host.start();
        host.shell.closeSheet();
      } catch (failure) {
        if (!closed) { error.textContent = failure instanceof Error ? failure.message : String(failure); busy = false; list.disabled = create.disabled = false; start.disabled = !selected; }
        else host.error(failure);
      }
    })();
  }, "is-primary"); start.disabled = true; footer.append(create, start);
  for (const agent of host.roster.filter(a => a.id !== GENERAL_ASSISTANT_ID && isAgentHired(a))) {
    const row = el(document, "label", `${prefix}-module-owner-option`), radio = el(document, "input", ""); radio.type = "radio"; radio.name = `${prefix}-owner-${module}`; radio.value = agent.id; radio.setAttribute("aria-label", agent.name);
    const copy = el(document, "span", `${prefix}-grow`); copy.append(el(document, "span", "", agent.name));
    if (agent.position) copy.append(el(document, "span", `${prefix}-sub`, agent.position)); row.append(host.avatar(agent), copy, radio); list.append(row);
    radio.addEventListener("change", () => { if (!radio.checked || busy) return; selected = agent.id; start.querySelector(`.${prefix}-button-visible > span:last-child`)!.textContent = `交给 ${agent.name}`; start.disabled = false; for (const label of Array.from(list.children)) label.classList.toggle("is-selected", label === row); });
  }
  host.shell.openSheet({ title, content, footer, onClose: () => { closed = true; } });
}
