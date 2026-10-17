export function assertPiSubmissionActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw Object.assign(new Error("Pi submission cancelled"), { name: "AbortError" });
}

/** Shared initialization may finish for other callers after this turn stops. */
export function waitForPiSubmission<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(Object.assign(new Error("Pi submission cancelled"), { name: "AbortError" })); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    operation.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}
