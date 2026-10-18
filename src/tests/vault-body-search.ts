import assert from "node:assert/strict";
import type { App, TFile } from "obsidian";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { VaultBodySearch, knowledgeSearchPathKind } from "../knowledge-base/vault-body-search";
import { emptyKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { KnowledgeAgentIndex } from "../knowledge-base/knowledge-agent-index";
import { KnowledgeReferenceBuilder, KnowledgeRetriever, formatKnowledgeReferencesForPrompt } from "../knowledge-base/query";
import { bindKnowledgeIndexToVault, createProductionPiKnowledgeRuntime } from "../plugin/pi-production-runtime-composition";
import { PiKnowledgeReadToolSecurity, createPiKnowledgeReadToolDefinitions } from "../harness/pi-native/pi-knowledge-read-tools";
import { EchoInkVaultToolEgressPolicy } from "../harness/pi-native/vault-tool-result-safety";
import { knowledgeReferenceEntryDetails } from "../knowledge-base/usage";
import { registerKnowledgeFolderBindings } from "../knowledge-base/root-paths";
import { searchBodyDocuments } from "../knowledge-base/search/body-search";

export async function runVaultBodySearchSourceRevisionTests(): Promise<void> {
  const sourcePath = "projects/Decision.md", targetPath = "notes/Target.md";
  const oldMarker = "OLD_DELIVERED_ZQWERTY", newMarker = "NEW_CURRENT_ASDFGHJ";
  const oldSource = `# Decision\n${oldMarker}\n\n[[notes/Target#Heading]]`;
  const newSource = oldSource.replace(oldMarker, newMarker);
  const bodies = new Map([[sourcePath, oldSource], [targetPath, "# Heading\nTarget navigation body."]]);
  const bindings = emptyKnowledgeFolderBindings();
  bindings.roles.projects.enabled = true; bindings.roles.projects.readPaths = ["projects"];
  let targetWait: { entered: () => void; wait: Promise<void> } | undefined;
  let sourceWait: { entered: () => void; wait: Promise<void> } | undefined;
  let sourceReads = 0;
  let targetUnavailable = false;
  const file = (name: string) => ({ path: name, basename: name.split("/").at(-1)!.slice(0, -3), extension: "md", stat: { mtime: 10, ctime: 1, size: bodies.get(name)!.length } }) as TFile;
  const app = { vault: { getMarkdownFiles: () => [...bodies.keys()].map(file), getAbstractFileByPath: (name: string) => bodies.has(name) ? file(name) : null,
    read: async (entry: TFile) => {
      if (entry.path === sourcePath && sourceWait && ++sourceReads === 2) { sourceWait.entered(); await sourceWait.wait; }
      if (entry.path === targetPath && targetUnavailable) throw new Error("Target is unavailable");
      if (entry.path === targetPath && targetWait) { targetWait.entered(); await targetWait.wait; }
      return bodies.get(entry.path)!;
    } }, metadataCache: { getFileCache: () => null } } as unknown as App;
  const port = new VaultBodySearch(app, () => bindings);
  const index = new KnowledgeAgentIndex({ vaultPath: "/synthetic-source-revision", storageRootPath: "/synthetic-source-revision-state", bodySearch: port });
  index.refresh = async () => { assert.fail("source revision checks cannot initialize a maintained index"); };
  const builder = new KnowledgeReferenceBuilder(index.vaultPath, port);
  const runtime = createProductionPiKnowledgeRuntime({ vaultRootPath: index.vaultPath, knowledgeAgentIndex: index, knowledgePreferences: {} as never, usage: {} as never });
  const search = port.search.bind(port);
  const observations: { route: string; race: string; oldBodyDelivered: boolean; errorCode?: string; sourceChanged?: boolean }[] = [];
  const race = async <T>(mode: "page" | "event" | "deleted" | "deleted-read", action: () => Promise<T>) => {
    bodies.set(sourcePath, oldSource); port.invalidate(sourcePath);
    sourceReads = 0;
    let entered!: () => void, resume!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { resume = resolve; });
    if (mode === "page" || mode === "deleted") port.search = async request => { if (request.mode === "related") { entered(); await wait; } return await search(request); };
    else if (mode === "event") targetWait = { entered, wait };
    else sourceWait = { entered, wait };
    const pending = action().then(value => ({ value, errorCode: undefined }), (error: { code?: string }) => ({ value: undefined, errorCode: error.code }));
    await started;
    if (mode.startsWith("deleted")) bodies.delete(sourcePath); else bodies.set(sourcePath, newSource);
    if (mode === "event") port.invalidate(sourcePath);
    resume();
    const result = await pending;
    targetWait = undefined; sourceWait = undefined; port.search = search;
    return result;
  };
  try {
    const baseline = await builder.buildReference({ vaultRelativePath: sourcePath, question: oldMarker, includeAnchorNavigation: true });
    assert.equal(baseline.excerpt, oldMarker, "the replaced marker is the actual delivered paragraph, not an unread tail");
    const baselineChat = await runtime.retrieveChat!({ question: oldMarker, explicitPaths: [sourcePath], includeUnrefined: false } as never);
    assert.ok(baselineChat.providerResourceText.includes(oldMarker), "the production baseline actually delivers the paragraph that the race replaces");
    for (const mode of ["page", "event", "deleted", "deleted-read"] as const) {
      const built = await race(mode, () => builder.buildReference({ vaultRelativePath: sourcePath, question: oldMarker, includeAnchorNavigation: true }));
      observations.push({ route: "builder", race: mode, errorCode: built.errorCode, oldBodyDelivered: Boolean(built.value?.excerpt.includes(oldMarker)) });
      const chat = await race(mode, () => runtime.retrieveChat!({ question: oldMarker, explicitPaths: [sourcePath], includeUnrefined: false } as never));
      observations.push({ route: "production.retrieveChat", race: mode, errorCode: chat.errorCode,
        oldBodyDelivered: Boolean(chat.value?.providerResourceText.includes(oldMarker) || chat.value?.references.some(reference => reference.excerpt.includes(oldMarker))),
        sourceChanged: chat.value ? (JSON.stringify(chat.value).includes("source-changed") || chat.value.status === "no_evidence") : undefined });
    }
    console.log(`Source revision replacement development evidence: ${JSON.stringify(observations)}`);
    assert.ok(observations.every(item => !item.oldBodyDelivered), "a known source revision change must never deliver the replaced old paragraph");
    assert.ok(observations.filter(item => item.route === "builder").every(item => item.errorCode === "source-changed"));
    bodies.set(sourcePath, oldSource); port.invalidate(sourcePath); targetUnavailable = true;
    const unavailable = await builder.buildReference({ vaultRelativePath: sourcePath, question: oldMarker, includeAnchorNavigation: true });
    assert.equal(unavailable.excerpt, oldMarker, "a stable source remains readable when only its target is unavailable");
    assert.equal(unavailable.related!.items[0].anchorLocation!.status, "not_located");
    if (unavailable.related!.items[0].anchorLocation!.status === "not_located") assert.equal(unavailable.related!.items[0].anchorLocation!.reason, "unavailable");
    const unavailableChat = await runtime.retrieveChat!({ question: oldMarker, explicitPaths: [sourcePath], includeUnrefined: false } as never);
    assert.ok(unavailableChat.providerResourceText.includes(oldMarker), "target-only failure still delivers the stable source through the real Chat route");
    assert.equal(unavailableChat.references[0].related!.items[0].anchorLocation!.status, "not_located");
  } finally { port.dispose(); }
  console.log("Source revision replacement: builder and actual Chat reject page mismatches and async source_changed; target-only failures retain stable source body PASS");
}

