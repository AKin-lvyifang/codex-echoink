import {
  applyAgentSelfOperations,
  type AgentSelfBaseField,
  type AgentSelfOperation,
  type AgentSelfState
} from "./agent-self-model";
import { isAgentTemplateId, type AgentTemplateId } from "./agent-templates";

export const AGENT_SELF_METADATA_SCHEMA = "echoink.agent-self-meta.v1" as const;
export const AGENT_SELF_METADATA_RELATIVE_PATH = "agents/echoink/agent-self-meta.json";

export interface AgentSelfMetadata {
  readonly schema: typeof AGENT_SELF_METADATA_SCHEMA;
  readonly revision: number;
  readonly templateId: AgentTemplateId | null;
  readonly legacyPersonalityImported: boolean;
  /** Provenance/control metadata only; AGENT.md remains the sole current text truth. */
  readonly derivations: readonly AgentSelfDerivation[];
  readonly updatedAt: number;
}

export type AgentSelfDerivationTarget = AgentSelfBaseField | `habit:${string}`;
export type AgentSelfDerivationOperation =
  | "replace"
  | "habit_add"
  | "habit_replace"
  | "habit_retire";

export interface AgentSelfDerivationSource {
  readonly kind: "memory" | "experience";
  readonly id: string;
  readonly revision?: number;
  readonly contextId: string;
  readonly evidence: string;
}

export interface AgentSelfDerivation {
  readonly target: AgentSelfDerivationTarget;
  readonly operation: AgentSelfDerivationOperation;
  readonly basis: "explicit" | "inferred";
  readonly sources: readonly AgentSelfDerivationSource[];
  readonly previousValue: string | null;
  readonly currentValue: string | null;
  readonly updatedAt: number;
}

export type AgentSelfMetadataInspection =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "valid"; state: AgentSelfMetadata }>
  | Readonly<{ kind: "invalid"; reason: string }>;

export function emptyAgentSelfMetadata(now = 0): AgentSelfMetadata {
  return Object.freeze({
    schema: AGENT_SELF_METADATA_SCHEMA,
    revision: 0,
    templateId: null,
    legacyPersonalityImported: false,
    derivations: Object.freeze([]),
    updatedAt: now
  });
}

export function parseAgentSelfMetadata(raw: Record<string, unknown>): AgentSelfMetadata | null {
  if (raw.schema !== AGENT_SELF_METADATA_SCHEMA) return null;
  if (typeof raw.revision !== "number" || !Number.isSafeInteger(raw.revision) || raw.revision < 0) return null;
  if (raw.templateId !== null && !isAgentTemplateId(raw.templateId)) return null;
  if (typeof raw.legacyPersonalityImported !== "boolean") return null;
  if (typeof raw.updatedAt !== "number" || !Number.isFinite(raw.updatedAt)) return null;
  const derivations = parseAgentSelfDerivations(raw.derivations);
  if (!derivations) return null;
  return Object.freeze({
    schema: AGENT_SELF_METADATA_SCHEMA,
    revision: raw.revision,
    templateId: raw.templateId,
    legacyPersonalityImported: raw.legacyPersonalityImported,
    derivations,
    updatedAt: raw.updatedAt
  });
}

function parseAgentSelfDerivations(value: unknown): readonly AgentSelfDerivation[] | null {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) return null;
  const targets = new Set<string>();
  const result: AgentSelfDerivation[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const raw = entry as Record<string, unknown>;
    if (!isDerivationTarget(raw.target) || targets.has(raw.target)) return null;
    targets.add(raw.target);
    if (!isDerivationOperation(raw.operation)
      || (raw.basis !== "explicit" && raw.basis !== "inferred")
      || !Array.isArray(raw.sources) || raw.sources.length === 0 || raw.sources.length > 32
      || (raw.previousValue !== null && !boundedText(raw.previousValue, 2_000))
      || (raw.currentValue !== null && !boundedText(raw.currentValue, 2_000))
      || typeof raw.updatedAt !== "number" || !Number.isFinite(raw.updatedAt)) return null;
    if (raw.operation === "replace" && !isBaseTarget(raw.target)) return null;
    if (raw.operation !== "replace" && !raw.target.startsWith("habit:")) return null;
    if (raw.operation === "habit_retire" ? raw.currentValue !== null : raw.currentValue === null) return null;
    const sources: AgentSelfDerivationSource[] = [];
    const sourceKeys = new Set<string>();
    for (const sourceValue of raw.sources) {
      if (!sourceValue || typeof sourceValue !== "object" || Array.isArray(sourceValue)) return null;
      const source = sourceValue as Record<string, unknown>;
      if ((source.kind !== "memory" && source.kind !== "experience")
        || !boundedToken(source.id, 512)
        || !boundedToken(source.contextId, 600)
        || !boundedText(source.evidence, 1_000)
        || (source.revision !== undefined
          && (!Number.isSafeInteger(source.revision) || (source.revision as number) < 1))) return null;
      const key = `${source.kind}:${source.id}`;
      if (sourceKeys.has(key)) return null;
      sourceKeys.add(key);
      sources.push(Object.freeze({
        kind: source.kind,
        id: source.id,
        ...(source.revision === undefined ? {} : { revision: source.revision as number }),
        contextId: source.contextId,
        evidence: source.evidence
      }));
    }
    if (raw.basis === "inferred"
      && new Set(sources.map((source) => source.contextId)).size < 2) return null;
    result.push(Object.freeze({
      target: raw.target,
      operation: raw.operation,
      basis: raw.basis,
      sources: Object.freeze(sources),
      previousValue: raw.previousValue,
      currentValue: raw.currentValue,
      updatedAt: raw.updatedAt
    }));
  }
  return Object.freeze(result);
}

