# EchoInk Memory V2 implementation

EchoInk Memory V2 adds a backend-neutral local memory layer to the Harness alongside the native memory capabilities of Codex, OpenCode, and Hermes. Native Agent memory remains enabled and reusable in ordinary runs. All three backends can curate the same EchoInk pending events, but only EchoInk validates and commits its formal local index.

## Storage authority

The formal root is `Vault/.echoink/memory`:

```text
.echoink/memory/
├── manifest.json
├── index.json
├── current.md
├── spec/index.md
├── tasks/index.md
├── archive/index.md
└── .runtime/
    ├── pending-events.jsonl
    ├── runs/
    ├── transactions/
    └── audit.jsonl
```

`index.json` is the only canonical structured source. The Markdown files are deterministic, human-readable projections. A Curator returns dispositions and candidates; it never returns or edits formal file contents.

`manifest.json` carries the schema version and committed revision. Every installed `index.json` also carries the identity of the transaction that produced it. Recovery checks both revision and commit identity, so an interrupted transaction cannot mistake a different commit at the same target revision for its own index or delete the wrong pending events.

Formal files fail closed. EchoInk creates them only when absent, migrates only the recognized V1 index shape while preserving its memory objects, and never replaces malformed JSON, invalid fields, or a future schema with defaults. Every stored memory and confirmation is validated field by field, including kind, scope, statement, evidence, source, confidence, timestamps, and optional lifecycle fields. These cases surface as `recovery required` while the original bytes and pending journal remain untouched. V1 migration and missing Markdown projections use a persistent repair marker and rebuild all four projections from the validated full index. The repair rechecks revision and commit identity after writing and repeats against the latest index if a formal commit won the race. A process interruption leaves the marker for the next startup instead of leaving empty or stale projections as a permanent state.

## Run lifecycle and workflow policy

The Harness records only the events needed to explain a durable memory: user input, material tool or file effects, the final result, and committed workflow results.

| Workflow | Read | Capture | Sync gate |
| --- | --- | --- | --- |
| `chat.generic` | Yes | Explicit durable signals only | Successful run terminal |
| `knowledge.ask` | Yes | Explicit durable signals only | Successful run terminal |
| `knowledge.maintain`, `knowledge.reingest`, `knowledge.outputs`, `knowledge.inbox`, `knowledge.journal`, `knowledge.calibrate` | No | Committed workflow result | `run.local_commit.completed` |
| `knowledge.check`, editor actions, prompt enhancement, weekly review | No | No | Never |
| `memory.curate` | No | No | Never; recursion guard |

An Agent result is not enough for a structured write workflow. If the Vault or plugin-local transaction fails, EchoInk does not create a workflow memory.

Manual and queued sync use the same lifecycle boundary. Without explicit event IDs, EchoInk selects only complete pending run groups: signal capture requires a `final-result`, while structured workflows require the generated `workflow-result`. Active and crash-orphan input/tool fragments remain pending and cannot be curated early.

Asynchronous backends use the same lifecycle. A run that initially returns `running` stays pending until `settleRunTerminal` records its authoritative terminal state.

Run ledger commits and terminal results do not wait for Memory work. The orchestrator sends committed lifecycle events to a per-run Memory queue, where they remain ordered and failures are isolated. A slow Curator therefore cannot delay the business Run terminal. Workflow finalization is order-independent: `run.completed` and `run.local_commit.completed` may arrive in either order, but capture occurs only after both are durable.

The file-backed Harness ledger is also the durable handoff across process restarts. Startup transaction recovery enumerates unfinished Memory run states, replays their relevant tool, file, terminal, and local-commit events from the ledger, and then applies the normal lifecycle gates. This closes the crash window between a durable Run terminal and the asynchronous Memory journal delivery without making the business Run wait for the Curator.

## Transaction path

