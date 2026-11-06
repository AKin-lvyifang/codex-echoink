import { emptyCompanyDocument, normalizeCompanyDocument } from "../company/logic";
import type { CompanyRecordStore } from "../company/service";
import type { CompanyDocument } from "../company/types";
import type { MobileStorageAdapter } from "./store";

/** One company record per device, beside that device's tasks: worker conversations never leave the device. */
export class MobileCompanyStore implements CompanyRecordStore {
  private doc: CompanyDocument = emptyCompanyDocument();
  private loading?: Promise<CompanyDocument>;
  private loaded = false;
  private writing: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  constructor(private readonly adapter: MobileStorageAdapter, readonly file: string) {}
  load(): Promise<CompanyDocument> {
    if (this.loaded) return Promise.resolve(this.doc);
    this.loading ??= (async () => {
      const raw = await this.adapter.exists(this.file) ? await this.adapter.read(this.file) : "";
      let parsed: unknown;
      try { parsed = raw ? JSON.parse(raw) : undefined; } catch { throw new Error("公司记录已损坏，未覆盖原文件。"); }
      this.doc = normalizeCompanyDocument(parsed); this.loaded = true;
      return this.doc;
    })().finally(() => { this.loading = undefined; });
    return this.loading;
  }
  snapshot(): CompanyDocument { return this.doc; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async mutate(change: (doc: CompanyDocument) => CompanyDocument): Promise<CompanyDocument> {
    await this.load();
    const next = normalizeCompanyDocument(change(structuredClone(this.doc)));
    this.doc = next;
    for (const listener of this.listeners) listener();
    const text = JSON.stringify(next, null, 2);
    const write = this.writing.then(async () => {
      const parent = this.file.slice(0, this.file.lastIndexOf("/"));
      if (parent && !await this.adapter.exists(parent)) await this.adapter.mkdir(parent);
      await this.adapter.write(this.file, text);
    });
    this.writing = write.catch(() => {});
    await write;
    return next;
  }
}
