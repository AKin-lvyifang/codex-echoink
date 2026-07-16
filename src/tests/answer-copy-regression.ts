import * as assert from "node:assert/strict";
import type { ChatMessage } from "../settings/settings";
import { copyAnswerMarkdown, resolveAnswerMarkdown } from "../ui/codex-view/answer-copy";

export async function runAnswerCopyRegressionTests(): Promise<void> {
  const inlineMarkdown = "  # 标题\n\n- **加粗**\n- [链接](https://example.com)\n\n```ts\nconst answer = 42;\n```\n  ";
  const inlineMessage = answerMessage({ text: inlineMarkdown });
  let inlineRawReads = 0;
  const resolvedInline = await resolveAnswerMarkdown(inlineMessage, async () => {
    inlineRawReads += 1;
    return "不应读取";
  });
  assert.equal(resolvedInline, inlineMarkdown, "inline answer Markdown must be preserved byte-for-byte without trimming");
  assert.equal(inlineRawReads, 0, "inline answers must not read raw storage");

  const rawMarkdown = "# 完整回答\n\n正文前半段\n\n```md\n保留代码围栏\n```\n\n正文后半段\n";
  const rawMessage = answerMessage({
    text: "# 完整回答\n\n[内容过大，已收起 80,000 字，展开后加载全文]",
    rawRef: "raw/answer-large.txt"
  });
  const rawRefs: string[] = [];
  const resolvedRaw = await resolveAnswerMarkdown(rawMessage, async (rawRef) => {
    rawRefs.push(rawRef);
    return rawMarkdown;
  });
  assert.equal(resolvedRaw, rawMarkdown, "raw-backed answers must resolve to the full original Markdown");
  assert.deepEqual(rawRefs, ["raw/answer-large.txt"]);

  const writes: string[] = [];
  const copied = await copyAnswerMarkdown(
    rawMessage,
    async () => rawMarkdown,
    async (text) => { writes.push(text); }
  );
  assert.deepEqual(copied, { status: "success" });
  assert.deepEqual(writes, [rawMarkdown], "clipboard payload must exclude the stored preview and preserve the original Markdown");

  const readError = new Error("raw answer unavailable");
  let writesAfterReadFailure = 0;
  const failedRead = await copyAnswerMarkdown(
    rawMessage,
    async () => { throw readError; },
    async () => { writesAfterReadFailure += 1; }
  );
  assert.equal(failedRead.status, "failure");
  if (failedRead.status === "failure") assert.equal(failedRead.error, readError);
  assert.equal(writesAfterReadFailure, 0, "clipboard must not be called when the full raw answer cannot be read");

  const writeError = new Error("clipboard permission denied");
  const failedWrite = await copyAnswerMarkdown(
    inlineMessage,
    async () => "不应读取",
    async () => { throw writeError; }
  );
  assert.equal(failedWrite.status, "failure");
  if (failedWrite.status === "failure") assert.equal(failedWrite.error, writeError);
}

function answerMessage(input: Pick<ChatMessage, "text"> & Pick<Partial<ChatMessage>, "rawRef">): ChatMessage {
  return {
    id: "answer-copy-test",
    role: "assistant",
    itemType: "assistant",
    status: "completed",
    createdAt: 1,
    ...input
  };
}
