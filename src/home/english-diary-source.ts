import { renderNativeJournalTemplate } from "./native-journal";
import { journalContentLines } from "./workbench-journal";
import { workbenchFingerprint, type JournalTemplateBaseline } from "./workbench-records";

/** Recognize the saved template, including a time token rendered earlier today. */
export function hasEnglishDiarySourceContent(content: string, input: {
  template: string; now: Date; title: string;
  formats: { templateDateFormat: string; templateTimeFormat: string };
  baseline?: JournalTemplateBaseline;
}): boolean {
  const lines = journalContentLines(content);
  if (input.baseline) {
    const remaining = [...input.baseline.lines];
    return lines.some(line => {
      const index = remaining.indexOf(workbenchFingerprint(line));
      if (index < 0) return true;
      remaining.splice(index, 1); return false;
    });
  }
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const patterns = journalContentLines(input.template).map(line => {
    const parts = line.split(/(\{\{(?:date|time)(?::[^}]+)?\}\}|\{\{title\}\})/giu);
    const pattern = parts.map(part => {
      const rendered = renderNativeJournalTemplate(part, input.now, input.title, input.formats);
      if (!/^\{\{(?:date|time)(?::[^}]+)?\}\}$/iu.test(part)) return escape(rendered);
      // Only token output varies; fixed template text and user additions remain exact.
      return escape(rendered).replace(/\d+/gu, "\\d+").replace(/AM|PM/gu, "(?:AM|PM)").replace(/am|pm/gu, "(?:am|pm)").replace(/上午|下午/gu, "(?:上午|下午)");
    }).join("");
    return new RegExp(`^${pattern}$`, "u");
  });
  return lines.some(line => {
    const index = patterns.findIndex(pattern => pattern.test(line));
    if (index < 0) return true;
    patterns.splice(index, 1); return false;
  });
}
