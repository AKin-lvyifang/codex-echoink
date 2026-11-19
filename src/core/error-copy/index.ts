/**
 * 报错文案统一入口。用户能看到的报错只从这里取：
 * - CAUSE：根因句（同一根因全插件同一句话）
 * - NEXT：标准下一步
 * - codes/：内部错误代码 → 根因句，按领域分文件
 * - compose：把任意异常翻成用户能看懂的话；场景句 + 根因/下一步
 * 规范：docs/claude建议/报错文案规范.md
 */
export { CAUSE, type CauseId } from "./causes";
export { NEXT, type NextStep } from "./next";
export { knownCopyBySentence, lookupErrorCode } from "./codes";
export { mcpDiagnosticText } from "./codes/mcp";
export { errorCopyLanguage, pickErrorCopy, type ErrorCopy, type ErrorCopyLanguage } from "./types";
export { ACTION_FAILED, actionFailureText, errorText, failureText, joinErrorCopy, normalizeProviderTerm, rawErrorText, settingsErrorText, userFacingErrorText } from "./compose";
