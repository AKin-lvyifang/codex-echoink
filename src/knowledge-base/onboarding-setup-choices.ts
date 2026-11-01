import { classifyKnowledgePath, knowledgeCollectionTargets, knowledgeOrganizationSettings, normalizeKnowledgeDirectory, pathInKnowledgeDirectory } from "./folder-bindings";
import type { OnboardingSetupInput, OnboardingSetupPlan } from "./onboarding-setup-plan";

export type OnboardingLocation = "wiki" | "inbox" | "outputs" | "journal";
export interface OnboardingSetupChoices {
  sources: string[];
  locations: Record<OnboardingLocation, string>;
  organize: boolean;
  autoLink: boolean;
  refine: boolean;
}
export function defaultOnboardingChoices(plan: OnboardingSetupPlan): OnboardingSetupChoices {
  const bindings = plan.directoryPlan.bindings;
  return { sources: plan.sources.map(source => source.path), locations: Object.fromEntries((["wiki", "inbox", "outputs", "journal"] as const).map(role => [role, bindings.roles[role].writePath ?? bindings.roles[role].readPaths[0] ?? ""])) as Record<OnboardingLocation, string>,
    organize: knowledgeOrganizationSettings(bindings).enabled, autoLink: plan.autoLinkEnabled !== false, refine: false };
}

/** Explicit choices change the same binding plan; no directory or note is moved. */
export async function customizeOnboardingSetup(input: OnboardingSetupInput, automatic: OnboardingSetupPlan, choices: OnboardingSetupChoices): Promise<OnboardingSetupPlan> {
  const initial = defaultOnboardingChoices(automatic), bindings = structuredClone(automatic.directoryPlan.bindings);
  if (JSON.stringify(choices.locations) === JSON.stringify(initial.locations) && JSON.stringify(choices.sources) === JSON.stringify(initial.sources) && choices.organize === initial.organize) {
    return { ...automatic, choices: structuredClone(choices), autoLinkEnabled: choices.autoLink };
  }
  const modules = { ...automatic.directoryPlan.moduleDirectories };
  const issues: string[] = [];
  const changedLocations = new Set<OnboardingLocation>();
  for (const role of ["wiki", "inbox", "outputs", "journal"] as const) {
    if (choices.locations[role] === initial.locations[role]) continue;
    try {
      const directory = choices.locations[role] === "" && role === "journal" ? "" : normalizeKnowledgeDirectory(choices.locations[role]);
      Object.assign(bindings.roles[role], { enabled: true, native: role === "journal" && !directory, readPaths: directory ? [directory] : [], writePath: directory || null });
      changedLocations.add(role);
      if (role === "journal") modules.journal = directory;
      if (role === "outputs") bindings.collectionTargets = { ...knowledgeCollectionTargets(bindings), answer: directory, generation: directory };
    } catch (error) { issues.push(String(error instanceof Error ? error.message : error)); }
  }
  for (const role of changedLocations) for (const directory of bindings.roles[role].readPaths) {
    if (Object.entries(bindings.roles).some(([otherRole, binding]) => otherRole !== role && otherRole !== "raw" && binding.enabled && binding.readPaths.includes(directory))) issues.push(`${directory}：与其他存放用途冲突，请选择不同位置。`);
  }
  const other = Object.entries(bindings.roles).flatMap(([role, binding]) => role !== "raw" && binding.enabled ? binding.readPaths : []);
  const overlap = (directory: string) => other.some(root => pathInKnowledgeDirectory(directory, root) || pathInKnowledgeDirectory(root, directory));
  const allowed = new Set(automatic.sourceCandidates?.map(source => source.path) ?? initial.sources);
  const raw = bindings.roles.raw;
  raw.readPaths = [...new Set(choices.sources)].filter(directory => allowed.has(directory) && !overlap(directory));
  if (!raw.readPaths.includes(raw.writePath ?? "")) raw.writePath = null;
  if (!raw.writePath) {
    const base = input.language === "zh" ? "资料来源" : "raw";
    let target = initial.sources.find(directory => directory === base && !overlap(directory)) ?? base, suffix = 2;
    while (overlap(target) || input.files.some(file => file.path === target) || input.folders.includes(target) && !raw.readPaths.includes(target)) target = `${base} ${suffix++}`;
    raw.writePath = target; if (!raw.readPaths.includes(target)) raw.readPaths.unshift(target);
  }
  raw.enabled = true;
  const targets = knowledgeCollectionTargets(bindings);
  for (const kind of ["web", "wechat", "files", "images", "fileText"] as const) if (targets[kind] && !raw.readPaths.some(root => pathInKnowledgeDirectory(targets[kind]!, root))) targets[kind] = raw.writePath;
  bindings.collectionTargets = targets;
  bindings.organization = { ...knowledgeOrganizationSettings(bindings), enabled: choices.organize };
  const guidePath = `${bindings.roles.outputs.writePath}/${input.language === "zh" ? "开始使用 EchoInk" : "Getting started with EchoInk"}.md`;
  bindings.onboardingGuidePath = guidePath;
  const roots = [...Object.values(bindings.roles).filter(binding => binding.enabled).flatMap(binding => binding.readPaths), ...Object.values(modules), targets.answer, targets.generation].filter((value): value is string => Boolean(value));
  const create = [...new Set(roots)].filter(directory => !input.folders.includes(directory));
  const moduleChoices = { ...modules };
  for (const key of ["english", "expressions"] as const) if (automatic.directoryPlan.moduleDirectoryModes?.[key] === "role") delete moduleChoices[key];
  const directoryPlan = await input.preview(bindings, create, { mode: "build", moduleDirectories: moduleChoices });
  directoryPlan.issues.push(...issues);
  if (input.folders.includes(guidePath)) directoryPlan.issues.push(`${guidePath}：指南路径已被文件夹占用。`);
  const notes = input.files.filter(file => /\.(?:md|markdown)$/iu.test(file.path) && !file.symbolicLink && file.path !== guidePath && file.path !== input.baseline?.onboardingGuidePath);
  const sourceCounts = new Map(raw.readPaths.map(root => [root, notes.filter(file => pathInKnowledgeDirectory(file.path, root)).length]));
  const skipped = automatic.skipped.filter(item => !raw.readPaths.some(root => pathInKnowledgeDirectory(item.path, root)));
  for (const source of automatic.sources) if (input.folders.includes(source.path) && !raw.readPaths.includes(source.path) && !skipped.some(item => item.path === source.path)) {
    skipped.push({ path: source.path, noteCount: source.noteCount, reason: overlap(source.path) ? "保留给其他用途" : "未选作资料来源" });
  }
  const normalized = { ...structuredClone(choices), sources: [...raw.readPaths], locations: { ...choices.locations } };
  return { ...automatic, choices: normalized, autoLinkEnabled: choices.autoLink, directoryPlan,
    skipped,
    sources: raw.readPaths.map(path => ({ path, noteCount: sourceCounts.get(path) ?? 0, existingBinding: input.baseline?.roles.raw.readPaths.includes(path) ?? false })),
    noteCount: notes.filter(file => ["raw", "wiki", "projects"].includes(classifyKnowledgePath(bindings, file.path) ?? "")).length,
    outputLocations: { answer: targets.answer ?? "", generation: targets.generation ?? "" },
    guide: { path: guidePath, action: input.files.some(file => file.path === guidePath) ? "preserve" : "create" } };
}
