import type CodexForObsidianPlugin from "../main";
import { ExpertContentService, adapterExpertContentFiles } from "../experts/service";
import { hireExpert, dismissExpert, rememberExpertConversation } from "../agents/expert-lifecycle";
import { isExpertAgent } from "../agents/persona";


export class DesktopExpertController {
  readonly content: ExpertContentService;
  constructor(private plugin: CodexForObsidianPlugin) {
    this.content = new ExpertContentService({ files: adapterExpertContentFiles(plugin.app.vault.adapter),
      cacheRoot: `${plugin.manifest.dir}/expert-cache`, account: () => plugin.accountService,
      pluginVersion: plugin.manifest.version, platform: "desktop" });
  }
  async hire(expertId: string): Promise<string> {
    const pack = await this.content.resolve(expertId); pack.assertAvailable();
    let agentId = "";
    await this.plugin.mutateExpertRegistry(registry => { pack.assertAvailable(); agentId = hireExpert(registry, pack).id; });
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
  async prepare(agentId: string, conversationId: string, text: string): Promise<{ prompt: string; assertAvailable(): void }> {
    const agent = this.plugin.settings.agentRegistry.agents.find(item => item.id === agentId);
    if (!isExpertAgent(agent) || !agent.expert.hired) throw new Error("专家已解聘。");
    const pack = await this.content.resolve(agent.expert.expertId);
    const assertAvailable = () => {
      pack.assertAvailable();
      const current = this.plugin.settings.agentRegistry.agents.find(item => item.id === agentId);
      if (!isExpertAgent(current) || !current.expert.hired || current.expert.expertId !== pack.id) throw new Error("专家已解聘或身份已变化。");
    };
    assertAvailable();
    // Public metadata may be refreshed; the secret body stays in the request closure.
    if (agent.expert.packageVersion !== pack.version) await this.plugin.mutateExpertRegistry(registry => {
      assertAvailable(); const current = registry.agents.find(item => item.id === agentId)!;
      current.name = pack.name; current.avatar = pack.avatar; current.position = pack.meta.scene;
      current.expert!.packageVersion = pack.version; current.expert!.summary = pack.summary;
    });
    await this.plugin.mutateExpertRegistry(registry => { assertAvailable(); rememberExpertConversation(registry, agentId, conversationId); });
    return { prompt: `${pack.buildTransientPrompt({ text })}\n首次视角声明由产品在会话中展示，不重复声明。`, assertAvailable: () => {
      assertAvailable();
      const current = this.plugin.settings.agentRegistry.agents.find(item => item.id === agentId);
      if (current?.expert?.packageVersion !== pack.version) throw new Error("专家包版本已变化，本次任务已停止。");
    } };
  }
  async about(agentId: string): Promise<void> {
    const agent = this.plugin.settings.agentRegistry.agents.find(item => item.id === agentId);
    if (!isExpertAgent(agent)) return;
    await this.plugin.openExpertHall(agent.expert.expertId);
  }
}
