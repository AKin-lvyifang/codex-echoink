import { registerKnowledgePrivateRoot } from "../knowledge-base/root-paths";
import { FilePhase3MaintenanceStateStore } from "./pi-knowledge-maintenance-production";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  CURRENT_SESSION_VERSION,
  SessionManager
} from "@earendil-works/pi-coding-agent";
import { PersonalMemoryRepository } from "../harness/memory/personal-memory-repository";
import { MemoryDeveloperBackups } from "./developer-mode/memory-backups";
import {
  FileConversationCatalog
} from "../harness/pi-native/file-conversation-catalog";
import {
  FileProductRunStore
} from "../harness/pi-native/file-product-run-store";
import {
  FileDomainReceiptStore
} from "../harness/pi-native/domain-receipt-store";
import {
  FileApprovalTicketStore
} from "../harness/pi-native/tool-authorization";
import {
  FileKnowledgeUsageStore,
  decorationsForBranch
} from "../knowledge-base/usage";
import type {
  PiConversationCatalogEntry,
  PiConversationCatalogStatus,
  PiConversationMemoryMode,
  PiConversationProjection,
  PiConversationSupportState
} from "../harness/pi-native/contracts";
import {
  PiNativeConversationRuntimeError,
  createPiConversation,
  readDurablePiConversationProjection,
  type CreatePiNativeConversationInput
} from "../harness/pi-native/pi-native-conversation-runtime";
import {
  ECHOINK_PI_CODING_AGENT_VERSION,
  type PiSessionManagerApi
} from "../harness/pi-native/pi-session-durability";
import {
  devicePiCanonicalStoreRoots,
  type DevicePiCanonicalStoreRoots,
  type DevicePiStoreSetBindingScope
} from "../harness/pi/pi-store-layout";
import {
  defaultEchoInkDeviceStateRoot,
  prepareEchoInkCredentialDeviceScope,
  type EchoInkCredentialDeviceScope
} from "./credential-device-scope";
import { pluginDataDir } from "./plugin-data-paths";
import { loadPiVaultToolProductState } from "./pi-vault-tool-production";

export interface PiLocalDataPluginHost {
  getVaultPath(): string;
  getPluginDataDirName(): string;
}

/**
 * Provider-independent access to the durable Pi Conversation and Personal
 * Memory stores. The production Agent runtime reuses these exact objects, so
 * local operations never need a second store or a Provider admission step.
 */
export class PiLocalDataService {
  private constructor(
    readonly vaultRootPath: string,
    readonly pluginDataRootPath: string,
    readonly piNativeStorageRootPath: string,
    readonly deviceScope: EchoInkCredentialDeviceScope,
    readonly storeScope: DevicePiStoreSetBindingScope,
    readonly roots: DevicePiCanonicalStoreRoots,
    readonly catalog: FileConversationCatalog,
    readonly productRuns: FileProductRunStore,
    readonly approvals: FileApprovalTicketStore,
    readonly receipts: FileDomainReceiptStore,
    readonly knowledgeUsageStore: FileKnowledgeUsageStore,
    readonly personalMemory: PersonalMemoryRepository,
    readonly sessionApi: PiSessionManagerApi
  ) {}

  static async create(
    plugin: PiLocalDataPluginHost,
    options: { recoverDeveloperChange?: boolean } = {}
  ): Promise<PiLocalDataService> {
    const vaultRootPath = await fsp.realpath(plugin.getVaultPath());
    const rawPluginDataRootPath = pluginDataDir(
      vaultRootPath,
      plugin.getPluginDataDirName()
    );
    await fsp.mkdir(rawPluginDataRootPath, { recursive: true, mode: 0o700 });
    const pluginDataRootPath = await fsp.realpath(rawPluginDataRootPath);
    const deviceScope = await prepareEchoInkCredentialDeviceScope({
      stateRootPath: defaultEchoInkDeviceStateRoot(),
      vaultPath: vaultRootPath
    });
    const storeScope: DevicePiStoreSetBindingScope = Object.freeze({
      pluginDataRootPath,
      vaultRootPath,
      deviceControlRootPath: deviceScope.stateRootPath,
      vaultIdDigest: deviceScope.vaultIdDigest,
      deviceIdDigest: deviceScope.deviceIdDigest
    });
    const roots = devicePiCanonicalStoreRoots(pluginDataRootPath);
    const piNativeStorageRootPath = path.join(
      pluginDataRootPath,
      "pi-agent-product-v1"
    );
    registerKnowledgePrivateRoot(vaultRootPath, path.join(piNativeStorageRootPath, "knowledge"));
    const catalog = new FileConversationCatalog({
      storageRootPath: piNativeStorageRootPath,
      vaultId: deviceScope.vaultIdDigest
    });
    const productRuns = new FileProductRunStore({
      storageRootPath: piNativeStorageRootPath,
      vaultId: deviceScope.vaultIdDigest,
      catalog
    });
    const approvals = new FileApprovalTicketStore({
      storageRootPath: piNativeStorageRootPath,
      vaultId: deviceScope.vaultIdDigest
    });
    const receipts = new FileDomainReceiptStore({
      storageRootPath: piNativeStorageRootPath,
      vaultId: deviceScope.vaultIdDigest
    });
    const knowledgeUsageStore = new FileKnowledgeUsageStore({
      storageRootPath: piNativeStorageRootPath,
      vaultId: deviceScope.vaultIdDigest
    });
    const personalMemory = new PersonalMemoryRepository({
      vaultPath: piNativeStorageRootPath,
      vaultId: deviceScope.vaultIdDigest
    });
    if (options.recoverDeveloperChange !== false) {
      await new MemoryDeveloperBackups(personalMemory.layout.root).recoverInterruptedChange();
    }
    const sessionApi = createPiSessionManagerApi();

    await catalog.initialize();
    await productRuns.initialize();
    await approvals.initialize();
    await receipts.initialize();
    await knowledgeUsageStore.initialize();
    await personalMemory.initialize();
    const maintenanceState = new FilePhase3MaintenanceStateStore({ vaultRootPath, storageRootPath: path.join(piNativeStorageRootPath, "knowledge"), vaultId: deviceScope.vaultIdDigest });
    await maintenanceState.initialize();
    await maintenanceState.recoverPrivateFinalization();

    return new PiLocalDataService(
      vaultRootPath,
      pluginDataRootPath,
      piNativeStorageRootPath,
      deviceScope,
      storeScope,
      roots,
      catalog,
      productRuns,
      approvals,
      receipts,
      knowledgeUsageStore,
      personalMemory,
      sessionApi
    );
  }

