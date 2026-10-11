import path from "node:path";
import { cognitivePathExists, cognitiveReadJsonOrNull } from "./cognitive-file-utils";
export * from "./agent-self-metadata-model";
import { AGENT_SELF_METADATA_RELATIVE_PATH, parseAgentSelfMetadata, type AgentSelfMetadata, type AgentSelfMetadataInspection } from "./agent-self-metadata-model";

export class AgentSelfMetadataStore {
  readonly filePath: string;
  private cache: AgentSelfMetadata | null = null;

  constructor(root: string) {
    this.filePath = path.join(root, AGENT_SELF_METADATA_RELATIVE_PATH);
  }

  async inspect(): Promise<AgentSelfMetadataInspection> {
    const raw = await cognitiveReadJsonOrNull<Record<string, unknown>>(this.filePath);
    if (!raw) {
      return await cognitivePathExists(this.filePath)
        ? { kind: "invalid", reason: "unparseable_json" }
        : { kind: "missing" };
    }
    const state = parseAgentSelfMetadata(raw);
    return state ? { kind: "valid", state } : { kind: "invalid", reason: "field_parse_failed" };
  }

  async read(): Promise<AgentSelfMetadata | null> {
    const inspected = await this.inspect();
    if (inspected.kind === "invalid") throw new Error(`agent_self_metadata_invalid:${inspected.reason}`);
    this.cache = inspected.kind === "valid" ? inspected.state : null;
    return this.cache;
  }

  peek(): AgentSelfMetadata | null {
    return this.cache;
  }

  updateCache(state: AgentSelfMetadata): void {
    this.cache = state;
  }
}
