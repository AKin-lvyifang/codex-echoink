import assert from "node:assert/strict";
import { defaultAgentRegistry, getModuleOwner, normalizeAgentRegistry, removeAgentDefinition, setModuleOwner } from "../agents/registry";
import { AGENT_MODULE_IDS } from "../agents/types";
import { normalizeSettingsData } from "../settings/settings";
import { loadMobileSettings } from "../mobile/settings";
import { workbenchSetupTodos } from "../home/workbench-setup-todos";

export function runModuleOwnerTests(): void {
  const fresh = defaultAgentRegistry();
  assert.deepEqual(fresh.agents.map(a => a.id), ["sol", "generalist"]);
  assert.ok(AGENT_MODULE_IDS.every(id => getModuleOwner(fresh, id) === null), "the bare registry baseline stays unassigned");
  const worker = { ...fresh.agents[1], id: "writer", name: "写手", capabilityIds: ["web-search"], disabledCapabilityIds: [] };
  const legacy = { schemaVersion: 1, legacyMigrationVersion: 1, agents: [...fresh.agents.map(a => a.id === "generalist" ? { ...a, disabledCapabilityIds: ["finance"] } : a), worker],
    moduleOwners: { journal: "writer", finance: "sol", todos: "deleted" } };
  const migrated = normalizeAgentRegistry(legacy);
  assert.equal(getModuleOwner(migrated, "finance")?.id, "generalist");
  assert.equal(getModuleOwner(migrated, "journal")?.id, "writer");
  assert.equal(getModuleOwner(migrated, "todos"), null);
  assert.ok(migrated.agents.find(a => a.id === "writer")!.capabilityIds!.includes("journal"));
  assert.ok(!migrated.agents.find(a => a.id === "generalist")!.disabledCapabilityIds!.includes("finance"));
  assert.deepEqual(normalizeAgentRegistry(migrated), migrated, "migration is idempotent");
  const cleared = setModuleOwner(migrated, "finance", "");
  assert.equal(getModuleOwner(normalizeAgentRegistry(JSON.parse(JSON.stringify(cleared))), "finance"), null);
  assert.throws(() => setModuleOwner(fresh, "finance", "sol"), /owner_invalid/);
  assert.throws(() => setModuleOwner(fresh, "finance", "missing"), /owner_invalid/);
  const assigned = setModuleOwner({ ...fresh, agents: [...fresh.agents, worker] }, "knowledge-base", "writer");
  assert.ok(assigned.agents.find(a => a.id === "writer")!.capabilityIds!.includes("knowledge"));
  assert.equal(getModuleOwner(removeAgentDefinition(assigned, "writer"), "knowledge-base"), null);
  for (const normalize of [(value: unknown) => normalizeSettingsData(value).settings, loadMobileSettings]) {
    assert.ok(AGENT_MODULE_IDS.every(id => getModuleOwner(normalize(null).agentRegistry, id)?.id === "generalist"), "new installs start every module on the generalist");
    assert.ok(AGENT_MODULE_IDS.every(id => getModuleOwner(normalize({ settingsLanguage: "zh-CN" }).agentRegistry, id)?.id === "generalist"), "pre-registry users retain module execution");
    assert.deepEqual(normalize({ agentRegistry: legacy }).agentRegistry, migrated);
    assert.equal(getModuleOwner(normalize({ agentRegistry: cleared }).agentRegistry, "finance"), null);
  }
  const todoSettings = normalizeSettingsData(null).settings;
  todoSettings.lifestyle.finance.enabled = true;
  const kinds = (pro: boolean) => workbenchSetupTodos(todoSettings, pro).map(item => item.kind);
  assert.deepEqual(kinds(false), ["knowledge", "model", "persona"], "a new install only needs setup and an optional persona");
  todoSettings.agentRegistry = setModuleOwner(setModuleOwner(todoSettings.agentRegistry, "journal", ""), "finance", "");
  todoSettings.lifestyle.finance.enabled = false;
  assert.ok(!workbenchSetupTodos(todoSettings, true).find(item => item.kind === "owners")?.moduleIds.includes("finance"), "turned-off modules are not counted");
  todoSettings.lifestyle.finance.enabled = true;
  const free = workbenchSetupTodos(todoSettings, false);
  assert.deepEqual(free.find(item => item.kind === "owners")?.moduleIds, ["journal"], "free users are not reminded about PRO modules");
  assert.deepEqual(workbenchSetupTodos(todoSettings, true).find(item => item.kind === "owners")?.moduleIds, ["journal", "finance"], "unowned modules merge into one row");
  todoSettings.agentRegistry = setModuleOwner(todoSettings.agentRegistry, "knowledge-base", "");
  assert.ok(kinds(false).includes("knowledge-owner"), "auto-link pause is said out loud");
  todoSettings.knowledgeBase.autoLinkEnabled = false;
  assert.deepEqual(workbenchSetupTodos(todoSettings, false).find(item => item.kind === "owners")?.moduleIds, ["journal", "knowledge-base"]);
  const owners = workbenchSetupTodos(todoSettings, false).find(item => item.kind === "owners")!;
  todoSettings.setup.setupTodoDismissed = { owners: owners.signature, persona: "persona" };
  assert.ok(!kinds(false).includes("owners") && !kinds(false).includes("persona"), "dismissed items stay hidden");
  todoSettings.agentRegistry = setModuleOwner(todoSettings.agentRegistry, "todos", "");
  assert.ok(kinds(false).includes("owners"), "a changed owners row returns after dismissal");
  const expert = { id: "expert-bookkeeper", name: "记账专家", avatar: { kind: "default" as const }, position: "", styleId: "execution" as const, kind: "expert" as const,
    expert: { expertId: "bookkeeper", hired: true, packageVersion: "1", summary: "", disclosureShown: true, events: [] } };
  todoSettings.agentRegistry = { ...todoSettings.agentRegistry, agents: [...todoSettings.agentRegistry.agents, expert], moduleOwners: { ...todoSettings.agentRegistry.moduleOwners, finance: expert.id } };
  assert.deepEqual(workbenchSetupTodos(todoSettings, false).filter(item => item.kind === "pro-owner").map(item => [item.moduleIds[0], item.agentName]), [["finance", "记账专家"]], "an expert owner without PRO asks for renewal");
  assert.ok(!workbenchSetupTodos(todoSettings, true).some(item => item.kind === "pro-owner"));
  todoSettings.agentRegistry.agents.find(agent => agent.id === "generalist")!.persona = "写日记先问我最在意的事";
  todoSettings.setup.setupTodoDismissed = {};
  assert.ok(!kinds(false).includes("persona"), "writing the persona clears the reminder");
  console.log("module owners: new install, both settings loaders, legacy migration, restart, capability grant and deletion passed");
}
