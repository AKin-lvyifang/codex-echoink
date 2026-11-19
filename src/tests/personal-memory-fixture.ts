import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PersonalMemoryRepository,
  type PersonalMemoryRuntimeContext
} from "../harness/memory/personal-memory-repository";

export interface PersonalMemoryFixture {
  readonly vaultPath: string;
  readonly vaultId: string;
  readonly repository: PersonalMemoryRepository;
  readonly now: () => number;
  /** 把测试时钟向前推进（做梦衰减等时间语义测试用）。 */
  advance(ms: number): number;
  runtime(input?: Partial<PersonalMemoryRuntimeContext>): PersonalMemoryRuntimeContext;
  reopen(): Promise<PersonalMemoryRepository>;
}

export async function withPersonalMemoryFixture<T>(
  callback: (fixture: Readonly<PersonalMemoryFixture>) => Promise<T>,
  options: Readonly<{ watchExternalChanges?: boolean; failTransactionAfterChange?: import("../harness/memory/personal-memory-repository").PersonalMemoryRepositoryOptions["failTransactionAfterChange"] }> = {}
): Promise<T> {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "echoink-personal-memory-"));
  const vaultId = `vault-${path.basename(vaultPath)}`;
  let timestamp = 1_800_000_000_000;
  let identifier = 0;
  const repositories = new Set<PersonalMemoryRepository>();
  const now = () => ++timestamp;
  const createRepository = () => {
    const created = new PersonalMemoryRepository({
      vaultPath,
      vaultId,
      now,
      idFactory: () => `mem_fixture_${++identifier}`,
      failTransactionAfterChange: options.failTransactionAfterChange,
      watchExternalChanges: options.watchExternalChanges
    });
    repositories.add(created);
    return created;
  };
  const repository = createRepository();
  await repository.initialize();
  const fixture: PersonalMemoryFixture = {
    vaultPath,
    vaultId,
    repository,
    now,
    advance: (ms: number) => (timestamp += Math.max(0, Math.floor(ms))),
    runtime: (input = {}) => ({
      vaultId,
      conversationId: "conversation-fixture",
      piSessionId: "pi-session-fixture",
      productRunId: "product-run-fixture",
      userEntryId: "user-entry-fixture",
      memoryMode: "normal",
      ...input
    }),
    reopen: async () => {
      const reopened = createRepository();
      await reopened.initialize();
      return reopened;
    }
  };
  try {
    return await callback(fixture);
  } finally {
    await Promise.all([...repositories].map(async (candidate) => await candidate.dispose()));
    // macOS APFS 上 node fs.rm(recursive) 偶发 ENOTEMPTY（目录项在
    // readdir/rmdir 间隙短暂重现）。测试进程内没有并发写者；带退避重试。
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        await rm(vaultPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
        break;
      } catch (error) {
        if (attempt === 5) {
          console.error("fixture teardown gave up:", (error as Error).message);
        }
        await new Promise((resolve) => setTimeout(resolve, 60 * (attempt + 1)));
      }
    }
  }
}
