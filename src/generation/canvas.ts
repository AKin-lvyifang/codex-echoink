import type {
  GenerationCanvasDocument,
  GenerationCanvasEdge,
  GenerationCanvasNode,
  GenerationCanvasOutput,
  GenerationMapHierarchy,
  GenerationMapPoint,
  GenerationSource
} from "./types";

const CENTER_WIDTH = 220;
const BRANCH_WIDTH = 220;
const POINT_WIDTH = 240;
const LEVEL_GAP = 100;
const POINT_GAP = 16;
const GROUP_GAP = 28;
const TEXT_PADDING = 16;
const LINE_HEIGHT = 24;
const PARAGRAPH_GAP = 16;
const NODE_BORDER = 1;

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
      /[\\#^|[\]]/u.test(value) || Array.from(value).some(character => {
        const code = character.charCodeAt(0);
        return code <= 0x1f || code === 0x7f;
      }) ||
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
  const available = width - (TEXT_PADDING + NODE_BORDER) * 2;
  // Native Canvas uses 16px text / 24px lines, 16px paragraph gaps and up to
  // 16px of space at each end. Its first/last paragraph margins are removed.
  // Measure aliased wikilinks as their visible labels; the target stays intact in the node.
  const visible = content.replace(/\[\[[^\]\n|]+\|([^\]\n]+)\]\]/gu, "$1");
  const paragraphs = visible.split(/\n\s*\n/u);
  let lines = 0;
  for (const paragraph of paragraphs) {
    for (const line of paragraph.split("\n")) {
      let lineWidth = 0;
      let wrappedLines = 1;
      for (const character of line) {
        const characterWidth = /\p{Mark}|\u200d|\ufe0e|\ufe0f/u.test(character) ? 0 :
          character === "\t" ? 32 : /^[\u0020-\u007e]$/u.test(character) ? 8 : 16;
        if (lineWidth + characterWidth > available) {
          wrappedLines++;
          lineWidth = 0;
        }
        lineWidth += characterWidth;
      }
      lines += wrappedLines;
    }
  }
  return lines * LINE_HEIGHT + (paragraphs.length - 1) * PARAGRAPH_GAP + (TEXT_PADDING + NODE_BORDER) * 2;
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

