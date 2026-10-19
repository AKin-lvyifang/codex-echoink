import { TFile, TFolder, type App } from "obsidian";
import type { PdfFiles } from "./types";

export class PdfVaultFiles implements PdfFiles {
  constructor(private readonly app: App, private readonly stateDirectory: string, private readonly mapped = false) {}
  roots(): string[] { return this.app.vault.getRoot().children.filter(item => item instanceof TFolder).map(item => item.path); }
  private safe(path: string): string {
    if (!path || path.startsWith("/") || /[\\:\p{Cc}]/u.test(path) || path.split("/").some(part => !part || part === "." || part === "..")) throw new Error("PDF 成果路径无效。");
    return path;
  }
  private state(path: string): boolean { return path.startsWith(this.stateDirectory + "/"); }
  async exists(path: string): Promise<boolean> { return this.app.vault.adapter.exists(this.safe(path)); }
  async readBinary(path: string): Promise<Uint8Array> { return new Uint8Array(await this.app.vault.adapter.readBinary(this.safe(path))); }
  async read(path: string): Promise<string> { return this.app.vault.adapter.read(this.safe(path)); }
  private async parents(path: string): Promise<void> {
    const parts = path.split("/"); parts.pop(); let parent = "";
    for (const part of parts) { parent = parent ? `${parent}/${part}` : part;
      if (!await this.exists(parent)) {
        if (this.mapped && !this.state(path)) throw new Error(`PDF 保存位置已失效：${parent}，请重新选择，未补建旧目录。`);
        if (parent.startsWith(this.app.vault.configDir)) await this.app.vault.adapter.mkdir(parent);
        else await this.app.vault.createFolder(parent);
      }
    }
  }
  async create(path: string, value: string | Uint8Array): Promise<void> {
    this.safe(path); await this.parents(path);
    if (await this.exists(path)) throw new Error("目标文件已存在，未覆盖。");
    if (this.state(path)) {
      if (typeof value !== "string") throw new Error("任务记录不能保存 PDF 二进制。");
      await this.app.vault.adapter.write(path, value);
    } else if (typeof value === "string") await this.app.vault.create(path, value);
    else await this.app.vault.createBinary(path, new Uint8Array(value).buffer);
    if (!await this.exists(path)) throw new Error("成果保存未能确认。");
  }
  async replace(path: string, value: string, expected?: string): Promise<void> {
    this.safe(path);
    if (this.state(path)) {
      if (expected === undefined) await this.app.vault.adapter.write(path, value);
      else await this.app.vault.adapter.process(path, current => {
        if (current !== expected) throw new Error("PDF 任务记录已有变化，未覆盖。");
        return value;
      });
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error("成果文件已移动或不存在。");
    await this.app.vault.process(file, current => {
      if (expected === undefined || current !== expected) throw new Error("文件已有用户修改，未覆盖。");
      return value;
    });
  }
  async listJobs(): Promise<string[]> {
    if (!await this.exists(this.stateDirectory)) return [];
    return (await this.app.vault.adapter.list(this.stateDirectory)).files.filter(value => /\/[a-z0-9-]+\.json$/u.test(value)).map(value => value.split("/").pop()!.slice(0, -5));
  }
}
