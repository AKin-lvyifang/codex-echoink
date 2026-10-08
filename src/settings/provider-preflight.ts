import type { ProviderFailureDetail } from "../harness/pi/provider-failure";
import type { DiscoveredProviderModel } from "./provider-model-discovery";
import type {
  PiProviderConfigurationDraft,
  PiProviderConnectionFailure,
  PiProviderConnectionTestResult,
  PiProviderModelListResult
} from "../plugin/pi-provider-configuration-service";
import {
  apiProviderApiKeyRequired,
  type ApiProviderId
} from "./provider-presets";

export type ProviderPreflightStatus =
  | "idle"
  | "loading"
  | PiProviderModelListResult["status"];

export type ProviderPreflightOperation = "model_list" | "connection";

export interface ProviderPreflightSnapshot {
  readonly status: ProviderPreflightStatus;
  readonly operation: ProviderPreflightOperation;
  readonly models: readonly DiscoveredProviderModel[];
  readonly source?: "remote" | "catalog";
  readonly connectionDetail?: ProviderFailureDetail;
  readonly connectionFailure: PiProviderConnectionFailure | null;
}

export interface ProviderPreflightService {
  listModels(
    draft: PiProviderConfigurationDraft
  ): Promise<PiProviderModelListResult>;
  testConnection(
    draft: PiProviderConfigurationDraft
  ): Promise<PiProviderConnectionTestResult>;
}

export function providerPreflightApiKeyReady(input: Readonly<{
  providerId: ApiProviderId;
  apiKey: string;
  storedApiKey?: string;
}>): boolean {
  if (!apiProviderApiKeyRequired(input.providerId)) return true;
  return Boolean(input.apiKey.trim() || input.storedApiKey?.trim());
}

/**
 * Owns the Provider modal's one preflight state. Network and API-key work
 * remains delegated to PiProviderConfigurationService through the supplied
 * service port.
 */
export class ProviderPreflightSession {
  private generation = 0;
  private current: ProviderPreflightSnapshot = snapshot({
    status: "idle",
    operation: "model_list",
    models: [],
    connectionFailure: null
  });

  constructor(
    private readonly service: ProviderPreflightService,
    private readonly onChange: (state: ProviderPreflightSnapshot) => void
  ) {}

  get state(): ProviderPreflightSnapshot {
    return this.current;
  }

  invalidate(clearModels = false): void {
    this.generation += 1;
    this.publish({
      status: "idle",
      operation: "model_list",
      models: clearModels ? [] : this.current.models,
      source: clearModels ? undefined : this.current.source,
      connectionFailure: null
    });
  }

  reset(): void {
    this.generation += 1;
    this.publish({
      status: "idle",
      operation: "model_list",
      models: [],
      connectionFailure: null
    });
  }

  cancel(): void {
    this.generation += 1;
  }

  async discoverModels(
    draft: PiProviderConfigurationDraft
  ): Promise<void> {
    const generation = ++this.generation;
    this.publish({
      status: "loading",
      operation: "model_list",
      models: this.current.models,
      source: this.current.source,
      connectionFailure: null
    });
    try {
      const result = await this.service.listModels(draft);
      if (generation !== this.generation) return;
      this.publish({
        status: result.status,
        operation: "model_list",
        models: result.status === "available" || result.status === "incomplete"
          ? result.models
          : [],
        source: result.source,
        connectionFailure: null
      });
    } catch {
      if (generation !== this.generation) return;
      this.publish({
        status: "temporary_failure",
        operation: "model_list",
        models: [],
        connectionFailure: null
      });
    }
  }

  async testConnection(
    draft: PiProviderConfigurationDraft
  ): Promise<void> {
    const generation = ++this.generation;
    this.publish({
      status: "loading",
      operation: "connection",
      models: this.current.models,
      source: this.current.source,
      connectionFailure: null
    });
    try {
      const result = await this.service.testConnection(draft);
      if (generation !== this.generation) return;
      this.publish({ ...connectionSnapshot(result, this.current.models), source: this.current.source });
    } catch {
      if (generation !== this.generation) return;
      this.publish({
        status: "temporary_failure",
        operation: "connection",
        models: this.current.models,
        connectionFailure: "provider"
      });
    }
  }

  private publish(input: ProviderPreflightSnapshot): void {
    this.current = snapshot(input);
    this.onChange(this.current);
  }
}

function connectionSnapshot(
  result: PiProviderConnectionTestResult,
  models: readonly DiscoveredProviderModel[]
): ProviderPreflightSnapshot {
  if (result.status === "available") {
    return snapshot({
      status: "available",
      operation: "connection",
      models,
      connectionFailure: null
    });
  }
  return snapshot({
    status: connectionFailureStatus(result.failure),
    operation: "connection",
    models,
    connectionDetail: result.detail,
    connectionFailure: result.failure
  });
}

function connectionFailureStatus(
  failure: PiProviderConnectionFailure
): Exclude<ProviderPreflightStatus, "idle" | "loading" | "available"> {
  if (failure === "auth") return "api_key_error";
  if (failure === "protocol") return "unsupported";
  return "temporary_failure";
}

function snapshot(
  input: ProviderPreflightSnapshot
): ProviderPreflightSnapshot {
  return Object.freeze({
    ...input,
    models: Object.freeze([...input.models])
  });
}
