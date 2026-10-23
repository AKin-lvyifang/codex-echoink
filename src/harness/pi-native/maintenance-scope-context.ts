import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { PiKnowledgeMaintenanceScope, PiProductRunRecord } from "./contracts";
import { isRawMarkdownPath } from "../../knowledge-base/raw-digest";
import { workbenchTaskSourceFromEntries } from "../../home/workbench-context";
import { knowledgePathRole } from "../../knowledge-base/root-paths";

export const MAINTENANCE_SCOPE_CONTEXT_TYPE = "echoink-maintenance-scope-v1";
export const MAINTENANCE_SCOPE_REQUIRED_MESSAGE = "请说明要维护哪些资料；当前没有可继续的未完成维护范围。";

/** Product-owned selection facts; never a capability or authority to write. */
export interface MaintenanceScopeContext {
  readonly productRunId: string;
  readonly request: string;
  readonly scope: PiKnowledgeMaintenanceScope;
  readonly folderBindingsRevision?: number;
}

export function maintenanceScopePaths(scope: PiKnowledgeMaintenanceScope): readonly string[] {
  return scope.mode === "query" ? scope.candidatePaths : scope.sourcePaths ?? [];
}

export function freezeMaintenanceScopeContext(value: unknown): Readonly<MaintenanceScopeContext> | null {
  const root = record(value), scope = record(root?.scope);
  if (!root || !scope || typeof root.productRunId !== "string" || !root.productRunId.trim() || typeof root.request !== "string") return null;
  const paths = scope.mode === "query" ? scope.candidatePaths : scope.sourcePaths;
  if (!["global", "exact", "batch", "query"].includes(String(scope.mode)) || !Array.isArray(paths)
    || paths.some(value => typeof value !== "string" || !isRawMarkdownPath(value) || value.split("/").some(part => !part || part === "." || part === ".."))
    || new Set(paths).size !== paths.length || paths.length > (scope.mode === "query" ? 12 : 20)
    || scope.mode === "exact" && paths.length !== 1 || scope.mode !== "global" && paths.length === 0) return null;
  const revision = root.folderBindingsRevision ?? scope.folderBindingsRevision;
  if (revision !== undefined && (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0)) return null;
  const frozenPaths = Object.freeze([...paths]) as readonly string[];
  const frozenScope: PiKnowledgeMaintenanceScope = scope.mode === "query" ? { mode: "query", candidatePaths: frozenPaths }
    : scope.mode === "exact" ? { mode: "exact", sourcePaths: frozenPaths as readonly [string] }
    : { mode: scope.mode as "global" | "batch", sourcePaths: frozenPaths, ...(revision === undefined ? {} : { folderBindingsRevision: revision as number }) };
  return Object.freeze({ productRunId: root.productRunId, request: root.request, scope: Object.freeze(frozenScope),
    ...(revision === undefined ? {} : { folderBindingsRevision: revision as number }) });
}

/** A narrow confirmation grammar prevents unrelated ordinary messages inheriting. */
export function isMaintenanceScopeConfirmation(text: string): boolean {
  const value = text.trim().replace(/^\/maintain\s*/iu, "").replace(/[\s，。！？、,.!?；;]+$/gu, "");
  // A reference to the original checklist may carry execution instructions.
  // Explicit replacement sources/queries still take precedence over recovery.
  if (/[^\s`\[\]<>|，。；]+\/[^\s`\[\]<>|，。；]+\.(?:markdown|md)(?![a-z0-9_.-])/iu.test(value)
    || /(?:改为|改成|换成)(?:[^。；\n]*)(?:来源|资料|笔记|主题|范围)|(?:另外|另行|重新)(?:维护|整理|处理|选择|检索|搜索)/u.test(value)) return false;
  if (/^(?:请[，,\s]*)?(?:继续|接着)(?:整理|维护|处理|执行|完成|写完)?(?:当前|原来?|上次|刚才|这)(?:的|这)?(?:一?批|维护清单|写作清单|清单|维护任务|整理任务|进度)/u.test(value)) return true;
  return /^(?:(?:好的?|可以|行|嗯)[，,\s]*)?(?:都?按(?:照)?(?:你(?:的)?推荐(?:的)?|推荐(?:的)?(?:方案)?|(?:刚才|上面)(?:的)?方案)(?:去)?(?:做|执行|整理|维护)|就(?:按这个|这么)(?:做|执行|办)|继续(?:吧|执行|整理|维护|处理)?|确认(?:执行)?|执行吧|开始吧|好的?|可以|行)$/u.test(value)
    || /^(?:yes|ok(?:ay)?|go ahead|continue|proceed)(?: please)?$/iu.test(value);
}

