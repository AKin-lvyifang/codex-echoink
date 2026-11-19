export interface XiaoechoModelSignal {
  kind: "fallback" | "retired";
  requestedModelId: string;
  baseUrl: string;
  requestId: string;
}

type XiaoechoModelSignalListener = (
  signal: Readonly<XiaoechoModelSignal>
) => void | Promise<void>;

const listeners = new Set<XiaoechoModelSignalListener>();

export function subscribeXiaoechoModelSignals(
  listener: XiaoechoModelSignalListener
): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Catalog refresh and settings writes must never interrupt a provider response. */
export function publishXiaoechoModelSignal(signal: XiaoechoModelSignal): void {
  const snapshot = Object.freeze({ ...signal });
  for (const listener of listeners) {
    try {
      void Promise.resolve(listener(snapshot)).catch(() => undefined);
    } catch { /* Observers cannot change the request's success or failure. */ }
  }
}
