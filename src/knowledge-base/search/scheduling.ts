interface SchedulerLike {
  yield?: () => Promise<void>;
}

interface TaskPort {
  onmessage: (() => void) | null;
  onmessageerror: (() => void) | null;
  postMessage(value: unknown): void;
  close(): void;
}

interface TaskChannel {
  port1: TaskPort;
  port2: TaskPort;
}

const environment = globalThis as unknown as {
  scheduler?: SchedulerLike;
  MessageChannel?: new () => TaskChannel;
};

function abortError(): Error {
  return Object.assign(new Error("Knowledge search aborted"), { name: "AbortError" });
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/** Each wait owns its signal listener and any cancellable task resources. */
function waitForTask(signal: AbortSignal | undefined, start: (done: () => void, fail: (error: unknown) => void) => (() => void) | void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let cleanup: (() => void) | void;
    const finish = (failed: boolean, error?: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      cleanup?.();
      if (failed) reject(error instanceof Error ? error : new Error("Knowledge search task failed", { cause: error }));
      else resolve();
    };
    const onAbort = () => finish(true, abortError());
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      cleanup = start(() => finish(false), (error) => finish(true, error));
      // A task implementation can fail or trigger abort before returning its cleanup.
      if (settled) cleanup?.();
    } catch (error) { finish(true, error); }
    if (signal?.aborted) onAbort();
  });
}

/** A real task boundary without nested-timer clamping on modern hosts. */
export async function yieldSearchTask(signal?: AbortSignal): Promise<void> {
  checkAbort(signal);
  try {
    const scheduler = environment.scheduler;
    const yieldMethod = scheduler?.yield;
    if (typeof yieldMethod === "function") {
      await waitForTask(signal, (done, fail) => {
        const task = yieldMethod.call(scheduler) as Promise<void>;
        void task.then(done, fail);
      });
      checkAbort(signal);
      return;
    }
  } catch { checkAbort(signal); }

  try {
    await waitForTask(signal, (done, fail) => {
      const Constructor = environment.MessageChannel;
      if (typeof Constructor !== "function") throw new Error("MessageChannel unavailable");
      const channel = new Constructor();
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        for (const port of [channel.port1, channel.port2]) {
          try { port.onmessage = null; port.onmessageerror = null; } catch { /* Continue releasing both ports. */ }
          try { port.close(); } catch { /* A host may already have closed the port. */ }
        }
      };
      try {
        channel.port1.onmessage = done;
        channel.port1.onmessageerror = () => fail(new Error("MessageChannel task failed"));
        channel.port2.postMessage(undefined);
      } catch (error) {
        close();
        throw error;
      }
      return close;
    });
    checkAbort(signal);
    return;
  } catch { checkAbort(signal); }

  await waitForTask(signal, (done) => {
    const timer = setTimeout(done, 0);
    return () => clearTimeout(timer);
  });
  checkAbort(signal);
}