/** Capture a new selection even when the Agent only gives advice this turn. */
export function isNewMaintenanceScopeRequest(text: string, vaultRootPath?: string): boolean {
  if (isMaintenanceScopeConfirmation(text)) return false;
  const value = text.trim();
  const explicitPath = /[^\s`\[\]<>|，。；]+\/[^\s`\[\]<>|，。；]+\.(?:markdown|md)(?![a-z0-9_.-])/giu;
  const paths = [...value.matchAll(explicitPath)].map(match => match[0]);
  // A Raw selection need not start with an imperative. Wiki/Projects paths
  // describe targets; unknown paths still go through the resolver's rejection.
  if (paths.length) {
    if (!vaultRootPath || paths.some(relative => !["wiki", "projects"].includes(knowledgePathRole(vaultRootPath, relative) ?? ""))) return true;
    return false;
  }
  return /^(?:(?:请|帮我|这次|本次|现在|先|只|麻烦|给我|我要|我想)[，,\s]*)*(?:改为|改成|换成)?(?:维护|整理|处理)/u.test(value)
    && /(?:资料|笔记|知识库|\.(?:markdown|md)(?![a-z0-9_.-]))/iu.test(value);
}

/** Explicit task changes end inheritance; clarification and failed turns do not. */
function maintenanceTopicBoundary(text: string, vaultRootPath?: string): boolean {
  if (isMaintenanceScopeConfirmation(text)) return false;
  return isNewMaintenanceScopeRequest(text, vaultRootPath) || /^\s*\/(?:ask|maintain|dream|skill:)/iu.test(text)
    || /(?:换(?:个|一个)?话题|另(?:一个|外的?)问题|接下来(?:聊|谈)|(?:不要|不再|停止|取消|暂停)(?:继续)?(?:整理|维护|处理)(?:这些|这批)?(?:资料|笔记|知识库)?)/u.test(text);
}

/** Only durable selections whose owning user entry is on this branch qualify. */
export function maintenanceScopeContextFromEntries(
  entries: readonly SessionEntry[],
  runs: readonly Readonly<PiProductRunRecord>[],
  options: Readonly<{ excludeProductRunId?: string; throughProductRunId?: string; vaultRootPath?: string }> = {}
): Readonly<MaintenanceScopeContext> | null {
  const positions = new Map(entries.map((entry, index) => [entry.id, index]));
  const through = options.throughProductRunId ? runs.find(run => run.productRunId === options.throughProductRunId) : undefined;
  const throughPosition = through ? positions.get(through.userEntryId) : undefined;
  if (options.throughProductRunId && throughPosition === undefined) return null;
  const branchRuns = runs.filter(run => run.productRunId !== options.excludeProductRunId && positions.has(run.userEntryId)
    && (throughPosition === undefined || positions.get(run.userEntryId)! <= throughPosition));
  const runById = new Map(branchRuns.map(run => [run.productRunId, run]));
  const contexts: MaintenanceScopeContext[] = [];
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== MAINTENANCE_SCOPE_CONTEXT_TYPE) continue;
    const context = freezeMaintenanceScopeContext(entry.data);
    // Older composer preflight searched continuation instructions as a query.
    // These are not new selection facts; recover the preceding owning scope.
    if (context && runById.has(context.productRunId)
      && !(context.scope.mode === "query" && isMaintenanceScopeConfirmation(context.request))) contexts.push(context);
  }
  // Pre-V9 signal7 already persisted its exact selection in before_agent_start.
  // It is repeated as background material on later turns; only its first entry
  // owns that selection, otherwise a later topic could revive an old snapshot.
  const seenSources = new Set<string>();
  for (let index = 0; index < entries.length; index++) {
    const source = workbenchTaskSourceFromEntries([entries[index]]);
    if (!source || source.signalId !== 7 || source.moduleId !== "knowledge-base") continue;
    const key = `${source.businessKey}:${source.capturedAt}`;
    if (seenSources.has(key)) continue;
    seenSources.add(key);
    const user = entries.slice(0, index).reverse().find(entry => entry.type === "message" && entry.message.role === "user");
    const run = user && branchRuns.find(run => run.userEntryId === user.id);
    if (!run || contexts.some(context => context.productRunId === run.productRunId)) continue;
    const context = freezeMaintenanceScopeContext({ productRunId: run.productRunId, request: source.prompt, scope: { mode: "batch", sourcePaths: source.objects } });
    if (context) contexts.push(context);
  }
  contexts.sort((left, right) => positions.get(runById.get(right.productRunId)!.userEntryId)! - positions.get(runById.get(left.productRunId)!.userEntryId)!);
  const latest = contexts[0];
  if (!latest) return null;
  const position = positions.get(runById.get(latest.productRunId)!.userEntryId)!;
  const end = throughPosition === undefined ? entries.length : throughPosition + 1;
  if (entries.slice(position + 1, end).some(entry => entry.type === "message" && entry.message.role === "user" && maintenanceTopicBoundary(messageText(entry.message), options.vaultRootPath))) return null;
  return latest;
}

function messageText(message: { content: unknown }): string {
  return typeof message.content === "string" ? message.content : Array.isArray(message.content)
    ? message.content.flatMap(part => part?.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n") : "";
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
