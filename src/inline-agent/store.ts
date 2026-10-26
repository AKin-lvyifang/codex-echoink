import { atomicWriteJsonFile, readJsonFileIfPresent, serializePiNativeFileWrite } from "../harness/pi-native/file-store-utils";
import { INLINE_STATUSES, type InlineRequest, type SourceAnchor } from "./types";
import { markerFor } from "./document";

export interface InlineRepository {
  load(): Promise<InlineRequest[]>;
  save(records: readonly InlineRequest[]): Promise<void>;
}
export class FileInlineRepository implements InlineRepository {
  constructor(readonly file: string, readonly vaultId: string) {}
  async load(): Promise<InlineRequest[]> {
    const raw = await readJsonFileIfPresent(this.file, "正文请求");
    return raw === null ? [] : this.validate(raw).requests;
  }
  async save(records: readonly InlineRequest[]): Promise<void> {
    const data = structuredClone({ schemaVersion: 1, vaultId: this.vaultId, requests: records });
    await serializePiNativeFileWrite(this.file, () => atomicWriteJsonFile(this.file, data, "正文请求", value => this.validate(value)));
  }
  private validate(value: unknown): { schemaVersion: 1; vaultId: string; requests: InlineRequest[] } {
    const invalid = (): never => { throw new Error("正文请求记录损坏或不属于当前仓库，已停止写入。"); };
    const raw = value as { schemaVersion?: number; vaultId?: string; requests?: InlineRequest[] };
    if (!raw || raw.schemaVersion !== 1 || raw.vaultId !== this.vaultId || !Array.isArray(raw.requests)) return invalid();
    const seen = new Set<string>();
    for (const r of raw.requests) {
      if (!r || typeof r.id !== "string" || !/^[a-zA-Z0-9-]+$/u.test(r.id) || seen.has(r.id) || r.vaultId !== this.vaultId
        || !validNotePath(r.path) || !r.taskId || !r.agentId || typeof r.agentName !== "string" || !INLINE_STATUSES.includes(r.status)
        || !validAnchor(r.instruction) || !r.instruction.trigger || r.instruction.marker !== markerFor(r.id) || !r.instruction.text.endsWith(r.instruction.marker)
        || !validAnchor(r.target) || !["replace", "insert"].includes(r.target.kind) || (r.target.kind === "insert") !== (r.target.from === r.target.to)
        || typeof r.observedDocument !== "string" || !Array.isArray(r.followups) || r.followups.some(item => typeof item !== "string")
        || !Number.isFinite(r.createdAt) || !Number.isFinite(r.updatedAt) || !Array.isArray(r.versions)
        || (!r.versions.length && ["pending", "confirmed"].includes(r.status))) return invalid();
      const versions = new Set<string>();
      for (const v of r.versions) {
        if (!v || !v.id || versions.has(v.id) || !Number.isSafeInteger(v.number) || typeof v.text !== "string" || typeof v.requirement !== "string"
          || !validAnchor(v.target) || typeof v.sourceDocument !== "string" || !v.context || typeof v.context.text !== "string" || !Array.isArray(v.context.segments)) return invalid();
        versions.add(v.id);
      }
      if (r.versions.length ? !versions.has(r.currentVersionId) : r.currentVersionId !== "") return invalid();
      if (r.order !== undefined && (!Number.isSafeInteger(r.order) || r.order < 1)) return invalid();
      if (r.queue && (!Array.isArray(r.queue.blockedBy) || r.queue.blockedBy.some(id => typeof id !== "string" || id === r.id)
        || !["unresolved", "overlap"].includes(r.queue.reason) || typeof r.queue.regenerate !== "boolean")) return invalid();
      const proposal = r.preparedProposal;
      if (proposal && (typeof proposal.text !== "string" || typeof proposal.original !== "string" || typeof proposal.requirement !== "string"
        || typeof proposal.section !== "string" || typeof proposal.sourceDocument !== "string" || !Number.isFinite(proposal.createdAt)
        || !validAnchor(proposal.sourceTarget) || !["replace", "insert"].includes(proposal.sourceTarget.kind)
        || !proposal.context || typeof proposal.context.text !== "string" || !Array.isArray(proposal.context.segments)
        || !proposal.timing || typeof proposal.timing !== "object" || proposal.versionId !== undefined && !versions.has(proposal.versionId))) return invalid();
      if (r.thread && (!Array.isArray(r.thread) || r.thread.some(m => !m.id || !["user", "assistant"].includes(m.role) || typeof m.text !== "string" || !Number.isFinite(m.at)))) return invalid();
      if (r.commit && ((!versions.has(r.commit.versionId) && !(r.versions.length === 0 && r.commit.versionId === "" && r.commit.action === "revoke")) || !["confirm", "revoke"].includes(r.commit.action) || typeof r.commit.beforeDocument !== "string"
        || typeof r.commit.afterDocument !== "string" || !validAnchor(r.commit.result) || !validAnchor(r.commit.originalTarget) || !validAnchor(r.commit.originalResult) || !Array.isArray(r.commit.changes)
        || r.commit.changes.some(c => !Number.isSafeInteger(c.from) || !Number.isSafeInteger(c.to) || c.from < 0 || c.to < c.from || typeof c.insert !== "string"))) return invalid();
      seen.add(r.id);
    }
    return raw as { schemaVersion: 1; vaultId: string; requests: InlineRequest[] };
  }
}
export function validNotePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\\") && !value.includes("\0") && !value.startsWith("/")
    && value.split("/").every(part => !!part && part !== "." && part !== "..") && /\.md$/iu.test(value);
}
function validAnchor(value: SourceAnchor | undefined): boolean {
  return !!value && Number.isSafeInteger(value.from) && Number.isSafeInteger(value.to) && value.from >= 0 && value.to >= value.from
    && typeof value.text === "string" && value.to - value.from === value.text.length && typeof value.before === "string" && typeof value.after === "string";
}
