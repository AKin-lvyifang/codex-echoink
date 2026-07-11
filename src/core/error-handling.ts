export function swallowError(context: string): (error: unknown) => void {
  return (error: unknown) => {
    console.warn(`[EchoInk] ${context}:`, error);
  };
}

export function emptyArrayOnMissingPathOrWarn(context: string): (error: unknown) => never[] {
  return (error: unknown) => {
    if (!isMissingPathError(error)) {
      console.warn(`[EchoInk] ${context}:`, error);
    }
    return [];
  };
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}
