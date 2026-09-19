import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyPiAnthropicDocumentPayload,
  PI_ANTHROPIC_PDF_DOCUMENT_ADAPTER,
  PI_ANTHROPIC_DOCUMENT_REQUEST_TOO_LARGE,
  resolvePiDocumentTransport,
  type PiDocumentCapabilityTarget
} from "../../harness/pi-native/pi-document-context";
import {
  preparePiChatDocuments,
  reconcilePiDocumentTransports,
  type PiDocumentInputError
} from "../../ui/codex-view/pi-document-input";
import { recordPiDocumentReplayForEntry } from "../../ui/codex-view/pi-conversation-support";
import type { StoredSession } from "../../settings/settings";
import { RuntimeTurnQueue, type QueuedTurnItem } from "../../ui/turn-queue";
import { BILINGUAL_PDF_TEXT, runPdfTextExtractorTests } from "./pdf-text-extractor";

const NATIVE_TARGET: Readonly<PiDocumentCapabilityTarget> = Object.freeze({
  providerId: "anthropic",
  apiProtocol: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  modelId: "claude-sonnet-5",
  adapter: PI_ANTHROPIC_PDF_DOCUMENT_ADAPTER
});

const EXTRACTED_TARGET: Readonly<PiDocumentCapabilityTarget> = Object.freeze({
  ...NATIVE_TARGET,
  providerId: "custom"
});

export async function runPiDocumentInputTests(): Promise<void> {
  await runPdfTextExtractorTests();
  exactAnthropicMatrixIsTheOnlyNativeCapability();
  nativeAnthropicPayloadUsesFrozenBytesWithoutPathsOrDuplication();
  await preparedDocumentsFreezeBytesTextAndShaBeforeQueueing();
  await textlessPdfDependsOnTheSelectedTransport();
  await pdfTextBytesErrorsAndReplay();
}

