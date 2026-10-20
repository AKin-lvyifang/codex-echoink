export function pdfLanguage(value: string): string {
  const label = value.trim();
  if (!label || label.length > 40 || [...label].some(char => char.charCodeAt(0) < 32) || /[\\/:*?"<>|#[\]]/u.test(label)) throw new Error("请填写明确的翻译目标语言。");
  if (/^(en|english|英语|英文)$/iu.test(label)) return "英文";
  if (/^(zh|zh-cn|chinese|中文|汉语|简体中文)$/iu.test(label)) return "中文";
  return label;
}

/** Conservative script evidence; ambiguous/multilingual text remains unidentified. */
export function pdfSourceLanguage(text: string): string {
  const clean = text.replace(/!?\[[^\]]*\]\([^)]*\)|https?:\S+|```[\s\S]*?```/gu, " ");
  if ([...clean].some(char => /\p{Letter}/u.test(char) && !/[\p{Script=Han}\p{Script=Latin}]/u.test(char))) return "未确定";
  const han = (clean.match(/\p{Script=Han}/gu) ?? []).length;
  const latin = (clean.match(/[a-z]/giu) ?? []).length;
  if (han >= 20 && han > latin) return "中文";
  // Script alone cannot distinguish English from other Latin languages.
  if (han === 0 && latin >= 50 && (clean.match(/\b(the|and|with|from|this|that|is|are|of|for)\b/giu) ?? []).length >= 8) return "英文";
  return "未确定";
}
