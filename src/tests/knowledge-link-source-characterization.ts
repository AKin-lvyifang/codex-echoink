import { createMaintenanceSectionSnapshot } from "../knowledge-base/maintenance-section-patch";
import { executeStagedMaintenanceFixture } from "./maintenance-staged-fixture";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  completeKnowledgeMaintenanceCandidateSources,
  validateKnowledgeMaintenanceCandidateSources
} from "../knowledge-base/knowledge-maintenance-protocol";
import { canonicalRawMarkdownForDigest, rawDigestFingerprint } from "../knowledge-base/raw-digest";
import { VaultDomainService } from "../harness/pi-native/vault-domain-service";
import { ObsidianVaultDomainAdapter } from "../plugin/obsidian-vault-domain-adapter";
import {
  ProductionPiKnowledgeMaintenanceToolPort,
  readPrivateMaintenanceRecords
} from "../plugin/pi-knowledge-maintenance-production";
import { nativeJournalFixture } from "./native-journal-fixture";
import { setRequestUrlForTests } from "./obsidian-shim";

// Regression coverage for preserving server-authenticated prior source evidence.
// The only simulated boundary is Obsidian host I/O; production source validation,
// planning, WAL, VaultDomainService writes, readback, and private records run here.
const TARGET = "wiki/AI.md";
const AGENT_LINK = "[[wiki/Agent.md|智能体]]";
const VAULT_ID = "source-characterization-vault";
const RAW = {
  "raw/old-a.md": "# 以前的资料 A\n智能体会调用工具。\n",
  "raw/old-b.md": "# 以前的资料 B\n保留旧资料的出处。\n",
  "raw/current-a.md": "# 本次资料 A\n本次新增的另一份知识。\n",
  "raw/current-b.md": "# 本次资料 B\n本次的第二份来源。\n"
} as const;
type RawPath = keyof typeof RAW;
type MarkerMode = "retained" | "omitted" | "all-evidence-omitted";
type Scenario = Readonly<{
  id: string;
  old: readonly RawPath[];
  selected: readonly RawPath[];
  markers: MarkerMode;
  rejection?: string;
  evidence?: readonly RawPath[];
}>;

const AMBIGUOUS = "来源关系不明确：请注明本候选采用的 Raw；程序不会编造多来源关系。";
const SCENARIOS: readonly Scenario[] = [
  { id: "old-single-marker_selected-single", old: ["raw/old-a.md"], selected: ["raw/current-a.md"], markers: "retained", evidence: ["raw/current-a.md"] },
  { id: "old-multiple-markers_selected-single", old: ["raw/old-a.md", "raw/old-b.md"], selected: ["raw/current-a.md"], markers: "retained", evidence: ["raw/current-a.md"] },
  { id: "old-single-marker_selected-multiple", old: ["raw/old-a.md"], selected: ["raw/current-a.md", "raw/current-b.md"], markers: "retained", rejection: AMBIGUOUS },
  { id: "old-multiple-markers_selected-multiple", old: ["raw/old-a.md", "raw/old-b.md"], selected: ["raw/current-a.md", "raw/current-b.md"], markers: "retained", rejection: AMBIGUOUS },
  { id: "old-visible-link-only_selected-single", old: ["raw/old-a.md"], selected: ["raw/current-a.md"], markers: "omitted", evidence: ["raw/current-a.md"] },
  { id: "old-evidence-dropped_selected-single", old: ["raw/old-a.md"], selected: ["raw/current-a.md"], markers: "all-evidence-omitted", evidence: ["raw/current-a.md"] },
  { id: "old-visible-link-only_selected-multiple", old: ["raw/old-a.md"], selected: ["raw/current-a.md", "raw/current-b.md"], markers: "omitted", rejection: AMBIGUOUS },
  { id: "old-evidence-dropped_selected-multiple", old: ["raw/old-a.md"], selected: ["raw/current-a.md", "raw/current-b.md"], markers: "all-evidence-omitted", rejection: AMBIGUOUS },
  { id: "old-source-in-current-snapshot_single", old: ["raw/old-a.md"], selected: ["raw/old-a.md"], markers: "retained", evidence: ["raw/old-a.md"] },
  { id: "old-source-in-current-snapshot_multiple", old: ["raw/old-a.md"], selected: ["raw/old-a.md", "raw/current-a.md"], markers: "retained", evidence: ["raw/old-a.md"] }
];

