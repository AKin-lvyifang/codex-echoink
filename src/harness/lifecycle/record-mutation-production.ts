import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  createArtifactSourceDeletionAdapter
} from "../artifacts/artifact-lifecycle-store";
import { RUN_RECORD_STORE_DIRECTORY } from "../ledger/run-record-store";
import {
  createRunRecordSourceDeletionAdapter
} from "../ledger/run-record-source-deletion";
import {
  createMemorySourceDeletionAdapter
} from "../memory/source-deletion";
import { echoInkMemoryV2Layout } from "../memory/v2-store";
import { pluginDataDir } from "../../core/raw-message-store";
import {
  registerRecordMutationRuntimeRoots,
  type RecordMutationRuntimeRoot,
  type RecordMutationRuntimeRootDefinition,
  type RecordMutationSourceAdapterFactory
} from "./record-mutation-execution-runtime";

export const ECHOINK_RECORD_MUTATION_ROOT_IDS = {
  artifact: "echoink-artifact-lifecycle",
  conversation: "echoink-conversation-store",
  memory: "echoink-memory-v2",
  raw: "echoink-raw-store",
  run: "echoink-run-record-store",
  trash: "echoink-record-mutation-trash"
} as const;

export type EchoInkRecordMutationRootId =
  typeof ECHOINK_RECORD_MUTATION_ROOT_IDS[
    keyof typeof ECHOINK_RECORD_MUTATION_ROOT_IDS
  ];

const ARTIFACT_LIFECYCLE_ROOT_DIRECTORY =
  "workflow-artifact-lifecycle-v1";
const RECORD_MUTATION_TRASH_ROOT_DIRECTORY =
  "record-mutation-trash-v1";

/**
 * Resolves and registers only the roots selected by a frozen destructive
 * participant plan. Plugin-owned root directories may be initialized here;
 * the vault-managed formal Memory root must already exist and is never
 * bootstrapped by deletion wiring.
 */
export async function prepareEchoInkRecordMutationRuntimeRoots(input: {
  vaultPath: string;
  pluginDir: string;
  rootIds: readonly EchoInkRecordMutationRootId[];
  createdAt: number;
}): Promise<{
  storageRootPath: string;
  roots: RecordMutationRuntimeRoot[];
}> {
  const vaultPath = requireAbsolutePath(input.vaultPath, "vaultPath");
  const storageRootPath = pluginDataDir(vaultPath, input.pluginDir);
  await fsp.mkdir(storageRootPath, { recursive: true, mode: 0o700 });
  const definitionsById = productionRootDefinitions(
    vaultPath,
    storageRootPath
  );
  const rootIds = normalizeSelectedRootIds(input.rootIds);
  const definitions = rootIds.map((rootId) => {
    const definition = definitionsById.get(rootId);
    if (!definition) {
      throw new Error(`Unknown EchoInk RecordMutation root: ${rootId}`);
    }
    return definition;
  });
  for (const definition of definitions) {
    if (definition.authority === "plugin-owned") {
      await fsp.mkdir(definition.rootPath, {
        recursive: true,
        mode: 0o700
      });
    }
  }
  const roots = await registerRecordMutationRuntimeRoots({
    storageRootPath,
    definitions,
    createdAt: input.createdAt
  });
  return { storageRootPath, roots };
}

export function createEchoInkRecordMutationSourceAdapterFactory(input: {
  vaultPath: string;
}): RecordMutationSourceAdapterFactory {
  const vaultPath = requireAbsolutePath(input.vaultPath, "vaultPath");
  return ({ journal, participant, root }) => {
    if (participant.execution.kind !== "source-deletion") {
      throw new Error(
        `RecordMutation participant ${participant.participantId} bundle runtime is not materialized`
      );
    }
    if (
      participant.recordKind === "workflow-run"
      && participant.execution.subject.kind === "workflow-run"
    ) {
      return createRunRecordSourceDeletionAdapter({
        storageRootPath: journal.handle.storageRootPath,
        rootPath: root.rootPath,
        boundaryRootPath: root.boundaryRootPath,
        rootBinding: root.rootBinding,
        mutationId: journal.record.mutationId,
        conversationId: journal.record.intent.conversationId,
        participantId: participant.participantId,
        workflowRunId:
          participant.execution.subject.workflowRunId,
        attemptId: participant.execution.subject.attemptId,
        harnessRunId: participant.execution.subject.harnessRunId,
        payloadDigest: participant.execution.subject.payloadDigest
      });
    }
    if (
      participant.recordKind === "memory"
      && participant.execution.subject.kind === "memory"
    ) {
      return createMemorySourceDeletionAdapter({
        vaultPath,
        storageRootPath: journal.handle.storageRootPath,
        boundaryRootPath: root.boundaryRootPath,
        rootBinding: root.rootBinding,
        participantId: participant.participantId,
        subjectState: participant.execution.subject.state
      });
    }
    if (
      participant.recordKind === "artifact"
      && participant.execution.subject.kind === "artifact"
    ) {
      return createArtifactSourceDeletionAdapter({
        storageRootPath: journal.handle.storageRootPath,
        rootPath: root.rootPath,
        boundaryRootPath: root.boundaryRootPath,
        rootBinding: root.rootBinding,
        participantId: participant.participantId,
        artifactKind: participant.execution.subject.artifactKind
      });
    }
    throw new Error(
      `RecordMutation participant ${participant.participantId} subject kind mismatch`
    );
  };
}

