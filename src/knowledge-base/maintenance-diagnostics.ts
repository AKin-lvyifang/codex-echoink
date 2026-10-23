/** Bounded, field-local diagnostics: never echo a full model argument or document. */
export function boundedMaintenanceMessage(message: string, bytes = 6_500): string {
  if (Buffer.byteLength(message,"utf8") <= bytes) return message;
  let text = message.slice(0,bytes);
  while (Buffer.byteLength(text,"utf8") > bytes - 120) text = text.slice(0,-1);
  return text + "\n诊断已截短；请按字段修正，区域目录用sections重新读取。";
}

export function throwMaintenanceDiagnostics(errors: readonly string[], label = "维护参数"): void {
  if (!errors.length) return;
  const shown: string[] = [];
  for (const error of errors.slice(0, 12)) {
    const line = error.length > 700 ? error.slice(0, 700) + "…" : error;
    if (Buffer.byteLength(shown.join("\n") + line, "utf8") > 5_700) break;
    shown.push(line);
  }
  throw new Error(`${label}共${errors.length}项错误，请一次修正后重试：\n${shown.join("\n")}\n${shown.length < errors.length ? `另有${errors.length - shown.length}项未展开。` : ""}`);
}
