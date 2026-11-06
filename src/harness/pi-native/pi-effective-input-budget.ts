export const PI_EFFECTIVE_INPUT_RATIO = 0.75 as const;
export const PI_DEFAULT_KEEP_RECENT_TOKENS = 20_000 as const;

export function personalMemoryRecallTokenBudget(effectiveInputBudget: number): number {
  return Math.max(512, Math.min(4_000, Math.floor(effectiveInputBudget * 0.05)));
}

export interface PiEffectiveInputBudget {
  readonly contextWindow: number;
  readonly maxOutputReserve: number;
  readonly ratioInputBoundary: number;
  readonly outputReserveBoundary: number;
  readonly effectiveInputBudget: number;
  readonly reserveTokens: number;
  readonly keepRecentTokens: number;
}

export class PiContextBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiContextBudgetError";
  }
}

/**
 * Single pure calculation shared by Pi compaction, Memory allocation and UI.
 */
export function calculatePiEffectiveInputBudget(
  input: Readonly<{
    contextWindow: number;
    maxOutputReserve: number;
  }>
): PiEffectiveInputBudget {
  if (!positiveSafeInteger(input.contextWindow)) {
    throw new PiContextBudgetError(
      "Pi contextWindow must be a positive safe integer"
    );
  }
  if (
    !positiveSafeInteger(input.maxOutputReserve)
    || input.maxOutputReserve >= input.contextWindow
  ) {
    throw new PiContextBudgetError(
      "Pi maxOutputReserve must be a positive safe integer below contextWindow"
    );
  }
  const ratioInputBoundary = Math.floor(
    input.contextWindow * PI_EFFECTIVE_INPUT_RATIO
  );
  const outputReserveBoundary =
    input.contextWindow - input.maxOutputReserve;
  const effectiveInputBudget = Math.min(
    ratioInputBoundary,
    outputReserveBoundary
  );
  if (effectiveInputBudget <= 0) {
    throw new PiContextBudgetError(
      "Pi effective input budget must be positive"
    );
  }
  const reserveTokens = input.contextWindow - effectiveInputBudget;
  // Pi's 20K default cannot compact a context smaller than 20K because it
  // would keep the whole branch. Bound it only for small models while keeping
  // the upstream default for ordinary production windows.
  const keepRecentTokens = Math.max(
    1,
    Math.min(
      PI_DEFAULT_KEEP_RECENT_TOKENS,
      Math.floor(effectiveInputBudget * 0.5)
    )
  );
  return Object.freeze({
    contextWindow: input.contextWindow,
    maxOutputReserve: input.maxOutputReserve,
    ratioInputBoundary,
    outputReserveBoundary,
    effectiveInputBudget,
    reserveTokens,
    keepRecentTokens
  });
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
