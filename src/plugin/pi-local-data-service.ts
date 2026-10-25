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
import { prepareVaultIdentity, repairVaultMemory } from "./vault-identity";
import { type VaultIdentity, type VaultMemoryNotice } from "../storage/vault-identity";
import { parseCanonicalMemoryManifest, PersonalMemoryIdentityMismatchError } from "../harness/memory/personal-memory-core";

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
  private memoryIssue: Error | null = null;
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
    public personalMemory: PersonalMemoryRepository,
    readonly sessionApi: PiSessionManagerApi,
    readonly vaultIdentity: VaultIdentity
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
    const vaultIdentity = await prepareVaultIdentity({
      pluginDataRoot: pluginDataRootPath, vaultRoot: vaultRootPath, recoverDeveloperChange: options.recoverDeveloperChange
    });
    const deviceScope = await prepareEchoInkCredentialDeviceScope({
      stateRootPath: defaultEchoInkDeviceStateRoot(),
      vaultPath: vaultRootPath,
      vaultId: vaultIdentity.vaultId
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
      vaultId: vaultIdentity.vaultId
    });
    const productRuns = new FileProductRunStore({
      storageRootPath: piNativeStorageRootPath,
      vaultId: vaultIdentity.vaultId,
      catalog
    });
    const approvals = new FileApprovalTicketStore({
      storageRootPath: piNativeStorageRootPath,
      vaultId: vaultIdentity.vaultId
    });
    const receipts = new FileDomainReceiptStore({
      storageRootPath: piNativeStorageRootPath,
      vaultId: vaultIdentity.vaultId
    });
    const knowledgeUsageStore = new FileKnowledgeUsageStore({
      storageRootPath: piNativeStorageRootPath,
      vaultId: vaultIdentity.vaultId
    });
    const personalMemory = new PersonalMemoryRepository({
      vaultPath: piNativeStorageRootPath,
      vaultId: vaultIdentity.vaultId
    });
    const sessionApi = createPiSessionManagerApi();

    await catalog.initialize();
    await productRuns.initialize();
    await approvals.initialize();
    await receipts.initialize();
    await knowledgeUsageStore.initialize();
    let memoryIssue: Error | null = null;
    try {
      if (options.recoverDeveloperChange !== false) await new MemoryDeveloperBackups(personalMemory.layout.root).recoverInterruptedChange();
      let manifest: string | null;
      try { manifest = await fsp.readFile(personalMemory.layout.manifest, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; manifest = null; }
      if (manifest !== null) {
        const parsed = parseCanonicalMemoryManifest(manifest);
        if (parsed.vaultId !== vaultIdentity.vaultId) throw new PersonalMemoryIdentityMismatchError(vaultIdentity.vaultId, parsed.vaultId);
      }
      await personalMemory.initialize();
    } catch (error) {
      memoryIssue = error instanceof Error ? error : new Error(String(error));
      await personalMemory.dispose();
    }
    const maintenanceState = new FilePhase3MaintenanceStateStore({ vaultRootPath, storageRootPath: path.join(piNativeStorageRootPath, "knowledge"), vaultId: vaultIdentity.vaultId });
    await maintenanceState.initialize();
    await maintenanceState.recoverPrivateFinalization();

    const service = new PiLocalDataService(
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
      sessionApi,
      vaultIdentity
    );
    service.memoryIssue = memoryIssue;
    return service;
  }

  get memoryNotice(): VaultMemoryNotice | null {
    return this.memoryIssue instanceof PersonalMemoryIdentityMismatchError ? { kind: "mismatch", reason: this.memoryIssue.message } : null;
  }

  get memoryError(): string | null { return this.memoryIssue && !this.memoryNotice ? this.memoryIssue.message : null; }
  get memoryUnavailable(): boolean { return this.memoryIssue !== null; }

  assertMemoryAvailable(): void {
    if (this.memoryIssue !== null) throw new Error("Personal Memory is paused; resolve it in Workbench");
  }

  async retryMemory(): Promise<void> {
    await this.personalMemory.dispose();
    const next = new PersonalMemoryRepository({ vaultPath: this.piNativeStorageRootPath, vaultId: this.vaultIdentity.vaultId });
    try {
      const raw = await fsp.readFile(next.layout.manifest, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
      if (raw !== null) {
        const parsed = parseCanonicalMemoryManifest(raw);
        if (parsed.vaultId !== this.vaultIdentity.vaultId) throw new PersonalMemoryIdentityMismatchError(this.vaultIdentity.vaultId, parsed.vaultId);
      }
      await next.initialize(); this.personalMemory = next; this.memoryIssue = null;
    } catch (error) { await next.dispose(); this.memoryIssue = error instanceof Error ? error : new Error(String(error)); throw error; }
  }

  async resolveMemory(action: "adopt" | "reset"): Promise<string> {
    if (!(this.memoryIssue instanceof PersonalMemoryIdentityMismatchError)) throw new Error("Memory identity recovery is unavailable for this error");
    await this.personalMemory.dispose();
    let next: PersonalMemoryRepository | null = null;
    try {
      const backup = await repairVaultMemory({
        pluginDataRoot: this.pluginDataRootPath, identity: this.vaultIdentity, action,
        validate: async () => {
          const validation = new PersonalMemoryRepository({ vaultPath: this.piNativeStorageRootPath, vaultId: this.vaultIdentity.vaultId, watchExternalChanges: false });
          try { await validation.initialize(); } finally { await validation.dispose(); }
        }
      });
      next = new PersonalMemoryRepository({ vaultPath: this.piNativeStorageRootPath, vaultId: this.vaultIdentity.vaultId });
      await next.initialize();
      this.personalMemory = next;
      this.memoryIssue = null;
      return backup;
    } catch (error) {
      await next?.dispose();
      this.memoryIssue = error instanceof Error ? error : new Error(String(error));
      throw error;
    }
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