1. The trigger gate selects explicit chat signals or locally committed workflow results.
2. EchoInk writes bounded, redacted events to the pending journal. All journal append/filter-replace mutations share a Vault-level lane, so concurrent run events cannot overwrite one another. Invalid JSON, checksum failure, or a partial line makes the journal fail closed; later mutations cannot rewrite away the original damaged bytes.
3. `prepare` snapshots the selected events, active memory, and base revision into a transaction directory.
4. A backend-neutral Curator returns strict JSON with `write`, `skip`, or `unresolved` for every source event.
5. `apply` accepts one bare JSON object only. It rejects fences and wrappers, unexpected fields, duplicate candidate IDs, unsafe identifiers or references, invalid types and bounds, incomplete coverage, and any `pending` outcome without an `unresolved` candidate.
6. EchoInk stages the next `index.json` and all Markdown projections.
7. The full `prepare → Curator → apply → commit` sync is serialized per Vault. Formal settings mutations use the same lane, so two terminal runs, confirmation, deletion, import, and expiry cannot race on one revision.
8. `commit` installs the index and projections with atomic file replacement, advances the manifest revision, and removes only the covered pending events.
9. Every formal mutation, including confirmation, deletion, import, supersede, and expiry, uses a staged transaction marker plus backups. `recover` rolls forward only when the installed index has both the target revision and the same transaction identity. A different identity is marked superseded without touching its index, projections, or pending events; an index that was not installed restores the transaction backups.

A no-op leaves the revision unchanged and does not show a success notification. Invalid coverage, Curator failure, unresolved candidates, and interrupted commits keep the relevant pending events.

## Curator isolation

The Curator interface does not expose a specific backend. Plugin settings can follow the default Agent or pin Codex, OpenCode, or Hermes.

Every internal Curator run uses a temporary workspace with read-only permission, no writable roots, no MCP, no EchoInk resources, no tools, and `memoryPolicy.enabled = false`. Its output is data for validation, not permission to write files. The common Curator system contract also labels pending events and active-memory snapshots—including imported Markdown—as untrusted data. Embedded commands, permission requests, tool instructions, and attempts to override the schema or workflow rules must be ignored.

Hermes requires one additional boundary only for the internal Curator task. Its current HTTP `/v1/runs` endpoint ignores per-run toolset and `skip_memory` controls, so a Hermes Curator never uses that endpoint even when the user configured a server URL. EchoInk derives an isolated Curator configuration that forces the local CLI path with `--ignore-rules` and the empty `context_engine` toolset. This keeps the one-off curation task from recursively using or changing unrelated Hermes state. If the isolated CLI path is unavailable, the Curator fails closed and leaves the pending events for retry instead of falling back to the unisolated HTTP path.

Ordinary Codex, OpenCode, and Hermes runs are not given instructions to disable, ignore, clear, or overwrite their native memory. That native memory may continue to help the Agent. It simply remains a separate backend-owned capability: it does not directly mutate EchoInk's local index, and EchoInk does not mutate the Agent's native memory store.

When Memory is enabled, Chat and `/ask` receive a small system catalog for EchoInk records that remain available under their independent retention contracts. The catalog points to local Conversation messages, Knowledge History, the V1 Run Record Store, legacy pre-migration Harness ledgers, referenced Raw bodies, and `.echoink/memory/index.json`. Agents use the curated index first and search retained local records only when older details are needed; the archive is never injected wholesale. Detailed Attempt payloads default to 30 days and bounded Run summaries to 90 days. An `expired` tombstone is intentionally unavailable detail and is never presented as searchable; `missing` and `corrupt` remain separate error states. Conversation, Workflow Artifact, and formal Memory retention stay independent.

The active-memory context sent to a Curator is a deterministic bounded snapshot, not the whole formal index. Records are ordered by `updatedAt` descending, then kind importance, confidence, and stable ID; at most 64 records and 32,000 serialized JSON characters are included. The transaction still builds its staged index against the complete `index.json`, so snapshot truncation cannot weaken exact-duplicate or conflict checks.

Retrieved memory is also treated as untrusted data. The common Memory section generator—not backend-specific code—wraps each statement in a single-line JSON record with an explicit boundary that forbids executing embedded commands, changing permissions, or overriding system/workflow rules. JSON escaping prevents an imported Markdown newline from escaping the data record.

## Confirmation, conflicts, and migration

Preferences, decisions, constraints, workflow rules, lessons, and detected conflicts can enter the confirmation queue instead of active memory. Settings lets the user accept or dismiss them. Accepting a conflict supersedes the older active item; dismissing it removes only the queued candidate.

Settings also exposes status, initialization, immediate sync, transaction recovery, unresolved transaction retry or dismissal, active-memory deletion, and `.codex-memory` migration preview/import.

If status loading fails because a formal file is damaged, the settings page stores and displays the error instead of entering an automatic reload loop. The user can explicitly reload status or run recovery. Confirmation, conflict, import, retry, deletion, and cancellation labels use the selected settings language.

