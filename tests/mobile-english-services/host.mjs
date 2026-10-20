import { folderFixture } from "../mobile-knowledge-folders/host.mjs";
import { existsSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { answer } from "../mobile/host.mjs";
export function responseFor(userPrompt) {
  const input = JSON.parse(userPrompt), translated = input.blocks.filter(block => block.mode === "translate");
  const first = translated.find(block => block.text.includes("鼓起勇气"));
  return JSON.stringify({ blocks: translated.map(block => ({ id: block.id, english: block.text.replaceAll("鼓起勇气", "worked up the courage"),
    alignments: block.id === first?.id ? [{ id: "courage", kind: "translation", source: [{ quote: "鼓起勇气", occurrence: 0 }], target: [{ quote: "worked up the courage", occurrence: 0 }], reason: "鼓起勇气开口。" }] : [] })),
    expressions: first ? [{ blockId: first.id, term: "work up the courage", type: "phrase", meaning: "鼓起勇气", category: "情绪感受", scene: "原本犹豫，最后提出请求。", example: "I worked up the courage to bring it up.", reason: "克服心理障碍。", usage: "谈论原本不敢做的事。", sourceExcerpt: "鼓起勇气", targetExcerpt: "worked up the courage", alignmentId: "courage" }] : [] });
}
const events = target => {
  const refs = new Set(); target.on = (name, callback) => { const ref = { name, callback }; refs.add(ref); return ref; }; target.offref = ref => refs.delete(ref);
  return { emit(name, ...args) { for (const ref of refs) if (ref.name === name) ref.callback(...args); }, get size() { return refs.size; } };
};
/** Real-disk Obsidian boundary. All product repository/service/model/transport code remains real. */
export async function englishFixture(api, root, seed = {}, options = {}) {
  const f = await folderFixture(api, root, { "journal/2026-10-19.md": "I finally 鼓起勇气 to ask.\nPRIVATE-MEDICAL-DETAIL\nI didn't explain why.", ...seed });
  const file = relative => {
    if (!existsSync(f.full(relative))) return null;
    const stat = statSync(f.full(relative));
    if (stat.isDirectory()) return Object.assign(new api.TFolder(), { path: relative, name: path.posix.basename(relative) });
    const entry = new api.TFile(relative); entry.stat = { size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs }; return entry;
  };
  f.app.vault.getAbstractFileByPath = file; f.app.vault.getFileByPath = file;
  const vaultEvents = events(f.app.vault); f.app.workspace = { getLeavesOfType: () => [], on: () => ({}), offref() {} };
  f.adapter.process = async (relative, change) => { const previous = await f.adapter.read(relative); await f.adapter.write(relative, change(previous)); };
  f.app.vault.create = async (relative, text) => { assert.equal(existsSync(f.full(relative)), false); await f.adapter.write(relative, text); return file(relative); };
  f.adapter.remove = async relative => { f.calls.removes.push(relative); await fs.unlink(f.full(relative)); };
  f.app.vault.trash = async entry => f.adapter.remove(entry.path);
  f.settings.englishDiary.enabled = true;
  const bindings = f.settings.knowledgeBase.folderBindings = api.emptyKnowledgeFolderBindings();
  bindings.roles.outputs = { enabled: true, readPaths: ["outputs"], writePath: "outputs", allowedSubdirectories: ["英文日记", "英文日记/表达库"], allowedSubdirectoryRoots: ["outputs"] };
  await fs.mkdir(f.full("outputs"), { recursive: true });
  let paid = true, skill = true, handler = options.request;
  f.services.skills = () => [{ id: "english-diary", enabled: skill }];
  f.services.requireAvailableEchoInkSkill = async id => { assert.equal(id, "english-diary"); if (!skill) throw Error("Skill disabled"); return api.renderBuiltinSkill(api.BUILTIN_SKILLS.find(item => item.id === id)); };
  const requests = [], usage = [];
  f.services.usageObserver = { recordUsage: async event => { usage.push(event); }, onRecordError(error) { throw error; } };
  const request = async params => {
    requests.push(params); f.calls.model++;
    if (handler) return handler(params);
    const body = JSON.parse(params.body); const user = body.messages?.find(message => message.role === "user")?.content ?? body.input?.find(message => message.role === "user")?.content;
    return answer("openai-completions", responseFor(user));
  };
  // Deliberately construct before account initialization; service must use live access.
  const service = new api.MobileEnglishDiaryService(f.services, request);
  f.services.accountService = { checkCapability: () => paid, requireCapability() { if (!paid) throw Error("PRO expired"); }, subscribe: () => () => {} };
  return { ...f, service, requests, usage, vaultEvents,
    paid(value) { paid = value; }, skill(value) { skill = value; }, request(value) { handler = value; },
    cold() { return new api.MobileEnglishDiaryService(f.services, request); },
    async approve() { const provider = await service.readProvider(); await service.approveProvider(provider.version); },
    async snapshot() { const values = {}; const visit = async relative => { const listed = await f.adapter.list(relative); for (const child of listed.files) values[child] = await f.adapter.read(child); for (const child of listed.folders) await visit(child); }; await visit(""); return values; }
  };
}
