import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  completeKnowledgeMaintenanceCandidateSources,
  validateKnowledgeMaintenanceCandidateSources
} from "../knowledge-base/knowledge-maintenance-protocol";
import { rawDigestFingerprint } from "../knowledge-base/raw-digest";
import { VaultDomainService } from "../harness/pi-native/vault-domain-service";
import { ObsidianVaultDomainAdapter } from "../plugin/obsidian-vault-domain-adapter";
import {
  ProductionPiKnowledgeMaintenanceToolPort,
  readPrivateMaintenanceRecords
} from "../plugin/pi-knowledge-maintenance-production";
import { nativeJournalFixture } from "./native-journal-fixture";
import { setRequestUrlForTests } from "./obsidian-shim";

// Characterization of the current implementation, not the proposed backlink feature.
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

const OUTSIDE = "来源不在本次范围：raw/old-a.md";
const AMBIGUOUS = "来源关系不明确：请注明本候选采用的 Raw；程序不会编造多来源关系。";
const SCENARIOS: readonly Scenario[] = [
  { id: "old-single-marker_selected-single", old: ["raw/old-a.md"], selected: ["raw/current-a.md"], markers: "retained", rejection: OUTSIDE },
  { id: "old-multiple-markers_selected-single", old: ["raw/old-a.md", "raw/old-b.md"], selected: ["raw/current-a.md"], markers: "retained", rejection: OUTSIDE },
  { id: "old-single-marker_selected-multiple", old: ["raw/old-a.md"], selected: ["raw/current-a.md", "raw/current-b.md"], markers: "retained", rejection: OUTSIDE },
  { id: "old-multiple-markers_selected-multiple", old: ["raw/old-a.md", "raw/old-b.md"], selected: ["raw/current-a.md", "raw/current-b.md"], markers: "retained", rejection: OUTSIDE },
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
      const directValidation = validationOutcome(candidate, scenario.selected);
      if (scenario.evidence && scenario.markers === "retained") {
        assert.deepEqual(directValidation, { evidence: scenario.evidence });
      } else {
        assert.deepEqual(directValidation, { error: "knowledge_candidate_source_missing" });
      }

      let completed: string | undefined;
      if (scenario.rejection) {
        assert.throws(() => completeKnowledgeMaintenanceCandidateSources({ targetPath: TARGET, content: candidate, selectedSources }),
          (error: unknown) => error instanceof Error && error.message === scenario.rejection);
      } else {
        completed = completeKnowledgeMaintenanceCandidateSources({ targetPath: TARGET, content: candidate, selectedSources });
        assert.deepEqual(validationOutcome(completed, scenario.selected), { evidence: scenario.evidence });
        assert.equal(Buffer.from(undoConceptLink(completed)).equals(Buffer.from(before)), false,
          "successful completion changes more than the proposed concept link");
        assert.equal(frontmatter(completed), frontmatter(before), "this completion leaves the fixture frontmatter alone");
        if (scenario.markers === "omitted") {
          assert.ok(completed.includes("[[raw/old-a.md|旧材料 1]]"), "unselected visible Raw link survives");
          assert.equal(sourceMarkers(completed).some(marker => marker.path === "raw/old-a.md"), false,
            "the surviving unselected visible link does not participate in validation");
        }
        if (scenario.markers === "retained") {
          assert.equal(completed.includes(originalMarker("raw/old-a.md")), false, "old marker formatting is removed and rebuilt");
          assert.equal(count(completed, "[[raw/old-a.md|"), 2, "completion appends another readable source link");
          assert.equal(sourceMarkers(completed).length, 1, "the original valid marker is replaced, not retained twice");
        }
      }

      const production = await runProductionScenario(path.join(root, scenario.id), scenario, before, candidate, completed);
      console.log(JSON.stringify({ scenario: scenario.id, directValidation, completion: scenario.rejection ?? "accepted",
        ...production, elapsedMs: Math.round(performance.now() - started) }));
    }
    assert.equal(networkAttempts, 0);
    console.log(`PASS: ${SCENARIOS.length} characterization scenarios; elapsedMs=${Math.round(performance.now() - startedAt)}; networkAttempts=0.`);
    console.log("Boundary: retained out-of-snapshot JSON markers reject before knowledge WAL/writes; failure bookkeeping still creates a terminal-only WAL.");
    console.log("Boundary: with old markers absent, a single selected source can be bound and written; multiple selected sources with no recognized evidence reject.");
    console.log("Boundary: an in-snapshot old source is accepted, but completion rewrites its marker/adds a visible source link, violating link-only byte preservation.");
    console.log("Not verified: real Obsidian UI, real model tendency to omit markers, custom folder bindings, or the proposed backlink implementation.");
  } finally {
    globalThis.fetch = originalFetch;
    restoreRequestUrl();
    await rm(root, { recursive: true, force: true });
  }
}

