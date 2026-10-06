# pi-bg-shell — provenance and distribution status

Lineage
-------
This project began as a fork of `richardgill/pi-extensions`,
directory `extensions/tmux-bash`, at commit
8eda59af3d2204b03f721362b6215af6626952f7 (2026-09-07). That repository
carries no license file.

Decoupling (2026-09-29)
-----------------------
The fork has been fully decoupled from its upstream origin:

- `vendor/` (verbatim upstream `pi-config`, `pi-zod-tool-call`) deleted and
  replaced with original implementations (`src/config-file.ts`,
  `src/tool-call.ts`) written against pi's public API and zod/typebox.
- Every adapter file with upstream lineage rewritten from scratch
  (`config`, `runtime`, `render`, `renderers/messages`, `system-prompt`,
  `tmux-utils`, `tool-call-schemas`, `tools/bash-tool`, `tools/tmux-tool`,
  `extension`), preserving behavior pinned by the test suite.
- Upstream doc artifacts (`docs/upstream-README.md`,
  `docs/upstream-CHANGELOG.md`) removed.
- The engine (`src/engine/*`), tool commands (`tasks`, `overlay`, `widget`,
  `orphans`), tests, and docs were authored in this project.
- The `v2` version scaffolding was removed (v1 was never released):
  `src/engine/*`, unprefixed names, `sessions` spool dir, sidecar
  `version: 1`.

No upstream code remains in this package. Behavior that must stay
compatible (tool names, sidecar field names, tmux option names, user-visible
texts covered by the completion contract) is interface, not expression.

Distribution status: MIT
------------------------
Published as `@amaksoft/pi-bg-shell` under the MIT license (see LICENSE).
Install with `pi install npm:@amaksoft/pi-bg-shell` (or pin a git ref:
`pi install git:github.com/amaksoft/pi-bg-shell@v0.1.0`).
Companion presentation package: `@owlburtoe/pi-claudify` (MIT, separate
lineage via `FammasMaz/pi-cc-tools`).