export async function runVaultBodySearchExplicitAnchorTests(): Promise<void> {
  const sourcePath = "projects/exports/Brief.md", targetPath = "notes/Checklist.md";
  const source = ["# Brief", "EXPLICIT_ANCHOR_TOKEN is the selected claim.", ...Array.from({ length: 65 }, () => "Background."),
    "[[notes/Checklist#Packing]]", "[[notes/Checklist#^sleeve]]", "[[notes/Checklist#Missing]]"].join("\n");
  const target = ["# Checklist", ...Array.from({ length: 40 }, () => "Preface."), "## Packing", "UNREAD_PACKING_BODY", "## Other", "Other detail.", "", "Use the padded sleeve. ^sleeve"].join("\n");
  const bodies = new Map([[sourcePath, source], [targetPath, target]]);
  const reads: string[] = [];
  const bindings = emptyKnowledgeFolderBindings();
  bindings.roles.projects.enabled = true; bindings.roles.projects.readPaths = ["projects"];
  const file = (name: string) => ({ path: name, basename: name.split("/").at(-1)!.slice(0, -3), extension: "md", stat: { mtime: 10, ctime: 1, size: bodies.get(name)!.length } }) as TFile;
  const app = { vault: { getMarkdownFiles: () => [...bodies.keys()].map(file), getAbstractFileByPath: (name: string) => bodies.has(name) ? file(name) : null,
    read: async (entry: TFile) => { reads.push(entry.path); return bodies.get(entry.path)!; } }, metadataCache: { getFileCache: () => null } } as unknown as App;
  const port = new VaultBodySearch(app, () => bindings);
  const index = new KnowledgeAgentIndex({ vaultPath: "/synthetic-explicit-anchors", storageRootPath: "/synthetic-explicit-anchor-state", bodySearch: port });
  index.refresh = async () => { assert.fail("explicit anchors never initialize the maintained index"); };
  const retriever = new KnowledgeRetriever(index.vaultPath, { agentIndex: index });
  const builder = new KnowledgeReferenceBuilder(index.vaultPath, port);
  const question = sourcePath;
  try {
    const baseline = await builder.buildReference({ vaultRelativePath: sourcePath, question, allowUnrefined: true });
    reads.length = 0;
    const result = await retriever.retrieve({ question, explicitPaths: [sourcePath], limit: 1 });
    assert.equal(result.references.length, 1);
    const reference = result.references[0];
    assert.ok(reference.related, "an explicit source excluded from normal search still delivers bounded anchor navigation");
    const { related, ...body } = reference;
    assert.deepEqual(body, baseline, "adding explicit anchor navigation never expands the delivered body range or identity");
    assert.equal(related!.contentRevision, reference.contentRevision);
    assert.equal(related!.returned, 3);
    assert.equal(related!.items[0].anchorLocation!.status, "located");
    assert.equal(related!.items[0].anchorLocation!.readStatus, "unread");
    assert.equal(related!.items[0].anchorLocation!.contentRevision, related!.items[0].target!.contentRevision);
    assert.equal(related!.items[1].anchorLocation!.kind, "block");
    assert.equal(related!.items[2].anchorLocation!.status, "not_located");
    assert.ok(reference.lineEnd < 65);
    assert.deepEqual(reads, [sourcePath, sourcePath, targetPath], "only this explicit source and its one unique target are read; no global scan is needed");
    assert.equal((await retriever.verifyReferences([reference])).status, "valid");
    assert.deepEqual(knowledgeReferenceEntryDetails([reference]).references[0].related, related);
    assert.doesNotMatch(formatKnowledgeReferencesForPrompt([reference]), /UNREAD_PACKING_BODY/u);
    const runtime = createProductionPiKnowledgeRuntime({ vaultRootPath: index.vaultPath, knowledgeAgentIndex: index, knowledgePreferences: {} as never, usage: {} as never });
    for (const delivered of [await runtime.retrieveChat!({ question, explicitPaths: [sourcePath], includeUnrefined: false } as never),
      await runtime.retrieveAsk({ question, explicitPaths: [sourcePath], includeUnrefined: false } as never)]) {
      assert.deepEqual(JSON.parse(delivered.providerResourceText).sources[0].related, delivered.references[0].related);
      assert.deepEqual(delivered.references[0].related, related);
      assert.equal(delivered.references[0].referenceId, baseline.referenceId);
    }
    bodies.set(targetPath, `New preface.\n\n${target}`);
    const moved = (await retriever.retrieve({ question, explicitPaths: [sourcePath], limit: 1 })).references[0];
    assert.notEqual(moved.related!.items[0].target!.contentRevision, related!.items[0].target!.contentRevision);
    if (moved.related!.items[0].anchorLocation!.status === "located" && related!.items[0].anchorLocation!.status === "located") {
      assert.equal(moved.related!.items[0].anchorLocation!.lineStart, related!.items[0].anchorLocation!.lineStart + 2);
    }
    // A source edit between the body snapshot and optional navigation cannot mix revisions.
    const search = port.search.bind(port);
    port.search = async request => {
      if (request.mode === "related") bodies.set(sourcePath, source.replace("EXPLICIT_ANCHOR_TOKEN is the selected claim.", "EXPLICIT_NEW_SOURCE_CLAIM"));
      return await search(request);
    };
    const changed = await retriever.retrieve({ question, explicitPaths: [sourcePath], limit: 1 });
    assert.equal(changed.references.length, 0, "a known source SHA mismatch rejects the old body rather than only omitting navigation");
    assert.equal(changed.localIssues![0].status, "source-changed");
    port.search = search; bodies.set(sourcePath, source); port.invalidate(sourcePath);
    port.search = async request => {
      if (request.mode === "related") bindings.roles.projects.searchEnabled = false;
      return await search(request);
    };
    const revoked = await retriever.retrieve({ question, explicitPaths: [sourcePath], limit: 1 });
    assert.equal(revoked.references.length, 0, "a scope revocation while decorating explicit navigation cannot publish the earlier body snapshot");
    assert.equal(revoked.localIssues![0].status, "source-changed");
    port.search = search; bindings.roles.projects.searchEnabled = true; port.invalidate(sourcePath);
    for (let i = 0; i < 5; i++) bodies.set(`notes/Other-${i}.md`, source.replace("# Brief", `# Other ${i}`));
    const mixed = await retriever.retrieve({ question: "EXPLICIT_ANCHOR_TOKEN", explicitPaths: [sourcePath], limit: 6 });
    assert.equal(mixed.references.length, 6);
    const navigation = mixed.references.filter(item => item.related);
    assert.equal(navigation.length, 3, "explicit and ordinary search share the first-three navigation source budget");
    assert.equal(navigation[0].vaultRelativePath, sourcePath);
    assert.ok(navigation.every(item => item.related!.returned <= 4));
    assert.deepEqual(knowledgeReferenceEntryDetails(mixed.references).references.map(item => item.related), mixed.references.map(item => item.related));
    bodies.set(sourcePath, "# Brief\nOrdinary [[notes/Checklist]] link and `[[notes/Checklist#Fake]]` code."); port.invalidate(sourcePath);
    reads.length = 0;
    const plain = (await retriever.retrieve({ question, explicitPaths: [sourcePath], limit: 1 })).references[0];
    assert.equal(plain.related, undefined);
    assert.deepEqual(reads, [sourcePath], "anchorless explicit sources retain their single original body read");
  } finally { port.dispose(); }
  console.log("Explicit source anchors: bounded same-source revision navigation, current target SHA, exact body/provider/storage parity and shared first-three source budget PASS");
}