Migration reads `Vault/.codex-memory` without changing it. Preview reports the actual Markdown file count and byte size for every mapping and in total. Explicit import is blocked above 1,000 Markdown files or 4 MiB, converts only an accepted bounded source into structured EchoInk records, writes it through a recoverable formal transaction, and leaves the source directory unchanged. External `codex-memory-lite` remains compatible as a separate tool, but EchoInk does not require it for long-term memory.

## Automated coverage

`src/tests/harness-v2/memory.ts` covers initialization, V1 and missing-projection repair, projection-repair/formal-commit races, field-level fail-closed corrupt/future formal files, corrupt-journal byte retention, redaction and bounds, bounded deterministic Curator snapshots with full-index consistency, concurrent journal writes, trigger no-op, full-sync serialization, commit-identity recovery, manual readiness gates, ledger crash-window replay, strict JSON and malformed-but-covered rejection, unresolved and Curator failure retention, issue retry, confirmation/deletion concurrency, recoverable settings writes, asynchronous terminal capture, workflow ordering and commit gating, cross-backend retrieval, untrusted prompt-data boundaries, recursion guard, Hermes Curator CLI isolation, deletion, expiry, export, backup, and bounded read-only migration.

`src/tests/harness-v2/async-run-settlement.ts` proves that slow or failed Memory observation does not delay a committed terminal Run.

## Real Vault acceptance — 2026-07-16

The implementation was deployed to `<REAL_VAULT>` and exercised through the real Obsidian settings and Agent sidebar. All Agent workspaces used `<REAL_VAULT>/testing`; no business note was edited and no `/maintain` run was started.

Verified in the product UI and on the formal files:

- Settings rendered the Memory V2 controls, initialization was idempotent, and explicit `.codex-memory` preview reported four mappings, 21 Markdown files, and 84.0 KiB without importing them.
- The `.codex-memory` aggregate source hash remained `d4be8dc9a1e0d29d148a53bc688c81e557e0b740a77a2f3a83c3e3d8bb11d2b5` before and after preview and Memory V2 activity.
- A regular Codex Chat stored `MEMV2-716-A`; a new Codex session and a new Hermes session both recovered the same marker from EchoInk's formal `index.json`. The Hermes answer was exactly `MEMV2-716-A`.
- A normal no-signal message returned `收到` without adding formal memory, advancing the revision, or leaving pending events.
- After the original local-archive catalog was added, a no-signal run stored the unique token `ARCHIVE-ONLY-716-Q9K4` only in Harness run `run-1784148283125-90xrid`. A fresh Hermes session then followed the injected catalog, searched `.obsidian/plugins/codex-echoink/harness-runs`, read the older ledger, and returned the token. The retrieval run `run-1784148384260-d5b2er` contains the real search/read tool events. The formal Memory index stayed at revision 6 and the pending journal stayed empty. This proves the on-demand legacy lookup path for that historical snapshot; it does not promise that detailed Run payload remains indefinitely searchable after the 30/90-day retention contract applies.
- The first real Curator retries exposed two strict-output omissions: the contract did not state that the top-level `schemaVersion` must be numeric `2`, or that `confidence` must be a numeric value from 0 through 1. After tightening the contract, the retained pending events committed successfully as `memory-v2-acceptance-marker`; failed transactions were superseded without losing pending data.
- A preference signal entered the confirmation queue and became active only after pressing **Accept** in settings.
- The first conflict attempt exposed a real gap: Hermes described an update from marker A to B but returned `requiresConfirmation:false`, while the local Chinese assignment heuristic failed to identify `标记是 MEMV2-…` as one subject. EchoInk briefly installed both active facts. The fix now treats Curator output as advisory, recognizes Chinese/English assignment subjects and update-style memory IDs locally, and always requires confirmation for a change or contradiction.
- After redeploy and Obsidian reload, marker C entered the confirmation queue with both A and B listed as conflicts. Pressing **Accept** advanced revision 5 to 6, superseded A and B, left only C active, cleared confirmations, and left pending at zero.

The test-only formal state at revision 6 was copied below `<BACKUP_ROOT>/20260716-020753-echoink-memory-v2-real-vault/pre-delete-revision-6` before the deletion check. The final UI deletion check remains pending explicit approval for the destructive GUI action. Memory and automatic sync were left enabled for the accepted product configuration.
