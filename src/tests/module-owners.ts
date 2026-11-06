import assert from "node:assert/strict";
import { defaultAgentRegistry, getModuleOwner, normalizeAgentRegistry, removeAgentDefinition, setModuleOwner } from "../agents/registry";
import { AGENT_MODULE_IDS } from "../agents/types";
import { normalizeSettingsData } from "../settings/settings";
import { loadMobileSettings } from "../mobile/settings";

export function runModuleOwnerTests(): void {
  const fresh = defaultAgentRegistry();
  assert.deepEqual(fresh.agents.map(a => a.id), ["sol", "generalist"]);
  assert.ok(AGENT_MODULE_IDS.every(id => getModuleOwner(fresh, id) === null));
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
    assert.ok(AGENT_MODULE_IDS.every(id => getModuleOwner(normalize(null).agentRegistry, id) === null));
    assert.ok(AGENT_MODULE_IDS.every(id => getModuleOwner(normalize({ settingsLanguage: "zh-CN" }).agentRegistry, id)?.id === "generalist"), "pre-registry users retain module execution");
    assert.deepEqual(normalize({ agentRegistry: legacy }).agentRegistry, migrated);
    assert.equal(getModuleOwner(normalize({ agentRegistry: cleared }).agentRegistry, "finance"), null);
  }
  console.log("module owners: new install, both settings loaders, legacy migration, restart, capability grant and deletion passed");
}
