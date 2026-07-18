import type {
  KnowledgeBaseRunPerformance,
  KnowledgeBaseRunPhasePerformance,
  KnowledgeWorkflowEvent,
  KnowledgeWorkflowPhaseId
} from "./types";

export type KnowledgeWorkflowEventSink = (event: KnowledgeWorkflowEvent) => void;

export class KnowledgeWorkflowProgress {
  private readonly startedAt = Date.now();
  private activePhase: { id: KnowledgeWorkflowPhaseId; title: string; startedAt: number } | null = null;
  private readonly phases: KnowledgeBaseRunPhasePerformance[] = [];
  private agentCalled = false;
  private finished = false;

  constructor(private readonly sink?: KnowledgeWorkflowEventSink) {
    this.emit({ type: "workflow.started", status: "running", message: "知识库任务已开始" });
  }

  phase(id: KnowledgeWorkflowPhaseId, title: string, message = ""): void {
    if (this.finished) return;
    this.completeActivePhase();
    const createdAt = Date.now();
    this.activePhase = { id, title, startedAt: createdAt };
    this.emit({
      type: "workflow.phase.started",
      phaseId: id,
      title,
      status: "running",
      message
    });
  }

  progress(current: number, total: number, message = ""): void {
    if (!this.activePhase || this.finished) return;
    this.emit({
      type: "workflow.phase.progress",
      phaseId: this.activePhase.id,
      title: this.activePhase.title,
      status: "running",
      current,
      total,
      message
    });
  }

  markAgentCalled(): void {
    this.agentCalled = true;
  }

  complete(message = ""): KnowledgeBaseRunPerformance {
    if (!this.finished) {
      this.completeActivePhase(message);
      this.finished = true;
      this.emit({ type: "workflow.completed", status: "success", message: message || "知识库任务已完成" });
    }
    return this.snapshot();
  }

  fail(status: "failed" | "canceled", message: string): KnowledgeBaseRunPerformance {
    if (!this.finished) {
      const current = this.activePhase;
      if (current) {
        const completedAt = Date.now();
        this.phases.push({
          id: current.id,
          title: current.title,
          startedAt: current.startedAt,
          completedAt,
          durationMs: Math.max(0, completedAt - current.startedAt),
          status
        });
        this.emit({
          type: "workflow.phase.failed",
          phaseId: current.id,
          title: current.title,
          status,
          message
        });
        this.activePhase = null;
      }
      this.finished = true;
      this.emit({ type: "workflow.completed", status, message });
    }
    return this.snapshot();
  }

  snapshot(): KnowledgeBaseRunPerformance {
    return {
      startedAt: this.startedAt,
      completedAt: Date.now(),
      totalMs: Math.max(0, Date.now() - this.startedAt),
      agentCalled: this.agentCalled,
      phases: this.phases.map((phase) => ({ ...phase }))
    };
  }

  private completeActivePhase(message = ""): void {
    const current = this.activePhase;
    if (!current) return;
    const completedAt = Date.now();
    this.phases.push({
      id: current.id,
      title: current.title,
      startedAt: current.startedAt,
      completedAt,
      durationMs: Math.max(0, completedAt - current.startedAt),
      status: "success"
    });
    this.emit({
      type: "workflow.phase.completed",
      phaseId: current.id,
      title: current.title,
      status: "success",
      message
    });
    this.activePhase = null;
  }

  private emit(event: Omit<KnowledgeWorkflowEvent, "createdAt">): void {
    try {
      this.sink?.({ ...event, createdAt: Date.now() });
    } catch (error) {
      console.warn("EchoInk knowledge workflow event sink failed", error);
    }
  }
}
