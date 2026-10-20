import { readFile } from "node:fs/promises";
import path from "node:path";
import { AGENT_IDENTITY_RELATIVE_PATH, DEFAULT_AGENT_DISPLAY_NAME, parseAgentIdentityState } from "../harness/memory/agent-identity-model";
import { inspectLegacyAgentMarkdown } from "../harness/memory/legacy-personality-reader";
import { GENERAL_ASSISTANT_ID, type AgentRegistry } from "./types";
import { styleFromLegacyTemplate } from "./styles";

/** Reads identity/template JSON only; never initializes CognitiveSystem or writes legacy files. */
export async function migrateLegacyAgentRegistry(registry: AgentRegistry, storageRoot: string): Promise<AgentRegistry> {
  if (registry.legacyMigrationVersion === 1) return registry;
  const rawIdentity = await readJson(path.join(storageRoot, AGENT_IDENTITY_RELATIVE_PATH));
  const identity = rawIdentity ? parseAgentIdentityState(rawIdentity) : null;
  const metadataPath = path.join(storageRoot, "agents/echoink/agent-self-meta.json");
  const metadata = await readJson(metadataPath);
  // An existing metadata file, even damaged or empty, is authoritative over its predecessor.
  const legacy = metadata === undefined
    ? await readJson(path.join(storageRoot, "agents/echoink/personality-state.json")) : null;
  let templateId = metadata?.schema === "echoink.agent-self-meta.v1"
    ? metadata.templateId
    : legacy && (legacy.schema === "echoink.personality.v1" || legacy.schema === "echoink.personality.v2") ? legacy.templateId : null;
  if (metadata === undefined && legacy === undefined) {
    try {
      const inspected = inspectLegacyAgentMarkdown(await readFile(path.join(storageRoot, "agents/echoink/AGENT.md"), "utf8"));
      if (inspected.kind === "valid") templateId = inspected.state.templateId;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return {
    ...registry, legacyMigrationVersion: 1,
    agents: registry.agents.map(agent => agent.id !== GENERAL_ASSISTANT_ID ? agent : {
      ...agent,
      ...(identity && identity.displayName !== DEFAULT_AGENT_DISPLAY_NAME ? { name: identity.displayName } : {}),
      ...(identity && identity.avatar.kind !== "default" ? { avatar: identity.avatar } : {}),
      styleId: styleFromLegacyTemplate(templateId)
    })
  };
}

async function readJson(filePath: string): Promise<Record<string, unknown> | null | undefined> {
  try {
    const raw: unknown = JSON.parse(await readFile(filePath, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

/** P3 display cutover: inspect only the formal identity file, once, without writing it. */
export async function synchronizeLegacyAgentIdentity(registry: AgentRegistry, storageRoot: string): Promise<AgentRegistry> {
  if (registry.legacyIdentitySyncVersion === 1) return registry;
  const sol = registry.agents.find(agent => agent.id === GENERAL_ASSISTANT_ID);
  if (sol?.identityEdited) return { ...registry, legacyIdentitySyncVersion: 1 };
  const raw = await readJson(path.join(storageRoot, AGENT_IDENTITY_RELATIVE_PATH));
  // A damaged existing file is retryable; absence is a completed inspection.
  if (raw === null) throw new Error("legacy_agent_identity_invalid");
  const identity = raw ? parseAgentIdentityState(raw) : null;
  if (raw && !identity) throw new Error("legacy_agent_identity_invalid");
  return { ...registry, legacyIdentitySyncVersion: 1, agents: registry.agents.map(agent =>
    agent.id !== GENERAL_ASSISTANT_ID ? agent : { ...agent,
      ...(identity && identity.displayName !== DEFAULT_AGENT_DISPLAY_NAME ? { name: identity.displayName } : {}),
      ...(identity && identity.avatar.kind !== "default" ? { avatar: identity.avatar } : {})
    }) };
}
