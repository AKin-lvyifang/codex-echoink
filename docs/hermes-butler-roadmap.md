# Hermes Butler Roadmap

This note tracks follow-up work after Hermes becomes a usable EchoInk Agent backend.

## Principle

EchoInk remains the controller of vault safety, resource loading, Raw protection, transactions, reports, and audit logs. Hermes profile, memory, dream, and insights can suggest or draft work, but they must not bypass EchoInk write boundaries.

## Phases

1. Profile mapping
   - Map a Hermes profile or SOUL file to an EchoInk "knowledge butler" role.
   - Keep stable user preferences separate from vault facts.
   - Show which profile is active before a task runs.

2. Memory boundary
   - Define what belongs in Hermes memory, EchoInk local history, Obsidian wiki, and `.codex-memory`.
   - Never treat personality memory as factual vault evidence.
   - Add export/import review before moving memories into Obsidian notes.

3. Dream and insights
   - Store dream/insight output under `outputs/hermes-insights/`.
   - Default to read-only suggestions.
   - Promote suggestions to inbox drafts only after user approval.

4. Proactive modes
   - Level 1: read-only suggestions.
   - Level 2: draft notes and reports.
   - Level 3: pending rewrites requiring confirmation.
   - Level 4: automatic maintenance through existing EchoInk `/maintain` transaction rules.

5. Verification
   - Every proactive write must have a report path, source list, and rollback path.
   - Raw source bodies stay protected.
   - Tool calls and MCP usage must enter EchoInk logs and permission checks.

## Open Questions

- Which Hermes profile should be the default EchoInk butler?
- Should Hermes insights be visible in Home dashboard cards or only in `outputs/` reports?
- Should EchoInk expose dream scheduling, or should Hermes own the schedule and EchoInk only import reviewed outputs?
- How should conflicts be resolved when Hermes memory says one preference and Obsidian project rules say another?
