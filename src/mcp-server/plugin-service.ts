import type CodexForObsidianPlugin from "../main";
import { getDesktopCrypto } from "../platform/desktop-crypto";
import { getDesktopPath } from "../platform/desktop-paths";
import { getDesktopFsPromises } from "../platform/desktop-filesystem";
import { hasProPluginAccess, unavailableCapabilityAccess } from "../membership/access";
import { KnowledgeAgentIndex } from "../knowledge-base/knowledge-agent-index";
import { VaultBodySearch, bindVaultBodySearchEvents } from "../knowledge-base/vault-body-search";
import { getKnowledgeFolderBindings } from "../knowledge-base/root-paths";
import { pluginDataDir } from "../plugin/plugin-data-paths";
import { normalizeVaultRelativePath } from "../harness/pi-native/vault-target-resolver";
import { EchoInkMcpServer } from "./server";
import { EchoInkMcpReadTools } from "./tools";
import type { EchoInkMcpServerSettings } from "./settings";
import { createConceptExplorerPort } from "../knowledge-base/obsidian-concept-explorer";

const { randomBytes, createHash } = getDesktopCrypto();
const path = getDesktopPath();
const fsp = getDesktopFsPromises();

export class EchoInkMcpController {
  readonly server: EchoInkMcpServer;
  private readonly body: VaultBodySearch;
  private readonly releaseEvents: () => void;
  private readonly vaultKey: string;
  private disposed = false;
  private signature = "";
  private tail = Promise.resolve();
  private releaseAccount: () => void;
  constructor(private readonly plugin: CodexForObsidianPlugin) {
    const vaultRoot = plugin.getVaultPath();
    const storage = path.join(pluginDataDir(vaultRoot, plugin.getPluginDataDirName()), "pi-agent-product-v1", "knowledge");
    this.vaultKey = createHash("sha256").update(vaultRoot).digest("hex");
    let root: Promise<string> | undefined;
    this.body = new VaultBodySearch(plugin.app, () => getKnowledgeFolderBindings(vaultRoot), {
      excludedRoots: () => [path.relative(vaultRoot, pluginDataDir(vaultRoot, plugin.getPluginDataDirName())).replaceAll("\\", "/")],
      resolveSourcePath: async relative => {
        const requested = normalizeVaultRelativePath(relative);
        root ??= fsp.realpath(vaultRoot);
        const [canonicalRoot, canonicalFile] = await Promise.all([root, fsp.realpath(path.join(vaultRoot, requested))]);
        return normalizeVaultRelativePath(path.relative(canonicalRoot, canonicalFile).replaceAll("\\", "/"));
      }
    });
    const index = new KnowledgeAgentIndex({ vaultPath: vaultRoot, storageRootPath: storage, bodySearch: this.body,
      linkResolver: (link, source) => plugin.app.metadataCache.getFirstLinkpathDest(link, source)?.path });
    this.releaseEvents = bindVaultBodySearchEvents(plugin.app, { invalidate: relative => index.invalidate(relative) });
    const concept = createConceptExplorerPort(plugin.app, index, this.body);
    const tools = new EchoInkMcpReadTools({ knowledge: { ...concept, search: input => index.search(input), scopeKey: () => this.body.scopeKey(), allowsPath: value => this.body.allowsPath(value) },
      memory: async () => { const local = await plugin.getKnowledgeUpgradeLocalData(); return { repository: local.personalMemory, vaultId: local.vaultIdentity.vaultId }; },
      access: () => this.access() });
    this.server = new EchoInkMcpServer({ tools, access: () => this.access(), token: () => plugin.settings.mcpServer.token, version: plugin.manifest.version });
    this.releaseAccount = (plugin.accountService ?? unavailableCapabilityAccess).subscribe(() => {
      if (!this.access().pro) this.server.revoke();
      void this.sync();
    });
  }
  private access() { const settings = this.plugin.settings.mcpServer; return { enabled: !this.disposed && settings.enabled, knowledge: settings.knowledge, memory: settings.memory,
    pro: hasProPluginAccess(this.plugin.accountService ?? unavailableCapabilityAccess) }; }
  sync(): Promise<void> {
    const signature = JSON.stringify([this.plugin.settings.mcpServer, this.access().pro]);
    if (signature !== this.signature) { this.signature = signature; this.server.revoke(); }
    this.tail = this.tail.catch(() => undefined).then(async () => {
      if (!this.access().enabled || !this.access().pro) { await this.server.stop(); return; }
      const settings = this.plugin.settings.mcpServer;
      if (!settings.token || settings.tokenVault !== this.vaultKey) {
        settings.token = randomBytes(32).toString("hex"); settings.tokenVault = this.vaultKey;
        await this.plugin.persistPiNativeSettings();
      }
      if (this.disposed) return;
      await this.server.start(settings.port || 27184);
      const state = this.server.read();
      if (state.status === "running" && settings.port !== state.port) { settings.port = state.port!; await this.plugin.persistPiNativeSettings(); }
      this.signature = JSON.stringify([settings, this.access().pro]);
    });
    return this.tail;
  }
  async update(patch: Partial<Pick<EchoInkMcpServerSettings, "enabled" | "knowledge" | "memory">>): Promise<void> {
    if ((patch.enabled === true || patch.knowledge === true || patch.memory === true) && !this.access().pro) throw new Error("Active EchoInk PRO membership required.");
    const previous = { ...this.plugin.settings.mcpServer };
    Object.assign(this.plugin.settings.mcpServer, patch); this.server.revoke();
    try { await this.plugin.persistPiNativeSettings(); await this.sync(); }
    catch (error) { this.plugin.settings.mcpServer = previous; await this.sync(); throw error; }
  }
  async rotateToken(): Promise<void> {
    if (!this.access().pro) throw new Error("Active EchoInk PRO membership required.");
    const previous = this.plugin.settings.mcpServer.token;
    this.plugin.settings.mcpServer.token = randomBytes(32).toString("hex"); this.server.revoke();
    try { await this.plugin.persistPiNativeSettings(); await this.sync(); }
    catch (error) { this.plugin.settings.mcpServer.token = previous; await this.sync(); throw error; }
  }
  dispose(): void { this.disposed = true; this.releaseAccount(); this.releaseEvents(); this.server.revoke(); void this.server.stop(); this.body.dispose(); }
}
