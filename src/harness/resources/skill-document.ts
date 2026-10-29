export interface VaultSkillFrontmatter {
  id: string;
  name: string;
  version: string;
  description: string;
  permissions: string[];
  entry: string;
}

export interface ParsedVaultSkillDocument {
  frontmatter: VaultSkillFrontmatter;
  instruction: string;
}

export function parseVaultSkillDocument(
  text: string,
  fallbackSkillId: string
): ParsedVaultSkillDocument {
  const skillId = normalizeSkillId(fallbackSkillId);
  const parsed = parseSkillDocument(text);
  return {
    frontmatter: {
      id: parsed.frontmatter.id || skillId,
      name: parsed.frontmatter.name || skillId,
      version: parsed.frontmatter.version || "",
      description: parsed.frontmatter.description || "",
      permissions: parsed.frontmatter.permissions,
      entry: parsed.frontmatter.entry || "instruction"
    },
    instruction: parsed.body
  };
}

export function normalizeSkillId(value: string): string {
  const id = value.trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(id) || id.includes("..")) throw new Error("Invalid skill id.");
  return id;
}

function parseSkillDocument(text: string): { frontmatter: VaultSkillFrontmatter; body: string } {
  if (!text.startsWith("---\n")) {
    return { frontmatter: emptyFrontmatter(), body: text.trim() };
  }
  const end = text.indexOf("\n---", 4);
  if (end < 0) return { frontmatter: emptyFrontmatter(), body: text.trim() };
  const rawFrontmatter = text.slice(4, end).trim();
  const body = text.slice(end + "\n---".length).trim();
  return {
    frontmatter: parseFrontmatter(rawFrontmatter),
    body
  };
}

function parseFrontmatter(text: string): VaultSkillFrontmatter {
  const data = emptyFrontmatter();
  const lines = text.split(/\r?\n/);
  let activeList: "permissions" | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const listItem = trimmed.match(/^-\s+(.+)$/);
    if (listItem && activeList) {
      data[activeList].push(stripQuotes(listItem[1].trim()));
      continue;
    }
    activeList = null;
    const match = trimmed.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1] as keyof VaultSkillFrontmatter;
    const value = stripQuotes(match[2].trim());
    if (key === "permissions") {
      activeList = key;
      if (value) data[key] = parseInlineList(value);
      continue;
    }
    if (key in data && typeof data[key] === "string") {
      data[key] = value;
    }
  }
  return data;
}

function parseInlineList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1).split(",").map((item) => stripQuotes(item.trim())).filter(Boolean);
  }
  return [stripQuotes(trimmed)];
}

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}

function emptyFrontmatter(): VaultSkillFrontmatter {
  return {
    id: "",
    name: "",
    version: "",
    description: "",
    permissions: [],
    entry: ""
  };
}
