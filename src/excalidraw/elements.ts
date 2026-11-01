/** The installed Excalidraw CLI owns serialization, text measurement and bindings. */
export type DrawingStyle = "white" | "blackboard";
export interface DrawingElement {
  id: string;
  type: "rectangle" | "ellipse" | "diamond" | "text" | "arrow" | "frame";
  x: number; y: number; width?: number; height?: number;
  text?: string;
  label?: { text: string; fontFamily?: number; fontSize?: number };
  start?: { id: string }; end?: { id: string };
  fontFamily?: number; fontSize?: number; roughness?: number;
  strokeColor?: string; backgroundColor?: string; fillStyle?: string;
  endArrowhead?: "arrow";
  children?: string[]; name?: string;
  points?: [number, number][];
}
export interface DrawingOutput { title: string; elements: DrawingElement[]; boxCount: number; arrowCount: number }
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("手绘图需要 JSON 对象。");
  return value as Record<string, unknown>;
};
const text = (value: unknown, field: string, max: number): string => {
  if (typeof value !== "string" || !value.trim() || Array.from(value).length > max) throw new Error(`${field}为空或超过 ${max} 字。`);
  return value.trim();
};
const number = (value: unknown, field: string, min: number, max: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`${field}须在 ${min}–${max} 范围内。`);
  return value;
};
export function parseDrawingOutput(value: unknown, sourcePaths?: readonly string[]): DrawingOutput {
  const input = record(value), title = text(input.title, "图标题", 20);
  if (!Array.isArray(input.elements) || !input.elements.length || input.elements.length > 80) throw new Error("手绘图需要 1–80 个元素。");
  const sources = new Set(sourcePaths), ids = new Set<string>();
  const annotations: { box: DrawingElement; paths: string[] }[] = [];
  const elements = input.elements.map((raw, index): DrawingElement => {
    const item = record(raw), id = text(item.id, `元素 ${index + 1} 的 id`, 80);
    if (ids.has(id)) throw new Error(`元素 id 重复：${id}`); ids.add(id);
    if (!["rectangle", "ellipse", "diamond", "text", "arrow", "frame"].includes(String(item.type))) throw new Error(`${id} 的类型不支持，请使用框、文字、分组或箭头。`);
    if (["__proto__", "constructor", "prototype"].includes(id)) throw new Error(`${id} 是保留的 id，请换一个。`);
    const positionedByProgram = item.type === "frame" || item.type === "arrow";
    const element: DrawingElement = { id, type: item.type as DrawingElement["type"], x: number(positionedByProgram ? 0 : item.x, `${id}.x`, -10000, 10000), y: number(positionedByProgram ? 0 : item.y, `${id}.y`, -10000, 10000), roughness: 1, strokeColor: "#1e1e1e" };
    if (element.type === "frame") {
      if (!Array.isArray(item.children) || !item.children.length || item.children.some(child => typeof child !== "string")) throw new Error(`${id} 的分组需要 children 元素 id。`);
      element.children = item.children as string[]; element.name = text(item.name, `${id} 的分组标题`, 40);
    } else if (element.type === "arrow") {
      element.start = { id: text(record(item.start).id, `${id} 的起点`, 80) };
      element.end = { id: text(record(item.end).id, `${id} 的终点`, 80) };
      element.endArrowhead = "arrow";
      if (item.label !== undefined) element.label = { text: text(record(item.label).text, `${id} 的连线文字`, 40), fontSize: 18, fontFamily: 5 };
    } else if (element.type === "text") {
      element.text = text(item.text, `${id} 的文字`, 120); element.fontSize = 24; element.fontFamily = 5;
    } else {
      element.width = number(item.width, `${id}.width`, 100, 1200);
      element.height = number(item.height, `${id}.height`, 60, 1000);
      const label = text(record(item.label).text, `${id} 的框内文字`, 240);
      element.label = { text: label, fontFamily: 5, fontSize: 24 };
      element.backgroundColor = "#e7f5ff"; element.fillStyle = "solid";
      // Conservative room for CJK fallback fonts; the converter does the actual measurement.
      const columns = Math.max(1, Math.floor((element.width - 40) / 24));
      const lines = label.split("\n").reduce((total, line) => total + Math.max(1, Math.ceil(Array.from(line).length / columns)), 0);
      element.height = Math.max(element.height, lines * 32 + 40);
      if (element.height > 1000) throw new Error(`${id} 的文字太多，请拆成多个框。`);
      if (item.sourcePaths !== undefined) {
        if (!Array.isArray(item.sourcePaths) || item.sourcePaths.some(path => typeof path !== "string" || !sources.has(path))) throw new Error(`${id} 的来源必须是本轮成功读取笔记的精确路径。`);
        annotations.push({ box: element, paths: [...new Set(item.sourcePaths as string[])] });
      }
    }
    return element;
  });
  const boxes = elements.filter(element => ["rectangle", "ellipse", "diamond"].includes(element.type));
  const grouped = new Set<string>();
  for (const frame of elements.filter(element => element.type === "frame")) for (const child of frame.children!) {
    if (!elements.some(element => element.id === child && element.type !== "frame") || grouped.has(child)) throw new Error(`${frame.id} 的分组成员 ${child} 不存在或重复。`);
    grouped.add(child);
  }
  if (!boxes.length || boxes.length > 40) throw new Error("手绘图需要 1–40 个框。");
  for (const arrow of elements.filter(element => element.type === "arrow")) {
    if (!boxes.some(box => box.id === arrow.start!.id) || !boxes.some(box => box.id === arrow.end!.id) || arrow.start!.id === arrow.end!.id) throw new Error(`${arrow.id} 的两端必须连接两个存在的不同框。`);
  }
  // Only resolve small overlaps; large collisions go back to the model, never a new layout engine.
  const occupied = boxes.map(box => ({ box, height: box.height! + (annotations.find(item => item.box === box)?.paths.length ?? 0) * 28 }));
  for (let pass = 0; pass < boxes.length; pass++) {
    let moved = false;
    for (let i = 0; i < occupied.length; i++) for (let j = i + 1; j < occupied.length; j++) {
      const a = occupied[i], b = occupied[j];
      const dx = Math.min(a.box.x + a.box.width!, b.box.x + b.box.width!) - Math.max(a.box.x, b.box.x);
      const dy = Math.min(a.box.y + a.height, b.box.y + b.height) - Math.max(a.box.y, b.box.y);
      if (dx <= 0 || dy <= 0) continue;
      if (Math.min(dx, dy) > 80) throw new Error(`框 ${a.box.id} 与 ${b.box.id} 严重重叠，请重新安排位置并留出来源文字的空间。`);
      if (dx < dy) b.box.x += dx + 32; else b.box.y += dy + 32;
      moved = true;
    }
    if (!moved) break;
    if (pass === boxes.length - 1) throw new Error("框仍重叠，请重新安排位置。");
  }
  for (const { box, paths } of annotations) paths.forEach((path, index) => {
    let id = `${box.id}-source-${index}`; while (ids.has(id)) id += "s"; ids.add(id);
    elements.push({ id, type: "text", x: box.x, y: box.y + box.height! + 8 + index * 28, text: `来源：${path.replace(/\.md$/iu, "")}`, fontFamily: 5, fontSize: 18, strokeColor: "#495057", roughness: 1 });
  });
  // Bindings establish identity; the CLI converter still requires real endpoint geometry.
  // Recompute it after any overlap correction so arrows cannot remain at its default (0,0).
  for (const arrow of elements.filter(element => element.type === "arrow")) {
    const from = boxes.find(box => box.id === arrow.start!.id)!, to = boxes.find(box => box.id === arrow.end!.id)!;
    const fromX = from.x + from.width! / 2, fromY = from.y + from.height! / 2;
    const toX = to.x + to.width! / 2, toY = to.y + to.height! / 2;
    const dx = toX - fromX, dy = toY - fromY;
    const startScale = .5 / Math.max(Math.abs(dx) / from.width!, Math.abs(dy) / from.height!);
    const endScale = .5 / Math.max(Math.abs(dx) / to.width!, Math.abs(dy) / to.height!);
    arrow.x = fromX + dx * startScale; arrow.y = fromY + dy * startScale;
    arrow.points = [[0, 0], [toX - dx * endScale - arrow.x, toY - dy * endScale - arrow.y]];
  }
  if (elements.length > 160 || elements.some(element => Math.abs(element.x) > 10000 || Math.abs(element.y) > 10000)) throw new Error("修正后的图超出数量或坐标上限，请精简。");
  return { title, elements, boxCount: boxes.length, arrowCount: elements.filter(element => element.type === "arrow").length };
}
