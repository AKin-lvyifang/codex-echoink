import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { emptyKnowledgeFolderBindings, normalizeKnowledgeFolderBindings, registerKnowledgeFolderBindings } from "../knowledge-base/root-paths";
import { knowledgeMayCreateCategoryDirectory, knowledgeMayOrganizeMove } from "../knowledge-base/folder-organization";
import { canonicalRawMarkdownForDigest, rawDigestFingerprint } from "../knowledge-base/raw-digest";
import { FileApprovalTicketStore } from "../harness/pi-native/tool-authorization";
import { FileDomainReceiptStore } from "../harness/pi-native/domain-receipt-store";
import { VaultDomainService } from "../harness/pi-native/vault-domain-service";
import { createPiVaultToolDefinitions } from "../harness/pi-native/pi-vault-tool-contracts";
import { createPiVaultToolSecurityAdapter, createSecurePiVaultToolResultCorrectionPort } from "../harness/pi-native/pi-vault-tool-security-extension";
import { piWorkspaceAllowsTool, type PiWorkspaceAccess } from "../harness/pi-native/pi-workspace-access";
import { EchoInkVaultToolEgressPolicy } from "../harness/pi-native/vault-tool-result-safety";
import { ObsidianVaultDomainAdapter } from "../plugin/obsidian-vault-domain-adapter";
import { createPiVaultProductionAuthorizationPort, createPiVaultProductionWriteExecutionPort } from "../plugin/pi-vault-tool-production";
import { ProductionPiKnowledgeMaintenanceToolPort } from "../plugin/pi-knowledge-maintenance-production";
import { nativeJournalFixture } from "./native-journal-fixture";

const VAULT_ID = "folder-organization-vault";
const SOURCE = "来源甲/source.md";
const BODY = "# 原始正文\n目录整理不能改动这段来源。\n";

