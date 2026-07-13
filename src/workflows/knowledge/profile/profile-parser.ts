export interface VaultKnowledgeProfile {
  version: number;
  language: string;
  roots: {
    raw: string;
    wiki: string;
    projects: string;
    outputs: string;
    inbox: string;
    journal: string;
  };
  protectedPaths: string[];
  ignoredPaths: string[];
  naming: {
    folderLanguage: string;
    fileLanguage: string;
    preferExistingPages: boolean;
  };
  automation: {
    moveInsideKnowledgeRoots: boolean;
    delete: boolean;
    merge: "confirm" | "never" | "auto";
  };
}

export interface ParsedVaultProfile {
  profile: VaultKnowledgeProfile;
  body: string;
  issues: string[];
}

const DEFAULT_PROFILE: VaultKnowledgeProfile = {
  version: 1,
  language: "zh-CN",
  roots: {
    raw: "raw",
    wiki: "wiki",
    projects: "projects",
    outputs: "outputs",
    inbox: "inbox",
    journal: "journal"
  },
  protectedPaths: ["templates", "work"],
  ignoredPaths: ["testing"],
  naming: {
    folderLanguage: "en",
    fileLanguage: "zh-CN",
    preferExistingPages: true
  },
  automation: {
    moveInsideKnowledgeRoots: true,
    delete: false,
    merge: "confirm"
  }
};

export function defaultVaultProfile(): VaultKnowledgeProfile {
  return cloneProfile(DEFAULT_PROFILE);
}

export function parseVaultProfile(markdown: string): ParsedVaultProfile {
  const { frontmatter, body } = splitFrontmatter(markdown);
  const raw = parseYamlLike(frontmatter);
  const issues: string[] = [];
  const profile = defaultVaultProfile();

  const version = Number(raw.echoink_profile_version);
  if (Number.isFinite(version) && version > 0) profile.version = Math.trunc(version);
  else if (raw.echoink_profile_version !== undefined) issues.push("Invalid echoink_profile_version; using default profile version.");

  const language = stringValue(raw.language);
  if (language) profile.language = language;
  else if (raw.language !== undefined) issues.push("Invalid language; using zh-CN.");

  applyRoots(profile, raw.roots, issues);
  profile.protectedPaths = safePathList(raw.protected_paths, profile.protectedPaths, "protected_paths", issues);
  profile.ignoredPaths = safePathList(raw.ignored_paths, profile.ignoredPaths, "ignored_paths", issues);
  applyNaming(profile, raw.naming);
  applyAutomation(profile, raw.automation, issues);

  return {
    profile,
    body,
    issues
  };
}

export function buildVaultProfileTemplate(now = new Date()): string {
  const stamp = now.toISOString().slice(0, 10);
  return [
    "---",
    "echoink_profile_version: 1",
    "language: zh-CN",
    "",
    "roots:",
    "  raw: raw",
    "  wiki: wiki",
    "  projects: projects",
    "  outputs: outputs",
    "  inbox: inbox",
    "  journal: journal",
    "",
    "protected_paths:",
    "  - templates",
    "  - work",
    "",
    "ignored_paths:",
    "  - testing",
    "",
    "naming:",
    "  folder_language: en",
    "  file_language: zh-CN",
    "  prefer_existing_pages: true",
    "",
    "automation:",
    "  move_inside_knowledge_roots: true",
    "  delete: false",
    "  merge: confirm",
    "---",
    "",
    "# 当前知识库说明",
    "",
    `更新时间：${stamp}`,
    "",
    "## 领域与分类",
    "",
    "## 路由偏好",
    "",
    "## Journal 格式",
    "",
    "## 用户额外约束",
    "",
    "## 特殊目录说明"
  ].join("\n");
}

function splitFrontmatter(markdown: string): { frontmatter: string; body: string } {
  if (!markdown.startsWith("---\n")) return { frontmatter: "", body: markdown.trim() };
  const end = markdown.indexOf("\n---", 4);
  if (end < 0) return { frontmatter: "", body: markdown.trim() };
  return {
    frontmatter: markdown.slice(4, end).trim(),
    body: markdown.slice(end + "\n---".length).trim()
  };
}

