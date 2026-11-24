import * as assert from "node:assert/strict";
import { setXiaoechoLanguageProbe, xiaoechoFailureText, xiaoechoFailureCode } from "../membership/xiaoecho-catalog";
import { XIAOECHO_RETRY_DELAY_MS, xiaoechoBusyCode } from "../harness/pi/xiaoecho-retry";
import { assistantProviderFailureText, xiaoechoProviderFailureText, xiaoechoProviderFailureDetail,
  sanitizeProviderFailureDetail, providerFailureDetailText, providerFailureText, PROVIDER_FAILURE_DETAIL_PREFIX } from "../harness/pi/provider-failure";

/** 小echo 排队与错误文案（方哥 11-08 定）：SERVER_BUSY 静默重试一次（2 秒），再失败才用 xiaoechoFailureText 的人话提示。 */
export async function runXiaoechoRetryTests(): Promise<void> {
  assert.equal(xiaoechoFailureCode('HTTP 503: {"error":"SERVER_BUSY"}'), "SERVER_BUSY");
  assert.equal(xiaoechoFailureCode('ECONNREFUSED secret=DO_NOT_SHOW'), "XIAOECHO_UNAVAILABLE");
  assert.equal(xiaoechoFailureCode('HTTP 400: {"error":"BODY_TOO_LARGE"}'), "CONTENT_TOO_LONG");
  assert.equal(xiaoechoFailureCode({ status: 400, message: "NEW_GATE_DENIAL_2" }), "NEW_GATE_DENIAL_2");
  assert.equal(xiaoechoFailureCode('HTTP 400: {"error":{"code":"new_limit","message":"Do not show this"}}'), "new_limit");
  assert.equal(xiaoechoFailureCode({ message: "Unstructured server detail" }), "XIAOECHO_REQUEST_REJECTED");
  const unknown = xiaoechoProviderFailureDetail(sanitizeProviderFailureDetail(400, '{"error":"NEW_GATE_DENIAL_2"}'));
  const persisted = `provider_request_rejected\n${PROVIDER_FAILURE_DETAIL_PREFIX}${providerFailureDetailText(unknown)}`;
  assert.equal(assistantProviderFailureText({ errorMessage: "provider_request_rejected", echoInkProviderFailure: unknown }),
    "模型服务没有接受这次请求（错误码 NEW_GATE_DENIAL_2）。");
  assert.equal(providerFailureText(persisted, "zh"), "模型服务没有接受这次请求（错误码 NEW_GATE_DENIAL_2）。");
  assert.deepEqual(xiaoechoProviderFailureDetail({ message: "BODY_TOO_LARGE" }), { message: "CONTENT_TOO_LONG" });
  for (const code of ["XIAOECHO_DISABLED", "NEW_API_NOT_CONFIGURED", "NEW_API_UNAUTHORIZED", "NEW_API_UNREACHABLE"]) {
    assert.equal(xiaoechoFailureText(code,"zh-CN"), "模型服务暂时不可用。请稍后重试。");
    assert.equal(xiaoechoFailureText(code,"en"), "The model service is temporarily unavailable. Try again later.");
    assert.ok(!/配置|令牌|凭据|渠道|OSS/.test(xiaoechoFailureText(code,"zh-CN")!));
  }
  for (const code of ["MODEL_UNAVAILABLE", "MODEL_UNKNOWN"]) {
    assert.equal(xiaoechoFailureText(code, "zh-CN"), "当前模型不可用（可能已下线或账号无权限）。请在 设置 → 模型服务 中更换模型。");
    assert.equal(xiaoechoFailureText(code, "en"), "The current model is unavailable (it may be retired or your account lacks access). Choose another model in Settings → Model services.");
  }
  assert.equal(XIAOECHO_RETRY_DELAY_MS, 2000);
  assert.equal(xiaoechoBusyCode("xiaoecho", 503, 'HTTP 503: {"error":"SERVER_BUSY","retryAfter":10}'), "SERVER_BUSY");
  assert.equal(xiaoechoBusyCode("xiaoecho", 503, '{"error":"XIAOECHO_BUSY"}'), "XIAOECHO_BUSY");
  assert.equal(xiaoechoBusyCode("xiaoecho", null, 'SERVER_BUSY'), "SERVER_BUSY", "status unknown but the body says busy");
  assert.equal(xiaoechoBusyCode("xiaoecho", 402, '{"error":"POINTS_INSUFFICIENT"}'), null, "only the busy codes are retried");
  assert.equal(xiaoechoBusyCode("xiaoecho", 503, '{"error":"XIAOECHO_UNAVAILABLE"}'), null);
  assert.equal(xiaoechoBusyCode("openai", 503, '{"error":"SERVER_BUSY"}'), null, "other providers keep their own policy");
  // Second failure: the server's fixed code reads as plain words, never as "HTTP 503 · SERVER_BUSY".
  const busy = sanitizeProviderFailureDetail(503, '{"error":"SERVER_BUSY","retryAfter":10}');
  assert.equal(busy?.message, "SERVER_BUSY");
  assert.equal(xiaoechoProviderFailureText(busy), "模型服务暂时不可用。请稍后重试。");
  assert.equal(assistantProviderFailureText({ errorMessage: "provider_service_unavailable", echoInkProviderFailure: busy }), "模型服务暂时不可用。请稍后重试。");
  const poor = sanitizeProviderFailureDetail(402, '{"error":"POINTS_INSUFFICIENT"}');
  assert.equal(assistantProviderFailureText({ errorMessage: "provider_request_rejected", echoInkProviderFailure: poor }), "AI 点数不足。请先签到领取 AI 点数后重试。");
  assert.equal(xiaoechoProviderFailureText(sanitizeProviderFailureDetail(500, '{"error":{"message":"Internal error","code":"server_error"}}')), null, "lower-case vendor codes are not ours");
  assert.match(assistantProviderFailureText({ errorMessage: "provider_service_unavailable", echoInkProviderFailure: sanitizeProviderFailureDetail(503, "upstream down") }), /模型服务暂时不可用/);
  // English branch (方哥 11-08): every code has a same-meaning English line; the probe follows the plugin language.
  for (const code of ["POINTS_INSUFFICIENT", "MODEL_UNAVAILABLE", "MODEL_UNKNOWN", "SERVER_BUSY", "XIAOECHO_BUSY", "XIAOECHO_UNAVAILABLE", "XIAOECHO_TIMEOUT", "XIAOECHO_DISABLED", "CONTENT_TOO_LONG", "AUTH_REQUIRED", "ACCOUNT_DISABLED"]) {
    const zh = xiaoechoFailureText(code, "zh"), en = xiaoechoFailureText(code, "en");
    assert.ok(zh && /[\u4e00-\u9fff]/u.test(zh), code); assert.ok(en && !/[\u4e00-\u9fff]/u.test(en), code);
  }
  assert.equal(xiaoechoFailureText("SERVER_BUSY", "en"), "The model service is temporarily unavailable. Try again later.");
  assert.equal(xiaoechoFailureText("NOT_A_CODE", "en"), null);
  setXiaoechoLanguageProbe(() => "en");
  assert.equal(assistantProviderFailureText({ errorMessage: "provider_request_rejected", echoInkProviderFailure: unknown }),
    "The model service did not accept this request (error code NEW_GATE_DENIAL_2).");
  assert.equal(providerFailureText(persisted, "en"), "The model service did not accept this request (error code NEW_GATE_DENIAL_2).");
  assert.equal(assistantProviderFailureText({ errorMessage: "provider_service_unavailable", echoInkProviderFailure: busy }), "The model service is temporarily unavailable. Try again later.");
  assert.equal(assistantProviderFailureText({ errorMessage: "provider_request_rejected", echoInkProviderFailure: poor }), "Not enough AI points. Check in to earn AI points, then try again.");
  setXiaoechoLanguageProbe(() => "zh-CN");
  assert.equal(xiaoechoProviderFailureText(busy), "模型服务暂时不可用。请稍后重试。");
  console.log("PASS xiaoecho busy retry decision and fixed-code failure text (zh + en)");
}
