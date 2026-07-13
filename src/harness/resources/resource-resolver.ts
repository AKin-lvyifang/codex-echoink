import type { ContextSection } from "../contracts/context";
import type { HarnessWorkspace, ResourceSelectionSnapshot } from "../contracts/run";
import { resourceRefToUri } from "./resource-ref";
import { loadVaultSkill } from "./skill-loader";

export interface ResolveResourceContextInput {
  workspace: HarnessWorkspace;
  backendId: string;
  selection: ResourceSelectionSnapshot;
  maxSkillBytes: number;
}

export interface ResolvedResourceContext {
  echoInkSkills: ContextSection[];
  nativeResourceHints: ContextSection[];
  warnings: string[];
}

export async function resolveResourceContext(input: ResolveResourceContextInput): Promise<ResolvedResourceContext> {
  const echoInkSkills: ContextSection[] = [];
  const nativeResourceHints: ContextSection[] = [];
  const warnings: string[] = [...input.selection.warnings];

  for (const ref of input.selection.selected) {
    const uri = safeResourceUri(ref);
    if (ref.plane === "echoink-vault" && !ref.resourceId.startsWith("mcp/")) {
      const skill = await loadVaultSkill({
        vaultPath: input.workspace.vaultPath,
        skillId: ref.resourceId,
        maxBytes: input.maxSkillBytes
      }).catch((error) => {
        if (isMissingVaultResourceError(error)) {
          warnings.push(`EchoInk Vault Skill ${uri} is selected but missing; skipped for this run.`);
          return null;
        }
        throw error;
      });
      if (!skill) continue;
      echoInkSkills.push({
        id: `resource:${uri}`,
        priority: 600,
        channel: "developer",
        content: formatVaultSkillContext(skill.frontmatter.name, skill.instruction, skill.files),
        source: uri,
        required: false,
        sensitive: false
      });
      continue;
    }

    if (ref.plane === "agent-native") {
      if (ref.backendId !== input.backendId) {
        warnings.push(`Native resource ${uri} belongs to ${ref.backendId}; current backend is ${input.backendId}.`);
        continue;
      }
      nativeResourceHints.push({
        id: `resource:${uri}`,
        priority: 450,
        channel: "developer",
        content: `Selected native Agent resource: ${uri}. EchoInk may mention it, but the ${input.backendId} adapter owns actual invocation.`,
        source: uri,
        required: false,
        sensitive: false
      });
    }
  }

  return { echoInkSkills, nativeResourceHints, warnings };
}

function isMissingVaultResourceError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT");
}

function formatVaultSkillContext(name: string, instruction: string, files: Array<{ relativePath: string; content: string }>): string {
  const supportFiles = files.map((file) => [
    `## ${file.relativePath}`,
    file.content.trim()
  ].join("\n")).join("\n\n");
  return [
    `# EchoInk Skill: ${name}`,
    instruction.trim(),
    supportFiles
  ].filter(Boolean).join("\n\n");
}

function safeResourceUri(ref: ResolveResourceContextInput["selection"]["selected"][number]): string {
  try {
    return resourceRefToUri(ref);
  } catch {
    return `${ref.plane}:${ref.backendId ?? ""}:${ref.resourceId}`;
  }
}
