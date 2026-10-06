# Credits

`@amaksoft/pi-bg-shell` stands on the work of others. This file records
whose ideas it builds on.

## Idea lineage

- **Richard Gill** — author of the original idea: tmux-backed background
  shell execution for pi (`pi-tmux-bash` in `richardgill/pi-extensions`).
  This project began as a fork of that code and was then fully rewritten
  (see `NOTICE.md`): **at the time of publication no shared code remains**,
  but the founding idea — run background jobs on tmux instead of in pi
  core — is his, and is gratefully acknowledged.

## Why extension-only (no pi core changes)

Background execution is deliberately outside pi core's scope: pi provides
native foreground Bash execution, streaming, timeouts, and truncation, but
no background-job registry, no detach, and no completion notifications
(see `docs/plans/2026-09-18-background-shell-research.md` in the companion
project for the full capability/gap analysis). The pi maintainers' position
is that background execution belongs in extensions, with tmux as the
mechanism — so this package implements the whole engine extension-side,
against pi's public extension API only.

Upstream proposal for a first-class `BackgroundJobs` host service is tracked
in the research doc; until/unless pi ships it, this extension is the
fallback made real.

## Architecture (summary)

One private tmux server per pi session (`tmux -L pi-bg-<id>`, never the
shared default server), so sessions cannot address each other's windows by
construction. Each session owns a spool dir of JSON sidecars
(`session.json`, per-job journals, exit files written tmp+fsync+rename):

- **Spawner** journals the job *before* creating the tmux window, so a
  crash can never produce an untracked window.
- **Single reconciler tick** owns all delivery: exactly-once completion
  follow-ups, interim polls, and batched/coalesced reports.
- **Owner lock + heartbeat** fence each spool dir; only the live owner
  reconciles it.
- **Reaper** (on `session_start`) buries dead sessions and sweeps leaked
  socket files — kills are GUID-verified, unknown is never treated as dead.
  (An in-tmux warden window did this job until Phase 5; the bootstrap shell
  now pins sessions structurally, and lazy reaper-on-next-start covers
  nobody-home.)
- **Orphan adoption** (`/orphans`) lets a new session take over a dead
  session's spool under the same fencing, preserving original job IDs.

Full detail: `docs/architecture-1-1-sessions.md`; user-visible guarantees:
`docs/completion-contract.md`.

## Design inspiration

- **Anthropic's Claude Code** — the UX paradigms paritied here:
  `run_in_background`, Ctrl+B send-to-background, `/tasks` job management,
  output-file `Read`, and automatic completion reports.

- **Patrick Rho's `pi-patty-bg-tasks`** (MIT) — the independent sibling
  implementation this engine learned from: the `notified` latch with
  read-suppresses-notification semantics, mid-turn steer delivery of
  completions, interactive-prompt stall detection, and the timeout-kill log
  marker. Ported here onto durable sidecars (so the latch survives
  restarts); the ideas are his.

## Platform

- **earendil-works/pi** — the agent harness and public extension API this
  package is built on (`@earendil-works/pi-coding-agent`,
  `@earendil-works/pi-tui`).

## Companion presentation

- **`@owlburtoe/pi-claudify`** (MIT) — the presentation layer this engine
  pairs with (Claude-style chrome, footer, settled-bash grammar). It began
  as a fork of `FammasMaz/pi-cc-tools` and has since been ~80% rewritten
  in this project line (aggregation, message chrome, conformance suite);
  completion blocks here mirror its collapsed verdict grammar exactly
  (`Done (N lines) (ctrl+o to expand)`, no preview, no click hints).
  Hosted on a personal Forgejo with no issue/PR path — long-term home TBD.

## Maintainer

- **amaksoft** — rewrite, session architecture, reconciler/reaper/janitor,
  orphan adoption, and ongoing maintenance.
