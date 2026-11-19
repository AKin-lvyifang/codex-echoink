import { pickErrorCopy } from "../core/error-copy";
import { PROVIDER_CODES } from "../core/error-copy/codes/provider";

export type ToolCallTextFailureCode = "model_tool_call_text_disabled" | "model_tool_call_text_incompatible";

/** Sentence from core/error-copy/codes/provider.ts; Chinese unless a language is given. */
export function toolCallTextFailureMessage(code: unknown, language?: string): string | undefined {
  if (code !== "model_tool_call_text_disabled" && code !== "model_tool_call_text_incompatible") return undefined;
  return pickErrorCopy(PROVIDER_CODES[code], language);
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
