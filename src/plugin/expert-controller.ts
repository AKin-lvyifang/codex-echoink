import type CodexForObsidianPlugin from "../main";
import { ExpertContentService, adapterExpertContentFiles, type ResolvedExpertPackage } from "../experts/service";
import { hireExpert, dismissExpert, rememberExpertConversation } from "../agents/expert-lifecycle";
import { isExpertAgent } from "../agents/persona";
import { getDecisionClient } from "../membership/decision-client";
import { expertLocalSkillPrompt, expertSkillOptions, planExpertSkills } from "../experts/prompt";
import { checkAgentSkill, requireAgentCapability } from "../agents/capability-policy";
import { redactEchoInkLocalSecretsV1 } from "../harness/pi-native/vault-tool-result-safety";
import { isCommunityExpertAgent } from "../agents/types";


export class DesktopExpertController {
  readonly content: ExpertContentService;
  constructor(private plugin: CodexForObsidianPlugin) {
    this.content = new ExpertContentService({ files: adapterExpertContentFiles(plugin.app.vault.adapter),
      cacheRoot: `${plugin.manifest.dir}/expert-cache`, account: () => plugin.accountService,
      pluginVersion: plugin.manifest.version, platform: "desktop" });
  }
  async hire(expertId: string): Promise<string> {
    const report = this.content.hireReporter(expertId);
    const pack = await this.content.resolve(expertId); pack.assertAvailable();
    let agentId = "";
    await this.plugin.mutateExpertRegistry(registry => { pack.assertAvailable(); agentId = hireExpert(registry, pack).id; });
    report();
    return agentId;
  }
  async dismiss(agentId: string): Promise<void> {
    const runs = this.plugin.getConversationRunService();
    runs.blockAgent(agentId);
    try {
      await this.plugin.mutateExpertRegistry(registry => dismissExpert(registry, agentId));
      const tasks = (await this.plugin.listAgentTaskEntries()).filter(task => task.agentId === agentId);
      await Promise.all(tasks.map(task => runs.stopTask(task.conversationId)));
      await Promise.all(tasks.map(task => this.plugin.releasePiConversation(task.conversationId)));
    } finally { runs.unblockAgent(agentId); }
  }
  async verifyCommunityRun(agentId: string): Promise<ResolvedExpertPackage | undefined> {
    const agent = this.plugin.settings.agentRegistry.agents.find(item => item.id === agentId);
    if (!isExpertAgent(agent) || !isCommunityExpertAgent(agent)) return;
    if (!agent.expert.hired) throw new Error("专家已解聘。");
    return this.content.resolve(agent.expert.expertId, true);
  }
  async prepare(agentId: string, conversationId: string, text: string, verified?: ResolvedExpertPackage): Promise<{ prompt: string; assertAvailable(): void }> {
    const agent = this.plugin.settings.agentRegistry.agents.find(item => item.id === agentId);
    if (!isExpertAgent(agent) || !agent.expert.hired) throw new Error("专家已解聘。");
    const pack = verified ?? await this.content.resolve(agent.expert.expertId, isCommunityExpertAgent(agent));
    if (pack.id !== agent.expert.expertId) throw new Error("专家身份已变化，请重新发送。");
    const assertAvailable = () => {
      pack.assertAvailable();
      const current = this.plugin.settings.agentRegistry.agents.find(item => item.id === agentId);
      if (!isExpertAgent(current) || !current.expert.hired || current.expert.expertId !== pack.id) throw new Error("专家已解聘或身份已变化。");
    };
    assertAvailable();
    // Public metadata may be refreshed; the secret body stays in the request closure.
    if (agent.expert.packageVersion !== pack.version || agent.expert.disclosure !== pack.disclosure || pack.meta.source === "community" && agent.expert.source !== "community") await this.plugin.mutateExpertRegistry(registry => {
      assertAvailable(); hireExpert(registry, pack);
    });
    await this.plugin.mutateExpertRegistry(registry => { assertAvailable(); rememberExpertConversation(registry, agentId, conversationId); });
    // The turn judgment saw both sources. If unavailable, match the same metadata locally.
    const judged = await getDecisionClient()?.latestTurn(conversationId, text).catch(() => null) ?? null;
    const { selectedPackageSkillIds, localSkillIds } = planExpertSkills(expertSkillOptions(pack.skillOptions(), this.localSkills(agentId)),
      { text, decidedSkillId: judged?.skill?.id });
    const local = await Promise.all(localSkillIds.map(async id => {
      const context = this.skillContext(agentId);
      requireAgentCapability(checkAgentSkill(context, id));
      const resource = context.resources.find(item => item.id === id)!;
      const skillId = typeof resource.metadata?.resourceId === "string" ? resource.metadata.resourceId : id;
      const content = await this.plugin.getSkillContentResolver().resolve(skillId, { path: resource.contentPath });
      if (content.source !== "user") throw new Error("本地 Skill 正文不可用。");
      return { id, content: redactEchoInkLocalSecretsV1(content.content) };
    }));
    return { prompt: `${pack.buildTransientPrompt({ text, selectedPackageSkillIds })}${expertLocalSkillPrompt(local)}\n首次视角声明由产品在会话中展示，不重复声明。`, assertAvailable: () => {
      assertAvailable();
      const current = this.plugin.settings.agentRegistry.agents.find(item => item.id === agentId);
      if (current?.expert?.packageVersion !== pack.version) throw new Error("专家包版本已变化，本次任务已停止。");
      for (const id of localSkillIds) requireAgentCapability(checkAgentSkill(this.skillContext(agentId), id));
    } };
  }
  private skillContext(agentId: string) {
    const settings = this.plugin.settings;
    return { agentId, settings, vaultRoot: this.plugin.getVaultPath(), resources: settings.resources.catalog, proAccess: this.plugin.accountService ?? undefined };
  }
  private localSkills(agentId: string) {
    const context = this.skillContext(agentId);
    return context.resources.filter(resource => resource.kind === "skill" && resource.contentPath && checkAgentSkill(context, resource.id).allowed)
      .map(({ id, name, description }) => ({ id, name, description }));
  }
  /** 智能判断的专家技能清单；专家不可用时为空，回到关键词选择。 */
  async decisionSkills(agentId: string): Promise<{ id: string; name: string; description: string }[]> {
    const agent = this.plugin.settings.agentRegistry.agents.find(item => item.id === agentId);
    if (!isExpertAgent(agent) || !agent.expert.hired) return [];
    try {
      const pack = await this.content.resolve(agent.expert.expertId); pack.assertAvailable();
      return expertSkillOptions(pack.skillOptions(), this.localSkills(agentId)).map(({ id, name, description }) => ({ id, name, description }));
    } catch { return []; }
  }
  async about(agentId: string): Promise<void> {
    const agent = this.plugin.settings.agentRegistry.agents.find(item => item.id === agentId);
    if (!isExpertAgent(agent)) return;
    await this.plugin.openExpertHall(agent.expert.expertId);
  }
}
