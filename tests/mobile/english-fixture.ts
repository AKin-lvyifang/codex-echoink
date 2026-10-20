import type { MobileServices } from "../../src/mobile/services";
import { mobileProvider, mobileModel } from "../../src/mobile/settings";
import type { MobileRequest } from "../../src/mobile/transport";

/** Controlled Provider response for browser appearance only; not real-model evidence. */
export const syntheticEnglishRequest: MobileRequest = async request => {
  const body = JSON.parse(String(request.body)), input = JSON.parse(body.messages?.find((item: any) => item.role === "user")?.content ?? body.input?.find((item: any) => item.role === "user")?.content), blocks = input.blocks.filter((block: any) => block.mode === "translate");
  await new Promise(resolve => setTimeout(resolve, 160));
  const first = blocks.find((block: any) => block.text.includes("鼓起勇气"));
  const content = JSON.stringify({ blocks: blocks.map((block: any) => ({ id: block.id, english: block.text.replaceAll("鼓起勇气", "worked up the courage"), alignments: block.id === first?.id ? [{ id: "courage", kind: "translation", source: [{ quote: "鼓起勇气", occurrence: 0 }], target: [{ quote: "worked up the courage", occurrence: 0 }], reason: "合成测试：克服犹豫后表达想法。" }] : [] })), expressions: first ? [{ blockId: first.id, term: "work up the courage", type: "phrase", meaning: "鼓起勇气", category: "情绪感受", scene: "合成测试：提出想法", example: "I worked up the courage to share my idea.", reason: "合成测试：克服犹豫", usage: "谈论原本不敢做的事", sourceExcerpt: "鼓起勇气", targetExcerpt: "worked up the courage", alignmentId: "courage" }] : [] });
  return { status: 200, json: { choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } } };
};
export async function seedEnglishFixture(host: any, services: MobileServices): Promise<void> {
  host.adapter.process = async (path: string, change: (content: string) => string) => host.adapter.write(path, change(await host.adapter.read(path)));
  await host.app.vault.createFolder("outputs");
  const settings = services.settings, provider = mobileProvider("deepseek");
  Object.assign(provider, { name: "DeepSeek · 测试", apiKey: "synthetic-browser-not-a-real-key", models: [mobileModel("synthetic-english")], defaultModelId: "synthetic-english" });
  settings.apiProviders = [provider]; settings.activeApiProviderId = provider.id; settings.defaultModel = "synthetic-english";
  settings.englishDiary.enabled = true;
  const snapshot = await services.knowledgeFolders.read(), bindings = structuredClone(snapshot.bindings);
  bindings.roles.outputs = { enabled: true, readPaths: ["outputs"], writePath: "outputs", allowedSubdirectories: ["英文日记", "英文日记/表达库"], allowedSubdirectoryRoots: ["outputs"] };
  await services.knowledgeFolders.saveBindings(bindings, snapshot.token);
  const source = "journal/2026-10-19.md", content = "# 合成测试日记\n\nI finally 鼓起勇气 to share my idea.\n\n测试：私密段落留在本地。";
  const existing = host.app.vault.getAbstractFileByPath(source); if (existing) await host.app.vault.modify(existing, content); else await host.app.vault.create(source, content);
  const current = await services.englishPage.readProvider(); await services.englishPage.approveProvider(current.version);
  const inspected = await services.englishPage.inspectSource(source), privacy = structuredClone(inspected.privacy);
  for (const rule of privacy.rules) if (inspected.blocks.find(block => block.id === rule.blockId)?.text.includes("私密段落")) rule.mode = "exclude";
  await services.englishPage.api.generate(source, { privacy, owner: "workspace" });
}