function color(value: unknown): void {
  if (value !== undefined && (typeof value !== "string" || !/^(?:[1-6]|#[0-9a-f]{6})$/iu.test(value))) {
    invalid("颜色必须是 Canvas 预设色或十六进制颜色。");
  }
}

function httpUrl(value: unknown): string {
  if (typeof value !== "string" || !/^https?:\/\//iu.test(value) || /\s|[\u0000-\u001f\u007f]/u.test(value)) {
    invalid("链接网址必须是完整的 http 或 https URL。");
  }
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return value;
  } catch { /* Report the same validation error for malformed URLs. */ }
  return invalid("链接网址必须是完整的 http 或 https URL。");
}

/** Validate structure and geometry only; source authorization belongs to the parser. */
export function validateGenerationCanvas(value: unknown): asserts value is GenerationCanvasDocument {
  const document = record(value, "Canvas");
  onlyKeys(document, ["nodes", "edges"], "Canvas");
  if (!Array.isArray(document.nodes) || document.nodes.length === 0 || !Array.isArray(document.edges)) {
    invalid("Canvas 需要非空节点列表和连线列表。");
  }
  const ids = new Set<string>();
  const nodeIds = new Set<string>();
  const bounds: Array<{ id: string; group: boolean; x: number; y: number; right: number; bottom: number }> = [];
  for (const value of document.nodes) {
    const node = record(value, "节点");
    const common = ["id", "type", "x", "y", "width", "height", "color"];
    switch (node.type) {
      case "text":
        onlyKeys(node, [...common, "text"], "文本节点");
        text(node.text, "节点内容");
        break;
      case "file":
        onlyKeys(node, [...common, "file", "subpath"], "文件节点");
        sourcePath(node.file);
        if (node.subpath !== undefined && (typeof node.subpath !== "string" || !node.subpath.startsWith("#"))) {
          invalid("文件节点的 subpath 必须以 # 开头。");
        }
        break;
      case "link":
        onlyKeys(node, [...common, "url"], "链接节点");
        httpUrl(node.url);
        break;
      case "group":
        onlyKeys(node, [...common, "label"], "分组节点");
        if (node.label !== undefined && typeof node.label !== "string") invalid("分组标签必须是文本。");
        break;
      default:
        invalid("节点类型必须是 text、file、link 或 group。");
    }
    const id = identifier(node.id);
    if (ids.has(id)) invalid(`ID 重复：${id}`);
    ids.add(id);
    nodeIds.add(id);
    for (const key of ["x", "y", "width", "height"] as const) {
      if (typeof node[key] !== "number" || !Number.isFinite(node[key])) invalid("节点坐标和尺寸必须是有限数值。");
    }
    const { x, y, width, height } = node as unknown as GenerationCanvasNode;
    if (width <= 0 || height <= 0 || !Number.isFinite(x + width) || !Number.isFinite(y + height)) {
      invalid("节点尺寸必须大于零，边界必须是有限数值。");
    }
    color(node.color);
    bounds.push({ id, group: node.type === "group", x, y, right: x + width, bottom: y + height });
  }
  for (const value of document.edges) {
    const edge = record(value, "连线");
    onlyKeys(edge, ["id", "fromNode", "fromSide", "fromEnd", "toNode", "toSide", "toEnd", "color", "label"], "连线");
    const id = identifier(edge.id);
    if (ids.has(id)) invalid(`ID 重复：${id}`);
    ids.add(id);
    if (typeof edge.fromNode !== "string" || typeof edge.toNode !== "string" ||
        !nodeIds.has(edge.fromNode) || !nodeIds.has(edge.toNode)) invalid("连线必须指向存在的节点。");
    for (const side of [edge.fromSide, edge.toSide]) {
      if (side !== undefined && !["top", "right", "bottom", "left"].includes(side as string)) invalid("连线方向必须是 top、right、bottom 或 left。");
    }
    for (const end of [edge.fromEnd, edge.toEnd]) {
      if (end !== undefined && end !== "none" && end !== "arrow") invalid("连线箭头必须是 none 或 arrow。");
    }
    color(edge.color);
    if (edge.label !== undefined && typeof edge.label !== "string") invalid("连线标签必须是文本。");
  }
  for (let index = 0; index < bounds.length; index++) {
    const a = bounds[index];
    for (let next = index + 1; next < bounds.length; next++) {
      const b = bounds[next];
      if (a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom) {
        // Equal rectangles are overlapping peers, not a group nesting relation.
        const equal = a.x === b.x && a.y === b.y && a.right === b.right && a.bottom === b.bottom;
        const aContainsB = a.group && a.x <= b.x && a.y <= b.y && a.right >= b.right && a.bottom >= b.bottom;
        const bContainsA = b.group && b.x <= a.x && b.y <= a.y && b.right >= a.right && b.bottom >= a.bottom;
        if (!equal && (aContainsB || bContainsA)) continue;
        invalid(`节点重叠：${a.id}、${b.id}`);
      }
    }
  }
}

function selectedSource(value: unknown, allowedSources: ReadonlySet<string>): string {
  const path = sourcePath(value);
  if (!allowedSources.has(path)) invalid(`来源不在所选资料中：${path}`);
  return path;
}

function checkTextSources(content: string, allowedSources: ReadonlySet<string>): void {
  const checkTarget = (target: string, markdown: boolean) => {
    if (markdown && /^https?:\/\//iu.test(target)) return;
    if (target.startsWith("#")) return;
    let path = target.split("#", 1)[0];
    if (markdown) {
      path = path.replace(/\\([\\`*{}[\]()#+\-.!_>])/gu, "$1");
      try { path = decodeURIComponent(path); } catch { /* Literal percent filenames are valid. */ }
    }
    selectedSource(path, allowedSources);
  };
  for (const match of content.matchAll(/\[\[([^\]\r\n]+)\]\]/gu)) {
    checkTarget(match[1].split("|", 1)[0], false);
  }
  // Read balanced destinations so parentheses in Markdown filenames cannot hide a link.
  for (const match of content.matchAll(/\]\(\s*/gu)) {
    let index = match.index + match[0].length;
    const start = index;
    if (content[index] === "<") {
      const end = content.indexOf(">", index + 1);
      if (end !== -1) checkTarget(content.slice(index + 1, end), true);
      continue;
    }
    let depth = 0;
    while (index < content.length) {
      const character = content[index];
      if (character === "\\") { index += 2; continue; }
      if (character === "(") depth++;
      else if (character === ")") {
        if (depth === 0) break;
        depth--;
      } else if (/\s/u.test(character) && depth === 0) break;
      index++;
    }
    checkTarget(content.slice(start, index), true);
  }
  // Reference-style links and images resolve through these destinations as well.
  for (const match of content.matchAll(/^ {0,3}\[[^\]\r\n]+\]:\s*(?:<([^>\r\n]+)>|([^\s]+))/gmu)) {
    checkTarget(match[1] ?? match[2], true);
  }
}

function sourceUrls(sources: readonly GenerationSource[]): ReadonlySet<string> {
  const urls = new Set<string>();
  for (const source of sources) {
    for (const match of source.content.matchAll(/\bhttps?:\/\//giu)) {
      const start = match.index;
      let end = start;
      const closing: string[] = [];
      // Keep balanced URL parentheses, IPv6 hosts and array query parameters.
      // An unmatched closing delimiter belongs to the surrounding Markdown.
      while (end < source.content.length) {
        const character = source.content[end];
        if (/[\s<>"'`，。；：！？、（）]/u.test(character)) break;
        if (character === "(") closing.push(")");
        else if (character === "[") closing.push("]");
        else if (character === "{") closing.push("}");
        else if ([")", "]", "}"].includes(character) && closing.pop() !== character) break;
        end++;
      }
      urls.add(source.content.slice(start, end).replace(/[.,;:!?]+$/u, ""));
    }
  }
  return urls;
}

/** Parse model-owned layout against the exact successful source snapshot. */
export function parseGenerationCanvas(value: unknown, sources: readonly GenerationSource[]): GenerationCanvasOutput {
  const root = record(value, "生成结果");
  onlyKeys(root, ["title", "canvas"], "生成结果");
  const title = text(root.title, "主题标题");
  const input = record(root.canvas, "Canvas");
  onlyKeys(input, ["nodes", "edges"], "Canvas");
  if (!Array.isArray(input.nodes) || !Array.isArray(input.edges)) invalid("Canvas 需要节点列表和连线列表。");
  const allowedSources = new Set(sources.map(source => source.path));
  const nodes = input.nodes.map(value => {
    const node = record(value, "节点");
    if (node.type !== "text") return { ...node };
    const { sourcePaths, ...copy } = node;
    const content = text(copy.text, "节点内容");
    const point: GenerationMapPoint = { text: content };
    if (sourcePaths !== undefined) {
      if (!Array.isArray(sourcePaths)) invalid("文本节点来源必须是路径列表。");
      point.sourcePaths = [...new Set(sourcePaths.map(path => selectedSource(path, allowedSources)))];
    }
    copy.text = pointText(point);
    checkTextSources(copy.text as string, allowedSources);
    return copy;
  });
  const canvas: unknown = { nodes, edges: input.edges.map(value => ({ ...record(value, "连线") })) };
  validateGenerationCanvas(canvas);
  const allowedUrls = sourceUrls(sources);
  for (const node of canvas.nodes) {
    if (node.type === "file") selectedSource(node.file, allowedSources);
    if (node.type === "link" && !allowedUrls.has(node.url)) invalid(`链接网址未出现在所选资料正文中：${node.url}`);
  }
  return { title, canvas };
}

export function serializeGenerationCanvas(hierarchy: GenerationMapHierarchy): string {
  const document = layoutGenerationCanvas(hierarchy);
  validateGenerationCanvas(document);
  return JSON.stringify(document);
}