function parseYamlLike(text: string): Record<string, any> {
  const root: Record<string, any> = {};
  const lines = text.split(/\r?\n/);
  let currentObject: Record<string, any> | null = null;
  let currentListKey = "";
  for (const rawLine of lines) {
    if (!rawLine.trim()) continue;
    const indent = rawLine.match(/^\s*/)?.[0].length ?? 0;
    const line = rawLine.trim();
    if (indent === 0) {
      currentObject = null;
      currentListKey = "";
      const match = line.match(/^([a-zA-Z0-9_]+):\s*(.*)$/);
      if (!match) continue;
      const key = match[1];
      const value = match[2];
      if (!value) {
        root[key] = {};
        currentObject = root[key];
        currentListKey = key;
      } else {
        root[key] = parseScalarOrList(value);
      }
      continue;
    }
    if (line.startsWith("- ") && currentListKey) {
      if (!Array.isArray(root[currentListKey])) root[currentListKey] = [];
      root[currentListKey].push(stripQuotes(line.slice(2).trim()));
      continue;
    }
    const child = line.match(/^([a-zA-Z0-9_]+):\s*(.*)$/);
    if (child && currentObject) {
      currentObject[child[1]] = parseScalarOrList(child[2]);
    }
  }
  return root;
}

function parseScalarOrList(value: string): any {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1).split(",").map((item) => stripQuotes(item.trim())).filter(Boolean);
  }
  return stripQuotes(trimmed);
}

function applyRoots(profile: VaultKnowledgeProfile, value: any, issues: string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const key of Object.keys(profile.roots) as Array<keyof VaultKnowledgeProfile["roots"]>) {
    const root = stringValue(value[key]);
    if (!root) continue;
    if (!isSafeRelativePath(root)) {
      issues.push(`Invalid roots.${key}; using default.`);
      continue;
    }
    profile.roots[key] = root;
  }
}

function applyNaming(profile: VaultKnowledgeProfile, value: any): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  profile.naming.folderLanguage = stringValue(value.folder_language) || profile.naming.folderLanguage;
  profile.naming.fileLanguage = stringValue(value.file_language) || profile.naming.fileLanguage;
  if (typeof value.prefer_existing_pages === "boolean") profile.naming.preferExistingPages = value.prefer_existing_pages;
}

function applyAutomation(profile: VaultKnowledgeProfile, value: any, issues: string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  if (typeof value.move_inside_knowledge_roots === "boolean") profile.automation.moveInsideKnowledgeRoots = value.move_inside_knowledge_roots;
  if (value.delete === true) {
    issues.push("automation.delete cannot be true; Core Policy keeps delete disabled by default.");
    profile.automation.delete = false;
  } else if (typeof value.delete === "boolean") {
    profile.automation.delete = value.delete;
  }
  if (value.merge === "confirm" || value.merge === "never" || value.merge === "auto") profile.automation.merge = value.merge;
}

function safePathList(value: any, fallback: string[], label: string, issues: string[]): string[] {
  const items = Array.isArray(value) ? value : [];
  if (!items.length) return [...fallback];
  const safe = items.map(stringValue).filter(Boolean).filter((item) => {
    const ok = isSafeRelativePath(item);
    if (!ok) issues.push(`Invalid ${label}: ${item}`);
    return ok;
  });
  return safe.length ? safe : [...fallback];
}

function isSafeRelativePath(value: string): boolean {
  return Boolean(value) && !value.startsWith("/") && !value.includes("..") && !/^[a-zA-Z]:/.test(value);
}

function stringValue(value: any): string {
  return typeof value === "string" ? stripQuotes(value.trim()) : "";
}

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}

function cloneProfile(profile: VaultKnowledgeProfile): VaultKnowledgeProfile {
  return {
    version: profile.version,
    language: profile.language,
    roots: { ...profile.roots },
    protectedPaths: [...profile.protectedPaths],
    ignoredPaths: [...profile.ignoredPaths],
    naming: { ...profile.naming },
    automation: { ...profile.automation }
  };
}
