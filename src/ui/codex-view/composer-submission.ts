import type { SelectionDraft } from "../../selection-ask/draft";
import type { StoredAttachment } from "../../settings/settings";
import type { EchoInkResource } from "../../resources/types";
import type { NoteMentionSelection } from "./note-mentions";

/** Local editor state moves with the submission; no View or DOM is retained. */
export interface DesktopComposerDraft {
  drawingRequested?: boolean;
  text: string;
  annotations: SelectionDraft;
  attachments: StoredAttachment[];
  noteMentions: readonly NoteMentionSelection[];
  selectedSkill: EchoInkResource | null;
}
