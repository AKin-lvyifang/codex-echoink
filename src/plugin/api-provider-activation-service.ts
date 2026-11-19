import { CAUSE } from "../core/error-copy";
export type ApiProviderActivationFailureCode =
  | "provider_switch_busy"
  | "provider_switch_failed"
  | "provider_switch_recovery_failed";

export class ApiProviderActivationError extends Error {
  constructor(
    readonly code: ApiProviderActivationFailureCode,
    message: string,
    options: ErrorOptions = {}
  ) {
    super(message, options);
    this.name = "ApiProviderActivationError";
  }
}

export interface ApiProviderActivationPort<TSnapshot, TPersisted, TRuntime> {
  isBusy(): boolean;
  beginSwitch(): void;
  endSwitch(): void;
  snapshotMemory(): TSnapshot;
  readPersisted(): Promise<TPersisted>;
  applyCandidate(): void;
  persistCandidate(): Promise<void>;
  createCandidateRuntime(): Promise<TRuntime | null>;
  finalizeCandidate(): Promise<void>;
  abortCandidate(): Promise<void>;
  currentRuntime(): TRuntime | null;
  activateRuntime(runtime: TRuntime | null): void;
  shutdownRuntime(runtime: TRuntime): Promise<void>;
  restoreMemory(snapshot: TSnapshot): void;
  restorePersisted(snapshot: TPersisted): Promise<void>;
  isRollbackSafe?(error: unknown): boolean;
}

export class ProductActivityGate {
  private active = 0;
  private exclusive = 0;
  private switching = false;

  get hasActivity(): boolean { return this.active > 0; }

  beginSwitch(): void {
    if (this.switching || this.active > 0) {
      throw new ApiProviderActivationError(
        "provider_switch_busy",
        CAUSE.busyAnswering[0]
      );
    }
    this.switching = true;
  }

  endSwitch(): void { this.switching = false; }

  async run<T>(
    action: () => Promise<T>,
    options: { concurrent?: boolean } = {}
  ): Promise<T> {
    if (this.switching) {
      throw new Error(CAUSE.providerSwitching[0]);
    }
    if (this.exclusive > 0 || (!options.concurrent && this.active > 0)) {
      throw new Error(CAUSE.busyAnswering[0]);
    }
    this.active += 1;
    if (!options.concurrent) this.exclusive += 1;
    try {
      return await action();
    } finally {
      this.active -= 1;
      if (!options.concurrent) this.exclusive -= 1;
    }
  }
}

/** Serializes all global Provider changes and keeps the old Runtime installed
 * until the candidate has initialized successfully. */
export class ApiProviderActivationService {
  private tail: Promise<void> = Promise.resolve();

  run<TSnapshot, TPersisted, TRuntime>(
    port: ApiProviderActivationPort<TSnapshot, TPersisted, TRuntime>
  ): Promise<void> {
    const run = this.tail.then(async () => await this.runOne(port));
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async runOne<TSnapshot, TPersisted, TRuntime>(
    port: ApiProviderActivationPort<TSnapshot, TPersisted, TRuntime>
  ): Promise<void> {
    if (port.isBusy()) {
      throw new ApiProviderActivationError(
        "provider_switch_busy",
        CAUSE.busyAnswering[0]
      );
    }
    port.beginSwitch();
    const memoryBefore = port.snapshotMemory();
    try {
      const persistedBefore = await port.readPersisted();
      const runtimeBefore = port.currentRuntime();
      let candidate: TRuntime | null = null;
      try {
        port.applyCandidate();
        await port.persistCandidate();
        candidate = await port.createCandidateRuntime();
        port.activateRuntime(candidate);
        await port.finalizeCandidate();
        if (runtimeBefore && runtimeBefore !== candidate) {
          await port.shutdownRuntime(runtimeBefore).catch((error) => {
            console.error("[EchoInk] previous Provider Runtime shutdown failed", error);
          });
        }
      } catch (error) {
        if (port.isRollbackSafe?.(error) === false) {
          throw new ApiProviderActivationError(
            "provider_switch_recovery_failed",
            "模型设置已变更或状态不确定，不能恢复旧模型。请立即重载 EchoInk 插件。",
            { cause: error }
          );
        }
        if (candidate && candidate !== runtimeBefore) {
          await port.shutdownRuntime(candidate).catch(() => undefined);
        }
        port.restoreMemory(memoryBefore);
        port.activateRuntime(runtimeBefore);
        const recoveryErrors: unknown[] = [];
        try { await port.abortCandidate(); } catch (recoveryError) {
          recoveryErrors.push(recoveryError);
        }
        try { await port.restorePersisted(persistedBefore); } catch (recoveryError) {
          recoveryErrors.push(recoveryError);
        }
        if (recoveryErrors.length > 0) {
          throw new ApiProviderActivationError(
            "provider_switch_recovery_failed",
            "模型切换失败，且设置恢复未完成。请立即重载 EchoInk 插件。",
            { cause: new AggregateError([error, ...recoveryErrors]) }
          );
        }
        throw new ApiProviderActivationError(
          "provider_switch_failed",
          "模型切换失败，已恢复原模型。",
          { cause: error }
        );
      }
    } finally {
      port.endSwitch();
    }
  }
}
