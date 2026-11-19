import { normalizeProviderTerm, rawErrorText, userFacingErrorText } from "../core/error-copy";
import * as assert from "node:assert/strict";

const FALLBACK = "操作没有完成，请再试一次。";
const FALLBACK_EN = "The operation could not be completed. Try again.";

export function runUserFacingErrorTests(): void {
  // Internal codes, English exceptions and jargon never reach the user.
  for (const raw of [
    "pi_native_agent_settled_missing",
    "agent_capability_catalog_required",
    "Provider being edited no longer exists",
    new Error("The proposed Pi Session recovery file failed strict JSONL validation"),
    new TypeError("Cannot read properties of undefined (reading 'id')"),
    "当前 Provider runtime identity 无效。",
    "Pi Chat ProductRun 终态与耐久回读不一致。",
    "",
    null,
    undefined,
    { unexpected: true }
  ]) {
    assert.equal(userFacingErrorText(raw, FALLBACK), FALLBACK, String(raw));
  }

  // Known codes get their plain-language sentence in both languages.
  assert.match(userFacingErrorText(new Error("provider_url_invalid"), FALLBACK), /HTTPS/u);
  assert.match(userFacingErrorText("provider_url_invalid", FALLBACK_EN, "en"), /HTTPS/u);
  const auth = userFacingErrorText("provider_auth_failed", FALLBACK);
  assert.notEqual(auth, FALLBACK);
  assert.match(auth, /\p{Script=Han}/u);
  assert.match(userFacingErrorText("pi_native_conversation_busy", FALLBACK), /上一条回答/u);

  // Chinese text written for users passes through, with "Provider" renamed.
  assert.equal(userFacingErrorText(new Error("EchoInk 正在回答，暂时无法切换英文日记模型。请等待回答结束后重试。"), FALLBACK), "EchoInk 正在回答，暂时无法切换英文日记模型。请等待回答结束后重试。");
  assert.equal(userFacingErrorText("所选 Provider 已停用，请重新选择。", FALLBACK), "所选模型服务已停用，请重新选择。");
  assert.equal(userFacingErrorText(new Error("Error: API Key 未填写。请填写后重试。"), FALLBACK), "API Key 未填写。请填写后重试。");

  // Language must match the interface.
  assert.equal(userFacingErrorText("The API key was rejected. Check it in settings.", FALLBACK_EN, "en"), "The API key was rejected. Check it in settings.");
  assert.equal(userFacingErrorText("所选模型已停用，请重新选择。", FALLBACK_EN, "en"), FALLBACK_EN);
  // A known shared sentence switches to the interface language instead.
  assert.equal(userFacingErrorText("API Key 未填写。请填写后重试。", FALLBACK_EN, "en"), "The API key is missing. Enter it and try again.");

  assert.equal(rawErrorText(new Error("Error: boom")), "boom");
  assert.equal(normalizeProviderTerm("请在 API Provider 设置中补充。"), "请在设置 → 模型服务中补充。");
  console.log("PASS user-facing error text: codes, jargon and English fall back; known codes and user Chinese pass");
}