export async function runVaultBodySearchAnchorTests(): Promise<void> {
  const sourcePath = "notes/Source.md", targetPath = "notes/Target.md";
  const source = ["# Source", "REAL_ANCHOR_TOKEN is the delivered source claim.", ...Array.from({ length: 60 }, () => "Background."),
    "[[Target#Exact heading]]", "[[Target#^paragraph]]", "[[Target#Missing]]", "[[private/Hidden#Secret]]", "[[disabled/Hidden#Secret]]", "[[.obsidian/Hidden#Secret]]", "[[../../escape#Secret]]",
    "[[Target#^bad_id]]", "[[Gone#Lost]]"].join("\n");
  const target = ["# Target", ...Array.from({ length: 45 }, () => "Preface."), "## Exact heading", "TARGET_BODY_SENTINEL is only unread navigation until requested.", "### Child", "Detail.",
    "## Tail", "TAIL_SENTINEL", "", "Paragraph first.", "Paragraph second. ^paragraph", "", "[[Source#Source]]"].join("\n");
  const bodies = new Map([[sourcePath, source], [targetPath, target], ["private/Hidden.md", "# Secret\nPRIVATE_BODY_SENTINEL"],
    ["disabled/Hidden.md", "# Secret\nDISABLED_BODY_SENTINEL"], [".obsidian/Hidden.md", "# Secret\nHIDDEN_BODY_SENTINEL"]]);
  const bindings = emptyKnowledgeFolderBindings();
  bindings.roles.wiki.readPaths = ["disabled"];
  let clock = 10;
  let reads = 0;
  let pause: { entered: () => void; wait: Promise<void> } | undefined;
  const file = (name: string) => ({ path: name, basename: name.split("/").at(-1)!.slice(0, -3), extension: "md", stat: { mtime: clock, ctime: 1, size: bodies.get(name)?.length ?? 0 } }) as TFile;
  const app = { vault: { getMarkdownFiles: () => [...bodies.keys()].map(file), getAbstractFileByPath: (name: string) => bodies.has(name) ? file(name) : null,
    read: async (entry: TFile) => {
      reads++;
      assert.ok(!entry.path.startsWith("private/") && !entry.path.startsWith("disabled/") && !entry.path.startsWith(".obsidian/"));
      const content = bodies.get(entry.path)!;
      if (entry.path === targetPath && pause) { pause.entered(); await pause.wait; }
      return content;
    } }, metadataCache: { getFileCache: () => null, getFirstLinkpathDest: () => file("private/Hidden.md") },
    workspace: { getActiveFile: () => null, getLastOpenFiles: () => [] } } as unknown as App;
  const port = new VaultBodySearch(app, () => bindings, { excludedRoots: () => ["private"] });
  const index = new KnowledgeAgentIndex({ vaultPath: "/synthetic-anchor-vault", storageRootPath: "/synthetic-anchor-state", bodySearch: port });
  index.refresh = async () => { assert.fail("ordinary anchor navigation must never initialize the maintained index"); };
  const retriever = new KnowledgeRetriever(index.vaultPath, { agentIndex: index });
  const observed: import("../knowledge-base/types").KnowledgeReference[] = [];
  const security = new PiKnowledgeReadToolSecurity({ currentRunIdentity: () => ({ vaultId: "vault-anchor-v", conversationId: "vault-anchor-c", piSessionId: "vault-anchor-s", productRunId: "vault-anchor-r" }),
    currentWorkflow: () => "chat", onSourceRead: reference => { observed.push(reference); }, egress: new EchoInkVaultToolEgressPolicy() });
  const tools = createPiKnowledgeReadToolDefinitions({ retriever, security });
  let sequence = 0;
  const call = async (name: "knowledge_search" | "knowledge_read", input: Record<string, unknown>, signal?: AbortSignal) => {
    const id = `vault-anchor-${++sequence}`;
    assert.equal(await security.handleToolCall({ toolName: name, toolCallId: id, input } as never, undefined), undefined);
    try { await tools.find(tool => tool.name === name)!.execute(id, input, signal, undefined); } catch { /* security returns the safe failure */ }
    return await security.handleToolResult({ toolName: name, toolCallId: id, isError: false } as never);
  };
  const gate = () => {
    let entered!: () => void, resume!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    pause = { entered, wait: new Promise<void>(resolve => { resume = resolve; }) };
    return { started, resume: () => { pause = undefined; resume(); } };
  };
  try {
    const initial = await index.search({ query: "REAL_ANCHOR_TOKEN", limit: 1 });
    const hit = initial.hits[0], page = hit.related!;
    assert.equal(page.returned, 4);
    assert.equal(page.total, 9);
    assert.ok(hit.lineEnd < 60, "links outside the excerpt still supply navigation");
    const heading = page.items[0];
    assert.equal(heading.target!.vaultRelativePath, targetPath);
    assert.equal(heading.anchorLocation!.status, "located");
    assert.equal(heading.anchorLocation!.contentRevision, heading.target!.contentRevision);
    assert.equal(heading.anchorLocation!.readStatus, "unread");
    assert.equal(page.items[2].anchorLocation!.status, "not_located");
    assert.equal(page.items[3].target, undefined, "host resolution cannot widen a private target into the allowed scope");
    const retrieval = await retriever.retrieve({ question: "REAL_ANCHOR_TOKEN", limit: 1 });
    assert.deepEqual(retrieval.references[0].related, page);
    assert.deepEqual(knowledgeReferenceEntryDetails(retrieval.references).references[0].related, page);
    assert.equal((await retriever.verifyReferences(retrieval.references)).status, "valid");
    assert.doesNotMatch(formatKnowledgeReferencesForPrompt(retrieval.references), /TARGET_BODY_SENTINEL|PRIVATE_BODY_SENTINEL|DISABLED_BODY_SENTINEL/u);
    const searchTool = await call("knowledge_search", { query: "REAL_ANCHOR_TOKEN", limit: 1 });
    assert.equal(searchTool.isError, false);
    const delivered = JSON.parse(searchTool.content[0].text).hits[0];
    assert.deepEqual(delivered.related, page);
    assert.deepEqual((searchTool.details.references as typeof observed)[0].related, page);
    assert.deepEqual(observed[0].related, page);
    assert.equal(observed[0].lineEnd, hit.lineEnd);
    assert.equal(observed.length, 1, "target navigation never creates a target read record");
    const all = await call("knowledge_search", { mode: "related", vaultRelativePath: sourcePath, limit: 8 });
    assert.equal(all.isError, false);
    assert.equal(observed.length, 1);
    const relations = JSON.parse(all.content[0].text).related;
    assert.equal(relations.returned, 8);
    for (const relation of relations.items.slice(3, 7)) assert.equal(relation.target, undefined);
    assert.equal(relations.items[7].anchorLocation.reason, "invalid");
    const next = await index.search({ mode: "related", vaultRelativePath: sourcePath, cursor: relations.continuationCursor, limit: 8 });
    assert.equal(next.related!.items[0].status, "unresolved");
    const beforeRevision = heading.target!.contentRevision;
    bodies.set(targetPath, `New preface.\n\n${target}`);
    const moved = (await index.search({ query: "REAL_ANCHOR_TOKEN", limit: 1 })).hits[0].related!.items[0];
    assert.notEqual(moved.target!.contentRevision, beforeRevision);
    if (moved.anchorLocation!.status === "located" && heading.anchorLocation!.status === "located") assert.equal(moved.anchorLocation!.lineStart, heading.anchorLocation!.lineStart + 2);
    const fresh = await call("knowledge_read", { vaultRelativePath: targetPath, expectedContentRevision: moved.target!.contentRevision, anchor: "Exact heading" });
    assert.equal(fresh.isError, false);
    assert.match(JSON.parse(fresh.content[0].text).excerpt, /TARGET_BODY_SENTINEL/u);
    assert.doesNotMatch(JSON.parse(fresh.content[0].text).excerpt, /TAIL_SENTINEL/u);
    const beforeStale = observed.length;
    const stale = await call("knowledge_read", { vaultRelativePath: targetPath, expectedContentRevision: beforeRevision, anchor: "Exact heading" });
    assert.equal(stale.isError, true);
    assert.equal(stale.details.errorCode, "knowledge_source_changed");
    assert.equal(observed.length, beforeStale);
    for (const related of [undefined, { ...page, extra: true }, { ...page, vaultRelativePath: targetPath }, { ...page, contentRevision: beforeRevision }, { ...page, returned: 0 },
      { ...page, items: [...page.items, ...page.items, ...page.items], returned: 12 },
      { ...page, items: [{ ...heading, original: "X".repeat(2049) }], returned: 1 },
      { ...page, items: [{ ...heading, target: { ...heading.target, contentRevision: hit.contentRevision } }], returned: 1 },
      { ...page, items: [{ ...page.items[2], anchorLocation: { schemaVersion: 1, readStatus: "unread", vaultRelativePath: targetPath, anchor: "Missing", kind: "heading", status: "not_located", reason: "missing" } }], returned: 1 },
      { ...page, items: [{ ...heading, anchorLocation: { ...heading.anchorLocation, readStatus: "read" } }], returned: 1 }]) {
      assert.throws(() => knowledgeReferenceEntryDetails([{ ...retrieval.references[0], related } as never]), /related 无效/u);
    }
    // Unchanged host metadata cannot authorize a cached source body with an old SHA.
    bodies.set(sourcePath, source.replace("REAL_ANCHOR_TOKEN", "FAKE_ANCHOR_TOKEN"));
    await assert.rejects(index.search({ query: "REAL_ANCHOR_TOKEN", limit: 1 }), { code: "source_changed" });
    bodies.set(sourcePath, source); port.invalidate(sourcePath);
    await index.search({ query: "REAL_ANCHOR_TOKEN", limit: 1 });
    for (const change of ["scope", "source", "cursor"] as const) {
      const currentPage = change === "cursor" ? await index.search({ mode: "related", vaultRelativePath: sourcePath, limit: 1 }) : undefined;
      const blocked = gate();
      const pending = index.search(change === "cursor" ? { mode: "related", vaultRelativePath: sourcePath, limit: 1, cursor: currentPage!.continuationCursor } : { query: "REAL_ANCHOR_TOKEN", limit: 1 });
      const rejected = assert.rejects(pending, { code: change === "cursor" ? "cursor_stale" : "source_changed" });
      await blocked.started;
      if (change === "scope") bindings.revision++; else port.invalidate(sourcePath);
      blocked.resume(); await rejected;
      await index.search({ query: "REAL_ANCHOR_TOKEN", limit: 1 });
    }
    const cancel = new AbortController();
    const blocked = gate();
    const pending = call("knowledge_search", { query: "REAL_ANCHOR_TOKEN", limit: 1 }, cancel.signal);
    await blocked.started; cancel.abort(); blocked.resume();
    assert.equal((await pending).isError, true);
    assert.equal(observed.length, beforeStale, "cancelled navigation cannot publish any read record");
    bodies.delete(targetPath); clock++; port.invalidate(targetPath);
    const deleted = (await index.search({ query: "REAL_ANCHOR_TOKEN", limit: 1 })).hits[0].related!.items[0];
    assert.equal(deleted.status, "unresolved"); assert.equal(deleted.target, undefined);
    bodies.set(sourcePath, "# Source\nOrdinary link [[Other]] and `[[Target#Fake]]` code."); port.invalidate(sourcePath);
    const plain = await port.read({ vaultRelativePath: sourcePath });
    const beforePlainRead = reads;
    assert.equal((await retriever.readAgentIndex({ vaultRelativePath: sourcePath, expectedContentRevision: plain.contentRevision })).related, undefined);
    assert.equal(reads - beforePlainRead, 1, "ordinary wiki links and code examples do not trigger a redundant source read");
  } finally { port.dispose(); }
  console.log("Public Vault anchors: ordinary search/preflight/tool delivery, fresh target SHA, strict unread storage, private boundaries, async scope/source guards and cancellation PASS");
}

