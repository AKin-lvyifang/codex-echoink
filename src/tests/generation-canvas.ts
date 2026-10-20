import assert from "node:assert/strict";
import {
  layoutGenerationCanvas,
  parseGenerationMapHierarchy,
  serializeGenerationCanvas,
  validateGenerationCanvas
} from "../generation/canvas";
import type { GenerationCanvasDocument, GenerationMapHierarchy } from "../generation/types";

function hierarchy(branchCount = 3, pointCount = 2): GenerationMapHierarchy {
  return {
    title: "知识整理",
    branches: Array.from({ length: branchCount }, (_, branch) => ({
      title: `分支 ${branch + 1}`,
      points: Array.from({ length: pointCount }, (_, point) => ({ text: `要点 ${branch + 1}.${point + 1}` }))
    }))
  };
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

function smallCanvas(): GenerationCanvasDocument {
  return {
    nodes: [
      { id: "a", type: "text", text: "甲", x: 0, y: 0, width: 10, height: 10 },
      { id: "b", type: "text", text: "乙", x: 10, y: 0, width: 10, height: 10 }
    ],
    edges: [{ id: "ab", fromNode: "a", fromSide: "right", toNode: "b", toSide: "left" }]
  };
}

export function runGenerationCanvasTests(): void {
  let passed = 0;
  const test = (name: string, run: () => void) => {
    run();
    passed++;
    console.log(`PASS generation-canvas: ${name}`);
  };

  test("parse clones the hierarchy, normalizes line endings and deduplicates exact source paths", () => {
    const input = hierarchy();
    input.title = "  知识整理  ";
    input.branches[0].points[0] = { text: "第一行\r\n第二行\r第三行", sourcePaths: ["资料/原文.md", "资料/原文.md"] };
    const before = clone(input);
    const parsed = parseGenerationMapHierarchy(input, ["资料/原文.md"]);
    assert.equal(parsed.title, "知识整理");
    assert.equal(parsed.branches[0].points[0].text, "第一行\n第二行\n第三行");
    assert.deepEqual(parsed.branches[0].points[0].sourcePaths, ["资料/原文.md"]);
    parsed.branches[1].title = "changed";
    assert.deepEqual(input, before);
  });

  test("sources are optional and an explicit empty list is accepted", () => {
    const input = hierarchy();
    input.branches[0].points[0].sourcePaths = [];
    assert.deepEqual(parseGenerationMapHierarchy(input, []), input);
  });

  test("empty and malformed hierarchy objects are rejected", () => {
    for (const input of [null, [], "topic", {}, { title: "", branches: [] }, { title: "topic", branches: {} }]) {
      assert.throws(() => parseGenerationMapHierarchy(input, []), /导图结构无效/u);
    }
    const variants = [
      (input: any) => { input.title = 12; },
      (input: any) => { input.title = " \n "; },
      (input: any) => { input.branches[0] = null; },
      (input: any) => { input.branches[0].title = ""; },
      (input: any) => { input.branches[0].points = {}; },
      (input: any) => { input.branches[0].points[0] = "point"; },
      (input: any) => { input.branches[0].points[0].text = "\n"; },
      (input: any) => { input.branches[0].points[0].text = 7; }
    ];
    for (const change of variants) {
      const input = hierarchy(); change(input);
      assert.throws(() => parseGenerationMapHierarchy(input, []), /导图结构无效/u);
    }
  });

  test("branch and point counts enforce both boundaries without truncation", () => {
    for (const count of [0, 1, 2, 6]) assert.throws(() => parseGenerationMapHierarchy(hierarchy(count), []), /3–5/u);
    for (const count of [0, 1, 5]) assert.throws(() => parseGenerationMapHierarchy(hierarchy(3, count), []), /2–4/u);
    for (const [branches, points] of [[3, 2], [5, 4]]) {
      const parsed = parseGenerationMapHierarchy(hierarchy(branches, points), []);
      assert.equal(parsed.branches.length, branches);
      assert(parsed.branches.every(branch => branch.points.length === points));
    }
  });

  test("model-supplied coordinates, IDs and extra hierarchy fields are rejected", () => {
    for (const change of [
      (input: any) => { input.nodes = []; },
      (input: any) => { input.id = "model-id"; },
      (input: any) => { input.branches[0].x = 100; },
      (input: any) => { input.branches[0].points[0].color = "1"; }
    ]) {
      const input = hierarchy(); change(input);
      assert.throws(() => parseGenerationMapHierarchy(input, []), /不支持的字段/u);
    }
  });

  test("source references must be an array of selected exact paths", () => {
    for (const sources of [null, "资料/原文.md", [12], ["资料/未选.md"], ["资料/原文.MD"]]) {
      const input = hierarchy();
      (input.branches[0].points[0] as any).sourcePaths = sources;
      assert.throws(() => parseGenerationMapHierarchy(input, ["资料/原文.md"]), /来源/u);
    }
    const input = hierarchy();
    input.branches[0].points[0].sourcePaths = ["资料/字面%20.md"];
    assert.throws(() => parseGenerationMapHierarchy(input, ["资料/字面 .md"]), /不在所选资料/u);
  });

  test("unsafe or unrepresentable source paths fail even if present in the allowed list", () => {
    for (const path of [
      "", "../原文.md", "资料/../原文.md", "/资料/原文.md", "C:/资料/原文.md", "资料\\原文.md", "./原文.md",
      "资料//原文.md", "资料/./原文.md", " 资料/原文.md", "资料/原文.md ", "资料/原\n文.md", "资料/原\0文.md",
      "资料/原文#标题.md", "资料/原文^段落.md", "资料/原文|别名.md", "资料/[原文].md", "资料/原文.pdf"
    ]) {
      const input = hierarchy(); input.branches[0].points[0].sourcePaths = [path];
      assert.throws(() => parseGenerationMapHierarchy(input, [path]), /完整 Vault 相对 Markdown 路径/u, path);
    }
  });

  test("source links preserve exact same-name, spaced, Unicode and literal-percent paths with aliases", () => {
    const paths = ["资料/甲/同名.md", "资料/乙/同名.md", "资料/空 格(一).md", "资料/增长100%.md", "资料/字面%20.MD"];
    const input = hierarchy(); input.branches[0].points[0].sourcePaths = paths;
    const canvas = layoutGenerationCanvas(parseGenerationMapHierarchy(input, paths));
    const node = canvas.nodes.find(node => node.id === "generation-point-1-1")!;
    assert.equal(node.text, "要点 1.1\n\n[[资料/甲/同名.md|同名]]\n[[资料/乙/同名.md|同名]]\n[[资料/空 格(一).md|空 格(一)]]\n[[资料/增长100%.md|增长100%]]\n[[资料/字面%20.MD|字面%20]]");
    assert(!node.text.includes("100%25"));
    validateGenerationCanvas(canvas);
  });

  test("layout supplies fixed widths, gaps, preset branch colors and a complete tree at both size bounds", () => {
    for (const [branches, points] of [[3, 2], [5, 4]]) {
      const canvas = layoutGenerationCanvas(hierarchy(branches, points));
      validateGenerationCanvas(canvas);
      assert.equal(canvas.nodes.length, 1 + branches + branches * points);
      assert.equal(canvas.edges.length, canvas.nodes.length - 1);
      const root = canvas.nodes[0];
      assert.equal(root.width, 220); assert.equal(root.color, undefined);
      const branchNodes = canvas.nodes.filter(node => node.id.startsWith("generation-branch-"));
      const pointNodes = canvas.nodes.filter(node => node.id.startsWith("generation-point-"));
      assert(branchNodes.every(node => node.width === 220 && node.x - (root.x + root.width) === 100 && node.color === "4"));
      assert(pointNodes.every(node => node.width === 240 && node.x - (branchNodes[0].x + branchNodes[0].width) === 100 && node.color === undefined));
      assert(canvas.edges.every(edge => edge.fromSide === "right" && edge.toSide === "left"));
      for (const branch of branchNodes) {
        assert.equal(canvas.edges.filter(edge => edge.toNode === branch.id && edge.fromNode === root.id).length, 1);
        assert.equal(canvas.edges.filter(edge => edge.fromNode === branch.id).length, points);
      }
      assert(pointNodes.every(node => canvas.edges.filter(edge => edge.toNode === node.id).length === 1));
    }
  });

  test("uneven tall branches and points remain separated by group and sibling gaps", () => {
    const input = hierarchy(5, 4);
    input.title = "中心主题\n".repeat(60).trim();
    input.branches[1].title = "很长的一级分支\n".repeat(35).trim();
    input.branches[0].points[2].text = "中文的长段落没有空格，也需要自动换行。".repeat(20);
    input.branches[4].points[3].text = "long-unbroken-word".repeat(90);
    const canvas = layoutGenerationCanvas(input);
    validateGenerationCanvas(canvas);
    const groupBounds: Array<{ top: number; bottom: number }> = [];
    for (let branch = 1; branch <= 5; branch++) {
      const points = canvas.nodes.filter(node => node.id.startsWith(`generation-point-${branch}-`));
      for (let index = 1; index < points.length; index++) {
        assert.equal(points[index].y - (points[index - 1].y + points[index - 1].height), 16);
      }
      const nodes = [...points, canvas.nodes.find(node => node.id === `generation-branch-${branch}`)!];
      groupBounds.push({ top: Math.min(...nodes.map(node => node.y)), bottom: Math.max(...nodes.map(node => node.y + node.height)) });
    }
    for (let index = 1; index < groupBounds.length; index++) {
      assert.equal(groupBounds[index].top - groupBounds[index - 1].bottom, 28);
    }
    const root = canvas.nodes[0];
    assert.equal(root.y + root.height / 2, (groupBounds[0].top + groupBounds[4].bottom) / 2);
    assert(canvas.nodes.every(node => node.y >= 0));
  });

  test("Chinese wrapping, explicit lines, emoji and source text all reserve node height", () => {
    const input = hierarchy(3, 4);
    input.branches[0].points = [
      { text: "简短" }, { text: "中文自动换行".repeat(20) }, { text: "第一行\n第二行\n第三行\n第四行" },
      { text: "简短", sourcePaths: ["很长的资料目录/有很多中文文字的原始笔记名称.md", "另一份资料/原始笔记.md"] }
    ];
    input.branches[1].points[0].text = "🙂👩‍💻一段包含表情的中文\n".repeat(10).trim();
    const canvas = layoutGenerationCanvas(input);
    validateGenerationCanvas(canvas);
    const points = canvas.nodes.filter(node => node.id.startsWith("generation-point-1-"));
    assert(points[1].height > points[0].height * 2);
    assert(points[2].height >= 4 * 24 + 32);
    assert(points[3].height > points[0].height);
  });

  test("native line and paragraph metrics reserve equal end space without counting blank lines twice", () => {
    const input = hierarchy(3, 4);
    input.branches[0].points = [
      { text: "一行文字" }, { text: "第一行\n第二行" },
      { text: "第一段\n\n第二段" }, { text: "第一段\n\n\n第二段" }
    ];
    const canvas = layoutGenerationCanvas(input);
    validateGenerationCanvas(canvas);
    const heights = canvas.nodes.filter(node => node.id.startsWith("generation-point-1-")).map(node => node.height);
    // 24px per visible line, 16px between paragraphs, 16px + 1px at each end.
    assert.deepEqual(heights, [58, 82, 98, 98]);
  });

  test("source-link aliases determine height while exact long target paths remain unchanged", () => {
    const input = hierarchy(3, 4);
    const shortPath = "资料/原文.md";
    const longPath = `${"非常长的资料目录/".repeat(12)}原文.md`;
    input.branches[0].points = [
      { text: "一行正文", sourcePaths: [shortPath] },
      { text: "一行正文", sourcePaths: [longPath] },
      { text: "一行正文", sourcePaths: [shortPath, "资料/另一篇.md"] },
      { text: "一行正文", sourcePaths: ["资料/这是一份会换成多行的非常长的来源笔记显示名称.md"] }
    ];
    const canvas = layoutGenerationCanvas(input);
    validateGenerationCanvas(canvas);
    const points = canvas.nodes.filter(node => node.id.startsWith("generation-point-1-"));
    assert.equal(points[0].height, 98, "one body line and one alias line occupy two paragraphs");
    assert.equal(points[1].height, points[0].height, "hidden target directories must not add empty space");
    assert(points[1].text.includes(`[[${longPath}|原文]]`), "height estimation must not shorten the saved link");
    assert.equal(points[2].height, 122, "each visible source alias contributes a line");
    assert(points[3].height > points[0].height, "a genuinely long visible alias still wraps");
    console.log(`Canvas height examples: plain=${58}px; two lines=${82}px; body + source=${points[0].height}px; body + two sources=${points[2].height}px`);
  });

  test("layout and serialization are deterministic and leave the model hierarchy unchanged", () => {
    const input = hierarchy(5, 4); const before = clone(input);
    const first = serializeGenerationCanvas(input);
    assert.equal(first, serializeGenerationCanvas(input));
    assert.deepEqual(input, before);
    const parsed: unknown = JSON.parse(first);
    validateGenerationCanvas(parsed);
    assert.deepEqual(parsed, layoutGenerationCanvas(input));
    const allIds = [...parsed.nodes, ...parsed.edges].map(value => value.id);
    assert.equal(new Set(allIds).size, allIds.length);
    assert.throws(() => serializeGenerationCanvas(hierarchy(2)), /3–5/u);
  });

  test("Canvas requires the text-node document shape and nonempty content", () => {
    for (const value of [null, [], {}, { nodes: [], edges: [] }, { nodes: {}, edges: [] }, { nodes: [null], edges: [] }, { nodes: smallCanvas().nodes, edges: {} }]) {
      assert.throws(() => validateGenerationCanvas(value), /导图结构无效/u);
    }
    for (const change of [
      (canvas: any) => { canvas.extra = true; },
      (canvas: any) => { canvas.nodes[0].type = "file"; },
      (canvas: any) => { canvas.nodes[0].text = ""; },
      (canvas: any) => { canvas.nodes[0].text = 3; },
      (canvas: any) => { canvas.nodes[0].file = "资料/原文.md"; },
      (canvas: any) => { canvas.edges[0].toEnd = "arrow"; },
      (canvas: any) => { canvas.edges[0] = null; }
    ]) {
      const canvas = smallCanvas(); change(canvas);
      assert.throws(() => validateGenerationCanvas(canvas), /导图结构无效/u);
    }
  });

  test("node and edge IDs are nonempty and globally unique", () => {
    for (const change of [
      (canvas: any) => { canvas.nodes[0].id = ""; },
      (canvas: any) => { canvas.nodes[0].id = 7; },
      (canvas: any) => { canvas.nodes[1].id = "a"; },
      (canvas: any) => { canvas.edges.push(clone(canvas.edges[0])); },
      (canvas: any) => { canvas.edges[0].id = "a"; },
      (canvas: any) => { canvas.edges[0].id = " "; }
    ]) {
      const canvas = smallCanvas(); change(canvas);
      assert.throws(() => validateGenerationCanvas(canvas), /ID/u);
    }
  });

  test("bad edge endpoints and directions are rejected", () => {
    for (const change of [
      (canvas: any) => { canvas.edges[0].fromNode = "missing"; },
      (canvas: any) => { canvas.edges[0].toNode = "missing"; },
      (canvas: any) => { canvas.edges[0].toNode = 1; },
      (canvas: any) => { canvas.edges[0].fromSide = "left"; },
      (canvas: any) => { canvas.edges[0].toSide = "right"; }
    ]) {
      const canvas = smallCanvas(); change(canvas);
      assert.throws(() => validateGenerationCanvas(canvas), /连线/u);
    }
  });

  test("coordinates and dimensions must be finite numbers with positive finite bounds", () => {
    for (const field of ["x", "y", "width", "height"]) {
      for (const value of [NaN, Infinity, -Infinity, "1", null]) {
        const canvas = smallCanvas(); (canvas.nodes[0] as any)[field] = value;
        assert.throws(() => validateGenerationCanvas(canvas), /有限/u);
      }
    }
    for (const field of ["width", "height"]) {
      for (const value of [0, -1]) {
        const canvas = smallCanvas(); (canvas.nodes[0] as any)[field] = value;
        assert.throws(() => validateGenerationCanvas(canvas), /大于零/u);
      }
    }
    const overflow = smallCanvas(); overflow.nodes[0].x = Number.MAX_VALUE; overflow.nodes[0].width = Number.MAX_VALUE;
    assert.throws(() => validateGenerationCanvas(overflow), /有限/u);
    const negative = smallCanvas(); negative.nodes.forEach(node => { node.x -= 100; node.y -= 100; });
    validateGenerationCanvas(negative);
  });

  test("touching boundaries pass while horizontal, vertical and contained overlaps fail", () => {
    validateGenerationCanvas(smallCanvas());
    for (const [x, y, width, height] of [[9.5, 0, 10, 10], [0, 9.5, 10, 10], [1, 1, 2, 2], [0, 0, 10, 10]]) {
      const canvas = smallCanvas(); Object.assign(canvas.nodes[1], { x, y, width, height });
      assert.throws(() => validateGenerationCanvas(canvas), /节点重叠/u);
    }
    const vertical = smallCanvas(); Object.assign(vertical.nodes[1], { x: 0, y: 10 });
    validateGenerationCanvas(vertical);
    const distant = smallCanvas(); distant.nodes[1].y = 100;
    validateGenerationCanvas(distant);
  });

  test("Canvas colors accept valid presets and hex values and reject invalid values", () => {
    for (const color of ["4", "#aAbBcC"]) {
      const canvas = smallCanvas(); canvas.nodes[0].color = color; validateGenerationCanvas(canvas);
    }
    for (const color of ["0", "7", "green", "#123", "", 4, null]) {
      const canvas = smallCanvas(); (canvas.nodes[0] as any).color = color;
      assert.throws(() => validateGenerationCanvas(canvas), /颜色/u);
    }
  });

  console.log(`generation-canvas: ${passed} tests passed`);
}
