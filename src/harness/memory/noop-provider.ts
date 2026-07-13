import type { MemoryBundle, MemoryCandidate, MemoryCommitResult, MemoryProvider, MemoryProposalRequest, MemoryRetrievalRequest } from "./provider";

export class NoopMemoryProvider implements MemoryProvider {
  async retrieve(_request: MemoryRetrievalRequest): Promise<MemoryBundle> {
    return {
      providerId: "noop",
      items: [],
      sections: []
    };
  }

  async propose(_request: MemoryProposalRequest): Promise<MemoryCandidate[]> {
    return [];
  }

  async commit(_candidates: MemoryCandidate[]): Promise<MemoryCommitResult> {
    return {
      committed: [],
      skipped: []
    };
  }

  async supersede(_memoryId: string, _reason: string): Promise<void> {
    return undefined;
  }
}