export async function runKnowledgeFolderOrganizationTests(): Promise<void> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "echoink-folder-organization-")));
  const vault = path.join(root, "vault");
  const fixture = await nativeJournalFixture(vault);
  const config = emptyKnowledgeFolderBindings();
  Object.assign(config.roles.raw, { enabled: true, readPaths: ["来源甲", "来源乙"], writePath: "来源甲" });
  Object.assign(config.roles.wiki, { enabled: true, readPaths: ["成果", "来源甲/知识"], writePath: "成果", compatibilityReadScopes: true });
  Object.assign(config.roles.projects, { enabled: true, readPaths: ["项目"], writePath: "项目" });
  const release = registerKnowledgeFolderBindings(vault, () => config);
  try {
    for (const directory of ["来源甲/已有", "来源乙", "来源甲/知识", "成果/已有", "项目", "普通目录"]) await mkdir(path.join(vault, directory), { recursive: true });
    await fixture.write(SOURCE, BODY);
    const adapter = new ObsidianVaultDomainAdapter(fixture.app, VAULT_ID, vault);
    const domain = new VaultDomainService(adapter, { allowMissingParentDirectories: true });
    const approvals = new FileApprovalTicketStore({ storageRootPath: path.join(root, "tool-state"), vaultId: VAULT_ID });
    const receipts = new FileDomainReceiptStore({ storageRootPath: path.join(root, "tool-state"), vaultId: VAULT_ID });
    await approvals.initialize();
    await receipts.initialize();
    const identity = { vaultId: VAULT_ID, conversationId: "folder-conversation", piSessionId: "folder-session", productRunId: "folder-run" };
    let access: PiWorkspaceAccess = { permission: "workspace-write", mode: "agent", memoryMode: "normal" };
    let approved = true;
    let confirmations = 0;
    let onConfirm: (() => void) | undefined;
    const security = createPiVaultToolSecurityAdapter({
      isToolAllowed: toolName => piWorkspaceAllowsTool({ ...access, toolName, planToolNames: ["note_read"], memoryToolNames: [], externalReadToolNames: [] }),
      authorization: createPiVaultProductionAuthorizationPort({
        approvals, adapter, currentRunIdentity: () => identity, currentWorkspaceAccess: () => access,
        userId: "fixture", deviceId: "fixture", confirmation: { async confirm() { confirmations++; onConfirm?.(); return approved; } }
      }),
      resultCorrection: createSecurePiVaultToolResultCorrectionPort(new EchoInkVaultToolEgressPolicy())
    });
    const handlers = new Map<string, (...args: any[]) => any>();
    await security.inlineExtension.factory({ on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler) } as never);
    const tools = createPiVaultToolDefinitions({ domainService: domain, security, writeExecution: createPiVaultProductionWriteExecutionPort({ receipts, domainService: domain, adapter }) });
    let sequence = 0;
    const call = async (toolName: string, input: Record<string, unknown>) => {
      const toolCallId = `folder-call-${++sequence}`;
      const blocked = await handlers.get("tool_call")!({ toolName, toolCallId, input }, { signal: undefined });
      if (blocked) return blocked;
      let result;
      try { result = await tools.find(tool => tool.name === toolName)!.execute(toolCallId, input, undefined, undefined); }
      catch (error) { result = { isError: true, content: [{ type: "text", text: String(error) }] }; }
      return await handlers.get("tool_result")!({ toolName, toolCallId, ...result, isError: result.isError === true });
    };
    const blocked = { block: true, reason: "tool_policy_blocked" };
    const move = (sourcePath: string, targetPath: string, content = BODY) => ({ sourcePath, targetPath, expectedVersion: sha256(content) });
    const save = (relativePath: string) => ({ relativePath, content: "# 保存内容\n" });
    const exists = async (relativePath: string) => !!await stat(path.join(vault, relativePath)).catch(() => null);

    delete config.roles.raw.autoOrganizePaths;
    assert.equal((await call("note_read", { relativePath: SOURCE })).isError, false, "old consent-less bindings remain readable");
    assert.equal((await call("note_create", save("成果/直接保存.md"))).isError, false);
    assert.equal((await call("note_create", save("成果/已有/保存.md"))).isError, false, "closed organization does not block saving in an existing category");
    const confirmationsBeforeDenied = confirmations;
    assert.deepEqual(await call("note_create", save("成果/未批准/保存.md")), blocked);
    assert.deepEqual(await call("note_create", save("普通目录/未批准/保存.md")), blocked, "an existing unbound parent does not grant missing descendants");
    assert.deepEqual(await call("note_move", move(SOURCE, "来源甲/已有/归类.md")), blocked);
    assert.equal(confirmations, confirmationsBeforeDenied, "folder policy denies before asking for write confirmation");
    assert.equal(await exists("成果/未批准"), false);

    config.roles.raw.autoOrganizePaths = ["来源甲", "来源乙"];
    config.roles.wiki.autoOrganizePaths = ["成果", "来源甲/知识"];
    assert.equal((await call("note_create", save("成果/新分类/子类/保存.md"))).isError, false, "consented production create builds a category");
    assert.equal((await call("note_move", move(SOURCE, "来源甲/新分类/归类.md"))).isError, false, "production move may create its consented category");
    assert.equal(await readFile(path.join(vault, "来源甲/新分类/归类.md"), "utf8"), BODY);
    assert.deepEqual(await call("note_move", move("来源甲/新分类/归类.md", "来源乙/归类.md")), blocked, "two Raw bindings remain separate even when both are open");
    assert.deepEqual(await call("note_move", move("来源甲/新分类/归类.md", "成果/归类.md")), blocked);
    assert.deepEqual(await call("note_move", move("来源甲/新分类/归类.md", "来源甲/知识/归类.md")), blocked, "a nested Wiki binding is not part of the Raw binding");
    await fixture.write("成果/原成果.md", BODY);
    assert.deepEqual(await call("note_move", move("成果/原成果.md", "来源甲/知识/原成果.md")), blocked, "two actual roots of the same outcome role cannot exchange files");
    assert.deepEqual(await call("note_move", move("成果/原成果.md", "普通目录/原成果.md")), blocked);

    const rawPath = "来源甲/新分类/归类.md";
    assert.deepEqual(await call("note_update", { relativePath: rawPath, expectedVersion: sha256(BODY), content: "# 已篡改来源\n" }), blocked, "organization consent never grants source body editing");
    assert.equal((await call("metadata_update", { relativePath: rawPath, expectedVersion: sha256(BODY), patch: { set: { topic: "test" } } })).isError, false);
    const withMetadata = await readFile(path.join(vault, rawPath), "utf8");
    assert.equal(canonicalRawMarkdownForDigest(withMetadata), canonicalRawMarkdownForDigest(BODY));
    assert.equal((await call("note_update", { relativePath: rawPath, expectedVersion: sha256(withMetadata), content: `---\ntopic: updated\n---\n${BODY}` })).isError, false, "the canonical source body protection permits metadata-only updates");

    for (const permission of ["read-only", "workspace-write"] as const) {
      access = { ...access, permission, mode: permission === "workspace-write" ? "plan" : "agent" };
      const count = confirmations;
      assert.deepEqual(await call("note_create", save("成果/开关不能扩权.md")), blocked);
      assert.deepEqual(await call("note_move", move("成果/原成果.md", "成果/已有/移动.md")), blocked);
      assert.equal(confirmations, count, "read-only and Plan never request mutation approval");
    }
    access = { ...access, permission: "workspace-write", mode: "agent" };
    approved = false;
    for (const [name, args] of [
      ["note_create", save("成果/拒绝创建.md")],
      ["note_move", move("成果/原成果.md", "成果/已有/拒绝移动.md")],
      ["note_delete", { relativePath: "成果/原成果.md", expectedVersion: sha256(BODY) }]
    ] as const) assert.deepEqual(await call(name, args), { block: true, reason: "approval_denied" }, "folder consent never replaces operation confirmation, including deletion");
    assert.equal(await exists("成果/拒绝创建.md"), false);
    assert.equal(await exists("成果/原成果.md"), true);
    approved = true;

    onConfirm = () => { config.roles.wiki.autoOrganizePaths = []; };
    assert.equal((await call("note_create", save("成果/确认时关闭/保存.md"))).isError, true, "execution rechecks consent after approval");
    assert.equal(await exists("成果/确认时关闭"), false);
    onConfirm = undefined;
    config.roles.wiki.allowedSubdirectories = ["旧批准/最深"];
    assert.equal((await call("note_create", save("成果/旧批准/最深/保存.md"))).isError, false);
    assert.deepEqual(await call("note_create", save("成果/旧批准/最深/未批准/保存.md")), blocked, "a legacy leaf is not a free organization root");
    assert.deepEqual(await call("note_move", move("成果/原成果.md", "成果/旧批准/最深/移动.md")), blocked, "legacy creation consent does not authorize moving existing notes");
    config.roles.wiki.allowedSubdirectories.push("保留的旧批准");
    config.roles.wiki.allowedSubdirectoryRoots = normalizeKnowledgeFolderBindings(config)!.roles.wiki.allowedSubdirectoryRoots;
    config.roles.wiki.readPaths.push("换绑成果");
    await mkdir(path.join(vault, "换绑成果"));
    assert.deepEqual(await call("note_create", save("换绑成果/旧批准/最深/拒绝.md")), blocked, "rebinding does not transfer the old category whitelist to a new actual root");
    assert.equal(await exists("换绑成果/旧批准"), false);
    assert.equal((await call("note_create", save("成果/保留的旧批准/保存.md"))).isError, false, "an unchanged original root retains its exact legacy category approval");
    config.roles.wiki.autoOrganizePaths = ["换绑成果"];
    assert.equal((await call("note_create", save("换绑成果/旧批准/最深/独立授权.md"))).isError, false, "a new explicit organization consent remains independent of the frozen legacy roots");
    config.roles.wiki.autoOrganizePaths = [];
    config.roles.wiki.readPaths.pop();
    config.roles.wiki.readPaths.push("尚不存在的绑定");
    config.roles.wiki.autoOrganizePaths = ["尚不存在的绑定"];
    assert.deepEqual(await call("note_create", save("尚不存在的绑定/保存.md")), blocked, "ongoing consent cannot create the binding root itself");
    config.roles.wiki.readPaths.pop();
    config.roles.wiki.autoOrganizePaths = [];
    assert.equal(knowledgeMayCreateCategoryDirectory(config, "成果/任意分类"), false);
    assert.equal(knowledgeMayOrganizeMove(config, "来源甲/新分类/归类.md", "来源乙/归类.md"), false);

    await assertMaintenanceCategoryPolicy({ root, vault, fixture, config, domain });
    console.log("Knowledge folder organization production policy: PASS");
  } finally { release(); await rm(root, { recursive: true, force: true }); }
}