async function pdfTextBytesErrorsAndReplay(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "echoink-pdf-text-"));
  const filePath = path.join(root, "bilingual.pdf");
  const attachment = { type: "file" as const, name: "bilingual.pdf", path: filePath, mimeType: "application/pdf" };
  try {
    const bytes = await readFile("src/tests/fixtures/pdf/bilingual-multipage.pdf");
    await writeFile(filePath, bytes);
    const prepared = await preparePiChatDocuments([attachment], {
      availableInputTokens: 10_000, capabilityTarget: NATIVE_TARGET
    });
    const document = prepared.documents[0]!;
    assert.equal(document.transport, "native");
    assert.equal(document.text, BILINGUAL_PDF_TEXT);
    assert.deepEqual(document.bytes, new Uint8Array(bytes));
    assert.equal(document.sha256, createHash("sha256").update(bytes).digest("hex"));
    await writeFile(filePath, "LATER_DISK_CONTENT_MUST_NOT_BE_READ");
    const downgraded = reconcilePiDocumentTransports(prepared.documents, EXTRACTED_TARGET);
    assert.equal(downgraded[0]?.text, BILINGUAL_PDF_TEXT);
    assert.deepEqual(downgraded[0]?.bytes, new Uint8Array(bytes));
    const session: StoredSession = {
      id: "pdf-text-replay", title: "PDF", kind: "chat", piSessionId: "pi-pdf-text",
      bodyAuthority: "pi_session_only", cwd: root, messages: [], createdAt: 1, updatedAt: 1
    };
    recordPiDocumentReplayForEntry(session, "entry-pdf", prepared.documents);
    const replay = session.piDocumentReplay?.["entry-pdf"]?.[0];
    const replayed = await preparePiChatDocuments([{ ...attachment, documentReplay: replay }], {
      availableInputTokens: 10_000, capabilityTarget: NATIVE_TARGET
    });
    assert.equal(replayed.documents[0]?.text, BILINGUAL_PDF_TEXT);
    assert.equal(replayed.documents[0]?.sha256, document.sha256);
    assert.equal(replayed.documents[0]?.transport, "extracted_text");
    assert.equal(replayed.documents[0]?.bytes.byteLength, 0);

    for (const [content, code] of [
      [await readFile("src/tests/fixtures/pdf/encrypted.pdf"), "encrypted"],
      [Buffer.from("%PDF-1.4\ncorrupted document"), "damaged"]
    ] as const) {
      await writeFile(filePath, content);
      await assert.rejects(preparePiChatDocuments([attachment], {
        availableInputTokens: 10_000, capabilityTarget: EXTRACTED_TARGET
      }), (error: PiDocumentInputError) => error.code === code);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function nativeAnthropicPayloadUsesFrozenBytesWithoutPathsOrDuplication(): void {
  const bytes = new Uint8Array([1, 2, 3]);
  const document = Object.freeze({
    attachment: Object.freeze({
      type: "file" as const,
      name: "private.pdf",
      path: "/Users/private/Documents/private.pdf",
      mimeType: "application/pdf",
      sizeBytes: bytes.byteLength,
      availability: "available" as const
    }),
    kind: "pdf" as const,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    transport: "native" as const,
    text: "FROZEN_FALLBACK_TEXT"
  });
  const payload = {
    model: "claude-sonnet-5",
    messages: [{
      role: "user",
      content: [{ type: "text", text: "请阅读附件" }]
    }, {
      role: "assistant",
      content: [{ type: "tool_use", id: "tool-1" }]
    }, {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tool-1", content: "done" }]
    }]
  };
  const transformed = applyPiAnthropicDocumentPayload({
    payload,
    documents: [document],
    capabilityTarget: NATIVE_TARGET
  }) as typeof payload;
  assert.notEqual(transformed, payload);
  assert.deepEqual(payload.messages[0]?.content, [{ type: "text", text: "请阅读附件" }]);
  assert.deepEqual(transformed.messages[0]?.content[0], {
    type: "document",
    source: {
      type: "base64",
      media_type: "application/pdf",
      data: "AQID"
    }
  });
  assert.equal(
    JSON.stringify(transformed).includes("/Users/private"),
    false
  );
  const repeated = applyPiAnthropicDocumentPayload({
    payload: transformed,
    documents: [document],
    capabilityTarget: NATIVE_TARGET
  }) as typeof payload;
  assert.equal(
    repeated.messages[0]?.content.filter((block) => block.type === "document").length,
    1
  );

  const largeBytes = new Uint8Array(13 * 1024 * 1024);
  const largeSha = createHash("sha256").update(largeBytes).digest("hex");
  const largeDocument = (name: string) => Object.freeze({
    ...document,
    attachment: Object.freeze({
      ...document.attachment,
      name,
      path: `/private/${name}`,
      sizeBytes: largeBytes.byteLength
    }),
    bytes: largeBytes,
    sha256: largeSha
  });
  assert.throws(
    () => applyPiAnthropicDocumentPayload({
      payload,
      documents: [largeDocument("one.pdf"), largeDocument("two.pdf")],
      capabilityTarget: NATIVE_TARGET
    }),
    (error: Error) => error.message === PI_ANTHROPIC_DOCUMENT_REQUEST_TOO_LARGE
  );
}

function exactAnthropicMatrixIsTheOnlyNativeCapability(): void {
  for (const modelId of [
    "claude-fable-5",
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-haiku-4-5",
    "claude-haiku-4-5-20251001"
  ]) {
    assert.equal(resolvePiDocumentTransport({
      ...NATIVE_TARGET,
      modelId
    }, "application/pdf"), "native");
  }
  const misses: Array<readonly [Readonly<PiDocumentCapabilityTarget>, string]> = [
    [{ ...NATIVE_TARGET, providerId: "custom" }, "application/pdf"],
    [{ ...NATIVE_TARGET, providerId: "minimax" }, "application/pdf"],
    [{ ...NATIVE_TARGET, apiProtocol: "openai-responses" }, "application/pdf"],
    [{ ...NATIVE_TARGET, baseUrl: "https://proxy.example/anthropic" }, "application/pdf"],
    [{ ...NATIVE_TARGET, modelId: "claude-sonnet-4-6" }, "application/pdf"],
    [{ ...NATIVE_TARGET, adapter: null }, "application/pdf"],
    [NATIVE_TARGET, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]
  ];
  for (const [target, mimeType] of misses) {
    assert.equal(resolvePiDocumentTransport(target, mimeType), "extracted_text");
  }
}

async function preparedDocumentsFreezeBytesTextAndShaBeforeQueueing(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "echoink-document-snapshot-"));
  try {
    const filePath = path.join(root, "queued.md");
    const original = Buffer.from("ORIGINAL_FROZEN_DOCUMENT", "utf8");
    await writeFile(filePath, original);
    const prepared = await preparePiChatDocuments([{
      type: "file",
      name: "queued.md",
      path: filePath,
      mimeType: "text/markdown"
    }], {
      availableInputTokens: 10_000,
      capabilityTarget: EXTRACTED_TARGET
    });
    assert.equal(prepared.documents[0]?.transport, "extracted_text");
    assert.equal(prepared.documents[0]?.text, "ORIGINAL_FROZEN_DOCUMENT");
    assert.equal(
      prepared.documents[0]?.sha256,
      createHash("sha256").update(original).digest("hex")
    );

    const queue = new RuntimeTurnQueue();
    const item: QueuedTurnItem = {
      id: "document-snapshot",
      sessionId: "document-session",
      text: "read",
      attachments: [{
        type: "file",
        name: "queued.md",
        path: filePath,
        mimeType: "text/markdown"
      }],
      preparedDocuments: prepared.documents,
      skill: null,
      turnOptions: {
        providerSettingsId: "custom-provider",
        runtimeProviderId: "echoink-custom",
        model: "fixture-model",
        reasoning: "none",
        permission: "workspace-write",
        mode: "agent",
        mcpEnabled: false
      },
      kind: "chat",
      createdAt: 1
    };
    queue.enqueue(item);
    await writeFile(filePath, "LATER_DISK_CONTENT", "utf8");
    (prepared.documents[0]!.bytes as Uint8Array)[0] = 0;

    const frozen = queue.peekNext(item.sessionId)?.preparedDocuments?.[0];
    assert.equal(
      Buffer.from(frozen?.bytes ?? []).toString("utf8"),
      "ORIGINAL_FROZEN_DOCUMENT"
    );
    assert.equal(frozen?.text, "ORIGINAL_FROZEN_DOCUMENT");
    assert.equal(
      frozen?.sha256,
      createHash("sha256").update(original).digest("hex")
    );

    const replayed = await preparePiChatDocuments([{
      type: "file",
      name: "queued.md",
      path: "/missing/reopen/queued.md",
      mimeType: "text/markdown",
      sizeBytes: original.byteLength,
      availability: "unavailable",
      documentReplay: {
        name: "queued.md",
        mimeType: "text/markdown",
        sizeBytes: original.byteLength,
        kind: "markdown",
        sha256: createHash("sha256").update(original).digest("hex"),
        text: "ORIGINAL_FROZEN_DOCUMENT"
      }
    }], {
      availableInputTokens: 10_000,
      capabilityTarget: NATIVE_TARGET
    });
    assert.equal(replayed.documents[0]?.transport, "extracted_text");
    assert.equal(replayed.documents[0]?.bytes.byteLength, 0);
    assert.equal(replayed.documents[0]?.text, "ORIGINAL_FROZEN_DOCUMENT");
    assert.equal(replayed.documents[0]?.attachment.availability, "unavailable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function textlessPdfDependsOnTheSelectedTransport(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "echoink-textless-pdf-"));
  try {
    const filePath = path.join(root, "scan.pdf");
    await writeFile(filePath, minimalBlankPdf());
    const attachment = {
      type: "file" as const,
      name: "scan.pdf",
      path: filePath,
      mimeType: "application/pdf"
    };
    const native = await preparePiChatDocuments([attachment], {
      availableInputTokens: 10_000,
      capabilityTarget: NATIVE_TARGET
    });
    assert.equal(native.documents[0]?.transport, "native");
    assert.equal(native.documents[0]?.text, undefined);
    assert.ok((native.documents[0]?.bytes.byteLength ?? 0) > 0);

    const entryId = "entry-scan-pdf";
    const session: StoredSession = {
      id: "conversation-scan-pdf",
      title: "Scan PDF",
      kind: "chat",
      piSessionId: "pi-scan-pdf",
      bodyAuthority: "pi_session_only",
      cwd: root,
      messages: [],
      createdAt: 1,
      updatedAt: 1
    };
    recordPiDocumentReplayForEntry(session, entryId, native.documents);
    const tombstone = session.piDocumentReplay?.[entryId]?.[0];
    assert.equal(tombstone?.text, null, "textless native PDF persists a replay tombstone");
    assert.equal(tombstone?.sha256, native.documents[0]?.sha256);

    await writeFile(filePath, "LATER_DISK_CONTENT_MUST_NOT_BE_READ", "utf8");
    await assert.rejects(
      preparePiChatDocuments([{
        ...attachment,
        sizeBytes: tombstone!.sizeBytes,
        documentReplay: tombstone
      }], {
        availableInputTokens: 10_000,
        capabilityTarget: NATIVE_TARGET
      }),
      (error: PiDocumentInputError) =>
        error.code === "textless"
        && /后来变化的源文件/u.test(error.message)
    );
    await writeFile(filePath, minimalBlankPdf());

    const nativeWithFallback = Object.freeze({
      ...native.documents[0]!,
      text: "FROZEN_PDF_FALLBACK"
    });
    const downgraded = reconcilePiDocumentTransports(
      [nativeWithFallback],
      EXTRACTED_TARGET
    );
    assert.equal(downgraded[0]?.transport, "extracted_text");
    assert.equal(downgraded[0]?.text, "FROZEN_PDF_FALLBACK");
    assert.deepEqual(downgraded[0]?.bytes, native.documents[0]?.bytes);
    assert.equal(native.documents[0]?.transport, "native");

    assert.throws(
      () => reconcilePiDocumentTransports(native.documents, EXTRACTED_TARGET),
      (error: PiDocumentInputError) => error.code === "textless"
    );

    await assert.rejects(
      preparePiChatDocuments([attachment], {
        availableInputTokens: 10_000,
        capabilityTarget: EXTRACTED_TARGET
      }),
      (error: PiDocumentInputError) => error.code === "textless"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function minimalBlankPdf(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] >>"
  ];
  let source = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(source, "ascii"));
    source += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(source, "ascii");
  source += `xref\n0 ${objects.length + 1}\n`;
  source += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    source += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  source += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(source, "ascii");
}
