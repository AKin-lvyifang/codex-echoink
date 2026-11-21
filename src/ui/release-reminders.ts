import { ECHOINK_COMMUNITY_URI, type ReleaseNotes, type ReleaseUpdateController } from "../settings/release-update";

interface ReleaseReminderRow {
  kind: "update" | "notes";
  version: string;
  text: string;
  action: string;
  close: string;
  icon: string;
  select: () => void | Promise<void>;
  dismiss: () => void;
}

export function releaseReminderRows(
  controller: ReleaseUpdateController,
  currentVersion: string,
  language: string,
  document: Document,
  openNotes: (notes: ReleaseNotes) => void | Promise<void>
): ReleaseReminderRow[] {
  const { updateVersion, notes } = controller.reminders(currentVersion, language);
  const en = language === "en";
  const rows: ReleaseReminderRow[] = [];
  if (updateVersion) rows.push({
    kind: "update", version: updateVersion, icon: "circle-arrow-up",
    text: en ? `EchoInk ${updateVersion} is out` : `EchoInk ${updateVersion} 已发布`,
    action: en ? "Update" : "去更新",
    close: en ? "Dismiss update reminder" : "关闭更新提醒",
    select: () => { document.defaultView?.open(ECHOINK_COMMUNITY_URI, "_blank"); },
    dismiss: () => controller.dismissUpdate(updateVersion)
  });
  if (notes) rows.push({
    kind: "notes", version: notes.version, icon: "sparkles",
    text: en ? `What's new in ${notes.version}` : `${notes.version} 更新了什么`,
    action: en ? "View" : "查看",
    close: en ? "Dismiss release notes" : "关闭版本说明",
    select: () => {
      const latest = controller.reminders(currentVersion, language).notes;
      if (latest) return openNotes(latest);
    },
    dismiss: () => controller.markNotesSeen(notes.version)
  });
  return rows;
}
