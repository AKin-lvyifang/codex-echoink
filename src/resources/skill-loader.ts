import type { CodexSkill } from "../types/app-server";
import type { EchoInkResource } from "./types";

export interface HermesSkillInfo {
  name: string;
  category: string;
  source: string;
  trust: string;
  enabled: boolean;
}

export function skillResourceFromCodexSkill(skill: CodexSkill): EchoInkResource {
  const name = cleanResourceName(skill.name);
  return {
    id: stableResourceId("codex-import", "skill", name || skill.path || "skill"),
    kind: "skill",
    source: "codex-import",
    name,
    description: skill.description || "",
    enabled: skill.enabled !== false,
    scopes: ["chat", "knowledge", "editor-actions"],
    bridgeMode: "prompt-only",
    contentPath: skill.path,
    metadata: {
      scope: skill.scope
    }
  };
}

export function skillResourceFromHermesSkill(skill: HermesSkillInfo): EchoInkResource {
  const name = cleanResourceName(skill.name);
  return {
    id: stableResourceId("hermes-import", "skill", name),
    kind: "skill",
    source: "hermes-import",
    name,
    description: [skill.category, skill.source, skill.trust].filter(Boolean).join(" · "),
    enabled: skill.enabled,
    scopes: ["chat", "knowledge", "editor-actions"],
    bridgeMode: "prompt-only",
    metadata: {
      category: skill.category,
      trust: skill.trust
    }
  };
}

export function parseHermesSkillListOutput(output: string): HermesSkillInfo[] {
  const rows: HermesSkillInfo[] = [];
  for (const line of output.split(/\r?\n/)) {
    const clean = stripBoxDrawing(line).trim();
    if (!clean || /^Name\s+Category\s+Source\s+Trust\s+Status$/i.test(clean)) continue;
    if (/^[-─━┅┄┈┉┌└┏┗╞╘]+$/.test(clean)) continue;
    const cells = clean.includes("│")
      ? clean.split("│").map((part) => part.trim()).filter(Boolean)
      : clean.split(/\s{2,}/).map((part) => part.trim()).filter(Boolean);
    const normalizedCells = cells.length >= 2 ? cells : clean.split(/\s+/).map((part) => part.trim()).filter(Boolean);
    if (normalizedCells.length < 2) continue;
    const [name, category = "", source = "", trust = "", status = ""] = normalizedCells;
    if (!name || /^installed skills$/i.test(name)) continue;
    rows.push({
      name,
      category,
      source,
      trust,
      enabled: !/disabled/i.test(status)
    });
  }
  return rows;
}

function stripBoxDrawing(value: string): string {
  return value.replace(/[┏┓┗┛┡┩└┘┌┐┬┴┼┠┨┃│╇╞╡═━─]/g, " ");
}

function cleanResourceName(value: string): string {
  return String(value ?? "").replace(/^\/+/, "").trim();
}

function stableResourceId(source: string, kind: string, rawName: string): string {
  const name = String(rawName || kind)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${source}:${kind}:${name || "resource"}`;
}