export async function runVaultBodySearchOutlineTests(): Promise<void> {
  const sourcePath = "notes/guide.md";
  const content = ["# Guide", "OUTLINE_DEV_TOKEN is the delivered claim.", ...Array.from({ length: 25 }, () => "Background."),
    "## Details", "UNREAD_BODY_SENTINEL is outside the delivered passage.", "### Conditions", ...Array.from({ length: 12 }, () => "Unrelated background.")].join("\n");
  const bodies = new Map([[sourcePath, content]]);
  let clock = 10;
  let reads = 0;
  const file = (path: string) => ({ path, basename: "guide", extension: "md", stat: { mtime: clock, ctime: 1, size: bodies.get(path)!.length } }) as TFile;
  const app = { vault: { getMarkdownFiles: () => [...bodies.keys()].map(file), getAbstractFileByPath: (path: string) => bodies.has(path) ? file(path) : null,
    read: async (source: TFile) => { reads++; return bodies.get(source.path)!; } },
  metadataCache: { getFileCache: () => ({ headings: [{ heading: "Stale fake", level: 1, position: { start: { line: 0 } } }] }) },
  workspace: { getActiveFile: () => null, getLastOpenFiles: () => [] } } as unknown as App;
  const port = new VaultBodySearch(app, () => emptyKnowledgeFolderBindings());
  const index = new KnowledgeAgentIndex({ vaultPath: "/synthetic-outline-search", storageRootPath: "/synthetic-outline-state", bodySearch: port });
  const retriever = new KnowledgeRetriever(index.vaultPath, { agentIndex: index });
  const production = createProductionPiKnowledgeRuntime({ vaultRootPath: index.vaultPath, knowledgeAgentIndex: index, knowledgePreferences: {} as never, usage: {} as never });
  try {
    const search = await index.search({ query: "OUTLINE_DEV_TOKEN" });
    assert.equal(reads, 1, "search navigation adds no second body read");
    const hit = search.hits[0];
    assert.deepEqual(hit.outline!.entries.map(entry => entry.heading), ["Guide", "Details", "Conditions"]);
    const retrieval = await retriever.retrieve({ question: "OUTLINE_DEV_TOKEN" });
    const reference = retrieval.references[0];
    assert.deepEqual(reference.outline, hit.outline);
    assert.equal(reference.lineEnd, hit.lineEnd);
    assert.ok(reference.lineEnd < reference.outline!.entries[0].lineEnd);
    assert.equal((await retriever.verifyReferences([reference])).status, "valid");
    assert.deepEqual(knowledgeReferenceEntryDetails([reference]).references[0].outline, hit.outline);
    const chat = await production.retrieveChat!({ question: "OUTLINE_DEV_TOKEN", explicitPaths: [], includeUnrefined: false } as never);
    assert.deepEqual(JSON.parse(chat.providerResourceText).sources[0].outline, chat.references[0].outline);
    assert.equal(chat.references[0].referenceId, reference.referenceId);
    assert.doesNotMatch(chat.providerResourceText, /UNREAD_BODY_SENTINEL/u);
    const captured: import("../knowledge-base/types").KnowledgeReference[] = [];
    const security = new PiKnowledgeReadToolSecurity({ currentRunIdentity: () => ({ vaultId: "outline-v", conversationId: "outline-c", piSessionId: "outline-s", productRunId: "outline-r" }),
      currentWorkflow: () => "chat", onSourceRead: (item, fingerprint) => { captured.push(item); assert.equal(fingerprint, undefined); }, egress: new EchoInkVaultToolEgressPolicy() });
    const tools = createPiKnowledgeReadToolDefinitions({ retriever, security });
    const input = { query: "OUTLINE_DEV_TOKEN", limit: 1 };
    await security.handleToolCall({ toolName: "knowledge_search", toolCallId: "outline-search", input } as never, undefined);
    await tools[0].execute("outline-search", input, undefined, undefined);
    const tool = await security.handleToolResult({ toolName: "knowledge_search", toolCallId: "outline-search", isError: false } as never);
    assert.equal(tool.isError, false);
    const delivered = JSON.parse(tool.content[0].text).hits[0];
    assert.deepEqual(delivered.outline, captured[0].outline);
    assert.deepEqual((tool.details.references as typeof captured)[0].outline, delivered.outline);
    assert.equal(captured[0].lineEnd, reference.lineEnd, "onSourceRead records only excerpt lines, never the outline's document-wide range");
    assert.equal(captured[0].referenceId, reference.referenceId);
    for (const outline of [undefined, null, { ...hit.outline, schemaVersion: 2 }, { ...hit.outline, readStatus: "read" }, { ...hit.outline, contentRevision: "stale" },
      { ...hit.outline, entries: [] }, { ...hit.outline, extra: true }, { ...hit.outline, entries: [{ ...hit.outline!.entries[0], level: 0 }] },
      { ...hit.outline, entries: [{ ...hit.outline!.entries[0], lineEnd: reference.totalLines! + 1 }] }]) {
      assert.throws(() => knowledgeReferenceEntryDetails([{ ...reference, outline } as never]), /outline 无效/u);
    }
    const forged = { ...reference, outline: { ...reference.outline!, entries: reference.outline!.entries.map((entry, index) => index ? entry : { ...entry, heading: "Forged heading" }) } };
    assert.equal((await retriever.verifyReferences([forged])).status, "source_changed");
    const { outline: _outline, ...legacy } = reference;
    assert.equal(Object.hasOwn(knowledgeReferenceEntryDetails([legacy]).references[0], "outline"), false);
    bodies.set(sourcePath, content.replace("## Details", "## Revised details")); clock++; port.invalidate(sourcePath);
    assert.equal((await retriever.verifyReferences([reference])).status, "source_changed");
    const revised = (await index.search({ query: "OUTLINE_DEV_TOKEN" })).hits[0];
    assert.notEqual(revised.outline!.contentRevision, reference.contentRevision);
    assert.ok(revised.outline!.entries.some(entry => entry.heading === "Revised details"));

    const budgetContent = ["# Guide", `BUDGET_NAV_TOKEN ${"文".repeat(5000)}`, ...Array.from({ length: 5 }, (_, index) => `## ${index}${"目录标题".repeat(65)}\nDetails.`), ...Array.from({ length: 120 }, () => "Background.")].join("\n");
    bodies.set(sourcePath, budgetContent); clock++; port.invalidate(sourcePath);
    const raw = await searchBodyDocuments({ documents: [{ vaultRelativePath: sourcePath, title: "guide", kind: "notes", recordedAt: clock, read: () => port.read({ vaultRelativePath: sourcePath }) }], request: { query: "BUDGET_NAV_TOKEN" } });
    const budget = (await index.search({ query: "BUDGET_NAV_TOKEN" })).hits[0];
    const { outline: fittedOutline, ...body } = budget;
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
    assert.ok(bytes([body]) < 10_000 && bytes([{ ...body, outline: raw.hits[0].outline }]) > 10_000, "the fixture crosses the real Vault cap only when its full outline is added");
    assert.ok(bytes([budget]) <= 10_000);
    assert.equal(budget.excerpt, raw.hits[0].excerpt);
    assert.ok(!fittedOutline || fittedOutline.entries.length < raw.hits[0].outline!.entries.length);
  } finally { port.dispose(); }
  console.log("Public Vault outlines: preflight/tool/storage parity, excerpt-only read accounting, strict validation, revision changes and 10KB body preservation PASS");
}

export async function runVaultBodySearchMetadataTests(): Promise<void> {
  const paragraph = "Keep the amber filter in the upper drawer.\nCheck the spare lens before departure.";
  const bodies = new Map([
    ["notes/Field kit.md", `---\naliases: [Copper Beacon]\ntags: [reserve-batch]\n---\n\n# Field kit\n\n${paragraph}\n\n## Archive\nThe earlier packing list is obsolete.`]
  ]);
  const file = (path: string) => ({ path, basename: "Field kit", extension: "md", stat: { mtime: 20, ctime: 1, size: bodies.get(path)!.length } }) as TFile;
  const app = { vault: {
    getMarkdownFiles: () => [...bodies.keys()].map(file),
    getAbstractFileByPath: (path: string) => bodies.has(path) ? file(path) : null,
    read: async (source: TFile) => bodies.get(source.path)!
  }, metadataCache: { getFileCache: () => ({ frontmatter: { aliases: ["Copper Beacon"], tags: ["reserve-batch"] } }) },
  workspace: { getActiveFile: () => null, getLastOpenFiles: () => [] } } as unknown as App;
  const port = new VaultBodySearch(app, () => emptyKnowledgeFolderBindings());
  const index = new KnowledgeAgentIndex({ vaultPath: "/synthetic-metadata-search", storageRootPath: "/synthetic-metadata-state", bodySearch: port });
  const retriever = new KnowledgeRetriever(index.vaultPath, { agentIndex: index });
  const production = createProductionPiKnowledgeRuntime({ vaultRootPath: index.vaultPath, knowledgeAgentIndex: index, knowledgePreferences: {} as never, usage: {} as never });
  try {
    for (const [query, source] of [["Field kit", "title"], ["Copper Beacon", "alias"], ["reserve-batch", "tag"]] as const) {
      const search = await index.search({ query, limit: 1 });
      assert.equal(search.hits[0].excerpt, paragraph);
      assert.equal(search.hits[0].lineStart, 8);
      assert.equal(search.hits[0].lineEnd, 9);
      assert.deepEqual(search.hits[0].matchSources, [source]);
      const retrieval = await retriever.retrieve({ question: query, limit: 1 });
      assert.equal(retrieval.references.length, 1);
      assert.equal(retrieval.references[0].excerpt, paragraph);
      assert.deepEqual(retrieval.references[0].matchSources, [source]);
      assert.equal((await retriever.verifyReferences(retrieval.references)).status, "valid");
      const reference = retrieval.references[0];
      const recorded = knowledgeReferenceEntryDetails([reference]).references[0];
      assert.deepEqual(recorded.matchSources, [source]);
      assert.equal(recorded.referenceId, reference.referenceId, "provenance does not change body-range identity");
      const { matchSources: _matchSources, ...legacy } = reference;
      assert.equal(Object.hasOwn(knowledgeReferenceEntryDetails([legacy]).references[0], "matchSources"), false, "legacy references remain valid without provenance");
      for (const matchSources of [[], ["body", "alias", "title", "tag", "alias"]] as const) {
        const normalized = knowledgeReferenceEntryDetails([{ ...reference, matchSources }]).references[0];
        assert.deepEqual(normalized.matchSources, matchSources, "valid provenance arrays retain their original order and entries");
        assert.equal(Object.isFrozen(normalized.matchSources), true);
      }
      for (const matchSources of ["title", null, undefined, ["unknown"], ["body", 1], ["Alias"], new Array(1)]) {
        assert.throws(() => knowledgeReferenceEntryDetails([{ ...reference, matchSources } as never]), /matchSources 无效/u);
      }
      const result = await production.retrieveChat!({ question: query, explicitPaths: [], includeUnrefined: false } as never);
      const delivered = JSON.parse(result.providerResourceText).sources[0];
      assert.equal(delivered.excerpt, paragraph);
      assert.equal(delivered.lineStart, 8);
      assert.deepEqual(delivered.matchSources, [source], "production preflight JSON retains the actual matching field");
      assert.equal(delivered.contentRevision, retrieval.references[0].contentRevision);
    }
  } finally { port.dispose(); }
  console.log("Public Vault metadata evidence: verified search/preflight JSON, strict provenance storage and legacy compatibility PASS");
}

