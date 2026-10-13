import { existsSync } from "node:fs";
import type CodexForObsidianPlugin from "../../main";
import type {
  PiChatPreparedDocument,
  PiChatPreparedImage,
  PiConversationDraftRecord,
  PiConversationProjection,
  PiConversationSupportState
} from "../../harness/pi-native/contracts";
import { piEntryIdFromProjectedMessageId } from "../../harness/pi-native/pi-chat-ui-projector";
import {
  sanitizeStoredPiDocumentReplay,
  sanitizeStoredPiImageAttachments,
  type ChatMessage,
  type StoredAttachment,
  type StoredPiDocumentReplayMetadata,
  type StoredPiImageAttachmentMetadata,
  type StoredSession
} from "../../settings/settings";
import { attachmentDisplayName } from "./attachment-resource";

interface PiConversationUiState {
  readonly supportByConversation: Map<string, PiConversationSupportState>;
  readonly selectedDraftByConversation: Map<string, string>;
  readonly recoveringConversations: Set<string>;
}

const stateByPlugin = new WeakMap<
  CodexForObsidianPlugin,
  PiConversationUiState
>();

export function rememberPiConversationProjection(
  plugin: CodexForObsidianPlugin,
  projection: Readonly<PiConversationProjection>
): PiConversationSupportState {
  return rememberPiConversationSupport(plugin, {
    catalog: projection.catalog,
    diagnostics: projection.diagnostics,
    drafts: projection.drafts
  });
}

export function rememberPiConversationSupport(
  plugin: CodexForObsidianPlugin,
  support: Readonly<PiConversationSupportState>
): PiConversationSupportState {
  const state = requireState(plugin);
  const snapshot = cloneSupportState(support);
  state.supportByConversation.set(
    snapshot.catalog.conversationId,
    snapshot
  );
  const selectedDraftId = state.selectedDraftByConversation.get(
    snapshot.catalog.conversationId
  );
  if (
    selectedDraftId
    && !snapshot.drafts.some((draft) => draft.draftId === selectedDraftId)
  ) {
    state.selectedDraftByConversation.delete(snapshot.catalog.conversationId);
  }
  return cloneSupportState(snapshot);
}

export async function refreshPiConversationSupport(
  plugin: CodexForObsidianPlugin,
  conversationId: string
): Promise<PiConversationSupportState> {
  return rememberPiConversationSupport(
    plugin,
    await plugin.readPiConversationSupportState(conversationId)
  );
}

export function piConversationSupport(
  plugin: CodexForObsidianPlugin,
  conversationId: string
): PiConversationSupportState | null {
  const support = requireState(plugin).supportByConversation.get(conversationId);
  return support ? cloneSupportState(support) : null;
}

export function selectPiConversationDraft(
  plugin: CodexForObsidianPlugin,
  conversationId: string,
  draftId: string
): PiConversationDraftRecord | null {
  const state = requireState(plugin);
  const draft = state.supportByConversation
    .get(conversationId)
    ?.drafts.find((candidate) => candidate.draftId === draftId);
  if (!draft) return null;
  state.selectedDraftByConversation.set(conversationId, draftId);
  return { ...draft };
}

export function selectedPiConversationDraftId(
  plugin: CodexForObsidianPlugin,
  conversationId: string
): string | undefined {
  const state = requireState(plugin);
  const draftId = state.selectedDraftByConversation.get(conversationId);
  if (!draftId) return undefined;
  const exists = state.supportByConversation
    .get(conversationId)
    ?.drafts.some((draft) => draft.draftId === draftId);
  if (exists) return draftId;
  state.selectedDraftByConversation.delete(conversationId);
  return undefined;
}

export function clearSelectedPiConversationDraft(
  plugin: CodexForObsidianPlugin,
  conversationId: string
): void {
  requireState(plugin).selectedDraftByConversation.delete(conversationId);
}

