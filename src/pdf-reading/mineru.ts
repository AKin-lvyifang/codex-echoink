import { unzipSync, strFromU8 } from "fflate/browser";
import { requestUrl } from "obsidian";
import { pdfAbort, type PdfExtraction, type PdfJob } from "./types";

const API = "https://mineru.net/api/v4";
export interface MinerTransport {
  request(url: string, method: string, headers?: Record<string, string>, body?: string | ArrayBuffer): Promise<{ status: number; json?: unknown; bytes?: ArrayBuffer }>;
  wait(signal: AbortSignal): Promise<void>;
}
export const minerTransport: MinerTransport = {
  async request(url, method, headers, body) {
    const response = await requestUrl({ url, method, headers, body, throw: false });
    let json: unknown;
    try { json = response.json; } catch { /* ZIP and upload responses need no JSON. */ }
    return { status: response.status, json, bytes: response.arrayBuffer };
  },
  wait: signal => new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(new Error("处理已取消。")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, 2500);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  })
};
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
function data(response: { status: number; json?: unknown }): RecordValue {
  const value = record(response.json);
  if (response.status < 200 || response.status >= 300 || value.code !== 0) throw new Error(`MinerU 请求失败（${response.status}），请检查专用 Token、额度或服务状态。`);
  return record(value.data);
}
function secureUrl(value: unknown): string {
  if (typeof value !== "string" || new URL(value).protocol !== "https:") throw new Error("MinerU 返回了无效的下载或上传地址。");
  return value;
}

export async function extractMinerPdf(job: PdfJob, bytes: Uint8Array | undefined, token: string, signal: AbortSignal,
  persist: () => Promise<void>, progress: (stage: string) => void, transport: MinerTransport = minerTransport
): Promise<PdfExtraction> {
  if (!token.trim()) throw new Error("请先在 PDF 插件设置填写 MinerU 专用 Token。");
  const headers = { Authorization: `Bearer ${token.trim()}`, "Content-Type": "application/json" };
  pdfAbort(signal);
  if (!job.batchId) {
    if (!bytes) throw new Error("临时 PDF 已清理，请重新选择文件。");
    progress("向 MinerU 申请单文件解析");
    const result = data(await transport.request(`${API}/file-urls/batch`, "POST", headers,
      JSON.stringify({ files: [{ name: job.name, data_id: job.id, is_ocr: true }], model_version: "vlm", enable_formula: true, enable_table: true, language: "auto" })));
    if (typeof result.batch_id !== "string" || !Array.isArray(result.file_urls) || result.file_urls.length !== 1) throw new Error("MinerU 未返回单文件上传任务。");
    job.batchId = result.batch_id; job.uploadState = "prepared"; job.uploadUrl = secureUrl(result.file_urls[0]);
    // Persist identity before any upload, so an uncertain PUT is never repeated.
    await persist();
  }
  if (job.uploadState === "prepared") {
    pdfAbort(signal);
    if (!bytes || !job.uploadUrl) throw new Error("此任务尚未上传。请重新选择同一 PDF，再点继续；将复用原 MinerU 任务。");
    job.uploadState = "uncertain"; await persist();
    const uploaded = await transport.request(secureUrl(job.uploadUrl), "PUT", { "Content-Type": "application/pdf" }, new Uint8Array(bytes).buffer);
    if (uploaded.status < 200 || uploaded.status >= 300) throw new Error("MinerU 上传未确认，任务 ID 已保留；继续查询，不自动重复上传。");
    job.uploadState = "uploaded"; delete job.uploadUrl; await persist();
  }
  for (let attempt = 0; attempt < 48; attempt++) {
    pdfAbort(signal);
    const status = data(await transport.request(`${API}/extract-results/batch/${encodeURIComponent(job.batchId)}`, "GET", headers));
    const results = Array.isArray(status.extract_result) ? status.extract_result.map(record) : [];
    const result = results.find(value => value.data_id === job.id) ?? (results.length === 1 ? results[0] : undefined);
    if (result?.state === "done") {
      progress("下载 MinerU 解析结果");
      const response = await transport.request(secureUrl(result.full_zip_url), "GET");
      pdfAbort(signal);
      if (response.status !== 200 || !response.bytes) throw new Error("MinerU 结果下载失败，可继续查询原任务。");
      return parseMinerPackage(new Uint8Array(response.bytes));
    }
    if (result?.state === "failed") throw new Error("MinerU 解析失败，请在 MinerU 核对原任务；不会自动重复上传。");
    progress(`MinerU：${result?.state === "running" ? "解析中" : "排队或等待上传确认"}`);
    await transport.wait(signal);
  }
  throw new Error("MinerU 尚未完成，任务 ID 已保留；可点击继续查询，无需重新上传。");
}

