Origin UI controls
==================

Source: https://github.com/coss-ui/coss/tree/main/apps/origin/registry/default/ui

Copied from the MIT apps/origin subproject, not the AGPL packages/ui project.
The original copyright and license are preserved in LICENSE.md.

Switch, Checkbox, RadioGroup, Input, Button and Select preserve the upstream
component and primitive structure. Imports use local utils and existing Radix
icons. Select accepts an explicit body portal for the owning window and copies
only the EchoInk theme tokens. The wrapper corrects Select and RadioGroup
keyboard focus in secondary documents without changing Radix internals.
Slider retains Root/Track/Range/Thumb and controlled value behavior; the unused
optional tooltip is omitted to match the approved interface.
Scoped CSS adapts dimensions and colors to EchoInk without a global preflight.

Pagination also adapts apps/origin/registry/default/ui/pagination.tsx and
hooks/use-pagination.ts (MIT). Local imports use existing Radix icons;
page links are buttons with native disabled and aria-current behavior.
When all pages fit, no ellipses are emitted; an isolated missing page is
shown instead of an ellipsis. React roots use the existing island cleanup.
