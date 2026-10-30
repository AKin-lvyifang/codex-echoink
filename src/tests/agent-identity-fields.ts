import assert from "node:assert/strict";
import { agentDisplayTitle, agentPositionDescription } from "../agents/identity";
import { defaultAgentRegistry, normalizeAgentRegistry } from "../agents/registry";
import { AGENT_PRESETS } from "../agents/presets";
import { assertExpertAgentLocks, preserveExpertAgentLocks } from "../agents/persona";
import { agentTaskSystemPrompt, resolveAgentRunSnapshot } from "../agents/capability-core";
import { hireExpert } from "../agents/expert-lifecycle";
import type { AgentDefinition } from "../agents/types";
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
  assert.equal(migrated.agents[1].position, "");
  assert.equal(migrated.agents[1].positionDescription, "写文章、整理资料");
  assert.equal(migrated.agents[1].persona, "保留人格");
  assert.deepEqual(migrated.agents[1].capabilityIds, ["knowledge"]);
  assert.equal(migrated.moduleOwners.journal, "writer");
  assert.deepEqual(normalizeAgentRegistry(migrated), migrated, "repeated loading never migrates a split identity again");
  const writer = migrated.agents[1];
  writer.position = "编辑"; writer.positionDescription = "";
  const reloaded = normalizeAgentRegistry(JSON.parse(JSON.stringify(migrated)));
  assert.equal(reloaded.agents[1].position, "编辑", "an intentionally blank description must not consume a newly entered role");
  assert.equal(reloaded.agents[1].positionDescription, "");
  writer.positionDescription = "写文章、整理资料";
  assert.equal(agentDisplayTitle(writer), "小林（编辑）");
  assert.equal(agentDisplayTitle(writer, "en"), "小林 (编辑)");
  assert.equal(agentDisplayTitle({ name: "小林", position: " 小林 " }), "小林");
  assert.equal(agentDisplayTitle({ name: "小林", position: "" }), "小林");
  assert.equal(agentPositionDescription(reloaded.agents[1]), "");
  for (const preset of AGENT_PRESETS) {
    assert.equal(preset.agent.position, "");
    assert.ok(preset.agent.positionDescription);
  }

  const expert: AgentDefinition = { id: "expert-socrates", name: "苏格拉底", position: "思考伙伴", avatar: { kind: "default" }, styleId: "analysis", kind: "expert",
    expert: { expertId: "socrates", hired: true, packageVersion: "1", summary: "帮你把问题想清楚", disclosureShown: false, events: [] } };
  const experts = normalizeAgentRegistry({ ...defaultAgentRegistry(), agents: [expert] });
  const normalizedExpert = experts.agents.find(agent => agent.id === expert.id)!;
  assert.equal(normalizedExpert.position, "思考伙伴");
  assert.equal(normalizedExpert.positionDescription, expert.expert!.summary);
  assert.deepEqual(normalizeAgentRegistry(experts), experts);
  assert.throws(() => assertExpertAgentLocks(normalizedExpert, { ...normalizedExpert, positionDescription: "修改简介" }), /expert_agent_locked/u);
  assert.equal(preserveExpertAgentLocks(normalizedExpert, { ...normalizedExpert, positionDescription: "过期草稿" }).positionDescription, expert.expert!.summary);
  const pack = { id: "socrates", name: "苏格拉底", version: "2", avatar: expert.avatar, summary: "新的公开简介", meta: { scene: "哲学顾问" } } as ResolvedExpertPackage;
  const hired = hireExpert(experts, pack);
  assert.equal(hired.position, "哲学顾问"); assert.equal(hired.positionDescription, pack.summary);

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
