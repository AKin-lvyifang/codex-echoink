import type {
  GenerationCanvasDocument,
  GenerationCanvasEdge,
  GenerationCanvasNode,
  GenerationMapHierarchy,
  GenerationMapPoint
} from "./types";

const CENTER_WIDTH = 220;
const BRANCH_WIDTH = 220;
const POINT_WIDTH = 240;
const LEVEL_GAP = 100;
const POINT_GAP = 16;
const GROUP_GAP = 28;
const TEXT_PADDING = 16;
const LINE_HEIGHT = 24;
const MIN_HEIGHT = 64;

function invalid(message: string): never {
  throw new Error(`导图结构无效：${message}`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(`${label}必须是对象。`);
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).some(key => !keys.includes(key))) invalid(`${label}含有不支持的字段。`);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) invalid(`${label}不能为空。`);
  return value.trim().replace(/\r\n?/gu, "\n");
}

function sourcePath(value: unknown): string {
  if (typeof value !== "string" || !value || value.trim() !== value ||
      value.startsWith("/") || /^[a-z]:/iu.test(value) ||
      /[\u0000-\u001f\u007f\\#^|\[\]]/u.test(value) ||
      value.split("/").some(part => !part || part === "." || part === "..") || !/\.md$/iu.test(value)) {
    invalid("来源必须是可用于双链的完整 Vault 相对 Markdown 路径。");
  }
  return value;
}

function readHierarchy(value: unknown, allowedSources?: ReadonlySet<string>): GenerationMapHierarchy {
  const root = record(value, "主题");
  onlyKeys(root, ["title", "branches"], "主题");
  const title = text(root.title, "主题标题");
  if (!Array.isArray(root.branches) || root.branches.length < 3 || root.branches.length > 5) {
    invalid("需要 3–5 个一级分支。");
  }
  const branches = root.branches.map((value, branchIndex) => {
    const branch = record(value, `分支 ${branchIndex + 1}`);
    onlyKeys(branch, ["title", "points"], "分支");
    const title = text(branch.title, "分支标题");
    if (!Array.isArray(branch.points) || branch.points.length < 2 || branch.points.length > 4) {
      invalid("每个分支需要 2–4 个要点。");
    }
    const points = branch.points.map(value => {
      const point = record(value, "要点");
      onlyKeys(point, ["text", "sourcePaths"], "要点");
      const result: GenerationMapPoint = { text: text(point.text, "要点内容") };
      if (point.sourcePaths !== undefined) {
        if (!Array.isArray(point.sourcePaths)) invalid("要点来源必须是路径列表。");
        result.sourcePaths = [...new Set(point.sourcePaths.map(value => {
          const path = sourcePath(value);
          if (allowedSources && !allowedSources.has(path)) invalid(`来源不在所选资料中：${path}`);
          return path;
        }))];
      }
      return result;
    });
    return { title, points };
  });
  return { title, branches };
}

/** Accept hierarchy only; the model cannot supply Canvas IDs or coordinates. */
export function parseGenerationMapHierarchy(value: unknown, allowedSourcePaths: readonly string[]): GenerationMapHierarchy {
  return readHierarchy(value, new Set(allowedSourcePaths));
}

function pointText(point: GenerationMapPoint): string {
  const links = (point.sourcePaths ?? []).map(path => {
    const alias = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/iu, "");
    // Obsidian resolves literal Vault paths. URI encoding changes percent-containing filenames.
    return `[[${path}|${alias}]]`;
  });
  return links.length ? `${point.text}\n\n${links.join("\n")}` : point.text;
}

function textHeight(content: string, width: number): number {
  const available = width - TEXT_PADDING * 2;
  let lines = 0;
  // Conservative text metrics keep Chinese, long words and source-link lines inside the node.
  // Count the complete link syntax too, so paths never reduce the reserved height.
  for (const line of content.split("\n")) {
    let lineWidth = 0;
    let wrappedLines = 1;
    for (const character of line) {
      const characterWidth = /[\p{Mark}\u200d\ufe0e\ufe0f]/u.test(character) ? 0 :
        character === "\t" ? 36 : /^[\u0020-\u007e]$/u.test(character) ? 9 : 18;
      if (lineWidth + characterWidth > available) {
        wrappedLines++;
        lineWidth = 0;
      }
      lineWidth += characterWidth;
    }
    lines += wrappedLines;
  }
  return Math.max(MIN_HEIGHT, lines * LINE_HEIGHT + TEXT_PADDING * 2);
}

