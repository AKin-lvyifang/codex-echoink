import * as assert from "node:assert/strict";
import { EditorTranslationService } from "../plugin/editor-translation-service";

export async function runEditorTranslationServiceTests(): Promise<void> {
  const calls: unknown[] = [];
  const service = new EditorTranslationService({
    generateEnglishTranslation: async (input) => {
      calls.push(input);
      return "\n  **Hello** world\n";
    }
  });
  assert.equal(await service.translate("**你好**世界"), "\n  **Hello** world\n");
  assert.equal(calls.length, 1);
  assert.equal((calls[0] as { timeoutMs: number }).timeoutMs, 45_000);
  assert.match((calls[0] as { systemPrompt: string }).systemPrompt, /Return only/u);
  await assert.rejects(service.translate("   "), /translation_selection_empty/u);

  const failed = new EditorTranslationService({
    generateEnglishTranslation: async () => {
      throw new Error("provider_text_generation_failed");
    }
  });
  await assert.rejects(
    failed.translate("完整选区"),
    /provider_text_generation_failed/u
  );
  assert.equal(failed.active, false);

  let release!: () => void;
  const pending = new Promise<string>((resolve) => { release = () => resolve("Hello"); });
  const singleFlight = new EditorTranslationService({
    generateEnglishTranslation: async () => await pending
  });
  const first = singleFlight.translate("你好");
  await assert.rejects(singleFlight.translate("世界"), /EchoInk 正在回答。请等待回答结束后重试。/u);
  release();
  assert.equal(await first, "Hello");
}
