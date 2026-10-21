import assert from "node:assert/strict";
import {
  layoutGenerationCanvas,
  parseGenerationCanvas,
  parseGenerationMapHierarchy,
  serializeGenerationCanvas,
  validateGenerationCanvas
} from "../generation/canvas";
import type { GenerationCanvasDocument, GenerationCanvasTextNode, GenerationMapHierarchy, GenerationSource } from "../generation/types";

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

function textNode(canvas: GenerationCanvasDocument, id: string): GenerationCanvasTextNode {
  const node = canvas.nodes.find(node => node.id === id);
  assert(node?.type === "text");
  return node;
}

function canvasNode(canvas: GenerationCanvasDocument, id: string) {
  const node = canvas.nodes.find(node => node.id === id);
  assert(node);
  return node;
}

function sources(...paths: string[]): GenerationSource[] {
  return paths.map(path => ({ path, content: "资料正文", bytes: 12 }));
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

  test("source paths reject C0 and DEL while preserving C1 and format-character names", () => {
    const parseSource = (source: string) => {
      const input = hierarchy();
      input.branches[0].points[0].sourcePaths = [source];
      return parseGenerationMapHierarchy(input, [source]);
    };
    for (const code of [...Array.from({ length: 32 }, (_, code) => code), 0x7f]) {
      assert.throws(() => parseSource(`资料/a${String.fromCodePoint(code)}b.md`), /来源必须/u);
    }
    for (const code of [0x80, 0x85, 0x9f, 0x200b, 0x200d]) {
      const source = `资料/a${String.fromCodePoint(code)}b.md`;
      assert.deepEqual(parseSource(source).branches[0].points[0].sourcePaths, [source]);
    }
    for (const source of ["资料/[原文].md", "资料/原文].md", "资料/原文#标题.md", "../原文.md", "资料/../原文.md", "/原文.md", "C:/原文.md", "资料\\原文.md"]) {
      assert.throws(() => parseSource(source), /来源必须/u);
    }
  });

  test("combining marks, ZWJ and variation selectors do not consume wrapping width", () => {
    const input = hierarchy(3, 4);
    input.branches[0].points = [
      { text: "a".repeat(25) }, { text: "a\u0301".repeat(25) },
      { text: "a".repeat(25) + "\u200d\ufe0e\ufe0f\u{e0100}" }, { text: "a".repeat(26) }
    ];
    const canvas = layoutGenerationCanvas(input);
    validateGenerationCanvas(canvas);
    assert.deepEqual(canvas.nodes.filter(node => node.id.startsWith("generation-point-1-")).map(node => node.height), [58, 58, 58, 82]);
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
    const node = textNode(canvas, "generation-point-1-1");
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
    const points = canvas.nodes.filter((node): node is GenerationCanvasTextNode => node.type === "text" && node.id.startsWith("generation-point-1-"));
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
    const points = canvas.nodes.filter((node): node is GenerationCanvasTextNode => node.type === "text" && node.id.startsWith("generation-point-1-"));
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

  test("Canvas retains strict document and type-specific shapes and nonempty text content", () => {
    for (const value of [null, [], {}, { nodes: [], edges: [] }, { nodes: {}, edges: [] }, { nodes: [null], edges: [] }, { nodes: smallCanvas().nodes, edges: {} }]) {
      assert.throws(() => validateGenerationCanvas(value), /导图结构无效/u);
    }
    for (const change of [
      (canvas: any) => { canvas.extra = true; },
      (canvas: any) => { canvas.nodes[0].type = "file"; },
      (canvas: any) => { canvas.nodes[0].text = ""; },
      (canvas: any) => { canvas.nodes[0].text = 3; },
      (canvas: any) => { canvas.nodes[0].file = "资料/原文.md"; },
      (canvas: any) => { canvas.edges[0].unsupported = "arrow"; },
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
      (canvas: any) => { canvas.edges[0].fromSide = "middle"; },
      (canvas: any) => { canvas.edges[0].toSide = null; }
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

  test("complete Canvas parsing preserves model geometry, all node kinds and edge fields", () => {
    const selected = sources("资料/原文.md");
    selected[0].content = "见 [示例](https://example.com/guide?q=1#intro)。";
    const input = {
      title: "  自由布局\r\n主题  ",
      canvas: {
        nodes: [
          { id: "group", type: "group", x: -30, y: -30, width: 600, height: 330, label: "资料分组", color: "6" },
          // This geometry-preservation fixture already fits both body lines and the appended source.
          { id: "text", type: "text", text: "  第一行\r\n第二行  ", sourcePaths: ["资料/原文.md", "资料/原文.md"], x: -10, y: 0, width: 240, height: 200 },
          { id: "file", type: "file", file: "资料/原文.md", subpath: "#^block", x: 260, y: 0, width: 100, height: 60 },
          { id: "url", type: "link", url: "https://example.com/guide?q=1#intro", x: 390, y: 0, width: 100, height: 60 }
        ],
        edges: [{ id: "flow", fromNode: "text", fromSide: "bottom", fromEnd: "none", toNode: "file", toSide: "top", toEnd: "arrow", color: "#AABBCC", label: "参考" }]
      }
    };
    const before = clone(input);
    const output = parseGenerationCanvas(input, selected);
    assert.equal(output.title, "自由布局\n主题");
    assert.deepEqual(Object.keys(output).sort(), ["canvas", "title"]);
    assert.deepEqual(Object.keys(output.canvas).sort(), ["edges", "nodes"]);
    assert.equal(textNode(output.canvas, "text").text, "第一行\n第二行\n\n[[资料/原文.md|原文]]");
    assert(!Object.hasOwn(output.canvas.nodes[1], "sourcePaths"));
    assert.deepEqual(output.canvas.edges, input.canvas.edges);
    assert.deepEqual(output.canvas.nodes[0], input.canvas.nodes[0]);
    assert.deepEqual(output.canvas.nodes.slice(2), input.canvas.nodes.slice(2));
    output.canvas.nodes[0].x = 999;
    output.canvas.edges[0].label = "changed";
    assert.deepEqual(input, before);
    assert.notEqual(output.canvas.nodes, input.canvas.nodes);
    assert.notEqual(output.canvas.edges, input.canvas.edges);
  });

  test("complete parsing rejects hierarchy roots, metadata and invalid Canvas wrappers", () => {
    for (const value of [null, [], hierarchy(), { title: "主题" }, { title: "", canvas: smallCanvas() },
      { title: "主题", canvas: { ...smallCanvas(), title: "内部标题" } },
      { title: "主题", canvas: smallCanvas(), sources: [] }, { title: "主题", canvas: { nodes: [], edges: [] } }]) {
      assert.throws(() => parseGenerationCanvas(value, []), /导图结构无效/u);
    }
    const output = parseGenerationCanvas({ title: "无来源节点", canvas: smallCanvas() }, []);
    validateGenerationCanvas(output.canvas);
  });

  test("file nodes only reference safe exact successful Markdown paths", () => {
    const parseFile = (file: unknown, available = sources("资料/原文.md"), subpath?: unknown) => parseGenerationCanvas({
      title: "文件", canvas: { nodes: [{ id: "file", type: "file", file, ...(subpath === undefined ? {} : { subpath }), x: 0, y: 0, width: 100, height: 100 }], edges: [] }
    }, available);
    for (const subpath of [undefined, "#", "#标题", "#^block"]) parseFile("资料/原文.md", sources("资料/原文.md"), subpath);
    for (const file of ["资料/未读取.md", "原文.md", "资料/原文.MD", "资料/原文.md/其他.md"]) {
      assert.throws(() => parseFile(file), /不在所选资料/u);
    }
    assert.throws(() => parseFile("资料/原文.md", []), /不在所选资料/u);
    for (const file of ["/原文.md", "../原文.md", "资料/../原文.md", "C:/原文.md", "资料\\原文.md", "资料/图片.png", "资料/原文.md#标题"]) {
      assert.throws(() => parseFile(file, sources(file)), /来源必须/u);
    }
    for (const subpath of [null, 2, "", "标题", "^block"]) assert.throws(() => parseFile("资料/原文.md", undefined, subpath), /subpath/u);
  });

  test("text sourcePaths deduplicate exact paths, preserve aliases and disappear from output", () => {
    const paths = ["甲/同名.md", "乙/同名.md", "资料/空 格(一).md", "资料/字面%20.MD"];
    const input = { title: "来源", canvas: smallCanvas() };
    Object.assign(input.canvas.nodes[0], { sourcePaths: [...paths, paths[0]] });
    const parsed = parseGenerationCanvas(input, sources(...paths));
    assert.equal(textNode(parsed.canvas, "a").text, "甲\n\n[[甲/同名.md|同名]]\n[[乙/同名.md|同名]]\n[[资料/空 格(一).md|空 格(一)]]\n[[资料/字面%20.MD|字面%20]]");
    assert(!JSON.stringify(parsed.canvas).includes("sourcePaths"));
    for (const sourcePaths of [null, "甲/同名.md", [42], ["未选.md"], ["甲/同名.MD"], ["资料/../同名.md"]]) {
      Object.assign(input.canvas.nodes[0], { sourcePaths });
      assert.throws(() => parseGenerationCanvas(input, sources(...paths)), /来源/u);
    }
    Object.assign(input.canvas.nodes[0], { sourcePaths: [] });
    assert.equal(textNode(parseGenerationCanvas(input, []).canvas, "a").text, "甲");
  });

  test("text wiki, inline Markdown and reference links must resolve to selected exact sources", () => {
    const selected = sources("资料/原文.md", "资料/空 格(一).md", "资料/字面%20.md");
    const parseText = (content: string) => {
      const canvas = smallCanvas(); textNode(canvas, "a").text = content;
      return parseGenerationCanvas({ title: "来源", canvas }, selected);
    };
    for (const content of [
      "[[资料/原文.md|原文]]", "![[资料/原文.md#标题]]", "[[#当前标题]]",
      "[原文](资料/原文.md#标题)", "[有空格](<资料/空 格(一).md>)", "[原文](资料/空%20格(一).md)",
      "[原文](资料/空%20格\\(一\\).md)", "[原文](资料/字面%2520.md)",
      "[原文][ref]\n\n[ref]: 资料/原文.md \"标题\"", "[原文][ref]\n\n[ref]: <资料/空 格(一).md>",
      "[当前标题](#当前标题)", "[外部网页](https://example.com/other)", "[[资料/字面%20.md|字面百分号]]"
    ]) parseText(content);
    for (const content of [
      "[[未选.md]]", "![[未选.md#标题|别名]]", "[[原文.md]]", "[[资料/原文.MD]]", "[[../资料/原文.md]]",
      "[未选](未选.md)", "![图片](未选.png)", "[未选](<其他/空 格(一).md>)", "[未选](%2e%2e/原文.md)",
      "[未选](其他/文件((嵌套)).md)", "[未选][ref]\n\n[ref]: 未选.md", "[未选][ref]\n\n[ref]: <未选.md>",
      "[本地](file:///资料/原文.md)", "[笔记](obsidian://open?file=未选)", "[同名](资料/字面%20.md)"
    ]) assert.throws(() => parseText(content), /来源/u, content);
  });

  test("link nodes require a whole http URL actually present in successful source bodies", () => {
    const available = sources("资料/原文.md");
    available[0].content = "[官网](https://example.com/guide?q=1#标题)；另见 https://example.org/path_(part)。\n<http://example.net/start> [https://shown.test/path](https://actual.test/path) http://[::1]:8080/a?ids[]=1";
    const parseUrl = (url: unknown, selected = available) => parseGenerationCanvas({ title: "网页", canvas: {
      nodes: [{ id: "url", type: "link", url, x: 0, y: 0, width: 100, height: 100 }], edges: []
    } }, selected);
    for (const url of ["https://example.com/guide?q=1#标题", "https://example.org/path_(part)", "http://example.net/start", "https://shown.test/path", "https://actual.test/path", "http://[::1]:8080/a?ids[]=1"]) parseUrl(url);
    for (const url of ["https://example.com", "https://example.com/guide", "https://example.com/guide?q=1", "https://example.org/path_", "https://example.net/start", "https://unknown.test/"]) {
      assert.throws(() => parseUrl(url), /未出现在/u, url);
    }
    available[0].content = "https://trusted.test.evil/x https://trusted.test/path-more";
    for (const url of ["https://trusted.test", "https://trusted.test/path"]) assert.throws(() => parseUrl(url), /未出现在/u);
    for (const url of ["file:///notes.md", "obsidian://open", "javascript:alert(1)", "ftp://example.com/", "https://", " https://example.com", "https://example.com/a\nb", null]) {
      assert.throws(() => parseUrl(url), /URL/u);
    }
    assert.throws(() => parseUrl("http://example.net/start", []), /未出现在/u);
    // Neither a source filename nor a requested-but-failed path authorizes a web URL.
    assert.throws(() => parseUrl("https://filename.test/", [{ path: "https://filename.test/", content: "无网址", bytes: 9 }]), /未出现在/u);
  });

  test("groups can contain nodes and nested groups in either array order", () => {
    const nodes: GenerationCanvasDocument["nodes"] = [
      { id: "outer", type: "group", x: -20, y: -20, width: 100, height: 100 },
      { id: "inner", type: "group", x: -10, y: -10, width: 60, height: 60, label: "嵌套" },
      { id: "text", type: "text", text: "内部", x: 0, y: 0, width: 10, height: 10 }
    ];
    validateGenerationCanvas({ nodes, edges: [] });
    validateGenerationCanvas({ nodes: [...nodes].reverse(), edges: [] });
    // Sharing one boundary still counts as complete containment, with distinct bounds.
    nodes[2].x = -10;
    validateGenerationCanvas({ nodes, edges: [] });
  });

  test("partial intersections, equal groups and overlapping ordinary children are rejected", () => {
    const group = { id: "group", type: "group", x: 0, y: 0, width: 100, height: 100 };
    for (const other of [
      { id: "child", type: "text", text: "跨边界", x: 90, y: 10, width: 20, height: 20 },
      { id: "peer", type: "group", x: 90, y: 10, width: 100, height: 100 },
      { id: "same", type: "group", x: 0, y: 0, width: 100, height: 100 },
      { id: "same", type: "text", text: "相等", x: 0, y: 0, width: 100, height: 100 },
      { id: "container", type: "text", text: "反向包含", x: -10, y: -10, width: 120, height: 120 }
    ]) assert.throws(() => validateGenerationCanvas({ nodes: [group, other], edges: [] }), /节点重叠/u);
    const canvas = smallCanvas();
    canvas.nodes.unshift({ id: "group", type: "group", x: -10, y: -10, width: 100, height: 100 });
    canvas.nodes[2].x = 0;
    assert.throws(() => validateGenerationCanvas(canvas), /节点重叠/u);
  });

  test("edges support every side, omitted sides, arrow ends, labels and colors", () => {
    for (const side of [undefined, "top", "right", "bottom", "left"]) {
      for (const end of [undefined, "none", "arrow"]) {
        const canvas = smallCanvas();
        Object.assign(canvas.edges[0], { fromSide: side, toSide: side, fromEnd: end, toEnd: end, label: "关系", color: "2" });
        validateGenerationCanvas(canvas);
      }
    }
    for (const [key, value] of [["fromEnd", "circle"], ["toEnd", null], ["label", 1], ["color", "blue"], ["fromSide", 1]]) {
      const canvas = smallCanvas(); (canvas.edges[0] as any)[key as string] = value;
      assert.throws(() => validateGenerationCanvas(canvas), /导图结构无效/u);
    }
  });

  test("group backgrounds, mixed type fields and unsupported extensions never reach output", () => {
    const base = { id: "node", x: 0, y: 0, width: 100, height: 100 };
    for (const node of [
      { ...base, type: "group", background: "资料/背景.png" },
      { ...base, type: "group", backgroundStyle: "cover" },
      { ...base, type: "group", label: 1 },
      { ...base, type: "group", sourcePaths: [] },
      { ...base, type: "file", file: "资料/原文.md", text: "混入文本" },
      { ...base, type: "file", file: "资料/原文.md", sourcePaths: [] },
      { ...base, type: "text", text: "文本", url: "https://example.com/" },
      { ...base, type: "text", text: "文本", metadata: {} },
      { ...base, type: "image", file: "资料/背景.png" }
    ]) assert.throws(() => parseGenerationCanvas({ title: "无扩展读取", canvas: { nodes: [node], edges: [] } }, sources("资料/原文.md")), /导图结构无效/u);
    const extended = smallCanvas(); Object.assign(extended.nodes[0], { sourcePaths: [] });
    assert.throws(() => validateGenerationCanvas(extended), /不支持的字段/u);
  });

  test("standalone validation needs no source snapshot while parsing checks provenance", () => {
    const canvas: GenerationCanvasDocument = {
      nodes: [
        { id: "file", type: "file", file: "未选择.md", x: 0, y: 0, width: 10, height: 10 },
        { id: "url", type: "link", url: "https://not-in-sources.test/", x: 20, y: 0, width: 10, height: 10 }
      ], edges: []
    };
    validateGenerationCanvas(canvas);
    assert.throws(() => parseGenerationCanvas({ title: "校验分层", canvas }, []), /不在所选资料/u);
    canvas.nodes.shift();
    assert.throws(() => parseGenerationCanvas({ title: "校验分层", canvas }, []), /未出现在/u);
  });

  test("final text including appended sources grows and shifts every lower node kind once", () => {
    const available = sources("资料/原文.md");
    available[0].content = "https://example.com/source";
    const input = { title: "补高", canvas: { nodes: [
      { id: "text", type: "text", text: "正文", sourcePaths: ["资料/原文.md"], x: 0, y: 0, width: 240, height: 58 },
      { id: "lower-text", type: "text", text: "下方", x: 0, y: 80, width: 240, height: 80 },
      { id: "file", type: "file", file: "资料/原文.md", x: 260, y: 80, width: 100, height: 80 },
      { id: "link", type: "link", url: "https://example.com/source", x: 380, y: 80, width: 100, height: 80 },
      { id: "group", type: "group", x: 500, y: 80, width: 300, height: 160, label: "下方分组" },
      { id: "child", type: "text", text: "组内", x: 520, y: 100, width: 240, height: 80 }
    ], edges: [{ id: "edge", fromNode: "text", toNode: "file", label: "来源", toEnd: "arrow" }] } };
    const before = clone(input);
    const output = parseGenerationCanvas(input, available);
    const expanded = textNode(output.canvas, "text");
    assert.equal(expanded.text, "正文\n\n[[资料/原文.md|原文]]");
    assert.equal(expanded.height, 98, "the appended source adds a visible paragraph");
    for (const id of ["lower-text", "file", "link", "group"]) assert.equal(canvasNode(output.canvas, id).y, 120, id);
    assert.equal(canvasNode(output.canvas, "child").y, 140);
    assert.equal(canvasNode(output.canvas, "group").height, 160, "a group starting below the cut moves without growing");
    assert.deepEqual(output.canvas.edges, input.canvas.edges);
    assert.deepEqual(output.canvas.nodes.map(node => node.id), input.canvas.nodes.map(node => node.id));
    assert.deepEqual(input, before);
    assert.deepEqual(parseGenerationCanvas(output, available), output, "parsing the final output is idempotent");
    validateGenerationCanvas(output.canvas);
  });

  test("nested containing groups and ancestors grow while lower groups and children translate once", () => {
    const canvas: GenerationCanvasDocument = { nodes: [
      { id: "outer", type: "group", x: 0, y: 0, width: 700, height: 300 },
      { id: "inner", type: "group", x: 20, y: 20, width: 300, height: 200 },
      { id: "text", type: "text", text: "两行\n文本", x: 40, y: 40, width: 240, height: 20 },
      { id: "sibling", type: "text", text: "同组下方", x: 40, y: 100, width: 240, height: 60 },
      { id: "lower-group", type: "group", x: 0, y: 340, width: 300, height: 160 },
      { id: "lower-child", type: "text", text: "下一组", x: 20, y: 360, width: 240, height: 60 },
      { id: "outside", type: "text", text: "外部下方", x: 350, y: 500, width: 240, height: 60 }
    ], edges: [] };
    const output = parseGenerationCanvas({ title: "嵌套分组", canvas }, []).canvas;
    assert.equal(textNode(output, "text").height, 82);
    assert.equal(canvasNode(output, "outer").height, 362);
    assert.equal(canvasNode(output, "inner").height, 262);
    assert.equal(canvasNode(output, "outer").y, 0);
    assert.equal(canvasNode(output, "inner").y, 20);
    assert.equal(canvasNode(output, "sibling").y, 162);
    assert.equal(canvasNode(output, "lower-group").y, 402);
    assert.equal(canvasNode(output, "lower-group").height, 160);
    assert.equal(canvasNode(output, "lower-child").y, 422);
    assert.equal(canvasNode(output, "outside").y, 562, "text, inner-group and ancestor thresholds must not add multiple translations");
    validateGenerationCanvas(output);
  });

  test("parallel and nested groups crossing the insertion line keep lower cards contained", () => {
    const canvas: GenerationCanvasDocument = { nodes: [
      { id: "text", type: "text", text: "补高", x: 0, y: 0, width: 240, height: 20 },
      { id: "peer-outer", type: "group", x: 300, y: -20, width: 600, height: 260 },
      { id: "peer-inner", type: "group", x: 320, y: -10, width: 260, height: 200 },
      { id: "above", type: "file", file: "资料/原文.md", x: 340, y: -5, width: 220, height: 20 },
      { id: "below", type: "text", text: "跨线组内下方", x: 340, y: 80, width: 220, height: 60 },
      { id: "ending-at-cut", type: "group", x: 1000, y: -20, width: 100, height: 40 },
      { id: "starting-at-cut", type: "group", x: 1000, y: 20, width: 100, height: 100 },
      { id: "outside", type: "file", file: "资料/原文.md", x: 0, y: 300, width: 240, height: 60 }
    ], edges: [] };
    const output = parseGenerationCanvas({ title: "并列分组", canvas }, sources("资料/原文.md")).canvas;
    assert.equal(canvasNode(output, "peer-outer").height, 298);
    assert.equal(canvasNode(output, "peer-inner").height, 238);
    assert.equal(canvasNode(output, "peer-outer").y, -20);
    assert.equal(canvasNode(output, "peer-inner").y, -10);
    assert.equal(canvasNode(output, "above").y, -5);
    assert.equal(canvasNode(output, "below").y, 118);
    assert.deepEqual(canvasNode(output, "ending-at-cut"), canvasNode(canvas, "ending-at-cut"));
    assert.equal(canvasNode(output, "starting-at-cut").y, 58);
    assert.equal(canvasNode(output, "starting-at-cut").height, 100);
    assert.equal(canvasNode(output, "outside").y, 338);
    validateGenerationCanvas(output);
  });

  test("a containing group ending at the text bottom still grows and never shrinks", () => {
    const canvas: GenerationCanvasDocument = { nodes: [
      { id: "group", type: "group", x: -10, y: -10, width: 260, height: 30 },
      { id: "text", type: "text", text: "正文", x: 0, y: 0, width: 240, height: 20 }
    ], edges: [] };
    const output = parseGenerationCanvas({ title: "底边相接", canvas }, []).canvas;
    assert.equal(canvasNode(output, "group").height, 68);
    assert.equal(canvasNode(output, "group").y, -10);
    assert.equal(canvasNode(output, "text").height, 58);
    const roomy = clone(output);
    canvasNode(roomy, "text").height = 160;
    canvasNode(roomy, "group").height = 200;
    assert.deepEqual(parseGenerationCanvas({ title: "已有足够高度", canvas: roomy }, []).canvas, roomy);
  });

  test("original y then x order is independent of array order and preserves node z-order", () => {
    const nodes: GenerationCanvasDocument["nodes"] = [
      { id: "a", type: "text", text: "左侧", x: 0, y: 0, width: 240, height: 20 },
      { id: "b", type: "text", text: "右侧\n两行", x: 300, y: 0, width: 240, height: 40 },
      { id: "middle", type: "file", file: "资料/原文.md", x: 600, y: 30, width: 100, height: 10 }
    ];
    const parse = (order: typeof nodes) => parseGenerationCanvas({ title: "顺序", canvas: { nodes: order, edges: [] } }, sources("资料/原文.md")).canvas;
    const first = parse(nodes);
    const reversed = parse([...nodes].reverse());
    assert.deepEqual(first.nodes.map(node => node.id), ["a", "b", "middle"]);
    assert.deepEqual(reversed.nodes.map(node => node.id), ["middle", "b", "a"]);
    assert.deepEqual([...first.nodes].sort((a, b) => a.id.localeCompare(b.id)), [...reversed.nodes].sort((a, b) => a.id.localeCompare(b.id)));
    assert.equal(canvasNode(first, "middle").y, 110, "left text expands before the right text despite reversed input order");
    assert.equal(canvasNode(first, "a").height, 58);
    assert.equal(canvasNode(first, "b").height, 82);
  });

  test("multiple text expansions accumulate from each current bounds snapshot", () => {
    const canvas: GenerationCanvasDocument = { nodes: [
      { id: "c", type: "text", text: "尾", x: 0, y: 100, width: 240, height: 20 },
      { id: "file", type: "file", file: "资料/原文.md", x: 0, y: 200, width: 240, height: 60 },
      { id: "b", type: "text", text: "二\n行", x: 0, y: 40, width: 240, height: 20 },
      { id: "a", type: "text", text: "首", x: 0, y: 0, width: 240, height: 20 }
    ], edges: [] };
    const input = { title: "累计补高", canvas };
    const before = clone(input);
    const output = parseGenerationCanvas(input, sources("资料/原文.md"));
    assert.equal(textNode(output.canvas, "a").y, 0);
    assert.equal(textNode(output.canvas, "b").y, 78);
    assert.equal(textNode(output.canvas, "c").y, 200);
    assert.equal(canvasNode(output.canvas, "file").y, 338);
    assert.deepEqual(output.canvas.nodes.map(node => node.id), canvas.nodes.map(node => node.id));
    assert.deepEqual(input, before);
    assert.deepEqual(parseGenerationCanvas(output, sources("资料/原文.md")), output);
    validateGenerationCanvas(output.canvas);
  });

  test("remaining overlaps and original equal rectangles still reject after height repair", () => {
    const overlap: GenerationCanvasDocument = { nodes: [
      { id: "text", type: "text", text: "较长内容", x: 0, y: 0, width: 240, height: 20 },
      { id: "file", type: "file", file: "资料/原文.md", x: 0, y: 10, width: 240, height: 20 }
    ], edges: [] };
    assert.throws(() => parseGenerationCanvas({ title: "仍然重叠", canvas: overlap }, sources("资料/原文.md")), /导图结构无效：节点重叠/u);
    // Without the equality precheck, the first text's insertion could grow the group
    // and turn its originally identical text rectangle into a seemingly valid child.
    const equal: GenerationCanvasDocument = { nodes: [
      { id: "first", type: "text", text: "触发插入", x: 500, y: 0, width: 240, height: 20 },
      { id: "group", type: "group", x: 0, y: 0, width: 240, height: 40 },
      { id: "child", type: "text", text: "原本同框", x: 0, y: 0, width: 240, height: 40 }
    ], edges: [] };
    for (const nodes of [equal.nodes, [...equal.nodes].reverse()]) {
      assert.throws(() => parseGenerationCanvas({ title: "原同框", canvas: { nodes, edges: [] } }, []), /节点重叠/u);
    }
    // Tied original y/x values are processed by ID, but ordinary text cards may
    // never share that top-left corner in the final accepted geometry.
    equal.nodes = [
      { id: "b", type: "text", text: "乙", x: 0, y: 0, width: 240, height: 20 },
      { id: "a", type: "text", text: "甲", x: 0, y: 0, width: 260, height: 40 }
    ];
    for (const nodes of [equal.nodes, [...equal.nodes].reverse()]) {
      assert.throws(() => parseGenerationCanvas({ title: "相同起点", canvas: { nodes, edges: [] } }, []), /节点重叠/u);
    }
  });

  test("height repair never turns invalid dimensions or IDs into accepted geometry", () => {
    const valid: GenerationCanvasDocument = { nodes: [{ id: "text", type: "text", text: "补高", x: 0, y: 0, width: 240, height: 20 }], edges: [] };
    for (const change of [
      (canvas: any) => { canvas.nodes[0].height = 0; },
      (canvas: any) => { canvas.nodes[0].height = -10; },
      (canvas: any) => { canvas.nodes[0].height = NaN; },
      (canvas: any) => { canvas.nodes[0].width = Infinity; },
      (canvas: any) => { canvas.nodes[0].y = Infinity; },
      (canvas: any) => { canvas.nodes[0].id = ""; },
      (canvas: any) => { canvas.nodes.push({ ...canvas.nodes[0], x: 300 }); }
    ]) {
      const canvas = clone(valid); change(canvas);
      assert.throws(() => parseGenerationCanvas({ title: "先校验", canvas }, []), /导图结构无效/u);
    }
    validateGenerationCanvas(valid);
    assert.equal(valid.nodes[0].height, 20, "standalone validation remains a pure check");
  });

  console.log(`generation-canvas: ${passed} tests passed`);
}
