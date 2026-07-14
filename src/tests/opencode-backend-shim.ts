export class OpenCodeBackend {
  constructor(_options: unknown) {
    hooks().instances?.push?.(this);
  }
  async connect(): Promise<void> {
    await hooks().onConnect?.(this);
  }
  async disconnect(): Promise<void> {
    await hooks().onDisconnect?.(this);
  }
  async abort(sessionId?: string): Promise<void> {
    hooks().abortCalls?.push?.(sessionId);
    await hooks().onAbort?.(sessionId, this);
  }
  getConnectionInfo(): { connected: boolean; serverUrl: string; command: string; version: string; errors: string[] } {
    return { connected: false, serverUrl: "", command: "", version: "", errors: [] };
  }
  async listModels(): Promise<any[]> {
    await hooks().onListModels?.(this);
    return hooks().models ?? [];
  }
  async listAgents(): Promise<any[]> {
    await hooks().onListAgents?.(this);
    return hooks().agents ?? [];
  }
  async startSession(options?: any): Promise<{ sessionId: string; title: string }> {
    hooks().startSessionOptions?.push?.(options);
    await hooks().onStartSession?.(options, this);
    return hooks().session ?? { sessionId: "test-opencode-session", title: "test" };
  }
  async sendPrompt(options?: any): Promise<string> {
    hooks().sendPromptCalls = (hooks().sendPromptCalls ?? 0) + 1;
    hooks().sendPromptOptions?.push?.(options);
    await hooks().onSendPrompt?.(options, this);
    if (hooks().sendPromptError) throw hooks().sendPromptError;
    return hooks().sendPromptResult ?? "";
  }
  async deleteSession(sessionId: string): Promise<boolean> {
    hooks().deleteSessionCalls?.push?.(sessionId);
    await hooks().onDeleteSession?.(sessionId, this);
    return true;
  }
  async runCliTask(options?: any): Promise<{ text: string; runId: string }> {
    hooks().runCliTaskCalls = (hooks().runCliTaskCalls ?? 0) + 1;
    const runId = hooks().session?.sessionId ?? "test-opencode-session";
    options?.onRunId?.(runId);
    await hooks().onRunCliTask?.(options, this);
    if (hooks().runCliTaskError ?? hooks().sendPromptError) throw hooks().runCliTaskError ?? hooks().sendPromptError;
    return hooks().runCliTaskResult ?? { text: hooks().sendPromptResult ?? "", runId };
  }
  async collectHistoryMessages(): Promise<null> {
    return null;
  }
}

function hooks(): any {
  return ((globalThis as any).__opencodeBackendTestHooks ??= {});
}
