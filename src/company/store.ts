import { atomicWriteJsonFile, readJsonFileIfPresent, serializePiNativeFileWrite } from "../harness/pi-native/file-store-utils";
import { emptyCompanyDocument, normalizeCompanyDocument } from "./logic";
import type { CompanyDocument } from "./types";

/** Projects, dispatches and the project record, in one desktop-only JSON file beside the Conversation Catalog. */
export class CompanyStore {
  private doc: CompanyDocument = emptyCompanyDocument();
  private loaded = false;
  private loading?: Promise<CompanyDocument>;
  private readonly listeners = new Set<() => void>();
  constructor(private readonly file: string) {}
  async load(): Promise<CompanyDocument> {
    if (this.loaded) return this.doc;
    if (!this.loading) this.loading = (async () => {
      this.doc = normalizeCompanyDocument(await readJsonFileIfPresent(this.file, "公司记录"));
      this.loaded = true;
      return this.doc;
    })().finally(() => { this.loading = undefined; });
    return this.loading;
  }
  snapshot(): CompanyDocument { return this.doc; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  /** Applies one change in memory, then writes atomically; listeners see the new state at once. */
  async mutate(change: (doc: CompanyDocument) => CompanyDocument): Promise<CompanyDocument> {
    await this.load();
    const next = normalizeCompanyDocument(change(structuredClone(this.doc)));
    this.doc = next;
    for (const listener of this.listeners) listener();
    await serializePiNativeFileWrite(this.file, () => atomicWriteJsonFile(this.file, structuredClone(next), "公司记录", value => normalizeCompanyDocument(value)));
    return next;
  }
}
