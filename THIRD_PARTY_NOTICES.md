# Third-Party Notices

## Finance brand SVG supplement

The 35 selectable brand SVGs under `assets/finance-brands/svg/` are bundled
from the following pinned upstream revisions. Per-asset source paths, names,
and license details are recorded in `assets/finance-brands/sources.json`.

- Simple Icons, commit `1089fb7d2bf0e323f834c205ab76265005a6d5e8`, CC0-1.0; license copy: `assets/finance-brands/licenses/simple-icons-LICENSE.txt`.
- gilbarbara/logos, commit `37a6b807fd71c622efea27a9309b5d4edc792969`, CC0-1.0; license copy: `assets/finance-brands/licenses/svg-logos-LICENSE.txt`.
- icongo/bank-logos, commit `ffca539a043900fbf2a4fd6a5d32f1706ae5dfd1`, MIT; license copy: `assets/finance-brands/licenses/bank-logos-LICENSE.txt`.

Brand names and marks remain the property of their owners. These assets are
optional artwork choices, not merchant identity or payment-account matching rules.

## React DOM

EchoInk bundles React DOM 19.1.1 with a targeted build-time adaptation that
removes its unused executable-script resource loaders: `preinitScript`,
`preinitModuleScript`, and the `script` branch of `acquireResource`. Calls to
these unsupported capabilities fail explicitly. The remaining renderer and
style-resource behavior are preserved; the installed dependency is not edited.
The adaptation checks the dependency version and source structure and fails
the build if an upgrade requires review.

- Upstream: https://github.com/facebook/react/tree/v19.1.1/packages/react-dom
- Build adaptation: `scripts/react-dom-script-resources.mjs`
- Regression checks: `scripts/react-dom-script-resources-tests.mjs`
- Upstream license: `node_modules/react-dom/LICENSE`

MIT License

Copyright (c) Meta Platforms, Inc. and affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Magic UI

EchoInk vendors the official Magic UI `BentoGrid`, `AnimatedShinyText`,
shared `cn` utility, and shadcn-compatible `Button` sources at commit
`2d671cc6c0e0f40e28682c9cbddd16694dcfe627`. The upstream global animation
declarations are retained locally as provenance for the isolated build-time
Tailwind CSS output. The unmodified upstream stylesheet is stored as
`src/home/magic-ui/provenance/globals.css.reference`; the build reads only its
`shiny-text` animation declaration and keyframes, rather than shipping the global
stylesheet.

- Repository: https://github.com/magicuidesign/magicui
- Source manifest: `src/home/magic-ui/SOURCE.json`
- License copy: `src/home/magic-ui/LICENSE.md`
- `apps/www/registry/magicui/bento-grid.tsx` — SHA-256 `9c2abcb2a4e51519e56d510299771a2d0e170ab9927a9a792a58614b1837ed47`
- `apps/www/registry/magicui/animated-shiny-text.tsx` — SHA-256 `3743a0a0b4894840a96bacd839e493872bac484a940684f91fd23a1784c00fbb`
- `apps/www/registry/lib/utils.ts` — SHA-256 `7c8c3dfc0cdd370d44932828eb067ef771c8fe7996693221d5d4b90af6d54f2d`
- `apps/www/components/ui/button.tsx` — SHA-256 `881fabaf889450b7c671ffabe455bd4b4d101c36f80868f1bf4819ba5f4f4886`
- `apps/www/styles/globals.css` — SHA-256 `b290ad71358829d043a8453924e0b97878596294849de34ea08451412fd760f2`
- `LICENSE.md` — SHA-256 `0147b84235ed916b8b4e89c1f80655351c5afe7d211b629be61f553a227b34ba`

MIT License

Copyright (c) Magic UI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Amicro Micro Transitions

EchoInk includes product-copy and lifecycle adaptations of four official
Amicro loading components from commit
`86b55340bfb939b8e93bb53aa46ba017c3449f1c`. The adaptations preserve the
upstream motion algorithms while adding Chinese text props, EchoInk class
hooks, reduced-motion behavior, visibility pausing, and React-root cleanup.

- `registry/ui/loading/text-shimmer-wave.tsx`: upstream SHA-256 `30c3d97fb98214283b760734c4331677bfccba77e02a5ba09b5fea42183ea489`; local `src/home/amicro/text-shimmer-wave.tsx`: `04e9f7914a6ec82d21b21bf7651dfe38d97c3e55771e3be3eb4af244d5a38601`
- `registry/ui/loading/morphing-shape.tsx`: upstream SHA-256 `ad2bb3627d8c332a199f656413aa8dc2604ea39226011d5bb326518c4522f317`; local `src/home/amicro/morphing-shape.tsx`: `5cf2101ae48601e247e46774ee3808ed97f022d2539e7f209e532a57f5cc9dfa`
- `registry/ui/loading/typing.tsx`: upstream SHA-256 `0cc94473f7b97885f64a946a189a8c1d641bb6efccdc75ac05607606013faa83`; local `src/home/amicro/typing.tsx`: `a83ff8833ce11374441f982ba74b08fcf34e8963f44bdcb251660f479f62c955`
- `registry/ui/loading/origami-shape.tsx`: upstream SHA-256 `7800305ad25cb6962aef752a8dc57fba28fed3544ba2dbfdb2a4752eb912baa5`; local `src/home/amicro/origami-shape.tsx`: `2e0bb583a734b79d357b0a56184e089b1f677b4f8b0fc0fc65a14c5abd12791b`
- `LICENSE`: upstream SHA-256 `4b2e0abfc3fdc8722545c3772ee7c6fd0bcdbe8af76112af50066689fca4a9c2`; local `src/home/amicro/LICENSE.md`: `4b2e0abfc3fdc8722545c3772ee7c6fd0bcdbe8af76112af50066689fca4a9c2`