export async function runVaultBodySearchReferenceTests(): Promise<void> {
  const bindings = emptyKnowledgeFolderBindings();
  for (const role of ["wiki", "projects", "journal"] as const) {
    bindings.roles[role].enabled = role !== "projects";
    bindings.roles[role].readPaths = [role];
  }
  const currentPath = "notes/current.md";
  const recentPath = "notes/recent.md";
  const bodies = new Map([
    [currentPath, "---\nstatus: draft\n---\n# Current source\n\nUse a silver label on the current crate."],
    [recentPath, "# Recent source\nUse a violet label on the recent crate."],
    ["notes/target-a.md", "# Target A\nQUARTZ_TARGET first independent evidence."],
    ["notes/target-b.md", "# Target B\nQUARTZ_TARGET second independent evidence."],
    ["notes/other-actions.md", "# Other actions\n这种方法的下一步安排是先检查封套。"],
    ["wiki/这篇材料.md", "# 这篇材料\n\nCheck the spare paper count.\n\n## Appendix\nReview the packing sheet."],
    ["wiki/guide.md", "# Guide\nThe guide requires an amber label."],
    ["journal/2026-08-01.md", "# Old journal\nThe older entry requires a brown label."],
    ["journal/2026-09-03.md", "# Current journal\nThe newer entry requires a blue label."],
    ["private/secret.md", "PRIVATE_REFERENCE_SECRET"], ["projects/disabled.md", "DISABLED_REFERENCE_SECRET"], [".hidden/secret.md", "HIDDEN_REFERENCE_SECRET"]
  ]);
  let activePath: string | undefined = currentPath;
  let recentPaths = [recentPath];
  const reads: string[] = [];
  const file = (path: string) => ({ path, basename: path.split("/").at(-1)!.replace(/\.md$/u, ""), extension: "md", stat: { mtime: 10, ctime: 1, size: bodies.get(path)?.length ?? 0 } }) as TFile;
  const app = { vault: {
    getMarkdownFiles: () => [...bodies.keys()].map(file),
    getAbstractFileByPath: (path: string) => bodies.has(path) ? file(path) : null,
    read: async (source: TFile) => { reads.push(source.path); return bodies.get(source.path)!; }
  }, metadataCache: { getFileCache: () => null }, workspace: { getActiveFile: () => activePath ? file(activePath) : null, getLastOpenFiles: () => recentPaths } } as unknown as App;
  const port = new VaultBodySearch(app, () => bindings, { excludedRoots: () => ["private"] });
  const index = new KnowledgeAgentIndex({ vaultPath: "/synthetic-reference-search", storageRootPath: "/synthetic-reference-state", bodySearch: port });
  const retriever = new KnowledgeRetriever(index.vaultPath, { agentIndex: index });
  const production = createProductionPiKnowledgeRuntime({ vaultRootPath: index.vaultPath, knowledgeAgentIndex: index, knowledgePreferences: {} as never, usage: {} as never });
  try {
    const query = "这篇的重点是什么？";
    const retrieval = await retriever.retrieve({ question: query, limit: 1 });
    const reference = retrieval.references[0];
    assert.equal(reference.vaultRelativePath, currentPath);
    assert.equal(reference.excerpt, "Use a silver label on the current crate.");
    assert.equal(reference.inclusionReason, "按指代带入");
    assert.equal(reference.matchSources, undefined);
    assert.equal((await retriever.verifyReferences([reference])).status, "valid");
    const stored = knowledgeReferenceEntryDetails([reference]).references[0];
    assert.equal(stored.inclusionReason, "按指代带入");
    assert.equal(stored.referenceId, reference.referenceId);
    const { inclusionReason: _reason, ...legacy } = reference;
    assert.equal(Object.hasOwn(knowledgeReferenceEntryDetails([legacy]).references[0], "inclusionReason"), false);
    for (const inclusionReason of [null, undefined, "body", "", ["按指代带入"]]) {
      assert.throws(() => knowledgeReferenceEntryDetails([{ ...reference, inclusionReason } as never]), /inclusionReason 无效/u);
    }
    const chat = await production.retrieveChat!({ question: query, explicitPaths: [], includeUnrefined: false } as never);
    const delivered = JSON.parse(chat.providerResourceText).sources[0];
    assert.equal(delivered.inclusionReason, "按指代带入");
    assert.equal(delivered.matchSources, undefined);
    assert.equal(delivered.contentRevision, reference.contentRevision);

    const singleQuestion = "当前这篇里，下一步安排是什么？";
    const single = await production.retrieveChat!({ question: singleQuestion, explicitPaths: [], includeUnrefined: false } as never);
    assert.deepEqual([...new Set(JSON.parse(single.providerResourceText).sources.map((source: { vaultRelativePath: string }) => source.vaultRelativePath))], [currentPath], "a current-note question cannot receive another note's action plan");
    const exact = await index.search({ query: "这篇材料", limit: 1 });
    assert.equal(exact.hits[0].vaultRelativePath, "wiki/这篇材料.md");
    assert.equal(exact.hits[0].inclusionReason, undefined);
    assert.ok(exact.continuationCursor);
    activePath = recentPath; recentPaths = [currentPath];
    const exactNext = await index.search({ query: "这篇材料", limit: 1, cursor: exact.continuationCursor });
    assert.equal(exactNext.hits[0].vaultRelativePath, "wiki/这篇材料.md", "exact-name pagination does not bind unrelated browsing context");
    assert.equal(exactNext.hits[0].inclusionReason, undefined);

    activePath = undefined;
    recentPaths = [recentPath];
    assert.equal((await index.search({ query })).hits[0].vaultRelativePath, recentPath);
    const recentSingle = await index.search({ query: "刚才那篇里面，下一步安排是什么？" });
    assert.deepEqual([...new Set(recentSingle.hits.map(hit => hit.vaultRelativePath))], [recentPath]);
    for (const crossQuestion of ["刚才那篇讲的方法我在别处还用过吗？", "刚才那篇讲的方法在其他地方还用过吗？"]) {
      const cross = await index.search({ query: crossQuestion });
      assert.equal(cross.hits[0].vaultRelativePath, recentPath);
      assert.ok(cross.hits.some(hit => hit.vaultRelativePath === "notes/other-actions.md"), "an explicit elsewhere question keeps cross-source retrieval");
    }
    for (const unavailable of ["private/secret.md", ".hidden/secret.md", "projects/disabled.md", "notes/deleted.md", "../outside.md"]) {
      activePath = unavailable;
      recentPaths = [unavailable, "private/secret.md", "projects/disabled.md", recentPath, currentPath];
      const result = await index.search({ query });
      assert.equal(result.hits[0].vaultRelativePath, recentPath);
      assert.equal(result.hits.some(hit => hit.vaultRelativePath === unavailable), false);
    }
    assert.equal(reads.some(path => path.startsWith("private/") || path.startsWith(".hidden/") || path.startsWith("projects/")), false);
    activePath = currentPath; recentPaths = [recentPath, "wiki/guide.md"];
    assert.equal((await index.search({ query, excludePaths: [currentPath] })).hits[0].vaultRelativePath, recentPath);
    assert.equal((await index.search({ query, kinds: ["wiki"] })).hits[0].vaultRelativePath, "wiki/guide.md");
    activePath = "journal/2026-08-01.md"; recentPaths = [activePath, "journal/2026-09-03.md"];
    assert.equal((await index.search({ query, kinds: ["journal"], dateFrom: "2026-09-01", dateTo: "2026-09-30" })).hits[0].vaultRelativePath, "journal/2026-09-03.md");

    activePath = currentPath; recentPaths = [recentPath];
    const page = await index.search({ query: "这篇提到的 QUARTZ_TARGET 在别处还有吗？", limit: 1 });
    assert.equal(page.hits[0].vaultRelativePath, currentPath);
    assert.ok(page.continuationCursor);
    const next = await index.search({ query: "这篇提到的 QUARTZ_TARGET 在别处还有吗？", limit: 1, cursor: page.continuationCursor });
    assert.equal(next.hits[0].inclusionReason, undefined);
    activePath = recentPath;
    await assert.rejects(() => index.search({ query: "这篇提到的 QUARTZ_TARGET 在别处还有吗？", limit: 1, cursor: page.continuationCursor }), { code: "cursor_stale" });
    const ordinary = await index.search({ query: "QUARTZ_TARGET", limit: 1 });
    assert.ok(ordinary.continuationCursor);
    activePath = currentPath; recentPaths = [currentPath, recentPath];
    const ordinaryNext = await index.search({ query: "QUARTZ_TARGET", limit: 1, cursor: ordinary.continuationCursor });
    assert.equal(ordinaryNext.hits[0].inclusionReason, undefined, "ordinary cursors do not depend on unrelated browsing changes");
    bodies.delete(currentPath);
    assert.equal((await index.search({ query })).hits[0].vaultRelativePath, recentPath, "deleted current sources cannot be directly included");
  } finally { port.dispose(); }
  console.log("Public Vault explicit references: verified preflight/storage, private/disabled/deleted scope, kind/date/exclusions and context-aware cursors PASS");
}

