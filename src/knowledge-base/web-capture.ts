const URL_PATTERN = /https?:\/\/[^\s<>"')]+/i;

export function extractFirstUrl(value: string): string | null {
  return value.match(URL_PATTERN)?.[0] ?? null;
}

export function isWeChatUrl(value: string): boolean {
  try {
    return new URL(value).hostname === "mp.weixin.qq.com";
  } catch {
    return false;
  }
}

export function stripCollectPrefix(value: string): string {
  return value.replace(/^(收集|收藏|剪藏|保存到\s*raw|网页收藏|公众号收集)[:：\s]*/i, "").trim();
}

export function isHtmlVerificationBlocked(html: string): boolean {
  return /环境异常|wappoc_appmsgcaptcha|完成验证后即可继续访问|captcha/i.test(html);
}

export function extractArticleMarkdown(html: string, url: string): { title: string; markdown: string } {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  for (const selector of ["script", "style", "noscript", "svg", "iframe"]) {
    for (const node of Array.from(doc.querySelectorAll(selector))) node.remove();
  }
  const title = cleanInlineText(
    doc.querySelector("meta[property='og:title']")?.getAttribute("content")
    || doc.querySelector("title")?.textContent
    || new URL(url).hostname
  );
  const content = doc.querySelector("#js_content") || doc.querySelector("article") || doc.querySelector("main") || doc.body;
  const markdown = content ? domNodeToMarkdown(content).replace(/\n{3,}/g, "\n\n").trim() : "";
  return { title, markdown };
}

export function sanitizeWebCaptureFileName(value: string): string {
  return cleanInlineText(value).replace(/[\\/:*?"<>|#\[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "未命名资料";
}

function domNodeToMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return cleanTextNode(node.textContent ?? "");
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  const children = Array.from(el.childNodes).map(domNodeToMarkdown).join("");
  if (tag === "br") return "\n";
  if (/^h[1-6]$/.test(tag)) return `\n\n${"#".repeat(Number(tag.slice(1)))} ${cleanInlineText(children)}\n\n`;
  if (tag === "p" || tag === "section" || tag === "div" || tag === "article") return children.trim() ? `\n\n${children.trim()}\n\n` : "";
  if (tag === "li") return `\n- ${children.trim()}`;
  if (tag === "blockquote") return children.trim().split("\n").map((line) => `> ${line.trim()}`).join("\n");
  if (tag === "a") {
    const href = el.getAttribute("href");
    const text = cleanInlineText(children) || href || "";
    return href ? `[${text}](${href})` : text;
  }
  if (tag === "img") {
    const src = el.getAttribute("data-src") || el.getAttribute("src");
    const alt = el.getAttribute("alt") || "image";
    return src ? `\n\n![${alt}](${src})\n\n` : "";
  }
  if (tag === "pre" || tag === "code") return `\n\n\`\`\`\n${el.textContent?.trim() ?? ""}\n\`\`\`\n\n`;
  return children;
}

function cleanTextNode(value: string): string {
  return value.replace(/\s+/g, " ");
}

function cleanInlineText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
