/** Deliberately narrow: entity naming remains a model judgment. */
export const MAINTENANCE_SHORT_TITLE_POLICY = "short-name-v1" as const;
export type MaintenanceTitlePolicy = typeof MAINTENANCE_SHORT_TITLE_POLICY;

export function assertMaintenanceShortTitle(title: string, context: string): void {
  if (/[:：]/u.test(title) || /^.+?\s*的\s*适用场景与限制\s*$/u.test(title)) {
    throw new Error(`${context} 标题须用知识条目短名，不带中英文冒号副标题或“XX 的适用场景与限制”；请改短名，把文章角度写进导语后重发，知识点ID可沿用。`);
  }
}

export function assertMaintenanceShortTarget(targetPath: string): void {
  assertMaintenanceShortTitle(targetPath.split("/").at(-1)!.replace(/\.(?:md|markdown)$/iu, ""), `targetPath=${JSON.stringify(targetPath)}`);
}
