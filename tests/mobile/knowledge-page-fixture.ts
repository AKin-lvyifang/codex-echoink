import type { MobileServices } from "../../src/mobile/services";
import { sha256Hex } from "../../src/utils/sha256";

/** Explicit synthetic browser data, never imported by a production entry. */
export async function seedKnowledgePageFixture(host: any, services: MobileServices): Promise<void> {
  await host.app.vault.create("Wiki/测试：来源待核对.md", `# 测试：来源待核对\n\n合成验收文件。\n<!-- echoink-source: ${JSON.stringify({ path: "Raw/测试：已缺失.md", revision: `sha256:${"0".repeat(64)}` })} -->`);
  await host.app.vault.createFolder("Projects/测试项目");
  await host.app.vault.create("Projects/测试项目/计划.md", "# 测试项目\n\n[[Wiki/项目/工作复盘]]");
  const stat = host.adapter.stat.bind(host.adapter);
  host.adapter.stat = async (path: string) => {
    const value = await stat(path), file = host.app.vault.getAbstractFileByPath(path);
    return value?.type === "file" && file?.stat ? { ...value, ctime: file.stat.ctime, mtime: file.stat.mtime, size: new TextEncoder().encode(await host.adapter.read(path)).length } : value;
  };
  const recordId = "maintenance-" + "f".repeat(32), record = {
    schemaVersion: 1, recordId, runId: "synthetic-browser-maintenance", at: Date.now(), date: new Date().toISOString().slice(0, 10),
    summary: "测试：合成整理记录，供界面验收", sources: [{ path: "Raw/资料.md", fingerprint: "synthetic", status: "unread", evidencePaths: [] }],
    result: { schema: "echoink.knowledge-maintenance-result.v1", status: "completed", notes: [{ operation: "updated", path: "Wiki/项目/工作复盘.md", title: "测试：工作复盘", summary: "合成测试记录，非真实模型执行" }], issues: [], systemPaths: [] }
  };
  const stable = (value: any): string => value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(stable).join(",")}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  const path = `${services.directory.replace(/\/mobile$/u, "")}/pi-agent-product-v1/knowledge/records/${recordId}.json`;
  await host.adapter.write(path, JSON.stringify({ schemaVersion: 1, kind: "record", vaultId: "synthetic-browser-vault", payloadDigest: sha256Hex(stable(record)), payload: record }));
  host.app.metadataCache.resolvedLinks = Object.fromEntries(host.app.vault.getMarkdownFiles().map((file: { path: string }) => [file.path, file.path === "Projects/测试项目/计划.md" ? { "Wiki/项目/工作复盘.md": 1 } : {}]));
  host.app.metadataCache.trigger("resolved");
}