export async function runVaultBodySearchTests(): Promise<void> {
  const bindings = emptyKnowledgeFolderBindings();
  for (const [role, folder] of [["wiki", "知识"], ["journal", "日记"], ["templates", "模板"], ["projects", "项目"]] as const) {
    bindings.roles[role].enabled = true; bindings.roles[role].readPaths = [folder];
  }
  const bodies = new Map([
    ["随手记/想法.md", `# 开头\n${"无关背景\n".repeat(130)}\n## 发布计划\n版本2.6.2采用纸飞机方案。\n不要向外部发布。\n---\n<source>原文边界</source>`],
    ["日记/2026-09-20.md", "# 记录\n莫干山徒步路线先去云桥。"],
    ["模板/模版.md", "纸飞机方案"], [".echoink/private.md", "纸飞机方案"],
    ["项目/决定.md", "# 决定\n纸飞机方案"]
  ]);
  const events = new EventEmitter();
  let clock = 10;
  const file = (path: string) => ({ path, basename: path.split("/").at(-1)!.replace(/\.md$/u, ""), extension: "md", stat: { mtime: clock, ctime: 1, size: bodies.get(path)?.length ?? 0 } }) as TFile;
  const app = { vault: {
    getMarkdownFiles: () => [...bodies.keys()].map(file),
    getAbstractFileByPath: (path: string) => bodies.has(path) ? file(path) : null,
    read: async (source: TFile) => { if (!bodies.has(source.path)) throw new Error("gone"); return bodies.get(source.path)!; },
    on: (name: string, callback: (...args: unknown[]) => void) => { events.on(name, callback); return { name, callback }; },
    offref: ({ name, callback }: { name: string; callback: (...args: unknown[]) => void }) => events.off(name, callback)
  }, metadataCache: { getFileCache: () => null }, workspace: { getActiveFile: () => null, getLastOpenFiles: () => [] } } as unknown as App;
  const port = new VaultBodySearch(app, () => bindings);
  const index = new KnowledgeAgentIndex({ vaultPath: "/synthetic-body-search", storageRootPath: "/synthetic-state", bodySearch: port });
  index.refresh = async () => { throw new Error("Question retrieval must not wait for the maintenance index"); };
  const unbind = bindKnowledgeIndexToVault(app, index);
  try {
    const result = await index.search({ query: "2.6.2 纸飞机方案", limit: 1 });
    assert.equal(result.hits[0].kind, "notes");
    assert(result.hits[0].lineStart! > 120);
    assert.equal(result.coverage?.totalFiles, 3);
    const retriever = new KnowledgeRetriever(index.vaultPath, { agentIndex: index });
    const preflight = await retriever.retrieve({ question: "2.6.2 纸飞机方案", limit: 1 });
    assert.equal(preflight.references[0].lineStart, result.hits[0].lineStart);
    assert.equal(preflight.references[0].sourceType, "notes");
    assert.equal((await retriever.verifyReferences(preflight.references)).status, "valid");
    const resource = JSON.parse(formatKnowledgeReferencesForPrompt(preflight.references));
    assert.equal(resource.sources[0].excerpt, preflight.references[0].excerpt);
    const boundaryText = "---\n<source>原文边界</source>";
    assert.equal(JSON.parse(formatKnowledgeReferencesForPrompt([{ ...preflight.references[0], excerpt: boundaryText }])).sources[0].excerpt, boundaryText);
    const production = createProductionPiKnowledgeRuntime({ vaultRootPath: index.vaultPath, knowledgeAgentIndex: index, knowledgePreferences: {} as never, usage: {} as never });
    const chat = await production.retrieveChat!({ question: "2.6.2 纸飞机方案", explicitPaths: [], includeUnrefined: false } as never);
    assert.equal(JSON.parse(chat.providerResourceText).sources[0].sourceType, "notes");
    assert.equal(chat.retrieval.coverage?.scannedFiles, 0);
    assert.equal(chat.retrieval.coverage?.cachedFiles, 3);
    assert.equal(chat.retrieval.coverage?.indexedFiles, 3);
    bindings.roles.journal.searchEnabled = false;
    assert.equal((await index.search({ query: "莫干山" })).hits.length, 0);
    await assert.rejects(() => retriever.readAgentIndex({ vaultRelativePath: "日记/2026-09-20.md" }));
    bindings.roles.projects.enabled = false;
    assert.equal(knowledgeSearchPathKind("项目/决定.md", bindings), null);
    assert.equal(knowledgeSearchPathKind("模板/模版.md", bindings), null);
    assert.equal(knowledgeSearchPathKind(".echoink/private.md", bindings), null);
    assert.equal(knowledgeSearchPathKind("私有/记忆.md", bindings, ["私有"]), null);
    const recent = await index.search({ mode: "recent" });
    assert(recent.hits.every(hit => hit.kind === "notes"));
    assert.equal(recent.hits.some(hit => hit.vaultRelativePath.startsWith("项目/") || hit.vaultRelativePath.startsWith("日记/")), false);
    bodies.set("随手记/单行.md", "甲".repeat(60_000) + "UNIQUE_MIDDLE_TARGET" + "乙".repeat(60_000));
    clock++; events.emit("create", file("随手记/单行.md"));
    const bounded = await retriever.retrieve({ question: "UNIQUE_MIDDLE_TARGET" });
    assert.equal(bounded.references.length, 1);
    const span = bounded.references[0];
    assert(span.excerpt.length <= 3200 && span.excerpt.includes("UNIQUE_MIDDLE_TARGET"));
    assert(span.columnStart! > 0 && span.columnEnd! > span.columnStart!);
    assert.equal((await retriever.verifyReferences([span])).status, "valid", "unchanged bounded single-line evidence verifies against its columns");
    assert.equal(knowledgeReferenceEntryDetails([span]).references[0].columnStart, span.columnStart);
    const boundedChat = await production.retrieveChat!({ question: "UNIQUE_MIDDLE_TARGET", explicitPaths: [], includeUnrefined: false } as never);
    assert.equal(boundedChat.references.length, 1, "bounded source survives the production resource budget");
    const captured: import("../harness/pi-native/contracts").PiKnowledgeReference[] = [];
    const security = new PiKnowledgeReadToolSecurity({ currentRunIdentity: () => ({ vaultId: "v", conversationId: "c", piSessionId: "s", productRunId: "r" }), currentWorkflow: () => "chat", onSourceRead: reference => captured.push(reference), egress: new EchoInkVaultToolEgressPolicy() });
    const tools = createPiKnowledgeReadToolDefinitions({ retriever, security });
    const searchInput = { query: "UNIQUE_MIDDLE_TARGET", limit: 1 };
    await security.handleToolCall({ toolName: "knowledge_search", toolCallId: "bounded-search", input: searchInput } as never, undefined);
    await tools[0].execute("bounded-search", searchInput, undefined, undefined);
    const secured = await security.handleToolResult({ toolName: "knowledge_search", toolCallId: "bounded-search", isError: false } as never);
    assert.equal(secured.isError, false); assert.equal(captured.length, 1);
    assert.equal(captured[0].columnStart, span.columnStart);
    assert.equal((await retriever.verifyReferences(captured.map(reference => ({ ...reference })))).status, "valid");
    const readInput = { vaultRelativePath: span.vaultRelativePath, expectedContentRevision: span.contentRevision, lineStart: span.lineStart, lineCount: 1, columnStart: span.columnStart, columnEnd: span.columnEnd };
    await security.handleToolCall({ toolName: "knowledge_read", toolCallId: "bounded-read", input: readInput } as never, undefined);
    await tools[1].execute("bounded-read", readInput, undefined, undefined);
    const readResult = await security.handleToolResult({ toolName: "knowledge_read", toolCallId: "bounded-read", isError: false } as never);
    assert.equal(readResult.isError, false); assert.equal(captured[1].excerpt, span.excerpt);
    assert.equal(captured[1].referenceId, span.referenceId);
    bodies.set("随手记/完好.md", "# 完好\nLOCAL_FAILURE_QUERY仍可交付。");
    bodies.set("随手记/消失.md", "# 消失\nLOCAL_FAILURE_QUERY删除后不交付。");
    const originalSearch = port.search.bind(port);
    port.search = async request => { const found = await originalSearch(request); if (request.query === "LOCAL_FAILURE_QUERY") bodies.delete("随手记/消失.md"); return found; };
    const partial = await retriever.retrieve({ question: "LOCAL_FAILURE_QUERY" });
    assert(partial.references.some(reference => reference.vaultRelativePath === "随手记/完好.md"));
    assert(partial.localIssues?.some(issue => issue.vaultRelativePath === "随手记/消失.md" && issue.status === "not-found"));
    port.search = originalSearch;
    const old = preflight.references[0];
    bodies.set(old.vaultRelativePath, "# 新内容\nMUTATED_BODY_TOKEN"); clock++;
    events.emit("modify", file(old.vaultRelativePath));
    assert.equal((await retriever.verifyReferences([old])).status, "source_changed");
    await assert.rejects(() => index.search({ query: "2.6.2 纸飞机方案", cursor: result.continuationCursor! }), /stale/u);
    assert.equal((await index.search({ query: "MUTATED_BODY_TOKEN" })).hits.length, 1);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(() => index.search({ query: "any", signal: controller.signal }), { name: "AbortError" });
    await assert.rejects(() => production.retrieveChat!({ question: "any", explicitPaths: [], includeUnrefined: false, signal: controller.signal } as never), { name: "AbortError" });
    await assert.rejects(() => index.related({ vaultRelativePath: "项目/决定.md" }), /outside the search scope/u);
    const graph = index as unknown as { current: unknown; relations: Map<string, unknown[]>; ensureFresh(): Promise<void>; relationPage(path: string, limit: number): Promise<{ items: unknown[] }> };
    graph.current = { generation: 1, entries: { "知识/允许.md": { contentRevision: span.contentRevision } } };
    graph.ensureFresh = async () => {};
    graph.relations = new Map([["知识/允许.md", [{ direction: "outgoing", source: { vaultRelativePath: "知识/允许.md" }, target: { vaultRelativePath: "项目/决定.md" }, status: "available" }]]]);
    assert.equal((await graph.relationPage("知识/允许.md", 8)).items.length, 0, "related targets obey the same disabled scope");
  } finally { unbind(); }
  console.log("Public Vault body search, scope, delivery, events and freshness: PASS");
}