export function setPiConversationRecovering(
  plugin: CodexForObsidianPlugin,
  conversationId: string,
  recovering: boolean
): void {
  const state = requireState(plugin);
  if (recovering) state.recoveringConversations.add(conversationId);
  else state.recoveringConversations.delete(conversationId);
}

export function isPiConversationRecovering(
  plugin: CodexForObsidianPlugin,
  conversationId: string
): boolean {
  return requireState(plugin).recoveringConversations.has(conversationId);
}

export function recordPiImageAttachmentsForEntry(
  session: StoredSession,
  entryIdValue: string,
  images: readonly Readonly<PiChatPreparedImage>[]
): void {
  const entryId = entryIdValue.trim();
  if (!entryId || !images.length) return;
  const metadata = images.map(({ attachment }, index) => Object.freeze({
    name: attachmentDisplayName(attachment, index),
    path: attachment.path,
    mimeType: attachment.mimeType,
    availability: localAttachmentAvailability(attachment.path)
  }));
  const normalized = sanitizeStoredPiImageAttachments({
    ...(session.piImageAttachments ?? {}),
    [entryId]: metadata
  });
  if (normalized) session.piImageAttachments = normalized;
}

export function recordPiDocumentReplayForEntry(
  session: StoredSession,
  entryIdValue: string,
  documents: readonly Readonly<PiChatPreparedDocument>[]
): void {
  const entryId = entryIdValue.trim();
  if (!entryId || !documents.length) return;
  const replay = documents.filter(document => document.transport !== "tool_reference").map((document) => {
    const text = document.text?.trim() || null;
    return Object.freeze({
      name: document.attachment.name,
      mimeType: document.attachment.mimeType,
      sizeBytes: document.attachment.sizeBytes,
      kind: document.kind,
      sha256: document.sha256,
      text
    });
  });
  const normalized = sanitizeStoredPiDocumentReplay({
    ...(session.piDocumentReplay ?? {}),
    [entryId]: replay
  });
  if (normalized) session.piDocumentReplay = normalized;
}

export function projectPiImageAttachments(
  session: Readonly<StoredSession>,
  messages: readonly Readonly<ChatMessage>[]
): ChatMessage[] {
  return messages.map((message) => {
    if (message.role !== "user" || !message.images?.length) {
      return { ...message };
    }
    const entryId = piEntryIdFromProjectedMessageId(message.id);
    const metadata = entryId
      ? session.piImageAttachments?.[entryId]
      : undefined;
    return {
      ...message,
      images: message.images.map((fallback, index) =>
        localPiImageAttachment(metadata?.[index], fallback, index)
      )
    };
  });
}

export function copyPiImageAttachmentsForProjection(
  source: Readonly<StoredSession>,
  target: StoredSession,
  messages: readonly Readonly<ChatMessage>[]
): void {
  const copied: Record<string, readonly StoredPiImageAttachmentMetadata[]> = {};
  for (const message of messages) {
    if (message.role !== "user" || !message.images?.length) continue;
    const entryId = piEntryIdFromProjectedMessageId(message.id);
    const metadata = entryId
      ? source.piImageAttachments?.[entryId]
      : undefined;
    if (entryId && metadata?.length) {
      copied[entryId] = metadata.map((attachment) => ({ ...attachment }));
    }
  }
  const normalized = sanitizeStoredPiImageAttachments(copied);
  if (normalized) target.piImageAttachments = normalized;
  else delete target.piImageAttachments;

  const documentReplay: Record<
    string,
    readonly StoredPiDocumentReplayMetadata[]
  > = {};
  for (const message of messages) {
    if (message.role !== "user" || !message.attachments?.length) continue;
    const entryId = piEntryIdFromProjectedMessageId(message.id);
    const replay = entryId ? source.piDocumentReplay?.[entryId] : undefined;
    if (entryId && replay?.length) {
      documentReplay[entryId] = replay.map((document) => ({ ...document }));
    }
  }
  const normalizedReplay = sanitizeStoredPiDocumentReplay(documentReplay);
  if (normalizedReplay) target.piDocumentReplay = normalizedReplay;
  else delete target.piDocumentReplay;
}

