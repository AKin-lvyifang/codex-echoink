# ADR 0002: Dual Resource Plane

## Decision

EchoInk Resource Plane and Agent Native Resource Plane are separate.

EchoInk Resource Plane belongs to the current Vault and includes EchoInk-owned skills, MCP, and native tools. Agent Native Resource Plane belongs to each agent and stays managed by that agent.

## Consequences

- EchoInk resources use stable `echoink://` references.
- Native resources use stable `native://<backend>/...` references.
- Same names must not silently merge.
- EchoInk must not rewrite global agent resource configuration.
