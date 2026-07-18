import * as path from "node:path";

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
    return hooks().connectionInfo ?? { connected: true, serverUrl: "", command: "", version: "", errors: [] };
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
  async sendPromptAsync(options?: any): Promise<void> {
    hooks().sendPromptCalls = (hooks().sendPromptCalls ?? 0) + 1;
    hooks().sendPromptAsyncCalls = (hooks().sendPromptAsyncCalls ?? 0) + 1;
    hooks().sendPromptOptions?.push?.(options);
    await (hooks().onSendPromptAsync ?? hooks().onSendPrompt)?.(options, this);
    if (hooks().sendPromptAsyncError ?? hooks().sendPromptError) {
      throw hooks().sendPromptAsyncError ?? hooks().sendPromptError;
    }
  }
  async hasSession(sessionId: string): Promise<boolean> {
    hooks().hasSessionCalls?.push?.(sessionId);
    const result = await hooks().onHasSession?.(sessionId, this);
    return result ?? hooks().hasSessionResult ?? false;
  }
  async updateSessionPermissions(sessionId: string, permission: string, writableRoots: string[] = []): Promise<void> {
    hooks().updateSessionPermissionCalls?.push?.({ sessionId, permission, writableRoots });
    await hooks().onUpdateSessionPermissions?.(sessionId, permission, writableRoots, this);
  }
  async subscribeEvents(signal: AbortSignal): Promise<AsyncIterable<unknown>> {
    hooks().subscribeEventsCalls = (hooks().subscribeEventsCalls ?? 0) + 1;
    const stream = await hooks().onSubscribeEvents?.(signal, this);
    if (stream) return stream;
    throw hooks().subscribeEventsError ?? new Error("OpenCode SSE unavailable in test shim");
  }
  async replyPermission(requestId: string, reply: "once" | "always" | "reject"): Promise<void> {
    hooks().permissionReplies?.push?.({ requestId, reply });
    await hooks().onReplyPermission?.(requestId, reply, this);
    if (hooks().replyPermissionError) throw hooks().replyPermissionError;
  }
  async getSessionStatus(sessionId: string): Promise<string | undefined> {
    hooks().getSessionStatusCalls?.push?.(sessionId);
    const result = await hooks().onGetSessionStatus?.(sessionId, this);
    return result ?? hooks().sessionStatus;
  }
  async readSessionMessages(sessionId: string): Promise<unknown[]> {
    hooks().readSessionMessagesCalls?.push?.(sessionId);
    const result = await hooks().onReadSessionMessages?.(sessionId, this);
    if (result) return result;
    if (Array.isArray(hooks().sessionMessagesQueue) && hooks().sessionMessagesQueue.length) {
      return hooks().sessionMessagesQueue.shift();
    }
    return hooks().sessionMessages ?? [];
  }
  async deleteSession(sessionId: string): Promise<boolean> {
    hooks().deleteSessionCalls?.push?.(sessionId);
    await hooks().onDeleteSession?.(sessionId, this);
    return true;
  }
  async runCliTask(options?: any): Promise<{ text: string; runId: string }> {
    hooks().runCliTaskCalls = (hooks().runCliTaskCalls ?? 0) + 1;
    hooks().sendPromptCalls = (hooks().sendPromptCalls ?? 0) + 1;
    const runId = hooks().session?.sessionId ?? "test-opencode-session";
    options?.onRunId?.(runId);
    options?.onPromptSubmitted?.();
    await (hooks().onRunCliTask ?? hooks().onSendPrompt)?.(options, this);
    if (hooks().runCliTaskError ?? hooks().sendPromptError) throw hooks().runCliTaskError ?? hooks().sendPromptError;
    return hooks().runCliTaskResult ?? { text: hooks().sendPromptResult ?? "", runId };
  }
  async collectHistoryMessages(): Promise<null> {
    return null;
  }
}

export function openCodePermissionRules(
  mode: "read-only" | "workspace-write" | "danger-full-access",
  writableRoots: string[] = [],
  vaultPath = ""
) {
  if (mode === "danger-full-access") {
    return [
      { permission: "*", pattern: "*", action: "allow" as const },
      { permission: "question", pattern: "*", action: "deny" as const }
    ];
  }
  if (mode === "workspace-write") {
    const resolvedVaultPath = vaultPath.trim() ? path.resolve(vaultPath) : "";
    const resolvedWritableRoots = Array.from(new Set(writableRoots
      .map((root) => root.trim())
      .filter(Boolean)
      .map((root) => path.resolve(root))));
    const scopedWorkspaceWrite = Boolean(
      resolvedVaultPath
      && resolvedWritableRoots.length
      && !resolvedWritableRoots.some((root) => path.resolve(root) === resolvedVaultPath)
    );
    const internalWritableRoots = resolvedWritableRoots
      .filter((root) => resolvedVaultPath && isPathInside(root, resolvedVaultPath));
    const externalWritableRoots = resolvedWritableRoots
      .filter((root) => !resolvedVaultPath || !isPathInside(root, resolvedVaultPath));
    if (scopedWorkspaceWrite) {
      return [
        { permission: "*", pattern: "*", action: "deny" as const },
        ...["read", "glob", "grep", "list", "todowrite"].map((permission) => ({
          permission,
          pattern: "*",
          action: "allow" as const
        })),
        ...internalWritableRoots.flatMap((root) =>
          openCodePathRules("edit", toOpenCodePath(path.relative(resolvedVaultPath, root)), "allow")
        ),
        ...externalWritableRoots.flatMap((root) =>
          openCodePathRules("edit", toOpenCodePath(root), "allow")
        ),
        ...openCodePathRules("edit", "outputs/.ingest-tracker.md", "deny"),
        { permission: "external_directory", pattern: "*", action: "deny" as const },
        ...externalWritableRoots.flatMap((root) =>
          openCodePathRules("external_directory", toOpenCodePath(root), "allow")
        ),
        { permission: "question", pattern: "*", action: "deny" as const }
      ];
    }
    return [
      { permission: "*", pattern: "*", action: "allow" as const },
      { permission: "external_directory", pattern: "*", action: "deny" as const },
      ...externalWritableRoots.flatMap((root) => [
        { permission: "external_directory", pattern: toOpenCodePath(root), action: "allow" as const },
        { permission: "external_directory", pattern: `${toOpenCodePath(root)}/**`, action: "allow" as const }
      ]),
      { permission: "question", pattern: "*", action: "deny" as const }
    ];
  }
  return [
    { permission: "*", pattern: "*", action: "deny" as const },
    ...["read", "glob", "grep", "list", "webfetch", "websearch", "codesearch", "todowrite"].map((permission) => ({
      permission,
      pattern: "*",
      action: "allow" as const
    }))
  ];
}

function openCodePathRules(permission: string, normalizedPath: string, action: "allow" | "deny") {
  const clean = normalizedPath.replace(/\/+$/, "");
  if (!clean) return [];
  return [
    { permission, pattern: clean, action },
    { permission, pattern: `${clean}/**`, action }
  ];
}

function toOpenCodePath(value: string): string {
  return value.split(path.sep).join("/");
}

function isPathInside(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function hooks(): any {
  return ((globalThis as any).__opencodeBackendTestHooks ??= {});
}
