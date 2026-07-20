import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  createArtifactSourceDeletionAdapter
} from "../artifacts/artifact-lifecycle-store";
import { RUN_RECORD_STORE_DIRECTORY } from "../ledger/run-record-store";
import {
  workflowRunPayloadParticipantId,
  type RecordMutationExecutionSubject
} from "./record-mutation-execution-plan";
import {
  createRunRecordSourceDeletionAdapter
} from "../ledger/run-record-source-deletion";
import {
  createMemorySourceDeletionAdapter
} from "../memory/source-deletion";
import { echoInkMemoryV2Layout } from "../memory/v2-store";
import { pluginDataDir } from "../../core/raw-message-store";
import {
  createRecordMutationSourceBundleAdapter
} from "./record-mutation-source-bundle";
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
  ] | `echoink-conversation-store-${string}`;

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
  conversationRootPath?: string;
}): Promise<{
  storageRootPath: string;
  roots: RecordMutationRuntimeRoot[];
}> {
  const vaultPath = requireAbsolutePath(input.vaultPath, "vaultPath");
  const storageRootPath = pluginDataDir(vaultPath, input.pluginDir);
  await fsp.mkdir(storageRootPath, { recursive: true, mode: 0o700 });
  const definitionsById = productionRootDefinitions(
    vaultPath,
    storageRootPath,
    input.conversationRootPath
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
    const createLeafAdapter = (
      subject: RecordMutationExecutionSubject,
      participantId: string
    ) => {
      if (
        participant.recordKind === "workflow-run"
        && subject.kind === "workflow-run"
      ) {
        return createRunRecordSourceDeletionAdapter({
          storageRootPath: journal.handle.storageRootPath,
          rootPath: root.rootPath,
          boundaryRootPath: root.boundaryRootPath,
          rootBinding: root.rootBinding,
          mutationId: journal.record.mutationId,
          conversationId: journal.record.intent.conversationId,
          participantId,
          workflowRunId: subject.workflowRunId,
          attemptId: subject.attemptId,
          harnessRunId: subject.harnessRunId,
          payloadDigest: subject.payloadDigest
        });
      }
      if (
        participant.recordKind === "memory"
        && subject.kind === "memory"
      ) {
        return createMemorySourceDeletionAdapter({
          vaultPath,
          storageRootPath: journal.handle.storageRootPath,
          boundaryRootPath: root.boundaryRootPath,
          rootBinding: root.rootBinding,
          participantId,
          subjectState: subject.state
        });
      }
      if (
        participant.recordKind === "artifact"
        && subject.kind === "artifact"
      ) {
        return createArtifactSourceDeletionAdapter({
          storageRootPath: journal.handle.storageRootPath,
          rootPath: root.rootPath,
          boundaryRootPath: root.boundaryRootPath,
          rootBinding: root.rootBinding,
          participantId,
          artifactKind: subject.artifactKind
        });
      }
      throw new Error(
        `RecordMutation participant ${participant.participantId} subject kind mismatch`
      );
    };
    if (participant.execution.kind === "source-deletion-bundle") {
      const subjects = participant.execution.subjects;
      return createRecordMutationSourceBundleAdapter({
        storageRootPath: journal.handle.storageRootPath,
        rootPath: root.rootPath,
        boundaryRootPath: root.boundaryRootPath,
        rootBinding: root.rootBinding,
        participantId: participant.participantId,
        recordKind: participant.recordKind,
        selectionDigest: participant.execution.selectionDigest,
        subjects,
        leafAdapters: subjects.map((subject) => (
          createLeafAdapter(subject, sourceSubjectParticipantId(subject))
        ))
      });
    }
    if (participant.execution.kind === "source-deletion") {
      return createLeafAdapter(
        participant.execution.subject,
        participant.participantId
      );
    }
    throw new Error(
      `RecordMutation participant ${participant.participantId} execution kind mismatch`
    );
  };
}

function sourceSubjectParticipantId(
  subject: RecordMutationExecutionSubject
): string {
  if (subject.kind === "workflow-run") {
    return workflowRunPayloadParticipantId(
      subject.workflowRunId,
      subject.attemptId
    );
  }
  return subject.kind === "memory"
    ? subject.memoryId
    : subject.artifactId;
}

export function echoInkRecordMutationRootPath(input: {
  vaultPath: string;
  pluginDir: string;
  rootId: EchoInkRecordMutationRootId;
  conversationRootPath?: string;
}): string {
  const vaultPath = requireAbsolutePath(input.vaultPath, "vaultPath");
  const storageRootPath = pluginDataDir(vaultPath, input.pluginDir);
  const definition = productionRootDefinitions(
    vaultPath,
    storageRootPath,
    input.conversationRootPath
  ).get(input.rootId);
  if (!definition) {
    throw new Error(`Unknown EchoInk RecordMutation root: ${input.rootId}`);
  }
  return definition.rootPath;
}

export function echoInkConversationRecordMutationRootId(input: {
  storageRootPath: string;
  conversationRootPath: string;
}): EchoInkRecordMutationRootId {
  const storageRootPath = path.resolve(input.storageRootPath);
  const conversationRootPath = resolveConversationRootPath(
    storageRootPath,
    input.conversationRootPath
  );
  if (
    conversationRootPath === path.join(storageRootPath, "conversations")
  ) {
    return ECHOINK_RECORD_MUTATION_ROOT_IDS.conversation;
  }
  const relativePath = path.relative(
    storageRootPath,
    conversationRootPath
  ).split(path.sep).join("/");
  return `echoink-conversation-store-${createHash("sha256")
    .update(relativePath, "utf8")
    .digest("hex")}`;
}

function productionRootDefinitions(
  vaultPath: string,
  storageRootPath: string,
  conversationRootPathInput?: string
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
  const conversationRootPath = resolveConversationRootPath(
    storageRootPath,
    conversationRootPathInput
  );
  const conversationRootId =
    echoInkConversationRecordMutationRootId({
      storageRootPath,
      conversationRootPath
    });
  const definitions: RecordMutationRuntimeRootDefinition[] = [
    pluginOwned(
      ECHOINK_RECORD_MUTATION_ROOT_IDS.artifact,
      ARTIFACT_LIFECYCLE_ROOT_DIRECTORY
    ),
    {
      rootId: conversationRootId,
      rootPath: conversationRootPath,
      boundaryRootPath: storageRootPath,
      authority: "plugin-owned"
    },
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

function resolveConversationRootPath(
  storageRootPath: string,
  rootPathInput: string | undefined
): string {
  const rootPath = path.resolve(
    rootPathInput ?? path.join(storageRootPath, "conversations")
  );
  if (
    rootPath === storageRootPath
    || !rootPath.startsWith(`${storageRootPath}${path.sep}`)
  ) {
    throw new Error(
      "EchoInk Conversation RecordMutation root must stay inside plugin storage"
    );
  }
  return rootPath;
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
    if (
      !allowed.has(rootId)
      && !/^echoink-conversation-store-[a-f0-9]{64}$/.test(rootId)
    ) {
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
