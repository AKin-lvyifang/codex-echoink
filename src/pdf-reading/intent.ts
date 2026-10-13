/** Explicit processing can refer to an attached PDF without repeating its format. */
export function isPdfReadingIntent(text: string, hasPdfAttachment = false): boolean {
  const request = text.trim();
  if (/^PDF 精读[:：]/u.test(request)) return true;
  if (/(?:不要|无需|不用|别)(?:再)?(?:提取|精读|解析|翻译)/u.test(request)) return false;
  const action = /提取|精读|解析|翻译|\bextract\b|\btranslate\b|\bclose[ -]read\b/iu.test(request);
  if (!action || !hasPdfAttachment && !/\bPDF\b/iu.test(request)) return false;
  // Capability/explanatory questions remain ordinary document questions.
  if (/(?:如何|怎么|为什么|什么是).{0,12}(?:提取|精读|解析|翻译)|(?:提取|精读|解析|翻译).{0,8}(?:原理|是什么|是什么意思)/u.test(request)) return false;
  return /\bPDF\b/iu.test(request) || /这个|这份|这篇|这本|此文|该文|附件|上传|附加|\b(this|attached|uploaded)\b/iu.test(request)
    || /^(?:请|帮我|直接|仅|只|先|麻烦)*(?:提取|精读|解析|翻译)(?:一下)?[。！.!]?$/u.test(request);
}