export async function runKnowledgeLinkSourceCharacterizationTests(): Promise<void> {
  const startedAt = performance.now();
  const originalFetch = globalThis.fetch;
  let networkAttempts = 0;
  globalThis.fetch = async () => { networkAttempts++; throw new Error("Network forbidden in source characterization"); };
  const restoreRequestUrl = setRequestUrlForTests(async () => { networkAttempts++; throw new Error("Obsidian network forbidden in source characterization"); });
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "echoink-source-characterization-")));
  try {
    console.log("Source characterization: real production port + VaultDomainService; temporary host fixture, no Provider.");
    for (const scenario of SCENARIOS) {
      const started = performance.now();
      const before = originalNote(scenario.old);
      const candidate = candidateNote(scenario, before);
      const selectedSources = bindings(scenario.selected);
      const directValidation = validationOutcome(candidate, scenario.selected, before);
      if (scenario.selected.includes("raw/old-a.md") && scenario.markers === "retained") {
        assert.deepEqual(directValidation, { evidence: ["raw/old-a.md"] });
      } else {
        assert.deepEqual(directValidation, { error: "knowledge_candidate_source_missing" });
      }

      let completed: string | undefined;
      if (scenario.rejection) {
        assert.throws(() => completeKnowledgeMaintenanceCandidateSources({ targetPath: TARGET, content: candidate, selectedSources, baselineContent: before }),
          (error: unknown) => error instanceof Error && error.message === scenario.rejection);
      } else {
        completed = completeKnowledgeMaintenanceCandidateSources({ targetPath: TARGET, content: candidate, selectedSources, baselineContent: before });
        assert.deepEqual(validationOutcome(completed, scenario.selected, before), { evidence: scenario.evidence });
        assert.equal(Buffer.from(undoConceptLink(completed)).equals(Buffer.from(before)), false,
          "successful completion changes more than the proposed concept link");
        assert.equal(frontmatter(completed), frontmatter(before), "this completion leaves the fixture frontmatter alone");
        if (scenario.markers === "omitted") {
          assert.ok(completed.includes("[[raw/old-a.md|旧材料 1]]"), "unselected visible Raw link survives");
          assert.equal(sourceMarkers(completed).some(marker => marker.path === "raw/old-a.md"), true,
            "an omitted marker can be restored from authenticated target bytes");
        }
        if (scenario.markers === "retained") {
          assert.equal(completed.includes(originalMarker("raw/old-a.md")), false, "old marker formatting is removed and rebuilt");
          assert.equal(count(completed, "[[raw/old-a.md|"), 2, "completion appends another readable source link");
          assert.equal(sourceMarkers(completed).length, new Set([...scenario.old, ...scenario.evidence!]).size, "prior and current source revisions coexist without duplicates");
        }
      }

      const production = await runProductionScenario(path.join(root, scenario.id), scenario, before, candidate, completed);
      console.log(JSON.stringify({ scenario: scenario.id, directValidation, completion: scenario.rejection ?? "accepted",
        ...production, elapsedMs: Math.round(performance.now() - started) }));
    }
    assert.equal(networkAttempts, 0);
    console.log(`PASS: ${SCENARIOS.length} characterization scenarios; elapsedMs=${Math.round(performance.now() - startedAt)}; networkAttempts=0.`);
    console.log("Boundary: prior sources survive only with server-authenticated expectedTarget baseline; adopted evidence contains this batch's sources only.");
    console.log("Boundary: multiple selected sources still require an explicit relation to current evidence; old provenance alone cannot select a current source.");
    console.log("Not verified: real Obsidian UI, real model tendency to omit markers, custom folder bindings, or the proposed backlink implementation.");
  } finally {
    globalThis.fetch = originalFetch;
    restoreRequestUrl();
    await rm(root, { recursive: true, force: true });
  }
}

