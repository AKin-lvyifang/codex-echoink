import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { WORKSPACE_MAX_BYTES, WORKSPACE_ROOT, WorkspaceError, type WorkspaceGuard, type WorkspaceService } from "./service";

export interface WorkspaceToolsOptions { guard: WorkspaceGuard }
const result = (details: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(details) }], details });
/** These explicit tools are the only model-facing workspace surface. */
export function createWorkspaceTools(service: WorkspaceService, options: WorkspaceToolsOptions): AgentTool[] {
  if (typeof options?.guard !== "function") throw new WorkspaceError("unsafe_adapter", "工作区工具缺少权限校验，未启用。");
  const path = Type.String({ minLength: 1, maxLength: 512 });
  const content = Type.String({ maxLength: WORKSPACE_MAX_BYTES });
  return [
    { name: "workspace_read", label: "读取工作区", description: `读取 ${WORKSPACE_ROOT}/ 内的 HTML、CSS、JS 或 MD 纯文本。返回完整内容和 contentRevision；修改时必须原样传入该版本。不能读取配置、隐藏目录或工作区外文件。`,
      parameters: Type.Object({ path }),
      async execute(_id, input: { path: string }, signal) { return result(await service.read(input, options.guard, signal)); } },
    { name: "workspace_create", label: "新建工作区文件", description: `只在 ${WORKSPACE_ROOT}/ 新建 HTML、CSS、JS、MD 文件；同名文件不覆盖。HTML 结果包含 previewPath 供用户交互预览。预览支持内联或相对 CSS/JS，不支持网络、CSS url/@import 或 JS 模块 import。`,
      parameters: Type.Object({ path, content }),
      async execute(_id, input: { path: string; content: string }, signal) { return result(await service.create(input, options.guard, signal)); } },
    { name: "workspace_update", label: "修改工作区文件", description: "修改已有工作区文本。先 workspace_read 读取，再原样传入 contentRevision 为 expectedRevision 和完整新内容；用户修改或版本冲突时拒绝覆盖。HTML 结果包含 previewPath。",
      parameters: Type.Object({ path, expectedRevision: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }), content }),
      async execute(_id, input: { path: string; expectedRevision: string; content: string }, signal) { return result(await service.update(input, options.guard, signal)); } }
  ];
}
