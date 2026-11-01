import { TFolder } from "obsidian";
import { getExcalidrawService } from "../excalidraw/service";
import { parseDrawingOutput } from "../excalidraw/elements";
import { drawingStyleLabel } from "../excalidraw/templates";
import { knowledgeExcalidrawLocation } from "../knowledge-base/folder-bindings";
import { assertGenerationPathSafe, type GenerationSourceAssessment } from "../generation/sources";
import { generationFileStem } from "../generation/output";
import { parseGenerationModelJson } from "../generation/request";
import type { GenerationRequest, GenerationResult } from "../generation/types";
import type { GenerationExecutionIdentity, GenerationStage } from "../generation/runtime";
import type { GenerationProductionOptions } from "./generation-production";

export function assertDrawingBinding(options: GenerationProductionOptions, request: GenerationRequest): void {
  const reason = getExcalidrawService(options.app).disabledReason(); if (reason) throw new Error(reason);
  const location = knowledgeExcalidrawLocation(options.bindings());
  if (location.directory !== request.outputDirectory) throw new Error("手绘图保存位置已改变，请重新打开生成弹窗。");
  const existing = options.app.vault.getAbstractFileByPath(location.directory);
  if (existing && !(existing instanceof TFolder) || !existing && !location.createIfMissing) throw new Error("手绘图保存位置已失效，请重新选择文件夹。");
  if (!existing && !(options.app.vault.getAbstractFileByPath(location.directory.split("/").slice(0, -1).join("/")) instanceof TFolder)) throw new Error("手绘图的输出目录已失效，请检查知识库设置。");
}
export async function finishDrawing(options: GenerationProductionOptions, request: GenerationRequest, assessment: GenerationSourceAssessment,
  modelText: string | null, identity: GenerationExecutionIdentity, onStage: (stage: GenerationStage) => Promise<void>): Promise<GenerationResult> {
  const result: GenerationResult = { requestId: request.id, outputKind: "excalidraw", drawingStyle: request.drawingStyle, writeState: "not_written", readFailures: assessment.readFailures, sourcePaths: assessment.sources.map(source => source.path) };
  try {
    identity.signal.throwIfAborted();
    if (!modelText) throw new Error("生成未完成，尚未创建手绘图。");
    const output = parseDrawingOutput(parseGenerationModelJson(modelText), result.sourcePaths, request.drawingStyle);
    Object.assign(result, { title: output.title, boxCount: output.boxCount, arrowCount: output.arrowCount });
    assertDrawingBinding(options, request);
    await assertGenerationPathSafe(options.vaultRoot, request.outputDirectory, true);
    const service = getExcalidrawService(options.app);
    const path = service.choosePath(request.outputDirectory, generationFileStem(output.title, request.template.name));
    await options.assertWrite(path, identity);
    // Bind approval to the exact immutable path, style and complete element payload.
    const preview = { domain: "excalidraw" as const, path, style: drawingStyleLabel(request.drawingStyle!), boxCount: output.boxCount, arrowCount: output.arrowCount, elements: structuredClone(output.elements) };
    await onStage("approval");
    if (!await options.confirmDrawing?.(preview, identity, request.id)) throw new Error("已取消，尚未创建手绘图。");
    identity.signal.throwIfAborted(); assertDrawingBinding(options, request);
    await options.assertWrite(path, identity);
    await assertGenerationPathSafe(options.vaultRoot, request.outputDirectory, true);
    await onStage("saving");
    const receipt = await service.create({ requestId: request.id, path, output, style: request.drawingStyle! });
    result.path = path; result.writeState = "unconfirmed";
    if (!receipt.verified) { result.error = receipt.error; return result; }
    result.writeState = "verified";
    try { await service.openOnce(request.id, path); } catch { result.error = "图已保存，请点击打开按钮查看。"; }
    return result;
  } catch (error) {
    result.error = identity.signal.aborted ? "已取消，尚未创建手绘图。" : error instanceof Error ? error.message : "手绘图生成失败。";
    return result;
  }
}
