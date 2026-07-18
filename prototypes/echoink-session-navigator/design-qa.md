# EchoInk 会话选择器 Design QA

## Comparison setup

- Source visual truth: user-supplied rectangular session-list reference, preserved in the comparison artifacts below
- Existing-problem reference: user-supplied screenshot of the overflowing numeric session tabs
- Implementation screenshot: `artifacts/session-picker-light-12-final.png`
- Stress-state screenshot: `artifacts/session-picker-dark-narrow-30.png`
- Full-view comparison: `artifacts/source-vs-prototype.png`
- Focused list comparison: `artifacts/source-vs-prototype-focused.png`
- Browser viewport: `1100 × 900`
- Primary plugin frame: `520 × 820`
- Narrow plugin frame: `360 × 820`
- Compared state: light theme, 12 sessions, picker open, first session selected

## Full-view comparison evidence

The source establishes a quiet vertical session list with rectangular rows, a soft selected background, full session titles, and small trailing actions. The implementation keeps that hierarchy inside an EchoInk-native picker while adding the controls required by the brief: total count, search, knowledge-base pinning, running state, management mode, batch deletion, and keyboard help.

The picker remains visually subordinate to the existing EchoInk header. It does not introduce a separate application shell or a heavy modal treatment.

## Focused region comparison evidence

`artifacts/source-vs-prototype-focused.png` compares the source list and the implementation list at readable scale.

- Selected state: both use a low-saturation rectangular background. The implementation intentionally maps the gray reference state to EchoInk's interactive accent.
- Row hierarchy: both lead with the title. The implementation adds a small timestamp/status line because session metadata already exists and helps scan a long list.
- Actions: the source shows lightweight trailing actions. The implementation reveals rename and delete on hover/focus so the normal list stays quiet.
- Density: the implementation uses 54px rows so 7-8 sessions remain visible in a typical Obsidian sidebar without shrinking the title below 13px.

## Required fidelity surfaces

### Fonts and typography

- Uses the native system stack used by Obsidian on macOS and Windows.
- Session titles use 13px/520 with 1.25 line height; active title uses 600 weight.
- Header, section labels, metadata, and count badges use a constrained scale with clear hierarchy.
- Long titles truncate in the compact top bar and list row without pushing persistent controls off-screen.

### Spacing and layout rhythm

- Uses 4/8/12/16px spacing families and 8/14px radii consistent with project rules.
- The 520px and 360px frames preserve the knowledge-base button, current-session summary, all-session count, and new-session action.
- At 30 sessions the list scrolls internally: client height `567`, scroll height `1835`.
- Narrow-state measurements show no horizontal overflow:
  - frame width `360`, frame scroll width `358`
  - picker width `334`, picker scroll width `332`

### Colors and visual tokens

- UI is driven by Obsidian-style semantic variables rather than fixed page colors.
- Light and dark themes preserve contrast and selection hierarchy.
- Accent is limited to the current session, running status, and active controls.
- Destructive color appears only in delete controls and confirmation.

### Image quality and asset fidelity

- The target contains no photographic or raster product assets.
- All visible product text is editable DOM text.
- Icons use the Lucide family because EchoInk's production UI uses Obsidian `setIcon`, which exposes the same visual family.
- No screenshot, custom SVG, emoji, CSS illustration, or bitmap is used as the product UI.

### Copy and content

- Uses real EchoInk session titles derived from the supplied reference.
- “知识库” is clearly separated as a permanent channel and excluded from the normal-session count.
- Running-session protection, selected count, irreversible deletion, and keyboard actions are stated in plain Chinese.

### States, interactions, and accessibility

- Verified expand/collapse through the “全部 12” entry.
- Verified search: `Graphify` returns exactly one session.
- Verified batch management: selected two sessions, opened confirmation, confirmed deletion, and observed count change from 12 to 10.
- Verified running-session delete control remains disabled.
- Verified inline rename and confirmed that `Enter` saves without closing the picker.
- Verified `Esc` closes the picker.
- Verified `ArrowDown` + `Enter` switches from the first to the second session.
- Verified 30-session, 360px-wide, and dark-theme states.
- Search, listbox, options, buttons, dialog, input labels, focus states, and reduced-motion behavior are represented semantically.
- Browser console check returned no errors or warnings.

## Findings

- No actionable P0, P1, or P2 findings remain.
- Intentional product additions relative to the source are search, timestamps, knowledge-base pinning, running state, management mode, and keyboard help. These are required to make the reference list work as a scalable EchoInk session selector.

## Open questions

- Production implementation should decide whether “全部 12” counts only ordinary sessions or includes the permanent knowledge-base channel. This prototype counts ordinary sessions and labels the knowledge-base channel as excluded.
- Production deletion must reuse EchoInk's existing session cleanup and confirmation semantics; the prototype only models the interaction.

## Comparison history

- Initial browser pass exposed a preview-canvas vertical scrollbar outside the plugin frame. The stage minimum height was reduced to match the 820px plugin frame. The final screenshot no longer shows the extra page scrollbar.
- Inline rename initially allowed its `Enter` event to reach the picker-level keyboard handler and close the list. Event propagation is now stopped inside the rename field, and the corrected flow was re-verified.
- No P0/P1/P2 mismatch was found during the final full-view and focused comparison pass.

## Implementation checklist

- Reuse `StoredSession.title` and `updatedAt`; no new persisted title or timestamp field is needed.
- Replace unbounded numeric-tab rendering with a compact current-session summary and counted picker entry.
- Add an in-sidebar picker with search, selection, keyboard navigation, and internal scrolling.
- Route single and batch deletion through the existing cleanup boundary, with knowledge-base and running-session protection.
- Use Obsidian CSS variables and the existing `setIcon` family in production.
- Add component, session-controller, and real Obsidian interaction tests before release.

## Follow-up polish

- Consider keeping two most-recent sessions as optional quick chips only at wider sidebar widths after the core picker is proven in real Obsidian.

final result: passed
