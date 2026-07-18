# ADR 0005: Record Lifecycle Authority

## Status

Accepted on 2026-07-18.

## Context

EchoInk already owns the Harness, Conversation Store, Run Ledger, Native
Execution Store, Knowledge History, Workflow Artifact commits, and its formal
Memory V2 index. Their lifecycle contracts are not yet aligned:

- clearing the Knowledge page hides messages but can still feed the old
  messages and snapshot back into a later backend run;
- lease rollover and workspace changes can replace a backend binding before the
  old native reference is durably retired;
- Editor runs create backend-native executions without registering them in the
  Native Execution Store;
- detailed run payload, Knowledge History, raw message bodies, and settings can
  duplicate or disagree about ownership;
- backend cleanup capabilities differ, while retry and user-facing deletion
  semantics are currently inconsistent.

Treating each backend's thread or session as the durable history would make
cross-backend continuity, deletion, retention, recovery, and audit depend on
three incompatible external stores. Treating every EchoInk record as one
indivisible history would instead retain sensitive diagnostic payload forever
and make ordinary cleanup unsafe.

## Decision

EchoInk owns five related but separate record classes:

1. `Conversation` is the user-visible, backend-neutral dialogue authority.
2. `Workflow Run` is the auditable record of one logical user operation or automated workflow. It owns one or more Attempt Runs, and each Attempt Run corresponds to one Harness invocation.
3. `Native Execution` is a disposable backend thread, session, run, or process used to execute work.
4. `Workflow Artifact` is a durable business result such as a maintenance report, tracker update, Wiki page, WAL, or accepted editor change.
5. `Long-term Memory` is a curated formal fact set with explicit source lineage.

Codex threads, OpenCode sessions, Hermes sessions/runs, and future backend-native executions are never the only source of conversation continuity or business truth. Chat and `knowledge.ask` may reuse them through a bounded lease. Structured workflows use an isolated native execution per attempt. When a lease is invalidated or a backend execution disappears, EchoInk rebuilds the required context from its Conversation, snapshot, workflow, artifact, and Memory records.

Detailed Harness events are diagnostic payload, not conversation history. They have an explicit retention policy and may be pruned while a bounded run summary and artifact lineage remain. Pruning a run payload must also update the Memory archive catalog so the product never claims that deleted detail is still searchable.

Native cleanup starts only after the required EchoInk local commit is durable. Cleanup failure cannot reverse a successful business result. Failed cleanup uses bounded retries, then enters quarantine for manual review instead of retrying forever.

User actions have separate contracts:

- Start new context: retain records, advance the Conversation revision, invalidate all backend leases, and rebuild on the next turn.
- Reset Agent cache: retain EchoInk records and dispose only linked Native Executions.
- Clear Conversation records: retain the Conversation shell while deleting its dialogue payload, snapshots, exclusively owned raw bodies, and policy-selected run detail.
- Delete Conversation: remove the shell and the same owned payload, then dispose linked Native Executions. Confirmed Memory and published Workflow Artifacts require an explicit, separate deletion choice.

The existing Knowledge `/clear` action means **Start new context**. It does not
mean Clear Conversation records or Delete Conversation.

Detailed run payload is retained for 30 days by default and bounded run summary
metadata for 90 days by default. Recovery evidence for an unsettled local
commit, WAL, cleanup, or quarantine is exempt from ordinary retention until it
reaches a safe terminal state. Conversation, Workflow Artifact, and confirmed
Memory retention remain independent.

Native cleanup is attempted automatically at most six times. A sixth failure
moves the record to quarantine. Cleanup scheduling reserves capacity for new
records so an old failure backlog cannot starve a newly completed run.

## Identifier Contract

Existing identifiers keep their current meanings:

- `sessionId` identifies the EchoInk Conversation.
- A backend-neutral product turn is anchored by EchoInk message IDs until a dedicated product `turnId` is introduced.
- `runId` identifies one Harness invocation.
- `workflowRunId` identifies a logical workflow that may contain multiple attempts.
- `attemptId` identifies one backend attempt inside that workflow.
- `NativeExecutionRef.id` identifies a backend-owned thread, session, run, or process.

The project does not rename the mature maintenance `attemptId` contract merely to make the labels symmetrical.

## Compatibility With Existing Decisions

This decision extends ADR 0001. EchoInk still owns the Harness, and Agents remain adapters.

It does not replace ADR 0004. EchoInk may dispose a precisely linked backend thread or session, but it does not silently clear or rewrite an Agent's separate global native Memory store. Product copy and deletion receipts must distinguish those two scopes.

It supersedes the older project-memory rule that every ordinary Chat native
thread must remain available for indefinite resume. EchoInk Conversation now
provides continuity; native resume is a bounded lease optimization.

The `/maintain` selected-first routing, Shadow Vault, write fence, artifact recovery, validation, WAL, partial commit, and fail-closed rules remain unchanged. This decision governs how their records are linked, retained, cleaned, migrated, and presented.

## Consequences

- Conversation Store becomes the recoverable catalog for user-visible conversations; `data.json` keeps settings and lightweight UI selection rather than acting as a second conversation authority.
- Knowledge History becomes a dated projection and browsing index, not an independent source allowed to delete shared raw bodies.
- Run Ledger separates retained summary metadata from bounded detailed payload.
- Native lifecycle code gains finite retry, quarantine, fairness, terminal compaction, and explicit cleanup receipts.
- Raw sidecars are reclaimed from a reference graph, never by deleting one caller's reference blindly.
- Storage migration always starts with a metadata-only dry-run and stable snapshot fingerprint. Existing records are not bulk-deleted during schema adoption.
- Backends expose truthful runtime capabilities. Hermes can use native load/resume/delete only when the installed version proves those capabilities; otherwise it remains in explicit context-rehydrated mode.

## Rejected Alternatives

- **Use backend-native history as the source of truth.** Rejected because
  continuity and deletion would change when the user switches backend or
  device, and Hermes/OpenCode/Codex do not expose equivalent contracts.
- **Delete every native execution immediately.** Rejected for leased Chat and
  `knowledge.ask`, where a short bounded lease reduces latency without becoming
  a durability dependency.
- **Retain every Harness event forever.** Rejected because full prompts, tool
  input/output, diffs, and absolute paths are diagnostic data with higher
  privacy and growth cost than a bounded summary.
- **Let cleanup failure fail the business run.** Rejected because local
  Conversation, Artifact, and Ledger commits are the business result; native
  disposal is a later cache-maintenance concern.
- **Clear backend-global Memory with a session reset.** Rejected by ADR 0004.
  EchoInk only disposes a precisely linked native execution.