export function piComposerImageAttachmentsForEntry(
  session: Readonly<StoredSession>,
  entryIdValue: string
): StoredAttachment[] {
  const entryId = entryIdValue.trim();
  const metadata = session.piImageAttachments?.[entryId] ?? [];
  const images = metadata.map((attachment, index) => {
    const projected: StoredAttachment = {
      type: "image",
      name: attachment.name,
      path: attachment.path,
      mimeType: attachment.mimeType,
      availability: localAttachmentAvailability(attachment.path)
    };
    return {
      ...projected,
      name: attachmentDisplayName(projected, index)
    };
  });
  // Existing Branch/resend callers use this attachment-restoration seam.
  // Append durable document cards without changing the image metadata map.
  return [...images, ...piComposerDocumentAttachmentsForEntry(session, entryId)];
}

export function piComposerDocumentAttachmentsForEntry(
  session: Readonly<StoredSession>,
  entryIdValue: string
): StoredAttachment[] {
  const entryId = entryIdValue.trim();
  if (!entryId) return [];
  const message = session.messages.find((candidate) =>
    candidate.role === "user"
    && piEntryIdFromProjectedMessageId(candidate.id) === entryId
  );
  const replay = session.piDocumentReplay?.[entryId] ?? [];
  return (message?.attachments ?? [])
    .filter((attachment) => attachment.type === "file" && !attachment.path.startsWith("pdf-attachment:"))
    .map((attachment, index) => ({
      ...attachment,
      availability: localAttachmentAvailability(attachment.path),
      ...documentReplayForAttachment(replay[index], attachment)
    }));
}

function documentReplayForAttachment(
  replay: Readonly<StoredPiDocumentReplayMetadata> | undefined,
  attachment: Readonly<StoredAttachment>
): Pick<StoredAttachment, "documentReplay"> | Record<string, never> {
  return replay
    && replay.name === attachment.name
    && replay.mimeType === attachment.mimeType
    && replay.sizeBytes === attachment.sizeBytes
    ? { documentReplay: { ...replay } }
    : {};
}

function localPiImageAttachment(
  metadata: Readonly<StoredPiImageAttachmentMetadata> | undefined,
  fallback: Readonly<StoredAttachment>,
  index: number
): StoredAttachment {
  if (!metadata) {
    const projected: StoredAttachment = {
      ...fallback,
      type: "image",
      name: fallback.name || `图片 ${index + 1}`,
      availability: localAttachmentAvailability(fallback.path)
    };
    return {
      ...projected,
      name: attachmentDisplayName(projected, index)
    };
  }
  const projected: StoredAttachment = {
    type: "image",
    name: metadata.name,
    path: metadata.path,
    mimeType: metadata.mimeType,
    availability: localAttachmentAvailability(metadata.path)
  };
  return {
    ...projected,
    name: attachmentDisplayName(projected, index)
  };
}

function localAttachmentAvailability(
  attachmentPath: string
): NonNullable<StoredAttachment["availability"]> {
  return attachmentPath.trim() && existsSync(attachmentPath)
    ? "available"
    : "unavailable";
}

function requireState(plugin: CodexForObsidianPlugin): PiConversationUiState {
  let state = stateByPlugin.get(plugin);
  if (!state) {
    state = {
      supportByConversation: new Map(),
      selectedDraftByConversation: new Map(),
      recoveringConversations: new Set()
    };
    stateByPlugin.set(plugin, state);
  }
  return state;
}

function cloneSupportState(
  support: Readonly<PiConversationSupportState>
): PiConversationSupportState {
  return {
    catalog: { ...support.catalog },
    diagnostics: support.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    drafts: support.drafts.map((draft) => ({ ...draft }))
  };
}
