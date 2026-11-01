import type { JournalFormatError } from "./journal-format";
import type { JournalKeepReason } from "./journal-organization";
export function journalFormatCopy(language: string) {
  const en = language === "en", t = (zh: string, english: string) => en ? english : zh;
  return {
    t, folder: t("日记文件夹", "Journal folder"), format: t("文件名格式", "File name format"), template: t("默认模板", "Default template"),
    templates: t("日记模板", "Journal templates"), custom: t("自定义…", "Custom…"), root: t("库根目录", "Vault root"), none: t("未选模板", "No template selected"),
    today: t("今天", "Today"), organize: t("整理老日记", "Organize old journals"), journal: t("日记", "Journal"), view: t("查看", "View"),
    move: t("改到新位置", "Move to new location"), ai: t("需要 AI 判断日期", "Dates needing AI"), keep: t("保留原处", "Keep in place"),
    identify: t("用 AI 判断", "Use AI"), identifying: t("判断中", "Identifying"), waiting: t("等待判断", "Waiting"), undo: t("撤销", "Undo"), finish: t("完成", "Done"),
    modelMissing: t("尚未配置当前模型，程序能认出的照常整理", "No model configured. Recognized journals can still be organized."),
    empty: t("没有需要整理的老日记", "No old journals need organizing"), loading: t("正在读取…", "Loading…"),
    more: (n: number) => t(`… 另外 ${n} 篇`, `… ${n} more`), count: (n: number) => t(`${n} 个`, String(n)),
    off: (n: number) => t(`${n} 篇老日记不在这个格式下`, `${n} old journals use a different format`),
    moved: (n: number) => t(`已整理 ${n} 篇`, `Organized ${n} journals`), all: (n: number) => t(`查看全部 ${n} 篇`, `View all ${n} journals`),
    quota: (n: number, model: string) => t(`会读这 ${n} 篇的正文，使用当前模型 ${model} 的额度`, `Reads the contents of ${n} journals and uses your current model ${model}'s quota`),
    run: (n: number) => t(`开始整理 ${n} 篇`, `Organize ${n} journals`),
    complete: (n: number, kept: number) => t(`已整理 ${n} 篇，${kept} 篇保留原处`, `Organized ${n} journals; ${kept} kept in place`),
    undone: (n: number) => t(`已撤销 ${n} 篇，回到原位置`, `Restored ${n} journals to their original locations`),
    partialUndo: (n: number, kept: number) => t(`已撤销 ${n} 篇，${kept} 篇未撤销`, `Restored ${n} journals; ${kept} could not be restored`),
    beforeAi: t("AI 判断前也可以先整理，没判断的保留原处", "You can organize first; journals awaiting AI stay in place"),
    aiOnly: t("先用 AI 判断，认出日期的才能整理", "Use AI first to identify dates before organizing"),
    interrupted: t("上次整理未完成，已移动的日记可以撤销", "The previous operation was interrupted. Moved journals can be restored."),
    reason: (reason: JournalKeepReason) => ({
      duplicate: t("同一天有两篇", "Multiple journals for the same day"), occupied: t("已有同名日记", "Target already exists"), parent: t("文件占用了目标文件夹", "A file occupies the destination folder"),
      unknown: t("认不出日期，保留原处", "Date unknown; kept in place"), changed: t("文件或设置已变化，保留原处", "File or settings changed; kept in place"),
      missing: t("文件已移动或丢失", "File moved or missing"), edited: t("文件已改过，保留现状", "File edited; left unchanged"), links: t("链接尚未就绪，保留原处", "Links not ready; kept in place"),
      failed: t("未能完成，请重新核对", "Could not finish; check again")
    })[reason] ?? t("保留原处", "Kept in place"),
    invalid: (error: JournalFormatError) => ({ empty: t("不能为空", "Cannot be empty"), date: t("需要同时包含 YYYY、MM、DD", "Include YYYY, MM and DD"),
      path: t('不能包含 .. 、开头的 / 或 \\ : * ? " < > |', 'Cannot contain .., a leading /, or \\ : * ? " < > |'), time: t("不支持时间字段", "Time fields are not supported"), fields: t("不支持的日期字段", "Unsupported date fields") })[error],
    error: (message: string) => ({
      journal_links_disabled: t("请在 Obsidian 设置 → 文件与链接中开启“自动更新内部链接”，再开始整理。", "Enable Automatically update internal links in Obsidian Settings → Files and links, then retry."),
      journal_model_missing: t("请先配置当前模型服务", "Configure a model first"), journal_parent_occupied: t("文件占用了目标文件夹", "A file occupies the destination folder"),
      journal_target_occupied: t("目标位置已被占用", "The destination is occupied"), journal_template_missing: t("模板不存在或位置已被占用", "Template missing or path occupied"),
      journal_settings_changed: t("日记设置已变化，请重新预览", "Journal settings changed. Preview again."), journal_source_changed: t("日记已变化，请重新预览", "Journal changed. Preview again."),
      journal_record_invalid: t("整理记录损坏，保留现状", "Organization record is invalid. Files were left unchanged."), journal_record_changed: t("整理记录保存未确认，保留现状", "Could not confirm the organization record. Files were left unchanged."),
      journal_previous_record: t("上次整理未完成，请先核对或撤销", "Check or restore the interrupted operation first"), journal_busy: t("正在整理，请稍后再试", "An operation is running. Try again later."),
      journal_cancelled: t("已停止，已移动的日记可撤销", "Stopped. Moved journals can be restored."), journal_plan_missing: t("请重新预览整理清单", "Preview the organization plan again")
    } as Record<string, string>)[message] ?? t("操作未完成，请核对模型连接或文件状态后重试", "Operation could not finish. Check the model connection and file state, then retry")
  };
}
