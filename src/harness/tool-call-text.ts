export const TOOL_CALLING_DISABLED_MESSAGE = "当前模型未开启工具调用，无法执行。";
export type ToolCallTextFailureCode = "model_tool_call_text_disabled" | "model_tool_call_text_incompatible";

export function toolCallTextFailureMessage(code: unknown): string | undefined {
  if (code === "model_tool_call_text_disabled") return "模型把工具调用写成了文字，本轮没有执行工具。请在模型服务中开启工具调用。";
  if (code === "model_tool_call_text_incompatible") return "模型返回了工具调用文本，本轮没有执行工具。请检查代理接口的工具调用兼容性，或更换模型。";
  return undefined;
}

/** Diagnose only; text is never turned into executable calls. */
export function diagnoseToolCallText(text: string, toolsExecuted: boolean, toolCalling: boolean): ToolCallTextFailureCode | undefined {
  if (toolsExecuted) return undefined;
  const visible = outsideCode(text);
  const dsml = /<[｜|]DSML[｜|]function_calls>\s*<[｜|]DSML[｜|]invoke\s+name=["'][^"'\r\n]+["'][^>]*>[\s\S]*?<\/[｜|]DSML[｜|]invoke>\s*<\/[｜|]DSML[｜|]function_calls>/iu;
  const blocks = visible.matchAll(/<(tool_call|function_call)\b([^>]*)>([\s\S]*?)<\/\1\s*>/giu);
  const structuredBlock = [...blocks].some(([, , attrs, body]) =>
    (/"name"\s*:\s*"[^"\r\n]+"/u.test(body) && /"arguments"\s*:/u.test(body))
    || (/\bname\s*=\s*["'][^"']+["']/u.test(attrs) && /\S/u.test(body))
    || /<function(?:=|\s+name=)[^>]+>[\s\S]*<\/function>/iu.test(body));
  return dsml.test(visible) || structuredBlock
    ? toolCalling ? "model_tool_call_text_incompatible" : "model_tool_call_text_disabled"
    : undefined;
}

function outsideCode(text: string): string {
  let fence: { character: string; length: number } | undefined;
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    if (fence) {
      if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      continue;
    }
    if (marker) { fence = { character: marker[1][0], length: marker[1].length }; continue; }
    if (/^(?: {4}|\t| {0,3}>)/u.test(line)) continue;
    lines.push(line);
  }
  return lines.join("\n").replace(/(`+)[^\n]*?\1/gu, "");
}
