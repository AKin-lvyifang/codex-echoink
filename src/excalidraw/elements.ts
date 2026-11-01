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
  link?: string;
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
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function textUnits(value: string): number {
  return [...graphemes.segment(value)].reduce((sum, { segment }) => sum + (/\p{Extended_Pictographic}/u.test(segment) ? 1.3 : /[^\p{ASCII}]/u.test(segment) ? 1 : .55), 0);
}
interface Bounds { x: number; y: number; width: number; height: number }
function overlaps(a: Bounds, b: Bounds): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
function lineCrosses(a: [number, number], b: [number, number], box: Bounds): boolean {
  let enter = 0, leave = 1;
  for (const [start, delta, min, max] of [[a[0], b[0] - a[0], box.x + 1, box.x + box.width - 1], [a[1], b[1] - a[1], box.y + 1, box.y + box.height - 1]]) {
    if (Math.abs(delta) < 1e-8) { if (start < min || start > max) return false; }
    else {
      const first = (min - start) / delta, last = (max - start) / delta;
      enter = Math.max(enter, Math.min(first, last)); leave = Math.min(leave, Math.max(first, last));
      if (leave < enter) return false;
    }
  }
  return true;
}
export function parseDrawingOutput(value: unknown, sourcePaths?: readonly string[], style: DrawingStyle = "white", requireSources = true): DrawingOutput {
  const input = record(value), title = text(input.title, "图标题", 20);
  if (!Array.isArray(input.elements) || !input.elements.length || input.elements.length > 80) throw new Error("手绘图需要 1–80 个元素。");
  const sources = new Set(sourcePaths), ids = new Set<string>();

  const elements = input.elements.map((raw, index): DrawingElement => {
    const item = record(raw), id = text(item.id, `元素 ${index + 1} 的 id`, 80);
    if (ids.has(id)) throw new Error(`元素 id 重复：${id}`); ids.add(id);
    if (!["rectangle", "ellipse", "diamond", "text", "arrow", "frame"].includes(String(item.type))) throw new Error(`${id} 的类型不支持，请使用框、文字、分组或箭头。`);
    if (["__proto__", "constructor", "prototype"].includes(id)) throw new Error(`${id} 是保留的 id，请换一个。`);
    const positionedByProgram = item.type === "frame" || item.type === "arrow";
    const element: DrawingElement = { id, type: item.type as DrawingElement["type"], x: number(positionedByProgram ? 0 : item.x, `${id}.x`, -10000, 10000), y: number(positionedByProgram ? 0 : item.y, `${id}.y`, -10000, 10000), roughness: 1, strokeColor: "#1e1e1e" };
    if (element.type === "frame") {
      if (!Array.isArray(item.children) || !item.children.length || item.children.some(child => typeof child !== "string")) throw new Error(`${id} 的分组需要 children 元素 id。`);
      element.children = [...item.children as string[]]; element.name = text(item.name, `${id} 的分组标题`, 40);
    } else if (element.type === "arrow") {
      element.start = { id: text(record(item.start).id, `${id} 的起点`, 80) };
      element.end = { id: text(record(item.end).id, `${id} 的终点`, 80) };
      element.endArrowhead = "arrow";
      if (item.label !== undefined) element.label = { text: text(record(item.label).text, `${id} 的连线文字`, 40), fontSize: 18, fontFamily: 5 };
    } else if (element.type === "text") {
      element.text = text(item.text, `${id} 的文字`, 120);
      if (element.text === title) throw new Error("图标题由程序添加，请删除重复的标题文字元素。");
      element.fontSize = 24; element.fontFamily = 5;
    } else {
      element.width = number(item.width, `${id}.width`, 100, 1200);
      element.height = number(item.height, `${id}.height`, 60, 1000);
      const label = text(record(item.label).text, `${id} 的框内文字`, 120);
      if (!/^\p{Extended_Pictographic}/u.test(label)) throw new Error(`${id} 的框内文字须以贴切的 emoji 开头。`);
      element.label = { text: label, fontFamily: 5, fontSize: 24 };
      element.backgroundColor = style === "blackboard" ? "transparent" : "#e7f5ff"; element.fillStyle = "solid";
      // Conservative room for CJK fallback fonts; the converter does the actual measurement.
      const columns = Math.max(1, Math.floor((element.width - 40) / 24));
      const lines = label.split("\n").reduce((total, line) => total + Math.max(1, Math.ceil(textUnits(line) / columns)), 0);
      element.height = Math.max(element.height, lines * 32 + 40);
      if (element.height > 1000) throw new Error(`${id} 的文字太多，请拆成多个框。`);
      if (item.sourcePaths !== undefined) {
        if (!Array.isArray(item.sourcePaths) || item.sourcePaths.some(path => typeof path !== "string" || !sources.has(path))) throw new Error(`${id} 的来源必须是本轮成功读取笔记的精确路径。`);
        const paths = [...new Set(item.sourcePaths as string[])];
        if (paths[0]) element.link = `[[${paths[0]}]]`;
      }
      if (requireSources && sourcePaths?.length && !element.link) throw new Error(`${id} 缺少来源，请提供至少一篇本轮成功读取笔记的 sourcePaths。`);
    }
    return element;
  });
  const boxes = elements.filter(element => ["rectangle", "ellipse", "diamond"].includes(element.type));
  const grouped = new Set<string>();
  for (const frame of elements.filter(element => element.type === "frame")) for (const child of frame.children!) {
    if (!elements.some(element => element.id === child && element.type !== "frame") || grouped.has(child)) throw new Error(`${frame.id} 的分组成员 ${child} 不存在或重复。`);
    grouped.add(child);
  }
  if (!boxes.length || boxes.length > 12) throw new Error("手绘图需要 1–12 个框，请先归纳资料再画，不要逐条铺开。");
  for (const arrow of elements.filter(element => element.type === "arrow")) {
    if (!boxes.some(box => box.id === arrow.start!.id) || !boxes.some(box => box.id === arrow.end!.id) || arrow.start!.id === arrow.end!.id) throw new Error(`${arrow.id} 的两端必须连接两个存在的不同框。`);
  }
  // Only resolve small overlaps; large collisions go back to the model, never a new layout engine.
  const occupied = boxes.map(box => ({ box, height: box.height! }));
  for (let pass = 0; pass < boxes.length; pass++) {
    let moved = false;
    for (let i = 0; i < occupied.length; i++) for (let j = i + 1; j < occupied.length; j++) {
      const a = occupied[i], b = occupied[j];
      const dx = Math.min(a.box.x + a.box.width!, b.box.x + b.box.width!) - Math.max(a.box.x, b.box.x);
      const dy = Math.min(a.box.y + a.height, b.box.y + b.height) - Math.max(a.box.y, b.box.y);
      if (dx <= 0 || dy <= 0) continue;
      if (Math.min(dx, dy) > 80) throw new Error(`框 ${a.box.id} 与 ${b.box.id} 严重重叠，请重新安排位置。`);
      if (dx < dy) b.box.x += dx + 32; else b.box.y += dy + 32;
      moved = true;
    }
    if (!moved) break;
    if (pass === boxes.length - 1) throw new Error("框仍重叠，请重新安排位置。");
  }
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
  const nextId = (base: string): string => { let id = base; while (ids.has(id)) id += "x"; ids.add(id); return id; };
  // Frame labels are rendered at a viewport-dependent size by Excalidraw. Hide
  // those in the file template and author scene text so hierarchy stays stable.
  for (const frame of elements.filter(element => element.type === "frame")) {
    const children = elements.filter(element => frame.children!.includes(element.id) && element.type !== "arrow");
    if (!children.length) throw new Error(`${frame.id} 的分组没有框或文字。`);
    const x = Math.min(...children.map(element => element.x));
    const y = Math.min(...children.map(element => element.y)) - 56;
    const id = nextId("echoink-group-heading");
    elements.push({ id, type: "text", x, y, text: frame.name!, fontFamily: 5, fontSize: 32, strokeColor: "#1e1e1e", roughness: 1 });
    frame.children!.push(id);
  }
  // The program owns the title and source footer; model text cannot duplicate them.
  const content = [...elements];
  const visible = content.filter(element => element.type !== "arrow" && element.type !== "frame");
  const minX = Math.min(...visible.map(element => element.x)), minY = Math.min(...visible.map(element => element.y));
  const maxX = Math.max(...visible.map(element => element.x + (element.width ?? textUnits(element.text ?? "") * (element.fontSize ?? 24))));
  const maxY = Math.max(...visible.map(element => element.y + (element.height ?? (element.text?.split("\n").length ?? 1) * (element.fontSize ?? 24) * 1.35)));
  if (maxX - minX > 1600) throw new Error(`全图宽度 ${Math.ceil(maxX - minX)} 超过 1600，请改为 2–4 列、分行排列，并精简框中文字。`);
  for (const element of content) if (element.type !== "frame") { element.x -= minX; element.y += 120 - minY; }
  // The converter otherwise expands a frame around every bound arrow, even
  // an arrow leading outside the group. Size it around its visible members.
  for (const frame of content.filter(element => element.type === "frame")) {
    const members = content.filter(element => frame.children!.includes(element.id) && element.type !== "arrow");
    frame.x = Math.min(...members.map(element => element.x)) - 10;
    frame.y = Math.min(...members.map(element => element.y)) - 10;
    frame.width = Math.max(...members.map(element => element.x + (element.width ?? textUnits(element.text ?? "") * (element.fontSize ?? 24)))) - frame.x + 10;
    frame.height = Math.max(...members.map(element => element.y + (element.height ?? (element.text?.split("\n").length ?? 1) * (element.fontSize ?? 24) * 1.35))) - frame.y + 10;
  }
  const frames = content.filter(element => element.type === "frame");
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index] as DrawingElement & Bounds;
    if (frames.slice(index + 1).some(other => overlaps(frame, other as DrawingElement & Bounds))) throw new Error(`分组 ${frame.id} 与其他分组区域重叠。各组成员必须占独立、连续的矩形区域，不能交错排；放不开就取消分组。`);
    if (boxes.some(box => !frame.children!.includes(box.id) && overlaps(frame, box as DrawingElement & Bounds))) throw new Error(`分组 ${frame.id} 的边界穿过组外的框，请分开各组区域，或取消分组。`);
  }
  for (const arrow of content.filter(element => element.type === "arrow")) {
    const start: [number, number] = [arrow.x, arrow.y], end: [number, number] = [arrow.x + arrow.points![1][0], arrow.y + arrow.points![1][1]];
    const crossingBox = boxes.find(box => box.id !== arrow.start!.id && box.id !== arrow.end!.id && lineCrosses(start, end, box as DrawingElement & Bounds));
    const crossingText = content.find(element => element.type === "text" && lineCrosses(start, end, { x: element.x, y: element.y, width: textUnits(element.text!) * element.fontSize!, height: element.fontSize! * 1.35 }));
    if (crossingBox || crossingText) throw new Error(`连线 ${arrow.id} 穿过${crossingBox ? `框 ${crossingBox.id}` : `文字“${crossingText!.text}”`}，请重新安排坐标，使用有留白的 2–4 列流程，不要跨过中间的框或组名。`);
  }
  content.unshift({ id: nextId("echoink-title"), type: "text", x: 0, y: 0, text: title, fontFamily: 5, fontSize: 48, strokeColor: "#1e1e1e", roughness: 1 });
  if (sourcePaths?.length) {
    const names = [...new Set(sourcePaths)].map(path => path.split("/").at(-1)!.replace(/\.md$/iu, ""));
    content.push({ id: nextId("echoink-sources"), type: "text", x: 0, y: maxY + 120 - minY + 64, text: `来源：${names.join("、")}`, fontFamily: 5, fontSize: 16, strokeColor: "#495057", roughness: 1 });
  }
  if (content.length > 160 || content.some(element => Math.abs(element.x) > 10000 || Math.abs(element.y) > 10000)) throw new Error("修正后的图超出数量或坐标上限，请精简。");
  return { title, elements: content, boxCount: boxes.length, arrowCount: elements.filter(element => element.type === "arrow").length };
}