function isBaseTarget(value: string): value is AgentSelfBaseField {
  return value === "complex_problem_method" || value === "tone" || value === "response_structure";
}

function isDerivationTarget(value: unknown): value is AgentSelfDerivationTarget {
  return typeof value === "string" && (
    isBaseTarget(value)
      || /^habit:[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)
  );
}

function isDerivationOperation(value: unknown): value is AgentSelfDerivationOperation {
  return value === "replace" || value === "habit_add"
    || value === "habit_replace" || value === "habit_retire";
}

function boundedToken(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max
    && !value.includes("\u0000") && !/[\r\n]/u.test(value);
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max
    && !value.includes("\u0000") && !/[\r\n\u2028\u2029]/u.test(value);
}

export function agentSelfMetadataJson(state: AgentSelfMetadata): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

export function reconcileAgentSelfDerivationSources(input: Readonly<{
  state: AgentSelfState;
  metadata: AgentSelfMetadata;
  currentMemoryRevisions: ReadonlyMap<string, number>;
  invalidatedExperienceContextIds?: ReadonlySet<string>;
  now: number;
}>): Readonly<{ state: AgentSelfState; metadata: AgentSelfMetadata; changed: boolean }> {
  let state = input.state;
  const derivations: AgentSelfDerivation[] = [];
  let changed = false;
  for (const derivation of input.metadata.derivations) {
    const retainedSources = derivation.sources.filter((source) => source.kind === "experience"
      ? !input.invalidatedExperienceContextIds?.has(source.contextId)
      : input.currentMemoryRevisions.get(source.id) === source.revision);
    const stillSupported = derivation.basis === "explicit"
      ? retainedSources.length >= 1
      : new Set(retainedSources.map((source) => source.contextId)).size >= 2;
    if (stillSupported) {
      if (retainedSources.length !== derivation.sources.length) {
        changed = true;
        derivations.push(Object.freeze({
          ...derivation,
          sources: Object.freeze(retainedSources),
          updatedAt: input.now
        }));
      } else {
        derivations.push(derivation);
      }
      continue;
    }

    changed = true;
    if (currentDerivationValue(state, derivation.target) !== derivation.currentValue) {
      continue;
    }
    const rollback = rollbackOperation(derivation);
    if (!rollback) continue;
    try {
      state = applyAgentSelfOperations(state, [rollback]);
    } catch {
      // A structurally valid but no-longer-applicable derivation is retired;
      // never use fuzzy text replacement to force a rollback.
    }
  }
  const metadata = changed
    ? Object.freeze({
        ...input.metadata,
        revision: input.metadata.revision + 1,
        derivations: Object.freeze(derivations),
        updatedAt: input.now
      })
    : input.metadata;
  return Object.freeze({ state, metadata, changed });
}

function rollbackOperation(derivation: AgentSelfDerivation): AgentSelfOperation | null {
  if (derivation.operation === "replace") {
    return derivation.previousValue === null
      ? null
      : Object.freeze({
          operation: "replace" as const,
          field: derivation.target as AgentSelfBaseField,
          value: derivation.previousValue
        });
  }
  const key = derivation.target.slice("habit:".length);
  if (derivation.operation === "habit_add") {
    return Object.freeze({ operation: "habit_retire" as const, key });
  }
  if (derivation.operation === "habit_replace") {
    return derivation.previousValue === null
      ? null
      : Object.freeze({ operation: "habit_replace" as const, key, text: derivation.previousValue });
  }
  return derivation.previousValue === null
    ? null
    : Object.freeze({ operation: "habit_add" as const, key, text: derivation.previousValue });
}

function currentDerivationValue(
  state: AgentSelfState,
  target: AgentSelfDerivationTarget
): string | null {
  if (target === "complex_problem_method") return state.complexProblemMethod;
  if (target === "tone") return state.tone;
  if (target === "response_structure") return state.responseStructure;
  const key = target.slice("habit:".length);
  return state.currentLearnedHabits.find((habit) => habit.key === key)?.text ?? null;
}