async function runProductionScenario(root: string, scenario: Scenario, before: string, candidate: string, _completed?: string) {
  const vault = path.join(root, "vault"), privateRoot = path.join(root, "private");
  const fixture = await nativeJournalFixture(vault);
  for (const [relative, content] of Object.entries(RAW)) await fixture.write(relative, content);
  await fixture.write(TARGET, before); await fixture.write("wiki/Agent.md", "---\naliases: [智能体]\n---\n# Agent\n");
  const adapter = new ObsidianVaultDomainAdapter(fixture.app, VAULT_ID, vault);
  const events: string[] = [], writes: string[] = [];
  const updateFile = adapter.updateFile.bind(adapter), createFile = adapter.createFile.bind(adapter);
  adapter.updateFile = async (...args) => { await updateFile(...args); writes.push(args[0].relativePath); events.push(`write:${args[0].relativePath}`); };
  adapter.createFile = async (...args) => { await createFile(...args); writes.push(args[0].relativePath); events.push(`write:${args[0].relativePath}`); };
  const domain = new VaultDomainService(adapter, { allowMissingParentDirectories: true });
  let sequence = 0;
  const port = new ProductionPiKnowledgeMaintenanceToolPort({ vaultRootPath: vault, privateKnowledgeRootPath: privateRoot, vaultId: VAULT_ID, userId: "fixture", deviceId: "fixture", domainService: domain,
    dateKey: () => "2026-10-15", createPreviewId: () => `preview-${scenario.id}-${++sequence}`, faultInjector: point => { events.push(point); } });
  await port.initialize();
  const createWal = port.state.createWal.bind(port.state);
  port.state.createWal = async wal => { const saved = await createWal(wal); events.push(wal.terminalRecord ? "terminal-only-wal" : "knowledge-wal"); return saved; };
  // Legacy prose alone could not disambiguate multiple current sources. The new
  // plan must declare that exact relation before a write can be authorized.
  const pageSources = scenario.rejection ? [] : scenario.evidence!;
  const result = await executeStagedMaintenanceFixture(port, domain, {
    vaultId: VAULT_ID, conversationId: "fixture-conversation", piSessionId: "fixture-session", productRunId: scenario.id, toolCallId: "maintain", mode: "maintain", request: "", sourcePaths: [...scenario.selected],
    preferenceSnapshot: { profileVersion: "echoink-knowledge-preference-profile-v1", state: "default", revision: `sha256:${"a".repeat(64)}` },
    candidateActions: [{ targetPath: TARGET, content: candidate, expectedTarget: { kind: "file", contentRevision: `sha256:${sha256(before)}` } }]
  }, [pageSources]);
  const afterBytes = await readFile(path.join(vault, TARGET)), wals = await port.state.listRecoverableWals(VAULT_ID);
  const knowledgeWals = wals.filter(wal => wal.actions.some(entry => entry.action.purpose === "knowledge"));
  const terminalWals = wals.filter(wal => wal.terminalRecord);
  const records = await readPrivateMaintenanceRecords(privateRoot, { vaultId: VAULT_ID });
  assert.equal(records.length, 1); const record = records[0];
  if (scenario.rejection) {
    assert.equal(result.status, "failed", result.message); assert.equal(result.errorCode, "proposal_invalid");
    assert.match(result.message, /来源|清单/u, "ambiguous current-source mapping is rejected at plan stage");
    assert.ok(afterBytes.equals(Buffer.from(before)), "rejected page stays byte exact"); assert.deepEqual(writes, []); assert.equal(wals.length, 0, "invalid source mapping cannot reach a write WAL");
    assert.equal(record.p1?.phase, "plan"); assert.equal(record.sources.some(source => source.status === "processed"), false);
  } else {
    assert.equal(result.status, "completed", result.message); assert.equal(result.maintenanceResult?.status, "completed");
    assert.equal(frontmatter(afterBytes.toString("utf8")), frontmatter(before));
    const withoutSources = (markdown: string) => {
      const sources = createMaintenanceSectionSnapshot(markdown).regions.find(region => region.kind === "sources");
      assert.ok(sources, "the fixture and output have an independently managed source region");
      return markdown.slice(0, sources.start) + markdown.slice(sources.end);
    };
    assert.equal(undoConceptLink(withoutSources(afterBytes.toString("utf8"))), withoutSources(before), "only the requested concept link and the independent source region may change; all other paragraphs/whitespace are byte exact");
    assert.ok(afterBytes.includes(Buffer.from(AGENT_LINK)), "requested concept patch is persisted");
    assert.deepEqual(validationOutcome(afterBytes.toString("utf8"), scenario.selected, before), { evidence: scenario.evidence });
    assert.deepEqual(writes.filter(relative => relative.startsWith("wiki/")), [TARGET, "wiki/合成回归索引.md"], "P2 adds one managed domain map after the content page");
    assert.equal(knowledgeWals.length, 2, "content and managed map both have ordinary WAL/readback"); assert.equal(terminalWals.length, 0, "P1 settles the existing parent record instead of creating duplicate terminal WAL records");
    assert.equal(knowledgeWals[0].status, "completed"); assert.equal(knowledgeWals[0].actions[0].status, "completed");
    assert.ok(events.indexOf("knowledge-wal") < events.indexOf("after-wal-before-first-write")); assert.ok(events.indexOf("after-wal-before-first-write") < events.indexOf(`write:${TARGET}`));
    assert.deepEqual(result.producedPaths, [TARGET]); assert.deepEqual([...result.processedSourcePaths ?? []].sort(), [...scenario.selected].sort());
    assert.deepEqual(record.sources.filter(source => source.status === "processed").map(source => ({ path: source.path, evidencePaths: source.evidencePaths })).sort((a, b) => a.path.localeCompare(b.path)),
      scenario.selected.map(relative => ({ path: relative, evidencePaths: scenario.evidence?.includes(relative) ? [TARGET] : [] })).sort((a, b) => a.path.localeCompare(b.path)));
  }
  for (const [relative, content] of Object.entries(RAW)) {
    const actual = await readFile(path.join(vault, relative), "utf8");
    if (scenario.rejection || !scenario.selected.includes(relative as RawPath)) assert.equal(actual, content);
    else assert.equal(canonicalRawMarkdownForDigest(actual), canonicalRawMarkdownForDigest(content), "selected source body is immutable while controlled metadata may be added");
  }
  assert.equal(await readFile(path.join(vault, "wiki/Agent.md"), "utf8"), "---\naliases: [智能体]\n---\n# Agent\n"); assert.equal(fixture.providerCalls(), 0);
  return { productionStatus: result.status, resultStatus: result.maintenanceResult?.status, errorCode: result.errorCode ?? null, formalWrites: writes.length, targetByteIdentical: afterBytes.equals(Buffer.from(before)), knowledgeWals: knowledgeWals.length, terminalOnlyWals: terminalWals.length, persistedMachineSources: sourceMarkers(afterBytes.toString("utf8")).map(marker => marker.path), processedSources: result.processedSourcePaths ?? [] };
}

