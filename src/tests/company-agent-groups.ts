import assert from "node:assert/strict";
import { agentRoleGroups } from "../agents/roster-groups";
import { normalizeAgentRegistry } from "../agents/registry";
import { renderAgentRoster } from "../ui/codex-view/agent-roster";
import { AgentEditorController } from "../ui/codex-view/agent-editor";
import { DEFAULT_SETTINGS } from "../settings/settings";
import type { AgentEditorHost } from "../ui/codex-view/agent-editor-contract";
import type { AgentDefinition } from "../agents/types";
import { installCompanyTestDom } from "./company-ui";

export async function runCompanyAgentGroupTests(document: Document): Promise<void> {
  installCompanyTestDom(document);
  document.defaultView!.HTMLElement.prototype.scrollIntoView = () => undefined;
  const fresh = normalizeAgentRegistry(undefined);
  assert.deepEqual(normalizeAgentRegistry(fresh), fresh, "approval default is stable across save/reload");
  const registry = normalizeAgentRegistry({ schemaVersion: 1, agents: [
    { id: "role-router", name: "总助", companyRole: "router", companyApprovalMode: "assistant" },
    { id: "sol", name: "总助" }
  ] });
  assert.equal(registry.agents.find(a => a.id === "sol")!.companyApprovalMode, "user", "old settings default to human approval");
  assert.equal(registry.agents.find(a => a.id === "role-router")!.companyApprovalMode, undefined, "role Agent cannot own main approval preference");
  const groups = agentRoleGroups(registry.agents);
  assert.deepEqual(groups.map(g => [g.id, g.agents.map(a => a.id)]), [["main", ["sol"]], ["role", ["role-router", "generalist"]]], "name and fake role cannot create a second main Agent");
  const root = document.createElement("div"); document.body.append(root);
  let selected = "", created = false;
  renderAgentRoster(root, registry.agents, [], "sol", { onSelect: id => { selected = id; }, onCreate: () => { created = true; } });
  assert.equal(root.querySelector('[data-agent-group="main"]')!.querySelectorAll('[data-agent-id]').length, 1);
  const roles = root.querySelector('[data-agent-group="role"]')!;
  assert.equal(roles.querySelectorAll('[data-agent-id]').length, 2);
  (roles.querySelector('[data-agent-id="role-router"]') as HTMLButtonElement).click(); assert.equal(selected, "role-router");
  (roles.querySelector('[aria-label="新建 Agent"]') as HTMLButtonElement).click(); assert.equal(created, true);
  root.remove();

  const settings = structuredClone(DEFAULT_SETTINGS); settings.agentRegistry = registry;
  let saved: AgentDefinition | undefined;
  const host: AgentEditorHost = { settings, draftCacheKey: {}, loadResources: async () => [],
    saveAgent: async agent => { saved = normalizeAgentRegistry({ ...registry, agents: registry.agents.map(a => a.id === agent.id ? agent : a) }).agents.find(a => a.id === agent.id); },
    deleteAgent: async () => undefined, getDeleteCounts: async () => ({ total: 0, running: 0 }), onClose() {} };
  const form = document.createElement("div"); document.body.append(form);
  const editor = new AgentEditorController(host); editor.open("sol"); editor.render(form);
  await new Promise(resolve => setTimeout(resolve, 0));
  const assistant = form.querySelector<HTMLButtonElement>('.echoink-agent-company-approval [aria-label="总助审批"]')!;
  assert.ok(assistant, "main editor exposes the exact approval choice"); assistant.click();
  const save = form.querySelector<HTMLButtonElement>('[data-action="save-agent"]')!; save.click();
  for (let i = 0; i < 20 && !saved; i++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(saved?.companyApprovalMode, "assistant", "choice reaches real registry normalization and save boundary");
  editor.dispose(); form.replaceChildren();
  const roleEditor = new AgentEditorController({ ...host, draftCacheKey: {} }); roleEditor.open("role-router"); roleEditor.render(form);
  assert.equal(form.querySelector('.echoink-agent-company-approval'), null, "role editor cannot acquire approval setting");
  roleEditor.dispose(); form.remove();
  console.log("company Agent groups: reserved main identity, default preference, grouped desktop actions, save/reload and role exclusion PASS");
}