/** Hosted content_list uses page_idx. Reject unknown layouts instead of inventing pagination. */
export function parseMinerPackage(zip: Uint8Array): PdfExtraction {
  let total = 0;
  const files = unzipSync(zip, { filter: info => {
    total += info.originalSize;
    if (total > 300 * 1024 * 1024 || info.originalSize > 50 * 1024 * 1024) throw new Error("解析结果包过大。");
    if (info.name.startsWith("/") || info.name.split(/[\\/]/u).some(value => value === "..")) throw new Error("解析结果包路径无效。");
    return true;
  } });
  const listName = Object.keys(files).find(name => /(?:^|\/)\w*content_list(?:_v\d+)?\.json$/u.test(name))
    ?? Object.keys(files).find(name => /content_list\.json$/u.test(name));
  if (!listName) throw new Error("解析包缺少带真实页码的 content_list，未将 Markdown 推测成分页正文。");
  const list: unknown = JSON.parse(strFromU8(files[listName]));
  if (!Array.isArray(list)) throw new Error("MinerU 结构化结果格式尚不支持。");
  const result: PdfExtraction = { pages: [], images: [], warnings: [], engine: "mineru" };
  const prefix = listName.slice(0, listName.lastIndexOf("/") + 1);
  const pages = new Map<number, string[]>();
  const savedImages = new Map<string, string>();
  const image = (source: unknown): string => {
    if (typeof source !== "string" || !source) return "";
    const normalized = source.replace(/^\.\//u, "");
    const bytes = files[prefix + normalized] ?? files[normalized];
    if (!bytes || !/\.(png|jpe?g|webp)$/iu.test(normalized)) throw new Error("解析包图片缺失或格式不支持，未保存失效图片引用。");
    if (!savedImages.has(normalized)) {
      const target = `images/figure-${savedImages.size + 1}.${normalized.split(".").pop()!.toLowerCase()}`;
      savedImages.set(normalized, target); result.images.push({ path: target, bytes });
    }
    return `![](${savedImages.get(normalized)})`;
  };
  const strings = (value: unknown): string => Array.isArray(value) ? value.filter(x => typeof x === "string").join("\n") : typeof value === "string" ? value : "";
  for (const item of list) {
    const block = record(item);
    if (!Number.isInteger(block.page_idx) || Number(block.page_idx) < 0 || Number(block.page_idx) >= 200) throw new Error("解析包缺少有效真实页码。");
    const page = Number(block.page_idx) + 1;
    let content = "";
    switch (block.type) {
      case "text": content = `${block.text_level ? "### " : ""}${strings(block.text)}`; break;
      case "equation": content = block.text ? `$$\n${strings(block.text)}\n$$` : image(block.img_path); break;
      case "chart": content = [image(block.img_path), strings(block.chart_caption), strings(block.chart_footnote)].filter(Boolean).join("\n\n"); break;
      case "code": content = [strings(block.code_caption), block.code_body ? `\`\`\`\n${strings(block.code_body)}\n\`\`\`` : image(block.img_path), strings(block.code_footnote)].filter(Boolean).join("\n\n"); break;
      case "image": content = [image(block.img_path), strings(block.image_caption), strings(block.image_footnote)].filter(Boolean).join("\n\n"); break;
      case "table": content = [image(block.img_path), strings(block.table_caption), strings(block.table_body), strings(block.table_footnote)].filter(Boolean).join("\n\n"); break;
      case "list": content = strings(block.list_items); break;
      default: content = [strings(block.text), image(block.img_path)].filter(Boolean).join("\n\n"); result.warnings.push(`第 ${page} 页存在未专门转换的 ${String(block.type)} 结构，请核对提取内容。`);
    }
    pages.set(page, [...(pages.get(page) ?? []), content]);
  }
  if (!pages.size) throw new Error("解析结果没有可保存的分页正文。");
  result.pages = [...pages].sort(([a], [b]) => a - b).map(([number, blocks]) => ({ number, markdown: blocks.filter(Boolean).join("\n\n") }));
  return result;
}
