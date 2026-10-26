import { randomUUID } from "node:crypto";
import type CodexForObsidianPlugin from "../main";
import { getActiveApiProviderModel } from "../settings/settings";
import { resolveComposerReasoningState } from "../ui/composer-reasoning";
import { locateTarget } from "./document";
import { buildInlineCandidates, proposalTarget, sectionAt } from "./candidates";
import type { InlineDraftSubmission } from "./mention";
import { InlineRequestService, type InlineEditorPort } from "./service";
import type { InlineModelSelection, InlineRequest } from "./types";

export interface InlineOrchestratorHost { editor(path: string): Promise<InlineEditorPort>; openTask(taskId: string): Promise<void> }
interface InlineFlight { id: string; token?: string; abort: AbortController; completion?: Promise<void> }
export class InlineAgentRuntimeController {
  private flights = new Map<string, InlineFlight>();
  private readonly unsubscribe: () => void;
  private drainScheduled = false;
  private disposed = false;
  constructor(private readonly plugin: CodexForObsidianPlugin, private readonly service: InlineRequestService, private readonly host: InlineOrchestratorHost) {
    this.unsubscribe = service.subscribe(() => this.scheduleQueue());
  }
  private model(): InlineModelSelection {
    const selected = getActiveApiProviderModel(this.plugin.settings);
    if (!selected) throw new Error("请先在设置里选择默认 Provider 和模型。");
    const reasoning = resolveComposerReasoningState(this.plugin.settings, selected.provider.id, selected.model.id);
    if (!reasoning || ["missing", "invalid"].includes(reasoning.status)) throw new Error("默认模型的推理设置不完整，请在设置里重新选择。");
    return { providerSettingsId: selected.provider.id, runtimeProviderId: selected.provider.runtimeProviderId, modelId: selected.model.id, reasoning: reasoning.effort,
      memoryMode: this.plugin.settings.memory.useLongTermMemory === false ? "no_memory" : "normal" };
  }
  async sendDraft(input: InlineDraftSubmission): Promise<void> {
    const submittedAt = Date.now();
    if (!input.text.trim()) throw new Error("先写下要交代的事。");
    const model = this.model(), editor = await this.host.editor(input.path);
    if (editor.read() !== input.document) throw new Error("正文已变化，请重新发送。");
    const agent = this.plugin.settings.agentRegistry.agents.find(a => a.id === input.agentId);
    if (!agent) throw new Error("这位管家已不存在，请重新选择。");
    const taskId = `inline-${randomUUID()}`;
    await this.plugin.createPiConversation({ conversationId: taskId, title: input.text.trim().slice(0, 64), agentId: agent.id, cwd: this.plugin.getVaultPath(), defaultMemoryMode: model.memoryMode });
    const request = await this.service.beginRequest({ path: input.path, taskId, agentId: agent.id, agentName: agent.name, trigger: input.trigger, instruction: { from: input.from, to: input.to } }, input.text.trim(), submittedAt);
    this.launch(request, input.text.trim(), model, false);
    void this.host.openTask(taskId).catch(error => this.report(error));
  }
  async reply(taskId: string, text: string): Promise<void> {
    if (!text.trim()) return;
    let request = this.service.latestForTask(taskId);
    if (!request) throw new Error("这件任务没有正文位置。");
    const model = this.model();
    if (this.flights.has(taskId)) await this.stop(taskId);
    if (["confirmed", "revoked", "withdrawn", "modified"].includes(request.status)) {
      request = await this.newRequest(request, text.trim());
      this.launch(request, text.trim(), model, false);
    } else {
      if (request.status === "missing") throw new Error("正文位置已删除，请从正文重新 @ 管家。");
      this.launch(request, text.trim(), model, true);
    }
  }
  async retry(taskId: string): Promise<void> {
    const request = this.service.latestForTask(taskId);
    if (!request) throw new Error("找不到正文请求。");
    const requirement = request.thread?.filter(m => m.role === "user").at(-1)?.text ?? request.versions.at(-1)?.requirement;
    if (!requirement) throw new Error("请重新写下要求。");
    if (this.flights.has(taskId)) return;
    this.launch(request, requirement, request.model ?? this.model(), false);
  }
  async stop(taskId: string): Promise<void> {
    const flight = this.flights.get(taskId); if (!flight) return;
    flight.abort.abort();
    if (flight.token) await this.service.failRun(flight.id, flight.token, "已停止", true);
    await this.plugin.abortPiConversation(taskId).catch(() => undefined);
    await flight.completion;
    if (this.flights.get(taskId) === flight) this.flights.delete(taskId);
  }
  private launch(request: InlineRequest, requirement: string, model: InlineModelSelection, addMessage: boolean): void {
    if (this.flights.has(request.taskId)) throw new Error("这件事正在写，请稍候。");
    const flight: InlineFlight = { id: request.id, abort: new AbortController() };
    this.flights.set(request.taskId, flight);
    flight.completion = this.run(request, requirement, model, addMessage, flight).catch(error => this.report(error)).finally(() => {
      if (this.flights.get(request.taskId) === flight) this.flights.delete(request.taskId);
      this.scheduleQueue();
    });
  }
  private scheduleQueue(): void {
    if (this.disposed || this.drainScheduled) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      if (this.disposed) return;
      for (const request of this.service.list()) {
        if (request.status !== "queued" || !request.queue?.regenerate || request.queue.blockedBy.length || this.flights.has(request.taskId)) continue;
        const requirement = request.preparedProposal?.requirement ?? request.thread?.filter(m => m.role === "user").at(-1)?.text;
        if (requirement && request.model) this.launch(request, requirement, request.model, false);
      }
    });
  }
  private async run(request: InlineRequest, requirement: string, model: InlineModelSelection, addMessage: boolean, flight: InlineFlight): Promise<void> {
    let unsubscribe: (() => void) | undefined;
    let productRunId: string | undefined;
    try {
      const source = await this.service.readSource(request.id);
      const candidates = buildInlineCandidates(source.document, source.context, source.request);
      const token = flight.token = await this.service.startRun(request.id, requirement, model, source.context, addMessage);
      if (flight.abort.signal.aborted) { await this.service.failRun(request.id, token, "已停止", true); return; }
      const latest = source.request.versions.find(v => v.id === source.request.currentVersionId);
      const handle = await this.plugin.submitPiChat({ conversationId: request.taskId, text: requirement, submittedAt: Date.now(), signal: flight.abort.signal,
        mode: "agent", permission: "read-only", ...model,
        inlineProposalRequest: { requestId: request.id, context: source.context.text,
          candidates: candidates.map(({ id, kind, text, label }) => ({ id, kind, text, label })),
          ...(latest ? { previousDraft: latest.text } : {}),
          questionAnswers: [...(source.request.thread?.filter(m => m.role === "user").map(m => m.text) ?? []), ...(source.request.question ? [`管家的追问：${source.request.question.question}`] : [])] } });
      productRunId = handle.productRunId;
      let sawOutput = false;
      const subscription = this.plugin.subscribePiRun(handle.productRunId, event => {
        if (!sawOutput && event.type === "message_update" && "textDelta" in event && event.textDelta) { sawOutput = true; void this.service.timing(request.id, token, { firstOutputAt: event.occurredAt }); }
      });
      unsubscribe = () => subscription.unsubscribe();
      const result = await handle.result;
      if (flight.abort.signal.aborted || this.service.get(request.id)?.runToken !== token) return;
      if (result.terminalState !== "completed" || !result.inlineProposalResult) throw new Error(result.error ?? "模型没有返回完整提案，请重试。");
      const timing = { productRunId: result.productRunId, toolCalls: result.toolCallIds.length, memoryRecall: result.memoryRecall };
      if (result.toolCallIds.length) throw new Error("本次提案发生了工具调用，已停止应用。");
      const output = result.inlineProposalResult;
      if (output.kind === "clarification") await this.service.clarify(request.id, token, { question: output.question, options: output.options.map(o => ({ ...o })) }, timing);
      else {
        const target = proposalTarget(source.document, candidates, output);
        await this.service.completeProposal(request.id, token, source.document, target, output.text, requirement, sectionAt(source.document, target.from), timing);
      }
    } catch (error) {
      if (flight.token || this.flights.get(request.taskId) === flight) await this.service.failRun(request.id, flight.token ?? this.service.get(request.id)?.runToken, error instanceof Error ? error.message : "模型请求失败。", flight.abort.signal.aborted);
    } finally {
      unsubscribe?.();
      if (productRunId) this.plugin.releasePiProductionRun(productRunId);
    }
  }
  private async newRequest(previous: InlineRequest, requirement: string): Promise<InlineRequest> {
    const editor = await this.host.editor(previous.path), document = editor.read();
    const old = previous.commit?.result ?? previous.target;
    const target = locateTarget(document, old, previous.observedDocument === document);
    if (!target) throw new Error("找不到原笔记中的位置，请从正文重新 @ 管家。");
    const trigger = this.plugin.settings.inlineAgent.trigger, command = `${trigger}${previous.agentName} ${requirement}`;
    const insertion = `\n\n${command}\n`, from = target.to;
    editor.apply([{ from, to: from, insert: insertion }], "normal", `inline-followup-${randomUUID()}`);
    return await this.service.beginRequest({ path: previous.path, taskId: previous.taskId, agentId: previous.agentId, agentName: previous.agentName, trigger,
      instruction: { from: from + 2, to: from + 2 + command.length } }, requirement);
  }
  dispose(): void { this.disposed = true; this.unsubscribe(); for (const flight of this.flights.values()) flight.abort.abort(); this.flights.clear(); }
  private report(error: unknown): void { console.error("EchoInk inline proposal failed", error instanceof Error ? error.message : "unknown error"); }
}
