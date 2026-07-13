# ADR 0001: EchoInk Is The Harness

## Decision

EchoInk owns the Harness. Agent 是 Adapter.

Codex, OpenCode, Hermes, and future engines provide reasoning and execution, but EchoInk owns the run model, session context, workflow state, policy, resources, ledger, and UI projection.

## Consequences

- UI and workflows call `harness.run()` instead of concrete backends.
- New agents must implement the Adapter contract.
- Agent output cannot become the authority for EchoInk business state.
