const EXPLANATION_PREFIXES = [
  /^改写如下[:：]\s*/i,
  /^扩写如下[:：]\s*/i,
  /^续写如下[:：]\s*/i,
  /^以下是(?:改写|扩写|续写)(?:后的)?内容[:：]\s*/i,
  /^当然可以，?以下是(?:改写|扩写|续写)(?:后的)?内容[:：]\s*/i,
  /^好的，?以下是(?:改写|扩写|续写)(?:后的)?内容[:：]\s*/i,
  /^候选文本[:：]\s*/i,
  /^结果[:：]\s*/i
];

export function cleanEditorActionOutput(value: string): string {
  let text = value.replace(/\r\n/g, "\n").trim();
  text = extractCandidateTag(text) ?? text;
  text = stripOuterFence(text).trim();
  for (const prefix of EXPLANATION_PREFIXES) {
    text = text.replace(prefix, "").trimStart();
  }
  return text.trim();
}

function extractCandidateTag(value: string): string | null {
  const match = value.match(/<codex-candidate>\s*([\s\S]*?)\s*<\/codex-candidate>/i);
  return match ? match[1] : null;
}

function stripOuterFence(value: string): string {
  const match = value.match(/^```[A-Za-z0-9_-]*\n([\s\S]*?)\n```$/);
  return match ? match[1] : value;
}
