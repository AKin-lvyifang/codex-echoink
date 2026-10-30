import { moment } from "obsidian";

interface JournalMoment {
  isValid(): boolean;
  format(format?: string): string;
}

type JournalMomentFactory = (input?: Date | string, format?: string, strict?: boolean) => JournalMoment;

/** Typed view of the host's moment, so date code stays checked when moment's own types are unavailable. */
export const journalMoment = moment as unknown as JournalMomentFactory;
