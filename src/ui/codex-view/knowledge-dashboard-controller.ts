import { normalizePath, Notice, TFile, type App } from "obsidian";
import type CodexForObsidianPlugin from "../../main";
import type { StoredSession } from "../../settings/settings";
import type { KnowledgeBaseDashboardSnapshot } from "../../knowledge-base/dashboard";
import { clearKnowledgeDashboardHealthTooltips, renderKnowledgeDashboardView, type KnowledgeDashboardTooltipState } from "./knowledge-dashboard";

export interface CodexKnowledgeDashboardHost {
  readonly app: App;
  readonly plugin: CodexForObsidianPlugin;
  knowledgeDashboardEl: HTMLElement;
  knowledgeDashboardSnapshot: KnowledgeBaseDashboardSnapshot | null;
  knowledgeDashboardExpanded: boolean;
  knowledgeDashboardLoading: boolean;
  knowledgeDashboardError: string;
  knowledgeDashboardRequestId: number;
  knowledgeDashboardTooltipState: KnowledgeDashboardTooltipState;
  ensureSession(): StoredSession;
  isKnowledgeBaseSession(session: StoredSession): boolean;
  renderKnowledgeDashboard(): void;
  refreshKnowledgeDashboard(force?: boolean): Promise<void>;
}

export function renderKnowledgeDashboard(host: CodexKnowledgeDashboardHost): void {
  if (!host.knowledgeDashboardEl) return;
  const session = host.ensureSession();
  const recovery = host.plugin.getKnowledgeBaseManager()?.maintenanceRecoveryStatus ?? {
    state: "ready" as const,
    message: ""
  };
  renderKnowledgeDashboardView(
    host.knowledgeDashboardEl,
    {
      visible: host.isKnowledgeBaseSession(session),
      snapshot: host.knowledgeDashboardSnapshot,
      expanded: host.knowledgeDashboardExpanded,
      loading: host.knowledgeDashboardLoading,
      error: host.knowledgeDashboardError,
      recovery
    },
    {
      onRefresh: () => void host.refreshKnowledgeDashboard(true),
      onToggleExpanded: () => {
        host.knowledgeDashboardExpanded = !host.knowledgeDashboardExpanded;
        host.renderKnowledgeDashboard();
      },
      onOpenRulesFile: (snapshot) => void openKnowledgeDashboardRulesFile(host, snapshot)
    },
    host.knowledgeDashboardTooltipState
  );
}

export async function refreshKnowledgeDashboard(host: CodexKnowledgeDashboardHost, force = false): Promise<void> {
  if (!host.knowledgeDashboardEl) return;
  const session = host.ensureSession();
  if (!host.isKnowledgeBaseSession(session)) {
    host.renderKnowledgeDashboard();
    return;
  }
  if (host.knowledgeDashboardLoading && !force) return;
  const manager = host.plugin.getKnowledgeBaseManager();
  if (!manager) return;
  const requestId = ++host.knowledgeDashboardRequestId;
  host.knowledgeDashboardLoading = true;
  host.knowledgeDashboardError = "";
  host.renderKnowledgeDashboard();
  try {
    const snapshot = await manager.getDashboardSnapshot();
    if (requestId !== host.knowledgeDashboardRequestId) return;
    host.knowledgeDashboardSnapshot = snapshot;
  } catch (error) {
    if (requestId !== host.knowledgeDashboardRequestId) return;
    host.knowledgeDashboardError = error instanceof Error ? error.message : String(error);
  } finally {
    if (requestId === host.knowledgeDashboardRequestId) {
      host.knowledgeDashboardLoading = false;
      host.renderKnowledgeDashboard();
    }
  }
}

export async function openKnowledgeDashboardRulesFile(host: CodexKnowledgeDashboardHost, snapshot: KnowledgeBaseDashboardSnapshot): Promise<void> {
  if (!snapshot.rulesFileExists) {
    new Notice(`知识库规则文件缺失：${snapshot.rulesFilePath}。请到设置里修正规则文件。`);
    return;
  }
  const file = host.app.vault.getAbstractFileByPath(normalizePath(snapshot.rulesFilePath));
  if (file instanceof TFile) {
    await host.app.workspace.getLeaf("tab").openFile(file, { active: true });
    return;
  }
  new Notice(`没有在当前 Obsidian 仓库找到：${snapshot.rulesFilePath}`);
}

export function clearKnowledgeDashboardTooltips(host: CodexKnowledgeDashboardHost): void {
  clearKnowledgeDashboardHealthTooltips(host.knowledgeDashboardTooltipState);
}