export function echoInkRecordMutationRootPath(input: {
  vaultPath: string;
  pluginDir: string;
  rootId: EchoInkRecordMutationRootId;
}): string {
  const vaultPath = requireAbsolutePath(input.vaultPath, "vaultPath");
  const storageRootPath = pluginDataDir(vaultPath, input.pluginDir);
  const definition = productionRootDefinitions(
    vaultPath,
    storageRootPath
  ).get(input.rootId);
  if (!definition) {
    throw new Error(`Unknown EchoInk RecordMutation root: ${input.rootId}`);
  }
  return definition.rootPath;
}

function productionRootDefinitions(
  vaultPath: string,
  storageRootPath: string
): Map<EchoInkRecordMutationRootId, RecordMutationRuntimeRootDefinition> {
  const pluginOwned = (
    rootId: EchoInkRecordMutationRootId,
    directory: string
  ): RecordMutationRuntimeRootDefinition => ({
    rootId,
    rootPath: path.join(storageRootPath, directory),
    boundaryRootPath: storageRootPath,
    authority: "plugin-owned"
  });
  const definitions: RecordMutationRuntimeRootDefinition[] = [
    pluginOwned(
      ECHOINK_RECORD_MUTATION_ROOT_IDS.artifact,
      ARTIFACT_LIFECYCLE_ROOT_DIRECTORY
    ),
    pluginOwned(
      ECHOINK_RECORD_MUTATION_ROOT_IDS.conversation,
      "conversations"
    ),
    {
      rootId: ECHOINK_RECORD_MUTATION_ROOT_IDS.memory,
      rootPath: echoInkMemoryV2Layout(vaultPath).root,
      boundaryRootPath: vaultPath,
      authority: "vault-managed"
    },
    pluginOwned(ECHOINK_RECORD_MUTATION_ROOT_IDS.raw, "raw"),
    pluginOwned(
      ECHOINK_RECORD_MUTATION_ROOT_IDS.run,
      RUN_RECORD_STORE_DIRECTORY
    ),
    pluginOwned(
      ECHOINK_RECORD_MUTATION_ROOT_IDS.trash,
      RECORD_MUTATION_TRASH_ROOT_DIRECTORY
    )
  ];
  return new Map(
    definitions.map((definition) => [
      definition.rootId as EchoInkRecordMutationRootId,
      definition
    ])
  );
}

function normalizeSelectedRootIds(
  value: readonly EchoInkRecordMutationRootId[]
): EchoInkRecordMutationRootId[] {
  if (value.length < 2) {
    throw new Error("EchoInk RecordMutation root selection 数量非法");
  }
  const allowed = new Set<EchoInkRecordMutationRootId>(
    Object.values(ECHOINK_RECORD_MUTATION_ROOT_IDS)
  );
  const rootIds = value.map((rootId) => {
    if (!allowed.has(rootId)) {
      throw new Error(`Unknown EchoInk RecordMutation root: ${String(rootId)}`);
    }
    return rootId;
  });
  const sorted = [...rootIds].sort((left, right) => left.localeCompare(right));
  if (
    new Set(rootIds).size !== rootIds.length
    || rootIds.some((rootId, index) => rootId !== sorted[index])
  ) {
    throw new Error(
      "EchoInk RecordMutation root selection 必须唯一且按 rootId 排序"
    );
  }
  return rootIds;
}

function requireAbsolutePath(value: string, label: string): string {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.includes("\0")
    || !path.isAbsolute(value)
  ) {
    throw new Error(`${label} 非法`);
  }
  return path.resolve(value);
}
