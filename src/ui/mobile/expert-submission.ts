import type { App } from "obsidian";
import type { AgentDefinition } from "../../agents/types";
import { isExpertAgent } from "../../agents/persona";
import { renderExpertSubmission } from "../../experts/submission-view";
import type { MobileServices } from "../../mobile/services";
import type { EchoInkResource } from "../../resources/types";
import { createOriginCheck, createOriginInput } from "./origin-controls";
import { shellElement } from "./shell-controls";
import type { MobileShellPage } from "./shell-types";

export function createMobileExpertSubmissionEntry(options: {
  document: Document; agent: AgentDefinition; app: App; services: MobileServices; language?: string;
  resources(): readonly EchoInkResource[];
  button(document: Document, text: string, action: () => void, variant?: string, icon?: string): HTMLButtonElement;
  open(page: MobileShellPage): Promise<boolean>;
  error(error: unknown): void;
}): HTMLButtonElement | undefined {
  if (isExpertAgent(options.agent)) return;
  const service = options.services.experts?.submissions;
  if (!service?.owner()) return;
  const title = options.language === "en" ? "Submit to Expert Hall" : "投稿到专家团";
  const row = options.button(options.document, title, () => { void open().catch(error => options.error(error)); }, "is-text");
  row.classList.add("echoink-expert-submission-entry");
  row.dataset.action = "expert-submission";
  row.querySelector(".ip-button-visible, .pd-button-visible")?.append(shellElement(options.document, "span", "echoink-expert-submission-chevron", "›"));

  async function open() {
    if (row.disabled || !service?.owner()) return;
    row.disabled = true;
    const content = shellElement(options.document, "div", "");
    try {
      const view = renderExpertSubmission(content, { service, agent: structuredClone(options.agent), language: options.language,
        resources: async () => options.resources(), readSkill: path => options.app.vault.adapter.read(path),
        input: createOriginInput, checkbox: createOriginCheck,
        button: (parent, text, action, primary) => {
          const control = options.button(parent.ownerDocument, text, action, primary ? "is-primary" : "");
          parent.append(control); return control;
        } });
      if (!await options.open({ id: "expert-submission", title, content, canLeave: view.canLeave, dispose: () => view.dispose() })) view.dispose();
    } finally { row.disabled = false; }
  }
  return row;
}
