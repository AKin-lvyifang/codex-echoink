import type { AgentDefinition } from "../agents/types";
import { isExpertAgent } from "../agents/persona";
import { isLocalUserSkill, resourceSkillCapabilityIds } from "../agents/capability-core";
import { parseVaultSkillDocument } from "../harness/resources/skill-document";
import { isBuiltinSkillId } from "../harness/resources/builtin-skills";
import type { EchoInkResource } from "../resources/types";
import { redactEchoInkLocalSecretsV1 } from "../security/local-secrets";
import { sha256Hex } from "../utils/sha256";
import { parseExpertSubmissionReceipt, type ExpertSubmissionPayload, type ExpertSubmissionReceipt } from "./submission-contract";
import type { ExpertContentFiles, ExpertDeliveryAccount } from "./service";

export const submissionText = (value: string): string => redactEchoInkLocalSecretsV1(value.trim());

/** Package explicitly attached, vault-owned text only. Never resolve a remote Skill or read script files. */
export async function collectExpertSubmissionSkills(agent: AgentDefinition, resources: readonly EchoInkResource[],
  read: (path: string) => Promise<string>): Promise<ExpertSubmissionPayload["skills"]> {
  if (isExpertAgent(agent)) throw new Error("只有自建 Agent 可以投稿。");
  const skills: ExpertSubmissionPayload["skills"] = [];
  const seen = new Set<string>();
  for (const resource of resources) {
    const skillId = resource.metadata?.resourceId;
    const path = resource.contentPath;
    if (!isLocalUserSkill(resource) || resource.source !== "echoink-local" || !resource.enabled
      || typeof skillId !== "string" || isBuiltinSkillId(skillId) || seen.has(skillId)
      || !path || !/^\.echoink\/resources\/skills\/[a-z0-9_.-]+\/SKILL\.md$/iu.test(path)
      || path.split("/").some(segment => segment === "." || segment === "..")) continue;
    const grants = resourceSkillCapabilityIds(resource);
    if (!grants.some(id => agent.capabilityIds?.includes(id)) || grants.some(id => agent.disabledCapabilityIds?.includes(id))) continue;
    const { instruction, frontmatter } = parseVaultSkillDocument((await read(path)).replaceAll("\r\n", "\n"), skillId);
    if (frontmatter.entry !== "instruction") continue;
    const content = submissionText(instruction);
    if (!content) throw new Error(`「${resource.name}」的 Skill 正文为空，请补齐后重试。`);
    const name = submissionText(resource.name);
    skills.push({ id: `skill-${sha256Hex(skillId)}`, name, description: submissionText(resource.description) || name, content });
    seen.add(skillId);
  }
  return skills;
}

export class ExpertSubmissionService {
  private readonly receipts = new Map<string, ExpertSubmissionReceipt>();
  private readonly sending = new Set<string>();
  constructor(private readonly options: {
    files: ExpertContentFiles; cacheRoot: string; account(): ExpertDeliveryAccount | null | undefined; pluginVersion: string;
  }) {}

  owner(): string | null { return this.options.account()?.expertSubmissionOwner?.() ?? null; }

  async presets(owner: string) {
    return this.account(owner).getExpertAvatarPresets!();
  }

  async receipt(agentId: string, owner: string): Promise<ExpertSubmissionReceipt | null> {
    this.account(owner);
    return this.readReceipt(this.path(agentId, owner));
  }

  async published(receipt: ExpertSubmissionReceipt, owner: string): Promise<boolean> {
    const account = this.account(owner);
    const catalog = await account.getExpertCatalog(this.options.pluginVersion);
    return this.owner() === owner && catalog.experts.some(entry => entry.id === receipt.id
      && entry.source === "community" && entry.status === "published" && entry.version === `v${receipt.version}`);
  }

  async submit(agentId: string, owner: string, payload: ExpertSubmissionPayload): Promise<{ receipt: ExpertSubmissionReceipt; saved: boolean }> {
    const account = this.account(owner), path = this.path(agentId, owner);
    if (this.sending.has(path)) throw new Error("这份投稿正在提交。");
    this.sending.add(path);
    try {
      const previous = await this.readReceipt(path);
      if (account !== this.account(owner)) throw new Error("账号已切换，请重新打开投稿页。");
      const receipt = await account.submitExpert!(owner, payload, previous?.id);
      this.receipts.set(path, receipt);
      const saved = await this.options.files.write(path, JSON.stringify(receipt)).then(() => true, () => false);
      return { receipt, saved };
    } finally { this.sending.delete(path); }
  }

  private account(owner: string) {
    const account = this.options.account();
    if (!account?.submitExpert || !account.getExpertAvatarPresets || account.expertSubmissionOwner?.() !== owner) {
      throw new Error("请使用当前设备已验证的 PRO 账号投稿。");
    }
    return account;
  }

  private async readReceipt(path: string): Promise<ExpertSubmissionReceipt | null> {
    const recent = this.receipts.get(path);
    if (recent) return recent;
    const raw = await this.options.files.read(path);
    return raw ? parseExpertSubmissionReceipt(JSON.parse(raw) as unknown) : null;
  }

  private path(agentId: string, owner: string): string {
    return `${this.options.cacheRoot}/submission-receipts/${sha256Hex(JSON.stringify([owner, agentId]))}.json`;
  }
}
