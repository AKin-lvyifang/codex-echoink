import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { TFile, TFolder } from "obsidian";
import { parse } from "yaml";
import { emptyKnowledgeFolderBindings, type KnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { saveAnswerAsNote, type AnswerSaveInput, type AnswerSaveVault } from "../ui/codex-view/answer-save";

function bindingsAt(directory = "成果/输出"): KnowledgeFolderBindings {
  const bindings = emptyKnowledgeFolderBindings();
  Object.assign(bindings.roles.outputs, { enabled: true, readPaths: [directory], writePath: directory });
  return bindings;
}

function answerInput(overrides: Partial<AnswerSaveInput> = {}): AnswerSaveInput {
  return {
    folderBindings: bindingsAt(), question: "如何做好知识整理？", answerMarkdown: "原样回答。",
    conversationId: "conversation-123", conversationTitle: "知识整理", sourcePaths: ["资料/原文.md"],
    savedAt: new Date("2026-10-19T08:09:10.000Z"), ...overrides
  };
}

function expectedLocalTime(date: Date): string {
  return new Intl.DateTimeFormat("sv-SE", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).format(date);
}

async function diskVault(root: string) {
  await fs.mkdir(root, { recursive: true });
  const entries = new Map<string, TFile | TFolder>();
  const writes = { folders: 0, files: 0 };
  const hostPath = (relative: string) => {
    const target = path.resolve(root, relative);
    assert(target.startsWith(`${path.resolve(root)}${path.sep}`), "fixture writes must stay inside its disposable Vault");
    return target;
  };
  const seedFolder = async (relative: string) => {
    await fs.mkdir(hostPath(relative), { recursive: true });
    const folder = new TFolder();
    folder.path = relative;
    folder.name = path.basename(relative);
    entries.set(relative, folder);
    return folder;
  };
  const seedFile = async (relative: string, text: string) => {
    await fs.mkdir(path.dirname(hostPath(relative)), { recursive: true });
    await fs.writeFile(hostPath(relative), text, { flag: "wx" });
    const file = Object.assign(new TFile(), { path: relative });
    entries.set(relative, file);
    return file;
  };
  const hooks = {
    beforeFolder: undefined as ((relative: string) => Promise<void>) | undefined,
    beforeCreate: undefined as ((relative: string) => Promise<void>) | undefined
  };
  const vault: AnswerSaveVault = {
    getAbstractFileByPath: relative => entries.get(relative) ?? null,
    createFolder: async relative => {
      writes.folders++;
      await hooks.beforeFolder?.(relative);
      await fs.mkdir(hostPath(relative));
      const folder = new TFolder();
      folder.path = relative;
      folder.name = path.basename(relative);
      entries.set(relative, folder);
      return folder;
    },
    create: async (relative, text) => {
      writes.files++;
      await hooks.beforeCreate?.(relative);
      await fs.writeFile(hostPath(relative), text, { flag: "wx" });
      const file = Object.assign(new TFile(), { path: relative });
      entries.set(relative, file);
      return file;
    }
  };
  return { vault, writes, hooks, seedFolder, seedFile, read: (relative: string) => fs.readFile(hostPath(relative), "utf8") };
}

export async function runAnswerSaveTests(root: string): Promise<void> {
  let passed = 0;
  const test = async (name: string, run: (fixture: Awaited<ReturnType<typeof diskVault>>) => Promise<void>) => {
    const fixture = await diskVault(path.join(root, String(passed + 1)));
    await run(fixture);
    passed++;
    console.log(`PASS answer-save: ${name}`);
  };
  let networkCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { networkCalls++; throw new Error("manual save must not call a Provider"); };
  try {
    await test("unbound and disabled outputs perform zero writes", async ({ vault, writes }) => {
      const disabled = bindingsAt(); disabled.roles.outputs.enabled = false;
      const noWritePath = bindingsAt(); noWritePath.roles.outputs.writePath = null;
      const withdrawn = bindingsAt(); withdrawn.roles.outputs.readPaths = ["其他输出"];
      for (const folderBindings of [undefined, null, emptyKnowledgeFolderBindings(), disabled, noWritePath, withdrawn]) {
        await assert.rejects(saveAnswerAsNote(vault, answerInput({ folderBindings })), /设置 › 知识库/u);
      }
      assert.deepEqual(writes, { folders: 0, files: 0 });
    });

    await test("unsafe or stale bindings never rebuild a root", async ({ vault, writes, seedFile }) => {
      for (const directory of ["../外部", "/绝对路径", "C:\\外部", "成果/../外部", "./成果", "成果//输出", ".obsidian", "成果\\输出", " 成果/输出"]) {
        await assert.rejects(saveAnswerAsNote(vault, answerInput({ folderBindings: bindingsAt(directory) })), /设置 › 知识库/u);
      }
      await assert.rejects(saveAnswerAsNote(vault, answerInput()), /输出目录已失效/u);
      await seedFile("成果/输出", "a file is not a bound folder");
      await assert.rejects(saveAnswerAsNote(vault, answerInput()), /输出目录已失效/u);
      assert.deepEqual(writes, { folders: 0, files: 0 });
    });

    await test("read-only conversation saves unchanged Markdown and valid properties without a model", async ({ vault, writes, seedFolder, read }) => {
      await seedFolder("成果/输出");
      const plugin = { settings: { defaultPermission: "read-only", knowledgeBase: { folderBindings: bindingsAt() } } };
      const question = '提问："标题"\n---\n类型: 不应注入';
      const answerMarkdown = "\n# 原始回答\r\n\n- **保留**\n![[图片.png]]\n```yaml\n类型: 正文\n```\n";
      const input = answerInput({ folderBindings: plugin.settings.knowledgeBase.folderBindings, question, answerMarkdown,
        sourcePaths: ["资料/原文.md", "资料/第二篇.md", "资料/原文.md"] });
      const saved = await saveAnswerAsNote(vault, input);
      const content = await read(saved);
      const frontmatterEnd = content.indexOf("\n---\n", 4);
      const properties = parse(content.slice(4, frontmatterEnd));
      assert.deepEqual(properties, { 类型: "摘录", 提问: question, 来源对话: "知识整理 (conversation-123)",
        来源: ["[[资料/原文]]", "[[资料/第二篇]]"], 保存时间: expectedLocalTime(input.savedAt!) });
      assert.equal(content.slice(frontmatterEnd + 5), `\n${answerMarkdown}\n\n## 来源\n- [[资料/原文]]\n- [[资料/第二篇]]\n`);
      assert.equal(plugin.settings.defaultPermission, "read-only");
      assert.deepEqual(writes, { folders: 1, files: 1 });
      assert.equal(networkCalls, 0);
    });

    await test("same-name files and folders are retained and numbered", async ({ vault, seedFolder, seedFile, read }) => {
      await seedFolder("成果/输出"); await seedFolder("成果/输出/摘录");
      const base = "成果/输出/摘录/如何做好知识整理";
      await seedFile(`${base}.md`, "USER CONTENT"); await seedFolder(`${base} 2.md`);
      assert.equal(await saveAnswerAsNote(vault, answerInput()), `${base} 3.md`);
      assert.equal(await read(`${base}.md`), "USER CONTENT");
    });

    await test("concurrent same-name saves produce two complete notes", async ({ vault, seedFolder, read }) => {
      await seedFolder("成果/输出");
      const saved = await Promise.all([saveAnswerAsNote(vault, answerInput({ answerMarkdown: "第一条" })),
        saveAnswerAsNote(vault, answerInput({ answerMarkdown: "第二条" }))]);
      assert.deepEqual(saved, ["成果/输出/摘录/如何做好知识整理.md", "成果/输出/摘录/如何做好知识整理 2.md"]);
      assert.match(await read(saved[0]), /\n第一条\n/u); assert.match(await read(saved[1]), /\n第二条\n/u);
    });

    await test("an external file creation race preserves its content", async ({ vault, hooks, seedFolder, seedFile, read }) => {
      await seedFolder("成果/输出");
      hooks.beforeCreate = async relative => {
        hooks.beforeCreate = undefined;
        await seedFile(relative, "EXTERNAL USER CONTENT");
        throw new Error("File already exists");
      };
      assert.equal(await saveAnswerAsNote(vault, answerInput()), "成果/输出/摘录/如何做好知识整理 2.md");
      assert.equal(await read("成果/输出/摘录/如何做好知识整理.md"), "EXTERNAL USER CONTENT");
    });

    await test("a concurrent child folder creation is accepted", async ({ vault, hooks, seedFolder, writes }) => {
      await seedFolder("成果/输出");
      hooks.beforeFolder = async relative => { await seedFolder(relative); throw new Error("Folder already exists"); };
      assert.equal(await saveAnswerAsNote(vault, answerInput()), "成果/输出/摘录/如何做好知识整理.md");
      assert.deepEqual(writes, { folders: 1, files: 1 });
    });

    await test("punctuation, Unicode truncation, and reserved names yield safe filenames", async ({ vault, seedFolder }) => {
      await seedFolder("成果/输出");
      for (const [question, filename] of [
        ["../../说：\"好\"？*<>|\\", "说好.md"], ["？！---", "对话摘录.md"], ["CON", "摘录 CON.md"],
        ["一二三四五六七八九十一二三四五六七八九十一二三四末尾", "一二三四五六七八九十一二三四五六七八九十一二三四.md"],
        ["🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂尾", "🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂.md"]
      ]) assert.equal(await saveAnswerAsNote(vault, answerInput({ question })), `成果/输出/摘录/${filename}`);
    });

    await test("literal percent source links resolve to their real files rather than encoded or decoded decoys", async ({ vault, seedFolder, seedFile, read }) => {
      await seedFolder("成果/输出");
      await seedFile("资料/增长100%.md", "LITERAL PERCENT SOURCE");
      await seedFile("资料/增长100%25.md", "WRONG ENCODED TARGET");
      await seedFile("资料/字面%20.md", "LITERAL PERCENT ESCAPE SOURCE");
      await seedFile("资料/字面 .md", "WRONG DECODED TARGET");
      const sourcePaths = ["资料/增长100%.md", "资料/字面%20.md"];
      const saved = await saveAnswerAsNote(vault, answerInput({ conversationTitle: undefined, sourcePaths }));
      const content = await read(saved);
      const properties = parse(content.slice(4, content.indexOf("\n---\n", 4)));
      assert.equal(properties.来源对话, "conversation-123");
      const bodyLinks = content.slice(content.indexOf("\n## 来源\n")).split("\n")
        .filter(line => line.startsWith("- ")).map(line => line.slice(2));
      for (const links of [properties.来源 as string[], bodyLinks]) {
        assert.equal(links.length, sourcePaths.length);
        const targets = links.map(link => {
          const match = /^\[\[([^\r\n]+)\]\]$/u.exec(link);
          assert(match, "each saved source must be a complete wikilink");
          // Obsidian resolves the literal link path, with # and | reserved for subpath/alias.
          const linkPath = match[1].split("|")[0].split("#")[0];
          const target = vault.getAbstractFileByPath(linkPath) ?? vault.getAbstractFileByPath(`${linkPath}.md`);
          assert(target instanceof TFile, "the saved link must resolve to a real source file");
          return target;
        });
        assert.deepEqual(targets.map(target => target.path), sourcePaths);
        assert.deepEqual(await Promise.all(targets.map(target => read(target.path))),
          ["LITERAL PERCENT SOURCE", "LITERAL PERCENT ESCAPE SOURCE"]);
      }
    });

    await test("Markdown links omit .md while Canvas and other file extensions resolve unchanged", async ({ vault, seedFolder, seedFile, read }) => {
      await seedFolder("成果/输出");
      const sourcePaths = ["资料/原文.md", "资料/图谱.md.canvas", "资料/附件.pdf"];
      for (const source of sourcePaths) await seedFile(source, `SOURCE ${source}`);
      const saved = await saveAnswerAsNote(vault, answerInput({ sourcePaths }));
      const content = await read(saved);
      const properties = parse(content.slice(4, content.indexOf("\n---\n", 4)));
      const bodyLinks = content.slice(content.indexOf("\n## 来源\n")).split("\n")
        .filter(line => line.startsWith("- ")).map(line => line.slice(2));
      for (const links of [properties.来源 as string[], bodyLinks]) {
        assert.deepEqual(links, ["[[资料/原文]]", "[[资料/图谱.md.canvas]]", "[[资料/附件.pdf]]"]);
        const targets = links.map(link => {
          const linkPath = link.slice(2, -2);
          const target = vault.getAbstractFileByPath(linkPath) ?? vault.getAbstractFileByPath(`${linkPath}.md`);
          assert(target instanceof TFile);
          return target;
        });
        assert.deepEqual(targets.map(target => target.path), sourcePaths);
        assert.deepEqual(await Promise.all(targets.map(target => read(target.path))), sourcePaths.map(source => `SOURCE ${source}`));
      }
    });

    const timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    await test(`saved time follows local ${timeZone} across midnight and daylight saving changes`, async ({ vault, seedFolder, read }) => {
      await seedFolder("成果/输出");
      for (const sample of [
        { instant: "2026-10-19T06:09:59.000Z", local: { "America/Los_Angeles": "2026-10-18 23:09", "Asia/Shanghai": "2026-10-19 14:09" } },
        { instant: "2026-12-31T20:04:59.000Z", local: { "America/Los_Angeles": "2026-12-31 12:04", "Asia/Shanghai": "2027-01-01 04:04" } }
      ]) {
        const savedAt = new Date(sample.instant);
        const content = await read(await saveAnswerAsNote(vault, answerInput({ savedAt })));
        const properties = parse(content.slice(4, content.indexOf("\n---\n", 4)));
        const expected = (sample.local as Record<string, string>)[timeZone] ?? expectedLocalTime(savedAt);
        assert.equal(properties.保存时间, expected);
      }
    });

    await test("imported source names unsafe for Obsidian wikilinks fail before any write", async ({ vault, writes, seedFolder, seedFile }) => {
      await seedFolder("成果/输出");
      for (const source of ["资料/标题#子标题.md", "资料/块^标识.md", "资料/[草稿.md", "资料/草稿].md", "资料/原文|别名.md", "资料/[[]].md"]) {
        await seedFile(source, "EXTERNALLY IMPORTED SOURCE");
        await assert.rejects(saveAnswerAsNote(vault, answerInput({ sourcePaths: [source] })), /来源路径.*重命名来源笔记或文件夹/u);
      }
      assert.deepEqual(writes, { folders: 0, files: 0 });
    });

    await test("no sources uses an empty property list", async ({ vault, seedFolder, read }) => {
      await seedFolder("成果/输出");
      const content = await read(await saveAnswerAsNote(vault, answerInput({ sourcePaths: [] })));
      assert.match(content, /\n来源: \[\]\n/u); assert(content.endsWith("\n\n## 来源\n"));
    });

    await test("invalid source paths and dates fail before writes", async ({ vault, writes, seedFolder }) => {
      await seedFolder("成果/输出");
      await assert.rejects(saveAnswerAsNote(vault, answerInput({ sourcePaths: ["../外部.md"] })), /来源笔记路径无效/u);
      await assert.rejects(saveAnswerAsNote(vault, answerInput({ savedAt: new Date("invalid") })), /Invalid time value/u);
      assert.deepEqual(writes, { folders: 0, files: 0 });
    });

    await test("a file occupying the child directory is retained", async ({ vault, writes, seedFolder, seedFile, read }) => {
      await seedFolder("成果/输出"); await seedFile("成果/输出/摘录", "KEEP");
      await assert.rejects(saveAnswerAsNote(vault, answerInput()), /摘录路径已被文件占用/u);
      assert.equal(await read("成果/输出/摘录"), "KEEP"); assert.deepEqual(writes, { folders: 0, files: 0 });
    });

    await test("folder failure propagates without file writes", async ({ vault, hooks, writes, seedFolder }) => {
      await seedFolder("成果/输出");
      hooks.beforeFolder = async () => { throw new Error("disk is read-only"); };
      await assert.rejects(saveAnswerAsNote(vault, answerInput()), /disk is read-only/u);
      assert.deepEqual(writes, { folders: 1, files: 0 });
    });

    await test("an error after a file becomes visible is not mistaken for a name collision", async ({ vault, hooks, writes, seedFolder, seedFile, read }) => {
      await seedFolder("成果/输出");
      hooks.beforeCreate = async relative => { await seedFile(relative, "VISIBLE CONTENT"); throw new Error("disk full after create"); };
      await assert.rejects(saveAnswerAsNote(vault, answerInput()), /disk full after create/u);
      assert.equal(writes.files, 1);
      assert.equal(await read("成果/输出/摘录/如何做好知识整理.md"), "VISIBLE CONTENT");
      assert.equal(vault.getAbstractFileByPath("成果/输出/摘录/如何做好知识整理 2.md"), null);
    });

    await test("write failure is not retried and does not poison later manual saves", async ({ vault, hooks, writes, seedFolder }) => {
      await seedFolder("成果/输出");
      hooks.beforeCreate = async () => { throw new Error("disk full"); };
      await assert.rejects(saveAnswerAsNote(vault, answerInput()), /disk full/u);
      assert.equal(writes.files, 1);
      hooks.beforeCreate = undefined;
      assert.equal(await saveAnswerAsNote(vault, answerInput()), "成果/输出/摘录/如何做好知识整理.md");
      assert.equal(writes.files, 2);
    });
    assert.equal(networkCalls, 0, "saving never requests a model or other network service");
    console.log(`answer-save: ${passed} tests passed; ${networkCalls} network requests`);
  } finally {
    globalThis.fetch = originalFetch;
  }
}
