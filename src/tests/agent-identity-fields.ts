import assert from "node:assert/strict";
import { agentDisplayTitle, agentPositionDescription } from "../agents/identity";
import { defaultAgentRegistry, normalizeAgentRegistry } from "../agents/registry";
import { AGENT_PRESETS } from "../agents/presets";
import { applyExpertIdentityOverrides, assertExpertAgentLocks } from "../agents/persona";
import { agentTaskSystemPrompt, resolveAgentRunSnapshot } from "../agents/capability-core";
import { dismissExpert, hireExpert } from "../agents/expert-lifecycle";
import { hasAgentCapabilityGrant, type AgentDefinition } from "../agents/types";
import type { ResolvedExpertPackage } from "../experts/service";
import { renderAgentTaskList } from "../ui/codex-view/task-list";
import { renderAgentRoster } from "../ui/codex-view/agent-roster";
import { disposeOriginControls } from "../settings/origin-controls";

export function runAgentIdentityFieldsTests(document: Document): void {
  const legacy = defaultAgentRegistry();
  delete legacy.agents[0].positionDescription;
  legacy.agents[0].position = "什么都能接，专门的活转给同事";
  legacy.agents.push({ id: "writer", name: "小林", avatar: { kind: "default" }, position: " 写文章、整理资料 ", styleId: "creative", capabilityIds: ["knowledge"], persona: "保留人格" });
  legacy.moduleOwners.journal = "writer";
  const migrated = normalizeAgentRegistry(JSON.parse(JSON.stringify(legacy)));
  assert.equal(migrated.agents[0].name, "总助");
  assert.equal(migrated.agents[0].position, "");
  assert.equal(migrated.agents[0].positionDescription, legacy.agents[0].position);
  assert.equal(migrated.agents.find(agent => agent.id === "writer")!.position, "");
  assert.equal(migrated.agents.find(agent => agent.id === "writer")!.positionDescription, "写文章、整理资料");
  assert.equal(migrated.agents.find(agent => agent.id === "writer")!.persona, "保留人格");
  assert.deepEqual(migrated.agents.find(agent => agent.id === "writer")!.capabilityIds, ["knowledge", "journal"]);
  assert.equal(migrated.moduleOwners.journal, "writer");
  assert.deepEqual(normalizeAgentRegistry(migrated), migrated, "repeated loading never migrates a split identity again");
  const writer = migrated.agents.find(agent => agent.id === "writer")!;
  writer.position = "编辑"; writer.positionDescription = "";
  const reloaded = normalizeAgentRegistry(JSON.parse(JSON.stringify(migrated)));
  assert.equal(reloaded.agents.find(agent => agent.id === "writer")!.position, "编辑", "an intentionally blank description must not consume a newly entered role");
  assert.equal(reloaded.agents.find(agent => agent.id === "writer")!.positionDescription, "");
  writer.positionDescription = "写文章、整理资料";
  assert.equal(agentDisplayTitle(writer), "小林（编辑）");
  assert.equal(agentDisplayTitle(writer, "en"), "小林 (编辑)");
  assert.equal(agentDisplayTitle({ name: "小林", position: " 小林 " }), "小林");
  assert.equal(agentDisplayTitle({ name: "小林", position: "" }), "小林");
  assert.equal(agentPositionDescription(reloaded.agents.find(agent => agent.id === "writer")!), "");
  for (const preset of AGENT_PRESETS) {
    assert.equal(preset.agent.position, "");
    assert.ok(preset.agent.positionDescription);
  }

  const expert: AgentDefinition = { id: "expert-socrates", name: "苏格拉底", position: "思考伙伴", avatar: { kind: "default" }, styleId: "analysis", kind: "expert",
    expert: { expertId: "socrates", hired: true, packageVersion: "1", summary: "帮你把问题想清楚", disclosureShown: false, events: [] } };
  const oldRegistry = defaultAgentRegistry();
  delete oldRegistry.capabilityMigrationVersion;
  oldRegistry.agents[0].disabledCapabilityIds = ["web-search"];
  oldRegistry.agents[1].disabledCapabilityIds = ["finance"];
  oldRegistry.agents.push(expert, { ...writer, capabilityIds: [] }, { ...writer, id: "researcher", capabilityIds: ["web-search"] });
  oldRegistry.moduleOwners.finance = expert.id;
  const experts = normalizeAgentRegistry(oldRegistry);
  const normalizedExpert = experts.agents.find(agent => agent.id === expert.id)!;
  assert.equal(normalizedExpert.position, "思考伙伴");
  assert.equal(normalizedExpert.positionDescription, expert.expert!.summary);
  assert.deepEqual(normalizeAgentRegistry(experts), experts);
  // 2026-11-25: web search is built into every non-expert Agent; the migrated opt-out stays in data but no longer narrows it.
  assert.equal(hasAgentCapabilityGrant(experts.agents.find(agent => agent.id === writer.id)!, "web-search"), true);
  assert.equal(hasAgentCapabilityGrant(experts.agents.find(agent => agent.id === "researcher")!, "web-search"), true);
  assert.deepEqual(experts.agents.slice(0, 2).map(agent => agent.disabledCapabilityIds), [["web-search"], ["finance"]]);
  assert.deepEqual(normalizedExpert.capabilityIds, ["journal", "knowledge", "finance"]);
  assert.throws(() => assertExpertAgentLocks(normalizedExpert, { ...normalizedExpert, positionDescription: "修改简介" }), /expert_agent_locked/u);
  const draft: AgentDefinition = { ...normalizedExpert, name: "苏老师", avatar: { kind: "preset", presetId: "lin" },
    capabilityIds: [...normalizedExpert.capabilityIds!, "vault-skill:synthetic", "mcp:synthetic:lookup"] };
  assertExpertAgentLocks(normalizedExpert, draft);
  experts.agents[experts.agents.indexOf(normalizedExpert)] = applyExpertIdentityOverrides(normalizedExpert, draft);
  const pack = { id: "socrates", name: "苏格拉底", version: "2", avatar: expert.avatar, summary: "新的公开简介", meta: { scene: "哲学顾问" } } as ResolvedExpertPackage;
  const hired = hireExpert(experts, pack);
  assert.equal(hired.position, "哲学顾问"); assert.equal(hired.positionDescription, pack.summary);
  assert.equal(hired.name, draft.name); assert.deepEqual(hired.avatar, draft.avatar);
  dismissExpert(experts, expert.id);
  const rehired = hireExpert(normalizeAgentRegistry(experts), { ...pack, version: "3" });
  assert.equal(rehired.name, draft.name); assert.deepEqual(rehired.avatar, draft.avatar);
  assert.deepEqual(rehired.capabilityIds, draft.capabilityIds);
  assert.equal(rehired.persona, undefined);

  const snapshot = resolveAgentRunSnapshot({ agentRegistry: migrated }, "writer");
  writer.positionDescription = "后续修改";
  assert.equal(snapshot.positionDescription, "写文章、整理资料", "task history freezes the description alongside its name and role");
  assert.match(agentTaskSystemPrompt(snapshot), /"position":"编辑","positionDescription":"写文章、整理资料"/u);
  assert.match(agentTaskSystemPrompt({ agentId: "old", name: "旧名字", position: "旧职责", styleId: "execution" }), /旧职责/u);

  const root = document.createElement("div"); document.body.append(root);
  try {
    const shown = { ...writer, positionDescription: "写文章、整理资料" };
    renderAgentTaskList(root, shown, [], [], { onTask() {}, onEdit() {} });
    assert.equal(root.querySelector(".echoink-agent-name")?.textContent, "小林（编辑）");
    assert.equal(root.querySelector(".echoink-agent-position")?.textContent, shown.positionDescription);
    renderAgentRoster(root, [shown], [], shown.id, { onSelect() {}, onCreate() {} });
    const avatar = root.querySelector<HTMLButtonElement>("[data-agent-id]")!;
    assert.match(avatar.getAttribute("aria-label")!, /小林（编辑）/u);
    assert.match(avatar.getAttribute("aria-label")!, /写文章、整理资料/u);
    assert.match(avatar.getAttribute("aria-description")!, /0件事/u, "task state remains available to assistive technology");
  } finally { disposeOriginControls(root); root.remove(); }
  console.log("PASS Agent identity migration, empty-description roundtrip, expert locks, frozen prompt and shared presentation");
}