async function runProductionScenario(root: string, scenario: Scenario, before: string, candidate: string, completed?: string) {
  const vault = path.join(root, "vault");
  const privateRoot = path.join(root, "private");
  const fixture = await nativeJournalFixture(vault);
  for (const [relative, content] of Object.entries(RAW)) await fixture.write(relative, content);
  await fixture.write(TARGET, before);
  await fixture.write("wiki/Agent.md", "---\naliases: [智能体]\n---\n# Agent\n");
  const adapter = new ObsidianVaultDomainAdapter(fixture.app, VAULT_ID, vault);
  const events: string[] = [];
  const writes: string[] = [];
  const updateFile = adapter.updateFile.bind(adapter);
  adapter.updateFile = async (...args) => {
    await updateFile(...args);
    writes.push(args[0].relativePath);
    events.push(`write:${args[0].relativePath}`);
  };
  const createFile = adapter.createFile.bind(adapter);
  adapter.createFile = async (...args) => {
    await createFile(...args);
    writes.push(args[0].relativePath);
    events.push(`write:${args[0].relativePath}`);
  };
  const domain = new VaultDomainService(adapter, { allowMissingParentDirectories: true });
  const port = new ProductionPiKnowledgeMaintenanceToolPort({
    vaultRootPath: vault, privateKnowledgeRootPath: privateRoot, vaultId: VAULT_ID,
    userId: "fixture", deviceId: "fixture", domainService: domain,
    dateKey: () => "2026-10-15", createPreviewId: () => `preview-${scenario.id}`,
    faultInjector: point => { events.push(point); }
  });
  await port.initialize();
  const createWal = port.state.createWal.bind(port.state);
  port.state.createWal = async wal => {
    const saved = await createWal(wal);
    events.push(wal.terminalRecord ? "terminal-only-wal" : "knowledge-wal");
    return saved;
  };
  const result = await port.execute({
    vaultId: VAULT_ID, conversationId: "fixture-conversation", piSessionId: "fixture-session",
    productRunId: scenario.id, toolCallId: "maintain", mode: "maintain", request: "",
    sourcePaths: [...scenario.selected],
    sourceBodyFingerprints: Object.fromEntries(scenario.selected.map(relative => [relative, rawDigestFingerprint(relative, Buffer.from(RAW[relative]))])),
    preferenceSnapshot: { profileVersion: "echoink-knowledge-preference-profile-v1", state: "default", revision: `sha256:${"a".repeat(64)}` },
    candidateActions: [{ targetPath: TARGET, content: candidate, expectedTarget: { kind: "file", contentRevision: `sha256:${sha256(before)}` } }]
  });
  const afterBytes = await readFile(path.join(vault, TARGET));
  const wals = await port.state.listRecoverableWals(VAULT_ID);
  const knowledgeWals = wals.filter(wal => !wal.terminalRecord);
  const terminalWals = wals.filter(wal => wal.terminalRecord);
  const records = await readPrivateMaintenanceRecords(privateRoot, { vaultId: VAULT_ID });
  assert.equal(records.length, 1);
  const record = records[0];
  if (scenario.rejection) {
    assert.equal(result.status, "failed", result.message);
    assert.equal(result.errorCode, "proposal_invalid", result.message);
    assert.equal(result.maintenanceResult?.status, "failed");
    assert.ok(result.message.includes(scenario.rejection), result.message);
    assert.deepEqual(result.maintenanceResult?.issues.map(issue => ({ code: issue.code, path: issue.path })), [{ code: "candidate_skipped", path: TARGET }]);
    assert.ok(afterBytes.equals(Buffer.from(before)), "rejected old note must remain byte-identical");
    assert.deepEqual(writes, []);
    assert.equal(knowledgeWals.length, 0, "source rejection precedes creation of the knowledge action WAL");
    assert.equal(terminalWals.length, 1, "execute persists a separate failure record via a terminal-only WAL");
    assert.equal(terminalWals[0].actions.length, 0);
    assert.equal(events.includes("after-wal-before-first-write"), false);
    assert.deepEqual(result.producedPaths ?? [], []);
    assert.deepEqual(result.processedSourcePaths ?? [], []);
    assert.equal(record.result.status, "failed");
    assert.equal(record.sources.some(source => source.status === "processed"), false);
  } else {
    assert.equal(result.status, "completed", result.message);
    assert.equal(result.maintenanceResult?.status, "completed", result.message);
    assert.equal(afterBytes.toString("utf8"), completed, "production persisted exactly the source-completed candidate");
    assert.deepEqual(writes, [TARGET]);
    assert.equal(knowledgeWals.length, 1);
    assert.equal(terminalWals.length, 1, "execute also stores a terminal record after the knowledge WAL");
    assert.equal(knowledgeWals[0].status, "completed");
    assert.equal(knowledgeWals[0].actions.length, 1);
    assert.equal(knowledgeWals[0].actions[0].status, "completed");
    assert.deepEqual(validationOutcome(knowledgeWals[0].preview.actions[0].content, scenario.selected), { evidence: scenario.evidence });
    assert.ok(events.indexOf("knowledge-wal") < events.indexOf("after-wal-before-first-write"));
    assert.ok(events.indexOf("after-wal-before-first-write") < events.indexOf(`write:${TARGET}`));
    assert.deepEqual(result.producedPaths, [TARGET]);
    assert.deepEqual([...result.processedSourcePaths ?? []].sort(), [...scenario.selected].sort(),
      "all selected Raw were declared read; processed includes read sources that need no additional note");
    assert.equal(record.result.status, "completed");
    assert.deepEqual(record.sources.filter(source => source.status === "processed").map(source => ({ path: source.path, evidencePaths: source.evidencePaths }))
      .sort((left, right) => left.path.localeCompare(right.path)),
      scenario.selected.map(relative => ({ path: relative, evidencePaths: scenario.evidence?.includes(relative) ? [TARGET] : [] }))
        .sort((left, right) => left.path.localeCompare(right.path)));
    assert.equal(Buffer.from(undoConceptLink(afterBytes.toString("utf8"))).equals(Buffer.from(before)), false);
  }
  // Raw files and the target page are real files in the disposable fixture.
  for (const [relative, content] of Object.entries(RAW)) assert.equal(await readFile(path.join(vault, relative), "utf8"), content);
  assert.equal(await readFile(path.join(vault, "wiki/Agent.md"), "utf8"), "---\naliases: [智能体]\n---\n# Agent\n");
  assert.equal(fixture.providerCalls(), 0);
  return { productionStatus: result.status, resultStatus: result.maintenanceResult?.status,
    errorCode: result.errorCode ?? null, formalWrites: writes.length, targetByteIdentical: afterBytes.equals(Buffer.from(before)),
    knowledgeWals: knowledgeWals.length, terminalOnlyWals: terminalWals.length,
    persistedMachineSources: sourceMarkers(afterBytes.toString("utf8")).map(marker => marker.path),
    processedSources: result.processedSourcePaths ?? [],
    linkOnlyBytesPreserved: Buffer.from(undoConceptLink(afterBytes.toString("utf8"))).equals(Buffer.from(before)) };
}

function originalNote(sources: readonly RawPath[]): string {
  return "---\naliases: [人工智能]\nstatus: established\n---\n# AI\n\n智能体会调用工具。\n\n"
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
function validationOutcome(content: string, selected: readonly RawPath[]): { evidence: readonly string[] } | { error: string } {
  try { return { evidence: validateKnowledgeMaintenanceCandidateSources({ targetPath: TARGET, content, selectedSources: bindings(selected) }).map(source => source.relativePath) }; }
  catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
}
