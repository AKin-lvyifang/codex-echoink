import { CAUSE } from "../core/error-copy";
import type { PersonalMemoryKind } from "../harness/memory/personal-memory-contracts";

const CORRECTION_TIMEOUT_MS = 45_000;

export interface PersonalMemoryCorrectionRecord {
  readonly kind: PersonalMemoryKind;
  readonly title: string;
  readonly content: string;
  readonly recallWhen: string;
}

export interface PersonalMemoryCorrectionPreview {
  readonly title: string;
  readonly content: string;
  readonly recallWhen: string;
}

export interface PersonalMemoryCorrectionPort {
  generateCorrection(input: Readonly<{
    systemPrompt: string;
    userPrompt: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }>): Promise<string>;
}

export class PersonalMemoryCorrectionService {
  private running = false;

  constructor(private readonly port: PersonalMemoryCorrectionPort) {}

  get active(): boolean { return this.running; }

  async generatePreview(input: Readonly<{
    record: PersonalMemoryCorrectionRecord;
    correction: string;
    signal?: AbortSignal;
  }>): Promise<Readonly<PersonalMemoryCorrectionPreview>> {
    const correction = input.correction.trim();
    if (!correction) throw new Error("personal_memory_correction_empty");
    if (this.running) throw new Error(CAUSE.busyAnswering[0]);
    this.running = true;
    try {
      const output = await this.port.generateCorrection({
        systemPrompt: [
          "You revise one user-owned Personal Memory record from an explicit correction.",
          "Return exactly one JSON object with only the string keys title, content, recallWhen.",
          "Keep the original meaning unless the user's correction explicitly changes it.",
          "Do not include Markdown fences, commentary, IDs, paths, revisions, sources, or metadata."
        ].join(" "),
        userPrompt: JSON.stringify({
          current: input.record,
          userCorrection: correction
        }),
        timeoutMs: CORRECTION_TIMEOUT_MS,
        signal: input.signal
      });
      return parsePersonalMemoryCorrectionPreview(output);
    } finally {
      this.running = false;
    }
  }
}

export function parsePersonalMemoryCorrectionPreview(
  raw: string
): Readonly<PersonalMemoryCorrectionPreview> {
  const text = raw.trim();
  if (!text || text.startsWith("```")) {
    throw new Error("personal_memory_correction_output_invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("personal_memory_correction_output_invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("personal_memory_correction_output_invalid");
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join("\n") !== ["content", "recallWhen", "title"].join("\n")) {
    throw new Error("personal_memory_correction_output_invalid");
  }
  return Object.freeze({
    title: requireCorrectionField(record.title, "title", 240),
    content: requireCorrectionField(record.content, "content", 32_000),
    recallWhen: requireCorrectionField(record.recallWhen, "recallWhen", 500)
  });
}

function requireCorrectionField(
  value: unknown,
  label: string,
  maxLength: number
): string {
  if (typeof value !== "string") {
    throw new Error(`personal_memory_correction_${label}_invalid`);
  }
  const text = value.trim();
  if (!text || text.length > maxLength) {
    throw new Error(`personal_memory_correction_${label}_invalid`);
  }
  return text;
}
