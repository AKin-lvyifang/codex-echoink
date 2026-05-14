const EXPLANATION_PREFIXES = [
  /^改写如下[:：]\s*/i,
  /^扩写如下[:：]\s*/i,
  /^续写如下[:：]\s*/i,
  /^翻译如下[:：]\s*/i,
  /^英文翻译[:：]\s*/i,
  /^译文[:：]\s*/i,
  /^Translation[:：]\s*/i,
  /^English translation[:：]\s*/i,
  /^Here(?:'s| is) (?:the )?(?:English )?translation[:：]\s*/i,
  /^以下是(?:改写|扩写|续写|(?:英文)?翻译)(?:后的)?(?:内容|结果)?[:：]\s*/i,
  /^当然可以，?以下是(?:改写|扩写|续写|(?:英文)?翻译)(?:后的)?(?:内容|结果)?[:：]\s*/i,
  /^好的，?以下是(?:改写|扩写|续写|(?:英文)?翻译)(?:后的)?(?:内容|结果)?[:：]\s*/i,
  /^候选文本[:：]\s*/i,
  /^结果[:：]\s*/i,
  /^最终输出[:：]\s*/i,
  /^最终结果[:：]\s*/i
];

const PROCESS_PREFIXES = [
  /^思考过程[:：]/i,
  /^推理过程[:：]/i,
  /^分析过程[:：]/i,
  /^分析[:：]/i
];

const FINAL_LABEL = /^(?:最终输出|最终结果|候选正文|输出)[:：]\s*$/i;

const DISALLOWED_OUTPUT_MARKERS = [
  /^```/,
  /^思考过程[:：]/i,
  /^推理过程[:：]/i,
  /^分析过程[:：]/i,
  /^版本\s*[一二三四五六七八九十0-9]+[:：]/i,
  /^方案\s*[一二三四五六七八九十0-9]+[:：]/i
];

export function cleanEditorActionOutput(value: string): string {
  let text = value.replace(/\r\n/g, "\n").trim();
  text = extractCandidateTag(text) ?? text;
  text = stripOuterFence(text).trim();
  text = stripProcessPrelude(text).trim();
  for (const prefix of EXPLANATION_PREFIXES) {
    text = text.replace(prefix, "").trimStart();
  }
  return text.trim();
}

export function validateEditorActionCandidateText(value: string): { ok: true } | { ok: false; reason: string } {
  const text = value.trim();
  if (!text) return { ok: false, reason: "Codex 没有返回可用候选文本" };
  if (/<\/?codex-candidate>/i.test(text)) return { ok: false, reason: "候选正文仍包含内部标签" };
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (DISALLOWED_OUTPUT_MARKERS.some((pattern) => pattern.test(line))) {
      return { ok: false, reason: "候选正文包含非最终输出内容" };
    }
  }
  return { ok: true };
}

function extractCandidateTag(value: string): string | null {
  const match = value.match(/<codex-candidate>\s*([\s\S]*?)\s*<\/codex-candidate>/i);
  return match ? match[1] : null;
}

function stripOuterFence(value: string): string {
  const match = value.match(/^```[A-Za-z0-9_-]*\n([\s\S]*?)\n```$/);
  return match ? match[1] : value;
}

function stripProcessPrelude(value: string): string {
  const lines = value.split("\n");
  const firstContentIndex = lines.findIndex((line) => line.trim());
  if (firstContentIndex < 0) return value;
  const firstContent = lines[firstContentIndex].trim();
  if (!PROCESS_PREFIXES.some((pattern) => pattern.test(firstContent))) return value;
  const finalLabelIndex = lines.findIndex((line, index) => index > firstContentIndex && FINAL_LABEL.test(line.trim()));
  if (finalLabelIndex >= 0) return lines.slice(finalLabelIndex + 1).join("\n");
  for (let index = firstContentIndex + 1; index < lines.length; index++) {
    const line = lines[index].trim();
    const inline = line.match(/^(?:最终输出|最终结果|候选正文|输出)[:：]\s*(.+)$/i);
    if (inline) return [inline[1], ...lines.slice(index + 1)].join("\n");
  }
  return value;
}