export async function runVaultBodySearchCacheTests(): Promise<void> {
  const bindings = emptyKnowledgeFolderBindings();
  bindings.roles.projects.enabled = true; bindings.roles.projects.readPaths = ["项目"];
  bindings.roles.templates.enabled = true; bindings.roles.templates.readPaths = ["模板"];
  bindings.roles.work.enabled = false; bindings.roles.work.readPaths = ["禁用"];
  const bodies = new Map([["普通/A.md", "# A\nCACHE_ALPHA"], ["项目/B.md", "# B\nCACHE_ALPHA"],
    ["私有/Memory.md", "private"], ["模板/T.md", "template"], ["禁用/W.md", "disabled"]]);
  const metadata = new Map<string, unknown>();
  const vaultEvents = new EventEmitter(), metadataEvents = new EventEmitter();
  let reads = 0;
  const failed = new Set<string>();
  let pause: (() => Promise<void>) | undefined;
  const file = (path: string) => ({ path, basename: path.split("/").at(-1)!.slice(0, -3), extension: "md", stat: { mtime: 1, size: bodies.get(path)?.length ?? 0 } }) as TFile;
  const hostEvents = (events: EventEmitter) => ({
    on: (name: string, callback: (...args: unknown[]) => void) => { events.on(name, callback); return { name, callback }; },
    offref: ({ name, callback }: { name: string; callback: (...args: unknown[]) => void }) => { events.off(name, callback); }
  });
  const app = { vault: { ...hostEvents(vaultEvents), getMarkdownFiles: () => [...bodies.keys()].map(file),
    getAbstractFileByPath: (path: string) => bodies.has(path) ? file(path) : null,
    read: async (source: TFile) => { reads++; await pause?.(); if (failed.has(source.path) || !bodies.has(source.path)) throw new Error("unreadable"); return bodies.get(source.path)!; }
  }, metadataCache: { ...hostEvents(metadataEvents), getFileCache: (source: TFile) => metadata.get(source.path) ?? null },
  workspace: { getActiveFile: () => null, getLastOpenFiles: () => [] } } as unknown as App;
  const port = new VaultBodySearch(app, () => bindings, { excludedRoots: () => ["私有"] });
  const index = new KnowledgeAgentIndex({ vaultPath: "/synthetic-cache", storageRootPath: "/synthetic-cache-state", bodySearch: port });
  const release = bindKnowledgeIndexToVault(app, index);
  try {
    const cold = await index.search({ query: "CACHE_ALPHA", limit: 1 });
    assert.deepEqual(cold.coverage, { totalFiles: 2, scannedFiles: 2, readFiles: 2, cachedFiles: 0, indexedFiles: 2, failedFiles: 0, complete: true, unknownJournalDates: 0 });
    const warm = await index.search({ query: "CACHE_ALPHA", limit: 1 });
    assert.deepEqual(warm.hits, cold.hits);
    assert.equal(warm.coverage?.readFiles, 0); assert.equal(warm.coverage?.cachedFiles, 2); assert.equal(reads, 2);
    const another = await index.search({ query: "CACHE_OTHER" });
    assert.equal(another.coverage?.cachedFiles, 2); assert.equal(reads, 2, "different query reuses full statistics");
    // Production subscriptions must ignore paths outside this search authority.
    port.invalidate("普通/A.md");
    let scanEntered!: () => void, scanResume!: () => void;
    const scanStarted = new Promise<void>(resolve => { scanEntered = resolve; });
    const scanGate = new Promise<void>(resolve => { scanResume = resolve; });
    pause = async () => { scanEntered(); await scanGate; };
    const liveSearch = index.search({ query: "CACHE_ALPHA", limit: 1 });
    await scanStarted;
    for (const path of ["私有/Memory.md", "模板/T.md", "禁用/W.md", ".cache/hidden.md"]) {
      vaultEvents.emit("modify", file(path)); metadataEvents.emit("changed", file(path));
    }
    vaultEvents.emit("rename", { path: "私有", children: [] }, ".private-old");
    scanResume();
    const unaffected = await liveSearch;
    assert.equal(unaffected.coverage?.complete, true, "an unrelated event cannot fail a fresh query with no cursor");
    pause = undefined;
    vaultEvents.emit("create", file("模板/T.md"));
    vaultEvents.emit("delete", file("私有/Memory.md"));
    assert.equal((await index.search({ query: "CACHE_ALPHA", limit: 1, cursor: unaffected.continuationCursor })).returned, 1, "an old cursor remains valid across excluded events");
    let readEntered!: () => void, readResume!: () => void;
    const readStarted = new Promise<void>(resolve => { readEntered = resolve; });
    const readGate = new Promise<void>(resolve => { readResume = resolve; });
    pause = async () => { readEntered(); await readGate; };
    const reading = port.read({ vaultRelativePath: "普通/A.md" });
    await readStarted; vaultEvents.emit("modify", file("项目/B.md")); readResume();
    assert.equal((await reading).content, bodies.get("普通/A.md"), "another searchable source changing does not invalidate this source read");
    pause = undefined;
    await index.search({ query: "CACHE_ALPHA" });
    // Same mtime and same length: the production modify event is the freshness authority.
    bodies.set("普通/A.md", "# A\nCACHE_OMEGA"); vaultEvents.emit("modify", file("普通/A.md"));
    const modified = await index.search({ query: "CACHE_OMEGA" });
    assert.equal(modified.hits[0].vaultRelativePath, "普通/A.md"); assert.equal(modified.coverage?.readFiles, 1); assert.equal(modified.coverage?.cachedFiles, 1);
    await assert.rejects(() => port.read({ vaultRelativePath: cold.hits[0].vaultRelativePath, expectedContentRevision: cold.hits[0].contentRevision }), /changed/u);
    await assert.rejects(() => index.search({ query: "CACHE_ALPHA", cursor: cold.continuationCursor! }), /stale/u);
    const metadataQuery = { queries: ["CACHE_ALPHA", "CACHE_OMEGA"], limit: 1 };
    const beforeMetadata = await index.search(metadataQuery);
    metadata.set("普通/A.md", { frontmatter: { aliases: ["星河计划"], tags: ["观察"] } });
    metadataEvents.emit("changed", file("普通/A.md"));
    const alias = await index.search({ query: "星河计划" });
    assert.equal(alias.hits[0].vaultRelativePath, "普通/A.md"); assert.equal(alias.coverage?.readFiles, 2, "dictionary changes rebuild affected tokenization view");
    await assert.rejects(() => index.search({ ...metadataQuery, cursor: beforeMetadata.continuationCursor! }), /stale/u);
    // Fresh metadata enumeration also catches a missed metadata notification.
    metadata.set("普通/A.md", { frontmatter: { aliases: ["月海计划"] } });
    assert.equal((await index.search({ query: "月海计划" })).hits[0].vaultRelativePath, "普通/A.md");
    bodies.set("普通/C.md", "# C\nCREATED_TOKEN"); vaultEvents.emit("create", file("普通/C.md"));
    assert.equal((await index.search({ query: "CREATED_TOKEN" })).hits[0].vaultRelativePath, "普通/C.md");
    bodies.set("普通/D.md", bodies.get("普通/C.md")!); bodies.delete("普通/C.md"); vaultEvents.emit("rename", file("普通/D.md"), "普通/C.md");
    assert.equal((await index.search({ query: "CREATED_TOKEN" })).hits[0].vaultRelativePath, "普通/D.md");
    bodies.set("新目录/D.md", bodies.get("普通/D.md")!); bodies.delete("普通/D.md"); vaultEvents.emit("rename", { path: "新目录", children: [] }, "普通");
    assert.equal((await index.search({ query: "CREATED_TOKEN" })).hits[0].vaultRelativePath, "新目录/D.md");
    bodies.delete("新目录/D.md"); vaultEvents.emit("delete", file("新目录/D.md"));
    assert.equal((await index.search({ query: "CREATED_TOKEN" })).hits.length, 0);
    bindings.roles.projects.searchEnabled = false;
    assert.equal((await index.search({ query: "CACHE_ALPHA" })).hits.length, 0);
    bindings.roles.projects.searchEnabled = true;
    assert.equal((await index.search({ query: "CACHE_ALPHA" })).hits[0].vaultRelativePath, "项目/B.md");
    failed.add("项目/B.md"); vaultEvents.emit("modify", file("项目/B.md"));
    const partial = await index.search({ query: "CACHE_ALPHA" });
    assert.equal(partial.coverage?.complete, false); assert.equal(partial.coverage?.failedFiles, 1); assert.equal(partial.coverage?.indexedFiles, 1);
    failed.clear(); assert.equal((await index.search({ query: "CACHE_ALPHA" })).coverage?.readFiles, 1);
    const recent = await index.search({ mode: "recent", limit: 1 });
    assert.equal(recent.coverage?.readFiles, 1); assert.equal(recent.coverage?.cachedFiles, 0); assert.equal(recent.coverage?.indexedFiles, 1); assert.equal(recent.coverage?.complete, false);
    const recentEnd = await index.search({ mode: "recent", limit: 1, cursor: recent.continuationCursor });
    assert.equal(recentEnd.exhausted, true); assert.equal(recentEnd.coverage?.complete, false, "last page does not claim all bodies were read in this request");
    port.invalidate();
    let started!: () => void, resume!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    pause = async () => { started(); await gate; };
    const pending = index.search({ query: "CACHE_ALPHA" });
    await entered; bindings.roles.projects.searchEnabled = false; resume();
    await assert.rejects(pending, /scope changed/u);
    pause = undefined;
    assert.equal((await index.search({ query: "CACHE_ALPHA" })).hits.length, 0);
    release(); release();
    assert.equal(vaultEvents.listenerCount("modify"), 0); assert.equal(metadataEvents.listenerCount("changed"), 0);
    const before = reads;
    await assert.rejects(() => port.search({ query: "any" }), /disposed/u);
    await assert.rejects(() => port.read({ vaultRelativePath: "普通/A.md" }), /disposed/u);
    assert.equal(reads, before);
  } finally { release(); }
  console.log("Public Vault memory reuse, production events, scope, partial failure and disposal: PASS");
}

