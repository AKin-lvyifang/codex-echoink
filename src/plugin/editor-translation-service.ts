import { CAUSE } from "../core/error-copy";
const TRANSLATION_TIMEOUT_MS = 45_000;

export interface EditorTranslationPort {
  generateEnglishTranslation(input: Readonly<{
    systemPrompt: string;
    userPrompt: string;
    timeoutMs: number;
  }>): Promise<string>;
}

export class EditorTranslationService {
  private running = false;

  constructor(private readonly port: EditorTranslationPort) {}

  get active(): boolean { return this.running; }

  async translate(selectedText: string): Promise<string> {
    if (!selectedText.trim()) throw new Error("translation_selection_empty");
    if (this.running) {
      throw new Error(CAUSE.busyAnswering[0]);
    }
    this.running = true;
    try {
      const result = await this.port.generateEnglishTranslation({
        systemPrompt: [
          "Translate the user's selected Markdown text into natural English.",
          "Return only the translated text.",
          "Preserve Markdown syntax, links, code spans, line breaks, and meaning.",
          "Do not explain, quote, wrap in a code fence, or add content."
        ].join(" "),
        userPrompt: selectedText,
        timeoutMs: TRANSLATION_TIMEOUT_MS
      });
      if (!result.trim()) throw new Error("translation_output_empty");
      return result;
    } finally {
      this.running = false;
    }
  }
}
