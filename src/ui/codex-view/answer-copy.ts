import type { ChatMessage } from "../../settings/settings";

export type ReadRawAnswerText = (rawRef: string) => Promise<string>;
export type WriteClipboardText = (text: string) => Promise<void>;

export type AnswerCopyResult =
  | { status: "success" }
  | { status: "failure"; error: unknown };

export async function resolveAnswerMarkdown(
  message: Pick<ChatMessage, "text" | "rawRef">,
  readRaw: ReadRawAnswerText
): Promise<string> {
  if (message.rawRef) return await readRaw(message.rawRef);
  return message.text;
}

export async function copyAnswerMarkdown(
  message: Pick<ChatMessage, "text" | "rawRef">,
  readRaw: ReadRawAnswerText,
  writeText: WriteClipboardText
): Promise<AnswerCopyResult> {
  try {
    const markdown = await resolveAnswerMarkdown(message, readRaw);
    await writeText(markdown);
    return { status: "success" };
  } catch (error) {
    return { status: "failure", error };
  }
}