export async function runVaultBodySearchConcurrencyTests(): Promise<void> {
  const requests = [{ query: "alpha" }, { query: "beta", kinds: ["wiki"] as const }, { query: "gamma", kinds: ["journal"] as const }];
  for (const warm of [false, true]) {
    const bindings = emptyKnowledgeFolderBindings();
    bindings.roles.wiki.enabled = true; bindings.roles.wiki.readPaths = ["知识"];
    bindings.roles.journal.enabled = true; bindings.roles.journal.readPaths = ["日记"];
    const bodies = new Map([
      ["普通/陶艺安排.md", "# 陶艺\nalpha beta gamma"],
      ["知识/湿地观察.md", "# 湿地\nalpha beta gamma"],
      ["日记/2026-10-01.md", "# 日记\nalpha beta gamma"],
    ]);
    const metadata = new Map<string, unknown>();
    const vaultEvents = new EventEmitter(), metadataEvents = new EventEmitter();
    let eventCount = 0, activeReads = 0, maxActiveReads = 0;
    let pause: Promise<void> | undefined;
    const file = (relativePath: string) => ({ path: relativePath, basename: relativePath.split("/").at(-1)!.slice(0, -3), extension: "md", stat: { mtime: 1, size: bodies.get(relativePath)?.length ?? 0 } }) as TFile;
    const hostEvents = (events: EventEmitter) => ({
      on: (name: string, callback: (...args: unknown[]) => void) => { events.on(name, callback); return { name, callback }; },
      offref: ({ name, callback }: { name: string; callback: (...args: unknown[]) => void }) => { events.off(name, callback); },
    });
    const app = { vault: { ...hostEvents(vaultEvents), getMarkdownFiles: () => [...bodies.keys()].map(file),
      getAbstractFileByPath: (relativePath: string) => bodies.has(relativePath) ? file(relativePath) : null,
      read: async (source: TFile) => {
        const content = bodies.get(source.path)!;
        activeReads++; maxActiveReads = Math.max(maxActiveReads, activeReads);
        try { await pause; return content; } finally { activeReads--; }
      },
    }, metadataCache: { ...hostEvents(metadataEvents), getFileCache: (source: TFile) => metadata.get(source.path) ?? null } } as unknown as App;
    const baselinePort = new VaultBodySearch(app, () => bindings);
    const expected = [];
    for (const request of requests) expected.push(await baselinePort.search(request));
    baselinePort.dispose();
    const port = new VaultBodySearch(app, () => bindings);
    const index = new KnowledgeAgentIndex({ vaultPath: "/synthetic-concurrent", storageRootPath: "/synthetic-concurrent-state", bodySearch: port });
    const release = bindKnowledgeIndexToVault(app, index);
    const startTogether = async (input: typeof requests, signal?: AbortSignal) => {
      let resume!: () => void;
      pause = new Promise<void>(resolve => { resume = resolve; });
      maxActiveReads = 0;
      const pending = input.map((request, i) => index.search({ ...request, ...(i === 0 && signal ? { signal } : {}) }));
      // Observe blocked public reads, rather than inferring overlap from elapsed time.
      for (let turn = 0; turn < 10; turn++) await Promise.resolve();
      return { pending, resume: () => { pause = undefined; resume(); } };
    };
    try {
      if (warm) await index.search(requests[0]);
      const together = await startTogether(requests);
      assert.ok(maxActiveReads >= 2, "independent searches are not globally serialized");
      together.resume();
      const actual = await Promise.all(together.pending);
      actual.forEach((result, i) => {
        assert.deepEqual(result.hits, expected[i].hits);
        assert.equal(result.coverage?.complete, true);
      });
      assert.equal(eventCount, 0, "static synthetic data has no host events during cold/warm mixed-view searches");
      const page = await index.search({ query: "alpha", limit: 1 });
      assert.ok(page.continuationCursor);
      await Promise.all(requests.map(request => index.search(request)));
      assert.equal((await index.search({ query: "alpha", limit: 1, cursor: page.continuationCursor })).generation, page.generation, "internal cache replacement preserves old cursors");

      const cancel = new AbortController();
      port.invalidate();
      const cancelling = await startTogether(requests, cancel.signal);
      cancel.abort(); cancelling.resume();
      const cancelled = await Promise.allSettled(cancelling.pending);
      assert.equal(cancelled[0].status, "rejected");
      if (cancelled[0].status === "rejected") assert.equal(cancelled[0].reason.name, "AbortError");
      assert.equal(cancelled[1].status, "fulfilled"); assert.equal(cancelled[2].status, "fulfilled");

      for (const change of ["body", "metadata", "scope"] as const) {
        port.invalidate();
        const changing = await startTogether(requests);
        if (change === "body") {
          bodies.set("普通/陶艺安排.md", "# 陶艺\nomega beta gamma");
          eventCount++; vaultEvents.emit("modify", file("普通/陶艺安排.md"));
        } else if (change === "metadata") {
          metadata.set("知识/湿地观察.md", { frontmatter: { aliases: ["新湿地别名"] } });
          eventCount++; metadataEvents.emit("changed", file("知识/湿地观察.md"));
        } else bindings.roles.wiki.searchEnabled = false;
        changing.resume();
        const changed = await Promise.allSettled(changing.pending);
        assert.ok(changed.every(result => result.status === "rejected" && result.reason.code === "source_changed"), "real body/metadata/scope changes still reject old snapshots without silent retries");
      }
      await assert.rejects(index.search({ query: "alpha", cursor: page.continuationCursor }), { code: "cursor_stale" });
      assert.equal((await index.search({ query: "新湿地别名" })).hits.length, 0, "disabled sources stay excluded after concurrent changes");
    } finally { pause = undefined; release(); }
  }

  // The legacy relation index needs real files. Keep this owned synthetic fixture in
  // the worktree; no native Obsidian Vault or operating-system temp Vault is used.
  const temporaryRoot = path.join(process.cwd(), ".tmp");
  await mkdir(temporaryRoot, { recursive: true });
  const root = await mkdtemp(path.join(temporaryRoot, "body-search-related-"));
  const bindings = emptyKnowledgeFolderBindings();
  bindings.configured = true; bindings.revision = 1;
  bindings.roles.wiki.enabled = true; bindings.roles.wiki.readPaths = ["知识"];
  const bodies = new Map([["知识/A.md", "# A\nalpha [[B]]"], ["知识/B.md", "# B\nalpha [[A]]"]]);
  await mkdir(path.join(root, "知识"));
  for (const [relativePath, content] of bodies) await writeFile(path.join(root, relativePath), content);
  const unregister = registerKnowledgeFolderBindings(root, () => bindings);
  try {
    for (const warm of [false, true]) {
      let resume!: () => void, entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { resume = resolve; });
      let blocked = !warm;
      const file = (relativePath: string) => ({ path: relativePath, basename: relativePath.split("/").at(-1)!.slice(0, -3), extension: "md", stat: { mtime: 1, size: bodies.get(relativePath)!.length } }) as TFile;
      const app = { vault: { getMarkdownFiles: () => [...bodies.keys()].map(file), getAbstractFileByPath: (relativePath: string) => bodies.has(relativePath) ? file(relativePath) : null,
        read: async (source: TFile) => { if (blocked) { entered(); await gate; } return bodies.get(source.path)!; },
      }, metadataCache: { getFileCache: () => null } } as unknown as App;
      const port = new VaultBodySearch(app, () => bindings);
      const index = new KnowledgeAgentIndex({ vaultPath: root, storageRootPath: path.join(root, warm ? "state-warm" : "state-cold"), bodySearch: port });
      try {
        if (warm) await port.search({ query: "alpha" });
        const normal = index.search({ query: "alpha" });
        if (!warm) await started;
        const relations = await Promise.all([index.related({ vaultRelativePath: "知识/A.md" }), index.related({ vaultRelativePath: "知识/B.md" })]);
        assert.ok(relations.every(result => result.items.length > 0));
        blocked = false; resume();
        assert.equal((await normal).hits.length, 2, "first relation-index initialization cannot clear an independent body search");
        assert.equal((await port.search({ query: "alpha" })).coverage?.cachedFiles, 2);
      } finally { blocked = false; resume(); port.dispose(); }
    }
  } finally { unregister(); await rm(root, { recursive: true, force: true }); }
  console.log("Public Vault concurrency: cold/warm independent views, cancellation, real events, cursors and first related initialization PASS");
}