  async dispose(): Promise<void> {
    await this.personalMemory.dispose();
  }

  async listConversations(
    statuses?: readonly PiConversationCatalogStatus[]
  ): Promise<Readonly<PiConversationCatalogEntry>[]> {
    return await this.catalog.list(statuses ? { statuses } : {});
  }

  async createConversation(
    input: CreatePiNativeConversationInput
  ): Promise<Readonly<PiConversationCatalogEntry>> {
    return await createPiConversation({
      catalog: this.catalog,
      sessionApi: this.sessionApi,
      conversation: input
    });
  }

  async readConversationProjection(
    conversationId: string,
    cwd?: string
  ): Promise<PiConversationProjection> {
    return await readDurablePiConversationProjection({
      catalog: this.catalog,
      productRuns: this.productRuns,
      sessionApi: this.sessionApi,
      conversationId,
      resolveConversationCwd: () => cwd?.trim() || this.vaultRootPath,
      loadToolProductState: async (state) =>
        await loadPiVaultToolProductState({
          approvals: this.approvals,
          receipts: this.receipts,
          ...state
        }),
      loadKnowledgeDecorations: async (state) =>
        decorationsForBranch(
          state.entries,
          await this.knowledgeUsageStore.list({
            conversationId: state.conversationId,
            piSessionId: state.piSessionId
          })
        )
    });
  }

  async readConversationSupportState(
    conversationId: string
  ): Promise<PiConversationSupportState> {
    const catalog = await this.requireConversation(conversationId);
    return {
      catalog,
      diagnostics: [...await this.catalog.diagnostics(conversationId)],
      drafts: [...await this.catalog.drafts(conversationId)]
    };
  }

  async discardDraft(
    conversationId: string,
    draftId: string
  ): Promise<boolean> {
    await this.requireConversation(conversationId);
    const normalizedDraftId = draftId.trim();
    if (!normalizedDraftId) {
      throw new PiNativeConversationRuntimeError(
        "draft_invalid",
        "draftId 不能为空"
      );
    }
    const draft = (await this.catalog.drafts(conversationId)).find(
      (candidate) => candidate.draftId === normalizedDraftId
    );
    if (!draft) return false;
    return await this.catalog.removeDraft(normalizedDraftId);
  }

  async renameConversation(
    conversationId: string,
    title: string
  ): Promise<Readonly<PiConversationCatalogEntry>> {
    return await this.catalog.rename(conversationId, title);
  }

  async setConversationMemoryMode(
    conversationId: string,
    defaultMemoryMode: PiConversationMemoryMode
  ): Promise<Readonly<PiConversationCatalogEntry>> {
    const catalog = await this.requireConversation(conversationId);
    return await this.catalog.upsert({
      ...catalog,
      defaultMemoryMode,
      updatedAt: Date.now()
    });
  }

  async setConversationStatus(
    conversationId: string,
    status: PiConversationCatalogStatus
  ): Promise<Readonly<PiConversationCatalogEntry>> {
    return await this.catalog.status(conversationId, status);
  }

  private async requireConversation(
    conversationId: string
  ): Promise<Readonly<PiConversationCatalogEntry>> {
    const catalog = await this.catalog.get(conversationId);
    if (!catalog) {
      throw new PiNativeConversationRuntimeError(
        "conversation_not_found",
        `Conversation ${conversationId} 不存在`
      );
    }
    return catalog;
  }
}

function createPiSessionManagerApi(): PiSessionManagerApi {
  return Object.freeze({
    codingAgentVersion: ECHOINK_PI_CODING_AGENT_VERSION,
    currentSessionVersion: CURRENT_SESSION_VERSION,
    open: (
      sessionFile: string,
      sessionRoot: string,
      cwdOverride: string
    ) => SessionManager.open(sessionFile, sessionRoot, cwdOverride)
  });
}
