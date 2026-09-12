/**
 * turn-navigator.ts — Conversation UI: turn extraction for the in-chat turn
 * navigation column (one tick per user message, paired reply preview).
 */

import assert from "node:assert/strict";
import { buildConversationTurns, conversationTurnVisibleText } from "../ui/codex-view/turn-navigator";
import type { ChatMessage } from "../settings/settings";

function message(partial: Partial<ChatMessage> & Pick<ChatMessage, "id" | "role">): ChatMessage {
  return {
    text: "",
    createdAt: 1_700_000_000_000,
    ...partial
  };
}

export async function runTurnNavigatorTests(): Promise<void> {
  // One tick per user message; reply is the first visible assistant answer.
  const basic = buildConversationTurns(
    [
      message({ id: "u1", role: "user", text: "第一轮问题" }),
      message({ id: "a1", role: "assistant", text: "第一轮回答" }),
      message({ id: "u2", role: "user", text: "第二轮问题" }),
      message({ id: "a2", role: "assistant", text: "第二轮回答" })
    ],
    false,
    "zh-CN"
  );
  assert.equal(basic.length, 2);
  assert.equal(basic[0].messageId, "u1");
  assert.equal(basic[0].userLabel, "第一轮问题");
  assert.equal(basic[0].replyLabel, "第一轮回答");
  assert.equal(basic[0].replyState, "done");
  assert.equal(basic[1].messageId, "u2");
  assert.equal(basic[1].replyLabel, "第二轮回答");

  // Process spine and reasoning messages never become the reply preview.
  const withProcess = buildConversationTurns(
    [
      message({ id: "u1", role: "user", text: "查一下文件" }),
      message({ id: "p1", role: "assistant", itemType: "commandExecution", text: "ls -la" }),
      message({ id: "p2", role: "assistant", itemType: "reasoning", text: "内部推理" }),
      message({ id: "a1", role: "assistant", text: "目录里有三个文件" })
    ],
    false,
    "zh-CN"
  );
  assert.equal(withProcess.length, 1);
  assert.equal(withProcess[0].replyLabel, "目录里有三个文件");

  // Missing reply: explicit "none"; running last turn: "streaming".
  const pending = buildConversationTurns(
    [
      message({ id: "u1", role: "user", text: "已回答" }),
      message({ id: "a1", role: "assistant", text: "答完了" }),
      message({ id: "u2", role: "user", text: "还没回答" })
    ],
    false,
    "zh-CN"
  );
  assert.equal(pending[1].replyState, "none");
  assert.equal(pending[1].replyLabel, "");
  const streaming = buildConversationTurns(
    [
      message({ id: "u1", role: "user", text: "已回答" }),
      message({ id: "a1", role: "assistant", text: "答完了" }),
      message({ id: "u2", role: "user", text: "生成中" }),
      message({ id: "a2", role: "assistant", itemType: "reasoning", text: "思考" })
    ],
    true,
    "zh-CN"
  );
  assert.equal(streaming[1].replyState, "streaming");

  // Attachment-only user messages keep an attachment label, not empty text.
  const attachments = buildConversationTurns(
    [
      message({ id: "u1", role: "user", text: "看图" }),
      message({ id: "a1", role: "assistant", text: "图里是一只猫" }),
      message({
        id: "u2",
        role: "user",
        text: "",
        images: [{ type: "image", name: "cat.png", path: "vault/cat.png" }]
      }),
      message({
        id: "u3",
        role: "user",
        text: "",
        attachments: [{ type: "file", name: "spec.pdf", path: "vault/spec.pdf" }]
      })
    ],
    false,
    "zh-CN"
  );
  assert.equal(attachments.length, 3);
  assert.equal(attachments[1].userLabel, "图片消息");
  assert.equal(attachments[2].userLabel, "spec.pdf");

  // Repeated identical text still yields distinct turns keyed by message id.
  const repeated = buildConversationTurns(
    [
      message({ id: "u1", role: "user", text: "重复内容" }),
      message({ id: "a1", role: "assistant", text: "重复内容" }),
      message({ id: "u2", role: "user", text: "重复内容" }),
      message({ id: "a2", role: "assistant", text: "重复内容" })
    ],
    false,
    "zh-CN"
  );
  assert.deepEqual(repeated.map((turn) => turn.messageId), ["u1", "u2"]);

  // Whitespace collapses and externalized previews fall back to previewText.
  assert.equal(
    conversationTurnVisibleText(message({ id: "x", role: "user", text: "  多行\n\n  文本  " })),
    "多行 文本"
  );
  assert.equal(
    conversationTurnVisibleText(message({ id: "x", role: "user", text: "", previewText: "外部化预览" })),
    "外部化预览"
  );

  // System and tool messages never start a turn.
  const systemOnly = buildConversationTurns(
    [
      message({ id: "s1", role: "system", text: "上下文压缩" }),
      message({ id: "u1", role: "user", text: "唯一一轮" }),
      message({ id: "t1", role: "tool", text: "tool output" })
    ],
    false,
    "zh-CN"
  );
  assert.equal(systemOnly.length, 1);
  assert.equal(systemOnly[0].messageId, "u1");
}
