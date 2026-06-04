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
  async startSession(): Promise<{ sessionId: string; title: string }> {
    await hooks().onStartSession?.(this);
    return hooks().session ?? { sessionId: "test-opencode-session", title: "test" };
  }
  async sendPrompt(): Promise<string> {
    hooks().sendPromptCalls = (hooks().sendPromptCalls ?? 0) + 1;
    await hooks().onSendPrompt?.(this);
    if (hooks().sendPromptError) throw hooks().sendPromptError;
    return hooks().sendPromptResult ?? "";
  }
  async collectHistoryMessages(): Promise<null> {
    return null;
  }
}

function hooks(): any {
  return ((globalThis as any).__opencodeBackendTestHooks ??= {});
}
