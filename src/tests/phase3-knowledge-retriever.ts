import { BUILTIN_SKILLS } from "../harness/resources/builtin-skills";
import { shouldPreflightPersonalKnowledge } from "../harness/pi-native/pi-native-conversation-runtime";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  KNOWLEDGE_NO_EVIDENCE_RESOURCE,
  KNOWLEDGE_NO_EVIDENCE_RESPONSE,
  KNOWLEDGE_SOURCE_CHANGED_RESPONSE,
  KnowledgeRetrievalError,
  KnowledgeRetriever,
  MAX_KNOWLEDGE_REFERENCES,
  formatKnowledgeReferencesForPrompt
} from "../knowledge-base/query";
import { KnowledgeAgentIndex } from "../knowledge-base/knowledge-agent-index";
import { createProductionPiKnowledgeRuntime, createPiKnowledgeInlineExtension } from "../plugin/pi-production-runtime-composition";

export async function runPhase3KnowledgeRetrieverTests(): Promise<void> {
  assert.match(KNOWLEDGE_NO_EVIDENCE_RESOURCE, /初次检索状态/);
  assert.match(KNOWLEDGE_NO_EVIDENCE_RESOURCE, /后续取得依据时[^]*不再声称没有找到/);
  assert.match(KNOWLEDGE_NO_EVIDENCE_RESOURCE, /只读外部工具或模型知识补答/);
  assert.match(KNOWLEDGE_NO_EVIDENCE_RESOURCE, /没有实际联网核验[^]*未联网核验/);
  assert.doesNotMatch(KNOWLEDGE_NO_EVIDENCE_RESOURCE, /当前轮是 \/ask|禁止 memory_write|当前轮只允许/);
  const journal = BUILTIN_SKILLS.find((item) => item.id === "daily-journal")!;
  const handlers = new Map<string, (...args: any[]) => any>();
  const extension = createPiKnowledgeInlineExtension({
    vaultSecurity: { name: "fixture-security", factory: () => undefined },
    currentTurn: () => null,
    currentWorkspaceAccess: () => ({ permission: "workspace-write", mode: "agent", memoryMode: "normal" }),
    currentSkillTurn: () => ({ skillId: "daily-journal", content: journal.body })
  });
  await extension.factory({ on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler) } as never);
  const request = await handlers.get("before_agent_start")!({ systemPrompt: "EchoInk", prompt: "想把今天发生的事记下来。" });
  assert.match(request.systemPrompt, /workspace-write/);
  assert.match(request.message.content, /obsidian_context[^]*templateContent/);
  assert.doesNotMatch(request.message.content, /当前轮是 \/ask|当前轮只允许/);
  assert.equal(shouldPreflightPersonalKnowledge("想把今天发生的事记下来。", "daily-journal"), false);
  assert.equal(shouldPreflightPersonalKnowledge("回看之前的笔记再补充", "daily-journal"), true);
  const vaultPath = await mkdtemp(path.join(tmpdir(), "echoink-phase3-retriever-"));
  const outsidePath = await mkdtemp(path.join(tmpdir(), "echoink-phase3-outside-"));
  try {
    const explicitBytes = Buffer.from([
      "# Explicit Source",
      "Intro line",
      "P3_FIXTURE_ANSWER only exists in this Vault file.",
      "Closing line",
      ""
    ].join("\r\n"), "utf8");
    await writeFixture(vaultPath, "root.md", "# Root\nROOT_SCOPE_TOKEN local fact\n");
    await writeFixture(
      vaultPath,
      "custom/topic.md",
      "# Custom\nCUSTOM_SCOPE_TOKEN local fact\n"
    );
    await writeFixture(vaultPath, "notes/explicit.md", explicitBytes);
    await writeFixture(vaultPath, "raw/source.md", "RAW_SCOPE_TOKEN raw fact\n");
    await writeFixture(vaultPath, "inbox/source.md", "INBOX_SCOPE_TOKEN inbox fact\n");
    await writeFixture(vaultPath, ".hidden/secret.md", "HIDDEN_SCOPE_TOKEN\n");
    await writeFixture(vaultPath, ".obsidian/config.md", "PLUGIN_SCOPE_TOKEN\n");
    await writeFixture(vaultPath, ".echoink/runtime.md", "RUNTIME_SCOPE_TOKEN\n");
    await writeFixture(
      vaultPath,
      ".obsidian/plugins/codex-echoink/data.md",
      "PLUGIN_STATE_TOKEN\n"
    );
    await writeFixture(vaultPath, "notes/not-markdown.txt", "TEXT_SCOPE_TOKEN\n");
    for (let index = 1; index <= 25; index += 1) {
      await writeFixture(
        vaultPath,
        `many/note-${String(index).padStart(2, "0")}.md`,
        `# Note ${index}\nLIMIT_SCOPE_TOKEN\n`
      );
    }
    for (let index = 1; index <= 8; index += 1) {
      await writeFixture(
        vaultPath,
        `projects/production-note-${String(index).padStart(2, "0")}.md`,
        `# Production Note ${index}\nPRODUCTION_LIMIT_SCOPE_TOKEN\n`
      );
    }
    const outsideFile = path.join(outsidePath, "outside.md");
    await writeFile(outsideFile, "OUTSIDE_SCOPE_TOKEN\n", "utf8");
    await symlink(outsideFile, path.join(vaultPath, "outside-link.md"));

    const retriever = new KnowledgeRetriever(vaultPath);
    const beforeReadOnly = await snapshotFixtureTree(vaultPath);

    const rootResult = await retriever.retrieve({ question: "ROOT_SCOPE_TOKEN" });
    assert.equal(rootResult.status, "ready");
    assert.deepEqual(
      rootResult.references.map((reference) => reference.vaultRelativePath),
      ["root.md"]
    );
    const customResult = await retriever.retrieve({
      question: "CUSTOM_SCOPE_TOKEN"
    });
    assert.equal(customResult.status, "ready");
    assert.equal(
      customResult.references[0]?.vaultRelativePath,
      "custom/topic.md"
    );

    for (const forbiddenOnlyToken of [
      "RAW_SCOPE_TOKEN",
      "INBOX_SCOPE_TOKEN",
      "HIDDEN_SCOPE_TOKEN",
      "PLUGIN_SCOPE_TOKEN",
      "RUNTIME_SCOPE_TOKEN",
      "PLUGIN_STATE_TOKEN",
      "OUTSIDE_SCOPE_TOKEN",
      "TEXT_SCOPE_TOKEN"
    ]) {
      const result = await retriever.retrieve({ question: forbiddenOnlyToken });
      assert.equal(result.status, "no_evidence", forbiddenOnlyToken);
      assert.equal(result.shouldInvokePi, false);
      assert.equal(result.fixedResponse, KNOWLEDGE_NO_EVIDENCE_RESPONSE);
    }

    const explicitRaw = await retriever.retrieve({
      question: "raw source",
      explicitPaths: ["raw/source.md"]
    });
    assert.equal(explicitRaw.status, "ready");
    assert.equal(explicitRaw.references[0]?.vaultRelativePath, "raw/source.md");
    const unrefined = await retriever.retrieve({
      question: "RAW_SCOPE_TOKEN INBOX_SCOPE_TOKEN",
      includeUnrefined: true
    });
    assert.equal(unrefined.status, "ready");
    assert.ok(unrefined.references.some(
      (reference) => reference.vaultRelativePath === "raw/source.md"
    ));
    assert.ok(unrefined.references.some(
      (reference) => reference.vaultRelativePath === "inbox/source.md"
    ));

    const explicit = await retriever.retrieve({
      question: "P3_FIXTURE_ANSWER",
      explicitPaths: ["notes/explicit.md"]
    });
    assert.equal(explicit.status, "ready");
    assert.equal(explicit.references.length, 1);
    const reference = explicit.references[0];
    assert.ok(reference);
    assert.equal(reference.vaultRelativePath, "notes/explicit.md");
    assert.equal(reference.title, "Explicit Source");
    assert.equal(
      reference.contentRevision,
      `sha256:${createHash("sha256").update(explicitBytes).digest("hex")}`
    );
    assert.match(reference.referenceId, /^knowledge-reference:[a-f0-9]{64}$/u);
    const sourceLines = explicitBytes.toString("utf8").split(/\r\n|\n|\r/u);
    assert.equal(
      reference.excerpt,
      sourceLines.slice(reference.lineStart - 1, reference.lineEnd).join("\n")
    );
    assert.ok(reference.lineStart <= 3 && reference.lineEnd >= 3);
    const delivered = JSON.parse(formatKnowledgeReferencesForPrompt(explicit.references)).sources[0];
    assert.equal(delivered.vaultRelativePath, "notes/explicit.md");
    assert.ok(delivered.lineStart >= 1 && delivered.lineEnd >= delivered.lineStart);
    assert.match(delivered.excerpt, /P3_FIXTURE_ANSWER/u);
    assert.equal(
      (await retriever.verifyReferences(explicit.references)).status,
      "valid"
    );

    const limited = await retriever.retrieve({ question: "LIMIT_SCOPE_TOKEN" });
    assert.equal(limited.status, "ready");
    assert.equal(limited.references.length, MAX_KNOWLEDGE_REFERENCES);
    assert.deepEqual(
      limited.references.map((reference) => reference.vaultRelativePath),
      Array.from({ length: MAX_KNOWLEDGE_REFERENCES }, (_, index) =>
        `many/note-${String(index + 1).padStart(2, "0")}.md`
      )
    );

    const productionIndex = new KnowledgeAgentIndex({
      vaultPath,
      storageRootPath: path.join(outsidePath, "production-index")
    });
    await productionIndex.refresh();
    const productionRuntime = createProductionPiKnowledgeRuntime({
      vaultRootPath: vaultPath,
      knowledgeAgentIndex: productionIndex,
      knowledgePreferences: {} as never,
      usage: {} as never
    });
    assert.deepEqual(await productionRuntime.resolveMaintenanceScope!("RAW_SCOPE_TOKEN"), {
      mode: "query", candidatePaths: ["raw/source.md"]
    });
    await assert.rejects(productionRuntime.resolveMaintenanceScope!("NO_MATCH_ZZXXQQ"), /不会回退到全局维护/u);
    const productionChat = await productionRuntime.retrieveChat!({
      vaultId: "vault-production-chat",
      conversationId: "conversation-production-chat",
      piSessionId: "pi-production-chat",
      productRunId: "run-production-chat",
      question: "PRODUCTION_LIMIT_SCOPE_TOKEN",
      explicitPaths: [],
      includeUnrefined: false
    });
    assert.equal(productionChat.status, "ready");
    assert.equal(productionChat.references.length, 6,
      "production normal Chat preflight is bounded to six references");
    assert.match(productionChat.providerResourceText, /有界本地预检/u);
    assert.equal(productionChat.references.every((item) =>
      item.recordedAt !== undefined
      && item.verificationStatus === "local_revision_verified"
    ), true);

    const emptyChat = await productionRuntime.retrieveChat!({ vaultId: "vault-production-chat", conversationId: "conversation-production-chat", piSessionId: "pi-production-chat", productRunId: "empty-chat", question: "NO_MATCH_ZZXXQQ", explicitPaths: [], includeUnrefined: false });
    assert.equal(emptyChat.status, "no_evidence");
    assert.doesNotMatch(emptyChat.providerResourceText, /当前轮是 \/ask|禁止 memory_write|当前轮只允许/);
    const emptyAsk = await productionRuntime.retrieveAsk({ vaultId: "vault-production-chat", conversationId: "conversation-production-chat", piSessionId: "pi-production-chat", productRunId: "empty-ask", question: "NO_MATCH_ZZXXQQ", explicitPaths: [], includeUnrefined: false });
    assert.match(emptyAsk.providerResourceText, /只读外部工具或模型知识补答/);
    assert.match(emptyAsk.providerResourceText, /未联网核验/);

    assert.deepEqual(
      await snapshotFixtureTree(vaultPath),
      beforeReadOnly,
      "KnowledgeRetriever must not write an index, state or Vault file"
    );

    for (const [explicitPath, code] of [
      ["../outside.md", "invalid-path"],
      [path.join(vaultPath, "root.md"), "invalid-path"],
      [".hidden/secret.md", "forbidden-path"],
      [".obsidian/config.md", "forbidden-path"],
      [".echoink/runtime.md", "forbidden-path"],
      ["outside-link.md", "not-regular-file"],
      ["notes/not-markdown.txt", "not-markdown"],
      ["notes/missing.md", "not-found"]
    ] as const) {
      await assert.rejects(
        retriever.retrieve({ question: "explicit", explicitPaths: [explicitPath] }),
        (error) =>
          error instanceof KnowledgeRetrievalError
          && error.code === code,
        `${explicitPath} must fail closed with ${code}`
      );
    }

    await writeFile(
      path.join(vaultPath, "notes", "explicit.md"),
      Buffer.concat([explicitBytes, Buffer.from("changed\n", "utf8")])
    );
    const changed = await retriever.verifyReferences(explicit.references);
    assert.equal(changed.status, "source_changed");
    assert.equal(changed.fixedResponse, KNOWLEDGE_SOURCE_CHANGED_RESPONSE);
    assert.deepEqual(changed.references, []);
    assert.deepEqual(changed.changedReferenceIds, [reference.referenceId]);
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
    await rm(outsidePath, { recursive: true, force: true });
  }
}