/** Lay out the three columns from subtree heights, without relying on a DOM or a model. */
export function layoutGenerationCanvas(hierarchy: GenerationMapHierarchy): GenerationCanvasDocument {
  const parsed = readHierarchy(hierarchy);
  const groups = parsed.branches.map(branch => {
    const points = branch.points.map(point => {
      const content = pointText(point);
      return { text: content, height: textHeight(content, POINT_WIDTH) };
    });
    const branchHeight = textHeight(branch.title, BRANCH_WIDTH);
    const pointsHeight = points.reduce((sum, point) => sum + point.height, 0) + (points.length - 1) * POINT_GAP;
    return { branch, points, branchHeight, pointsHeight, height: Math.max(branchHeight, pointsHeight) };
  });
  const groupsHeight = groups.reduce((sum, group) => sum + group.height, 0) + (groups.length - 1) * GROUP_GAP;
  const centerHeight = textHeight(parsed.title, CENTER_WIDTH);
  const totalHeight = Math.max(centerHeight, groupsHeight);
  const nodes: GenerationCanvasNode[] = [{
    id: "generation-center", type: "text", text: parsed.title,
    x: 0, y: (totalHeight - centerHeight) / 2, width: CENTER_WIDTH, height: centerHeight
  }];
  const edges: GenerationCanvasEdge[] = [];
  let groupY = (totalHeight - groupsHeight) / 2;
  groups.forEach((group, branchIndex) => {
    const branchId = `generation-branch-${branchIndex + 1}`;
    nodes.push({
      id: branchId, type: "text", text: group.branch.title,
      x: CENTER_WIDTH + LEVEL_GAP, y: groupY + (group.height - group.branchHeight) / 2,
      width: BRANCH_WIDTH, height: group.branchHeight, color: "4"
    });
    edges.push({ id: `generation-edge-branch-${branchIndex + 1}`, fromNode: "generation-center", fromSide: "right", toNode: branchId, toSide: "left" });
    let pointY = groupY + (group.height - group.pointsHeight) / 2;
    group.points.forEach((point, pointIndex) => {
      const pointId = `generation-point-${branchIndex + 1}-${pointIndex + 1}`;
      nodes.push({
        id: pointId, type: "text", text: point.text,
        x: CENTER_WIDTH + LEVEL_GAP + BRANCH_WIDTH + LEVEL_GAP,
        y: pointY, width: POINT_WIDTH, height: point.height
      });
      edges.push({ id: `generation-edge-point-${branchIndex + 1}-${pointIndex + 1}`, fromNode: branchId, fromSide: "right", toNode: pointId, toSide: "left" });
      pointY += point.height + POINT_GAP;
    });
    groupY += group.height + GROUP_GAP;
  });
  return { nodes, edges };
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) invalid("节点和连线的 ID 不能为空。");
  return value;
}

/** Validate the generated text-only Canvas before it can reach the write layer. */
export function validateGenerationCanvas(value: unknown): asserts value is GenerationCanvasDocument {
  const document = record(value, "Canvas");
  onlyKeys(document, ["nodes", "edges"], "Canvas");
  if (!Array.isArray(document.nodes) || document.nodes.length === 0 || !Array.isArray(document.edges)) {
    invalid("Canvas 需要非空节点列表和连线列表。");
  }
  const ids = new Set<string>();
  const nodeIds = new Set<string>();
  const bounds: Array<{ id: string; x: number; y: number; right: number; bottom: number }> = [];
  for (const value of document.nodes) {
    const node = record(value, "节点");
    onlyKeys(node, ["id", "type", "text", "x", "y", "width", "height", "color"], "节点");
    const id = identifier(node.id);
    if (ids.has(id)) invalid(`ID 重复：${id}`);
    ids.add(id);
    nodeIds.add(id);
    if (node.type !== "text") invalid("只支持文本节点。");
    text(node.text, "节点内容");
    for (const key of ["x", "y", "width", "height"] as const) {
      if (typeof node[key] !== "number" || !Number.isFinite(node[key])) invalid("节点坐标和尺寸必须是有限数值。");
    }
    const { x, y, width, height } = node as unknown as GenerationCanvasNode;
    if (width <= 0 || height <= 0 || !Number.isFinite(x + width) || !Number.isFinite(y + height)) {
      invalid("节点尺寸必须大于零，边界必须是有限数值。");
    }
    if (node.color !== undefined && (typeof node.color !== "string" || !/^(?:[1-6]|#[0-9a-f]{6})$/iu.test(node.color))) {
      invalid("节点颜色必须是 Canvas 预设色或十六进制颜色。");
    }
    bounds.push({ id, x, y, right: x + width, bottom: y + height });
  }
  for (const value of document.edges) {
    const edge = record(value, "连线");
    onlyKeys(edge, ["id", "fromNode", "fromSide", "toNode", "toSide"], "连线");
    const id = identifier(edge.id);
    if (ids.has(id)) invalid(`ID 重复：${id}`);
    ids.add(id);
    if (typeof edge.fromNode !== "string" || typeof edge.toNode !== "string" ||
        !nodeIds.has(edge.fromNode) || !nodeIds.has(edge.toNode)) invalid("连线必须指向存在的节点。");
    if (edge.fromSide !== "right" || edge.toSide !== "left") invalid("连线必须从父节点右侧连接子节点左侧。");
  }
  for (let index = 0; index < bounds.length; index++) {
    const a = bounds[index];
    for (let next = index + 1; next < bounds.length; next++) {
      const b = bounds[next];
      if (a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom) {
        invalid(`节点重叠：${a.id}、${b.id}`);
      }
    }
  }
}

export function serializeGenerationCanvas(hierarchy: GenerationMapHierarchy): string {
  const document = layoutGenerationCanvas(hierarchy);
  validateGenerationCanvas(document);
  return JSON.stringify(document);
}