async function assertMaintenanceCategoryPolicy(input: {
  root: string;
  vault: string;
  fixture: Awaited<ReturnType<typeof nativeJournalFixture>>;
  config: ReturnType<typeof emptyKnowledgeFolderBindings>;
  domain: VaultDomainService;
}): Promise<void> {
  const { root, vault, fixture, config, domain } = input;
  await fixture.write(SOURCE, BODY);
  config.roles.wiki.allowedSubdirectories = [];
  config.roles.wiki.autoOrganizePaths = [];
  const port = new ProductionPiKnowledgeMaintenanceToolPort({ vaultRootPath: vault, privateKnowledgeRootPath: path.join(root, "maintenance-state"), vaultId: VAULT_ID, userId: "fixture", deviceId: "fixture", domainService: domain, dateKey: () => "2026-10-15" });
  await port.initialize();
  let sequence = 0;
  const maintain = async (targetPath: string) => await port.execute({
    vaultId: VAULT_ID, conversationId: "maintenance-conversation", piSessionId: "maintenance-session", productRunId: `maintenance-run-${++sequence}`, toolCallId: "maintain", mode: "maintain", request: "", sourcePaths: [SOURCE],
    sourceBodyFingerprints: { [SOURCE]: rawDigestFingerprint(SOURCE, Buffer.from(BODY)) },
    preferenceSnapshot: { profileVersion: "echoink-knowledge-preference-profile-v1", state: "default", revision: `sha256:${"a".repeat(64)}` },
    candidateActions: [{ targetPath, content: `# 整理成果\n来源：[[${SOURCE}]]\n`, expectedTarget: { kind: "missing" } }]
  });
  const denied = await maintain("成果/维护新分类/拒绝.md");
  assert.equal(denied.status, "failed", denied.message);
  assert.equal(await stat(path.join(vault, "成果/维护新分类")).catch(() => null), null);
  const existing = await maintain("成果/已有/维护保存.md");
  assert.equal(existing.status, "completed", existing.message);
  assert.deepEqual(existing.processedSourcePaths, [SOURCE], "closed organization still extracts and saves knowledge to an existing category");
  config.roles.wiki.autoOrganizePaths = ["成果"];
  const allowed = await maintain("成果/维护新分类/子类/允许.md");
  assert.equal(allowed.status, "completed", allowed.message);
  assert.equal(await readFile(path.join(vault, SOURCE), "utf8"), BODY);
  config.roles.wiki.autoOrganizePaths = [];
  config.roles.wiki.allowedSubdirectories = ["旧维护/子类"];
  const legacy = await maintain("成果/旧维护/子类/允许.md");
  assert.equal(legacy.status, "completed", legacy.message);
  const tooDeep = await maintain("成果/旧维护/子类/未批准/拒绝.md");
  assert.equal(tooDeep.status, "failed", tooDeep.message);
  const closedExisting = await maintain("成果/维护新分类/子类/关闭后保存.md");
  assert.equal(closedExisting.status, "completed", closedExisting.message);
  const otherBinding = await maintain("来源甲/知识/新分类/拒绝.md");
  assert.equal(otherBinding.status, "failed", otherBinding.message);
  const projectsClosed = await maintain("项目/新分类/拒绝.md");
  assert.equal(projectsClosed.status, "failed", projectsClosed.message);
  config.roles.projects.autoOrganizePaths = ["项目"];
  const projectsOpen = await maintain("项目/新分类/允许.md");
  assert.equal(projectsOpen.status, "completed", projectsOpen.message);
}

function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