async function writeFixture(
  vaultPath: string,
  relativePath: string,
  content: string | Buffer
): Promise<void> {
  const absolutePath = path.join(vaultPath, ...relativePath.split("/"));
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content);
}

async function snapshotFixtureTree(
  vaultPath: string
): Promise<Array<{ path: string; kind: string; revision?: string; target?: string }>> {
  const result: Array<{
    path: string;
    kind: string;
    revision?: string;
    target?: string;
  }> = [];
  const walk = async (directoryPath: string): Promise<void> => {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name)
    )) {
      const absolutePath = path.join(directoryPath, entry.name);
      const relativePath = path.relative(vaultPath, absolutePath)
        .split(path.sep).join("/");
      const stat = await lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        result.push({
          path: relativePath,
          kind: "symlink",
          target: await readFile(absolutePath).then(
            () => "followed",
            () => "unreadable"
          )
        });
        continue;
      }
      if (stat.isDirectory()) {
        result.push({ path: relativePath, kind: "directory" });
        await walk(absolutePath);
        continue;
      }
      if (stat.isFile()) {
        result.push({
          path: relativePath,
          kind: "file",
          revision: createHash("sha256")
            .update(await readFile(absolutePath)).digest("hex")
        });
      }
    }
  };
  await walk(vaultPath);
  return result;
}
