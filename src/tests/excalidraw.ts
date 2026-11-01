import { runDiagramToolTests } from "./pi-native/diagram-tools";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Platform, TFile, TFolder } from "obsidian";
import { parseDrawingOutput } from "../excalidraw/elements";
import { ExcalidrawService } from "../excalidraw/service";
import { drawingTemplateContent } from "../excalidraw/templates";
import { emptyKnowledgeFolderBindings, knowledgeExcalidrawLocation, knowledgeFolderBindingsSignature, normalizeKnowledgeFolderBindings, rebaseKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { defaultGenerationTemplates, normalizeGenerationTemplates } from "../settings/generation-templates";
import { createGenerationRequest, generationSystemPrompt } from "../generation/request";
import { isGenerationSourcePath } from "../generation/sources";
import { formatApprovalPresentation } from "../ui/codex-view/approval-presentation";
import { createGenerationRuntimePort } from "../plugin/generation-production";
import type { GenerationExecutionIdentity } from "../generation/runtime";
import { isKnowledgeMaintenanceSourcePath } from "../knowledge-base/raw-digest-core";

const model = () => ({ title: "资料到知识", elements: [
  { id: "a", type: "rectangle", x: 0, y: 0, width: 320, height: 140, label: { text: "📖 读取资料" }, sourcePaths: ["资料/原文.md"] },
  { id: "b", type: "rectangle", x: 450, y: 0, width: 320, height: 140, label: { text: "🧩 整理知识" }, sourcePaths: ["资料/原文.md"] },
  { id: "ab", type: "arrow", x: 0, y: 0, start: { id: "a" }, end: { id: "b" } }
] });
export async function runExcalidrawTests(root: string): Promise<void> {
  const previous = Platform.isDesktopApp; Platform.isDesktopApp = true;
  try { await assertExcalidrawTests(root); } finally { Platform.isDesktopApp = previous; }
}
async function assertExcalidrawTests(root: string): Promise<void> {
  await runDiagramToolTests(root);
  const output = parseDrawingOutput(model(), ["资料/原文.md"]);
  assert.equal(output.boxCount, 2); assert.equal(output.arrowCount, 1);
  assert.equal(output.elements.find(e => e.id === "a")!.fontFamily, undefined, "CLI only accepts container fonts inside label");
  assert.equal(output.elements.find(e => e.id === "a")!.label!.fontFamily, 5);
  assert.equal(output.elements.find(e => e.id === "ab")!.x, 320);
  assert.deepEqual(output.elements.find(e => e.id === "ab")!.points, [[0, 0], [130, 0]], "arrow geometry joins the real box edges before the converter binds it");
  assert.equal(output.elements.at(-1)!.text, "来源：原文");
  assert.equal(output.elements.filter(element => element.text?.startsWith("来源：")).length, 1);
  assert.equal(output.elements.find(element => element.id === "a")!.link, "[[资料/原文.md]]");
  assert.equal(output.elements[0].text, "资料到知识");
  assert.equal(output.elements[0].fontSize, 48);
  assert.equal(output.elements.at(-1)!.fontSize, 16);
  assert(output.elements.at(-1)!.y > Math.max(...output.elements.filter(e => e.label).map(e => e.y + e.height!)));
  assert.equal(parseDrawingOutput(model(), ["资料/原文.md"], "blackboard").elements.find(e => e.id === "a")!.backgroundColor, "transparent");
  const grouped = model(); (grouped.elements as unknown[]).push({ id: "g", type: "frame", name: "流程", children: ["a", "b"] });
  const grouping = parseDrawingOutput(grouped, ["资料/原文.md"]);
  assert.equal(grouping.elements.find(e => e.text === "流程")!.fontSize, 32);
  assert.equal(grouping.elements.find(e => e.id === "g")!.children!.length, 3);
  const frame = grouping.elements.find(e => e.id === "g")!;
  assert(grouping.elements.filter(e => frame.children!.includes(e.id)).every(e => e.y > frame.y && e.y + (e.height ?? e.fontSize! * 1.35) < frame.y + frame.height!), "explicit frame bounds contain their heading and boxes");
  const interleaved = model(); (interleaved.elements as unknown[]).push({ ...model().elements[0], id: "c", x: 900 }, { ...model().elements[0], id: "d", x: 0, y: 220 }, { id: "g1", type: "frame", name: "准备", children: ["a", "b"] }, { id: "g2", type: "frame", name: "分析", children: ["c", "d"] });
  assert.throws(() => parseDrawingOutput(interleaved, ["资料/原文.md"]), /分组.*重叠/u);
  const crossing = model(); crossing.elements[1].x = 800; (crossing.elements as unknown[]).push({ ...model().elements[0], id: "middle", x: 400 });
  assert.throws(() => parseDrawingOutput(crossing, ["资料/原文.md"]), /连线.*穿过/u);
  const wide = model(); wide.elements[1].x = 1800;
  assert.throws(() => parseDrawingOutput(wide, ["资料/原文.md"]), /1600/u);
  const many = { ...model(), elements: Array.from({ length: 13 }, (_, i) => ({ ...model().elements[0], id: String(i), x: (i % 3) * 400, y: Math.floor(i / 3) * 220 })) };
  assert.throws(() => parseDrawingOutput(many, ["资料/原文.md"]), /1–12/u);
  const emoji = model(); emoji.elements[0].width = 100; emoji.elements[0].height = 60; emoji.elements[0].label!.text = "👩‍🌾 种";
  assert.equal(parseDrawingOutput(emoji, ["资料/原文.md"]).elements.find(e => e.id === "a")!.height, 104, "one emoji grapheme still takes room during wrapping");

  const overlap = model(); overlap.elements[1].x = 310;
  assert.ok(parseDrawingOutput(overlap, ["资料/原文.md"]).elements.find(e => e.id === "b")!.x > 320);
  const collision = model(); collision.elements[1].x = 0;
  assert.throws(() => parseDrawingOutput(collision, ["资料/原文.md"]), /严重重叠/u);
  const dangling = model(); dangling.elements[2].end = { id: "missing" };
  assert.throws(() => parseDrawingOutput(dangling, ["资料/原文.md"]), /两端/u);
  assert.throws(() => parseDrawingOutput(model(), ["资料/其他.md"]), /来源/u);
  assert.throws(() => parseDrawingOutput({ ...model(), elements: Array.from({ length: 81 }, () => model().elements[0]) }), /1–80/u);
  const outside = model(); outside.elements[0].x = 10001; assert.throws(() => parseDrawingOutput(outside), /范围/u);
  assert.equal(isGenerationSourcePath("资料/图.excalidraw.md"), false);
  assert.equal(isKnowledgeMaintenanceSourcePath("资料/图.excalidraw.md"), false);
  const bindings = emptyKnowledgeFolderBindings(); bindings.roles.outputs = { enabled: true, readPaths: ["输出"], writePath: "输出", allowedSubdirectories: [] };
  assert.equal(knowledgeExcalidrawLocation(bindings).directory, "输出/导图");
  const signature = knowledgeFolderBindingsSignature(bindings); bindings.excalidrawDirectory = "普通/图";
  assert.notEqual(knowledgeFolderBindingsSignature(bindings), signature);
  assert.equal(normalizeKnowledgeFolderBindings(bindings)!.excalidrawDirectory, "普通/图", "shared mobile settings normalization preserves the desktop field");
  assert.equal(rebaseKnowledgeFolderBindings(bindings, "普通", "改名").excalidrawDirectory, "改名/图");
  bindings.excalidrawDirectory = "../invalid"; assert.throws(() => knowledgeExcalidrawLocation(normalizeKnowledgeFolderBindings(bindings)), /检查/u);
  delete bindings.excalidrawDirectory;
  const template = defaultGenerationTemplates().find(item => item.id === "drawing")!;
  assert.equal(normalizeGenerationTemplates([{ ...template, description: "我的说明", outputKind: "markdown" }]).find(item => item.id === "drawing")!.outputKind, "excalidraw");
  const request = createGenerationRequest(template, ["资料/原文.md"], "输出", { directory: "输出/导图", style: "blackboard" });
  assert.throws(() => generationSystemPrompt(request), /元素格式/u);
  assert.match(generationSystemPrompt(request, undefined, "INSTALLED_SCHEMA"), /INSTALLED_SCHEMA/u);
  assert.match(drawingTemplateContent("blackboard"), /excalidraw-export-dark: true/u);
  assert.match(drawingTemplateContent("white"), /excalidraw-export-dark: false/u);
  const presentation = formatApprovalPresentation({ language: "zh-CN", target: JSON.stringify({ relativePath: "输出/图.excalidraw.md" }), preview: JSON.stringify({ domain: "excalidraw", path: "输出/图.excalidraw.md", style: "黑板", boxCount: 2, arrowCount: 1, elements: output.elements }) });
  assert.equal(presentation.action, "创建手绘图"); assert.equal(presentation.changes.length, 3); assert.equal(presentation.destination[0].value, "输出/图.excalidraw.md");

  const directory = path.join(root, "drawing"); await mkdir(directory); await mkdir(path.join(directory, "输出")); await mkdir(path.join(directory, "资料")); await writeFile(path.join(directory, "资料/原文.md"), "读取资料，整理知识。");
  const files = new Map<string, TFile | TFolder>([["输出", new TFolder()], ["资料", new TFolder()]]);
  let creates = 0, opens = 0, uncertain = false;
  const cli = { manifest: { version: "2.29.0" }, isReady: true, settings: Object.freeze({ matchThemeAlways: true }), executeCLI: async (input: Record<string, unknown>) => {
    if (input.command === "schema") return { ok: true, data: { jsonSchema: { type: "object" }, example: {} } };
    if (input.command === "read") return { ok: true, data: { elements: output.elements.flatMap(element => [{ ...element, ...(element.type === "arrow" ? { startBinding: {}, endBinding: {} } : {}) }, ...(element.label ? [{ type: "text", originalText: element.label.text }] : [])]) } };
    creates++; files.set(String(input.path), new TFile(String(input.path))); await writeFile(path.join(directory, String(input.path)), "drawing");
    return uncertain ? { ok: false, mutation: "unknown", persistence: "unknown", error: { code: "OUTCOME_UNKNOWN" } } : { ok: true, mutation: "applied", persistence: "saved" };
  } };
  const registry = { manifests: { "obsidian-excalidraw-plugin": {} }, plugins: { "obsidian-excalidraw-plugin": cli }, enabledPlugins: new Set(["obsidian-excalidraw-plugin"]) };
  const app = { plugins: registry, metadataCache: { getFileCache: () => ({ frontmatter: { "excalidraw-plugin": "parsed", "excalidraw-export-dark": true } }) }, vault: { getAbstractFileByPath: (name: string) => files.get(name),
    createFolder: async (name: string) => { await mkdir(path.join(directory, name)); files.set(name, new TFolder()); },
    create: async (name: string, content: string) => { await writeFile(path.join(directory, name), content); const file = new TFile(name); files.set(name, file); return file; },
    read: (file: TFile) => readFile(path.join(directory, file.path), "utf8") }, workspace: { getLeaf: () => ({ openFile: async () => { opens++; } }) } } as never;
  const service = new ExcalidrawService(app);
  assert.equal(service.disabledReason(), null);
  registry.enabledPlugins.clear(); assert.match(service.disabledReason()!, /启用/u); registry.enabledPlugins.add("obsidian-excalidraw-plugin");
  cli.manifest.version = "2.28.9"; assert.match(service.disabledReason()!, /版本太低/u); cli.manifest.version = "2.29.0";
  cli.isReady = false; assert.match(service.disabledReason()!, /初始化/u); cli.isReady = true;
  const desktop = Platform.isDesktopApp; Platform.isDesktopApp = false; assert.match(service.disabledReason()!, /电脑端/u); Platform.isDesktopApp = desktop;
  const identity = { conversationId: "drawing-test", piSessionId: "pi", productRunId: "run", vaultId: "vault", access: { permission: "workspace-write", mode: "agent" }, signal: new AbortController().signal } as GenerationExecutionIdentity;
  const port = createGenerationRuntimePort({ app, vaultRoot: directory, bindings: () => bindings, assertRead: async () => {}, assertWrite: async () => {}, authorization: () => { throw Error("drawing does not enter note serialization"); }, domain: {} as never, writeExecution: {} as never, confirmDrawing: async () => false });
  const assessment = await port.prepare(request, identity);
  const before = await readdir(directory);
  const cancelled = await port.finish(request, assessment, JSON.stringify(model()), identity, async () => {});
  assert.equal(cancelled.writeState, "not_written"); assert.deepEqual(await readdir(directory), before); assert.equal(creates, 0);
  const target = service.choosePath("输出/导图", "图");
  const input = { requestId: "same-request", path: target, style: "blackboard" as const, output };
  assert.equal((await service.create(input)).verified, true); assert.equal((await service.create(input)).verified, true); assert.equal(creates, 1);
  await service.openOnce(input.requestId, target); await service.openOnce(input.requestId, target); assert.equal(opens, 1);
  assert.match(service.choosePath("输出/导图", "图"), /图 2\.excalidraw\.md$/u);
  await assert.rejects(service.create({ ...input, path: target + "other" }), /换名重建/u);
  uncertain = true; assert.equal((await service.create({ ...input, requestId: "unknown-request", path: service.choosePath("输出/导图", "图") })).verified, true, "unknown outcome reconciles exact path and expected elements");
  assert.equal(creates, 2); assert.equal(cli.settings.matchThemeAlways, true);
  console.log("PASS Excalidraw: validation, independent binding, portable settings, readable approval, zero-write cancel, stable identity, exact-path reconciliation and one-time open");
}