MIT License

Copyright (c) 2026 SYED  SUBHAN UDDIN

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## SmoothUI

EchoInk includes native TypeScript DOM and CSS adaptations of the official
SmoothUI `Blur Out Up`, `AI Message`, `AI Reasoning`, `AI Tool Call`,
`AI Artifact`, `AI Task List`, `AI Diff`, `AI Approval`, `AI Sources`,
`AI Loader`, `AI Response`, and `AI Suggestions` component patterns.

Adapted official component sources:

- [Blur Out Up](https://github.com/educlopez/smoothui/blob/main/packages/smoothui/components/blur-out-up/index.tsx)
- [AI Message](https://github.com/educlopez/smoothui/blob/main/packages/smoothui/components/ai-message/index.tsx)
- [AI Reasoning](https://github.com/educlopez/smoothui/blob/main/packages/smoothui/components/ai-reasoning/index.tsx)
- [AI Tool Call](https://github.com/educlopez/smoothui/blob/main/packages/smoothui/components/ai-tool-call/index.tsx)
- [AI Artifact](https://github.com/educlopez/smoothui/blob/main/packages/smoothui/components/ai-artifact/index.tsx)
- [AI Task List](https://github.com/educlopez/smoothui/blob/main/packages/smoothui/components/ai-task-list/index.tsx)
- [AI Diff](https://github.com/educlopez/smoothui/blob/main/packages/smoothui/components/ai-diff/index.tsx)
- [AI Approval](https://github.com/educlopez/smoothui/blob/main/packages/smoothui/components/ai-approval/index.tsx)
- [AI Sources](https://github.com/educlopez/smoothui/blob/main/packages/smoothui/components/ai-sources/index.tsx)
- [AI Loader](https://github.com/educlopez/smoothui/blob/main/packages/smoothui/components/ai-loader/index.tsx)
- [AI Response](https://github.com/educlopez/smoothui/blob/main/packages/smoothui/components/ai-response/index.tsx)
- [AI Suggestions](https://github.com/educlopez/smoothui/blob/main/packages/smoothui/components/ai-suggestions/index.tsx)

MIT License

Copyright (c) 2024 Eduardo Calvo

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Vercel AI Elements

EchoInk includes modified native Obsidian TypeScript DOM and CSS adaptations
of the Vercel AI Elements `Sources` component for local document provenance,
the read-only `Task` component used for durable task-plan history, the
`Question` and `Confirmation` interaction semantics, and the `Attachments`
container, preview, info, and remove semantics, plus the `Shimmer` text-loading
effect used while an Assistant reply is being prepared.
The adaptation replaces React, Radix Collapsible, Tailwind CSS, and Lucide with
the existing Obsidian DOM and icon APIs, and it intentionally omits the
upstream external-link behavior.

Adapted upstream source at commit `6a9d5b1822ffb10bba4bd97175f01edd7d8651cd`:

- [Sources](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/sources.tsx)
- [Task](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/task.tsx)
- [Question](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/question.tsx)
- [Confirmation](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/confirmation.tsx)
- [Attachments](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/attachments.tsx)
- [Shimmer](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/shimmer.tsx)

Copyright 2023 Vercel, Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

## AnimateIcons

EchoInk includes dependency-free native SVG and CSS adaptations of the
AnimateIcons Lucide `Upload`, `Mic`, `Send Horizontal`, `Circle Stop`, `Users`,
and `User Round Pen` icons. The adaptation replaces React and Motion with the
existing Obsidian DOM and EchoInk motion tokens, including reduced-motion
behavior.

Adapted upstream sources at commit `e19861bd8e1e214105221040aefb27644fd1362f`:

- [Upload](https://github.com/Avijit07x/animateicons/blob/e19861bd8e1e214105221040aefb27644fd1362f/icons/lucide/upload-icon.tsx)
- [Mic](https://github.com/Avijit07x/animateicons/blob/e19861bd8e1e214105221040aefb27644fd1362f/icons/lucide/mic-icon.tsx)
- [Send Horizontal](https://github.com/Avijit07x/animateicons/blob/e19861bd8e1e214105221040aefb27644fd1362f/icons/lucide/send-horizontal-icon.tsx)
- [Circle Stop](https://github.com/Avijit07x/animateicons/blob/e19861bd8e1e214105221040aefb27644fd1362f/icons/lucide/circle-stop-icon.tsx)
- [Users](https://github.com/Avijit07x/animateicons/blob/e19861bd8e1e214105221040aefb27644fd1362f/icons/lucide/users-icon.tsx)
- [User Round Pen](https://github.com/Avijit07x/animateicons/blob/e19861bd8e1e214105221040aefb27644fd1362f/icons/lucide/user-round-pen-icon.tsx)

MIT License

Copyright (c) 2025 Avijit Dey

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