function originalNote(sources: readonly RawPath[]): string {
  return "---\naliases: [人工智能]\nstatus: established\n---\n# AI\n\n智能体会调用工具。\n\n## 来源\n"
    + sources.map((relative, index) => `[[${relative}|旧材料 ${index + 1}]]\n${originalMarker(relative)}\n`).join("");
}

function originalMarker(relative: RawPath): string {
  return `<!-- echoink-source: { "revision": "sha256:${digest(relative)}", "path": "${relative}" } -->`;
}

function candidateNote(scenario: Scenario, before: string): string {
  let candidate = before.replace("智能体", AGENT_LINK);
  if (scenario.markers !== "retained") candidate = candidate.replace(/^<!-- echoink-source:[^\n]*-->\n/gmu, "");
  if (scenario.markers === "all-evidence-omitted") candidate = candidate.replace(/^\[\[raw\/[^\n]*\]\]\n/gmu, "");
  if (scenario.markers === "retained") assert.equal(undoConceptLink(candidate), before, "candidate itself only adds the concept link");
  return candidate;
}

function bindings(paths: readonly RawPath[]) { return paths.map(relativePath => ({ relativePath, contentSha256: digest(relativePath) })); }
function digest(relative: RawPath): string { return rawDigestFingerprint(relative, Buffer.from(RAW[relative])).split(":").at(-1)!; }
function sha256(content: string): string { return createHash("sha256").update(content).digest("hex"); }
function undoConceptLink(content: string): string { return content.replace(AGENT_LINK, "智能体"); }
function frontmatter(content: string): string { return content.match(/^---\n[\s\S]*?\n---\n/u)?.[0] ?? ""; }
function count(content: string, needle: string): number { return content.split(needle).length - 1; }
function sourceMarkers(content: string): { path: string; revision: string }[] {
  return [...content.matchAll(/<!--\s*echoink-source\s*:\s*(\{[^\r\n]*\})\s*-->/gu)].map(match => JSON.parse(match[1]));
}
function validationOutcome(content: string, selected: readonly RawPath[], baselineContent?: string): { evidence: readonly string[] } | { error: string } {
  try { return { evidence: validateKnowledgeMaintenanceCandidateSources({ targetPath: TARGET, content, selectedSources: bindings(selected), baselineContent }).map(source => source.relativePath) }; }
  catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
}
