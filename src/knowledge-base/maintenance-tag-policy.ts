import { readMaintenanceFrontmatterProperty } from "./maintenance-source-frontmatter";

function bodyTags(content: string): string[] {
  const body = content.replace(
    /^\uFEFF?---[^\S\r\n]*\r?\n[\s\S]*?^(?:---|\.\.\.)[^\S\r\n]*(?:\r?\n|$)/mu,
    "",
  );
  let fence: string | undefined;
  const visible = body
    .split(/\r?\n/u)
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
      if (fence) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
        return "";
      }
      if (marker) {
        fence = marker;
        return "";
      }
      return /^ {4}|^\t/u.test(line) ? "" : line;
    })
    .join("\n")
    .replace(/<!--[\s\S]*?-->|`+[^`]*`+/gu, "");
  return [...visible.matchAll(/(?:^|[\s(（])#([\p{L}\p{N}_/-]+)/gu)]
    .map((match) => match[1])
    .filter((tag) => !/^\d+$/u.test(tag))
    .sort();
}

/** Enforce user ownership for new pages and additions/replacements to old pages. */
export function assertMaintenanceWikiTags(content: string, baseline?: string): void {
  for (const key of ["tags", "tag"]) {
    const current = readMaintenanceFrontmatterProperty(content, key);
    const prior =
      baseline === undefined
        ? { present: false, value: undefined, error: undefined }
        : readMaintenanceFrontmatterProperty(baseline, key);
    if (
      current.present !== prior.present ||
      JSON.stringify(current.value) !== JSON.stringify(prior.value) ||
      current.error !== prior.error
    )
      throw new Error("通用Wiki标签只属于用户，不能新增、修改或删除tag/tags属性。");
  }
  if (JSON.stringify(bodyTags(content)) !== JSON.stringify(bodyTags(baseline ?? "")))
    throw new Error("通用Wiki标签只属于用户，不能新增、修改或删除正文标签。");
}
