# Clean-slate architecture panel (2026-09-30)

> **Provenance:** 4 independent designers (minimalist, durability, presentation,
> platform) → 3 judges (shippability, correctness-skeptic, UX-fidelity) →
> synthesis. **The judges split 1-1-1** (ship→minimalist, correctness→durability,
> UX→presentation); the synthesis below takes minimalist as the base and grafts
> the other two in. Treat "winner" as plurality judgment, not consensus.
>
> **Tensions with the current roadmap (maintainer note):** several panel
> deletions conflict with recently shipped, user-requested features — stall
> detection, coalesced batching, steer delivery, the warden. The panel
> optimizes for clean code; those features optimize for live-session UX.
> Migration phases touching them (3, 4) need explicit product sign-off per
> item — "panel says delete" is not alone a reason to remove shipped behavior.
> Start with phases 0–2 (no deletions, all safety).

# Target architecture — minimalist (clean-slate bg-shell)

> One writer per dir, one loop per process. Engine executes + reports frozen strings; chrome decorates. Everything else is deleted.

## Principles

1. **One writer per dir, one loop per process** — a single `sweep()` tick watches own + adopted dirs; no per-dir Reconciler objects, watchers, or pollers to leak or double-fire.
2. **Engine executes + reports; presentation decorates** — engine emits data + stable model text with zero TUI imports; all verdict/elision/duration/unread grammar lives in one `grammar.verdict.ts` in chrome.
3. **Pull beats push** — completions push (must wake the model); interim output is pull-only via `peek`/`Read`. Deletes poll cursors, delivery modes, and cadence config.
4. **Crash safety from two files + two bools, not seven mechanisms** — journal-first spawn + atomic rename consume + `seen` flag + idempotent redelivery id. No `.consumed`-rename-back dance, no staging, no sqlite/outbox/daemon.
5. **Kill-transaction-first, fail closed** — journal `killed+seen` under lock *before* `killpg`/`if-shell`; GUID + epoch gate aborts on mismatch (`STALE_EPOCH`). Killed rows never deliver, ever.
6. **Liveness from mtime + lock, not identity** — `mkdir session.lock` + heartbeat mtime + socket-dead check only. No pid/`startTime`/`/proc` matrix, no nonce options, no `resume.intent` protocol.
7. **Fail closed, never split** — one `pi-id` = one dir forever; stale leftover reclaims in place; live-owner second creator busy-exits. No disambiguated sessions/sockets/sibling sweeps.
8. **Stable identity is `JobId+logPath` only** — `windowId`/`sessionId` never leave the engine, never match, never display. `job_id` stays frozen 6hex; breaking it breaks transcripts.
9. **Byte-identical UX is law** — launch/completion/footer/kill-suppression strings are snapshot-tested; any `@pi-tui` import or verdict string in engine is a bug.
10. **Delete beats migrate** — shadow-drain/dual-home, warden suicide, death-synth, stall machines go outright on major bump (release note: finish legacy jobs first) rather than carrying dual-home races forever.

## Modules

| module | owns | replaces-today |
|---|---|---|
| **store** — `<spool>/<piId>/{session.json, jobs/*.json, session.lock/, heartbeat}` | atomic JSON (`tmp+fsync+rename`), `mkdir`-lock + mtime heartbeat, versioned `JobRecord` `{jobId:6hex, command, name, log, exit, state:running\|killed\|done, seen:bool, done:bool, epoch:int}`. Only module that touches the journal filesystem. Spool path overridable via `XDG_STATE_HOME` / explicit state-spool override. | reconciler cursors, notified-latch machine, foregroundClaim journal fields, `claimHeartbeat`/`claimStealAfter`, owner-lock pid+`startTime`/`/proc` matrix |
| **exec** — tmux private server + windows + EXIT-trap | `ensureSession` (create-or-takeover, GUID set+verify), `spawnJob` (journal-first then `new-window`), `waitJob` (foreground block with Ctrl+B abort), single `killGuarded()` helper (txn `killed+seen` under lock → one fenced kill). Takes store lock; invents no locks. | scattered kill sites, GUID `if-shell` + repair-once + nonce options (kept as one helper), `waitJob` idle-wait hacks |
| **sweep** — the ONLY loop, one `setInterval` tick per process | each tick: heartbeat touch → for each watched dir (`string[]`, own + adopted): strict-parse exit files (torn defers), `consume = rename exit→consumed once` + deliver once via callbacks, close window, update footer. No class, no cursors, no per-dir instances. Interim output pull-only. | reconciler + reaper + socket-sweep + `orphans.ts` as separate subsystems, coalescing hold/holdTimer, `checkStall`, `onPoll`/`deliverPoll`/subscribe, push polls, death.json salvage |
| **janitor** — startup/shutdown only, no timer | called from `session_start`/`shutdown`: takeover-or-busy-exit, rebuild watchlist, reap dead non-`leave-running` dirs (lock+stale gate, GUID kill, unlink dir), unlink dead `pi-bg-*` sockets (prefix+age+liveness), TTL-prune tombstoned dirs, one-shot spool import then self-delete. | `warden` + `warden-loop.sh` + `warden-kill.mjs` + `resume.intent`, standalone `reaper.ts` runs/probes, disambiguated sessions, shadow-drain/legacy backfill/dual-home |
| **tools** — extension-only surface, pi public API only | `bash` (launch/foreground/demote), `tmux list/peek/kill`, `/tasks` (own dirs + trigger-free orphan pointer), `/orphans list/adopt/release` (`adopt` = acquire foreign lock + push dir onto sweep watchlist + one-shot deliver of completed). Idempotent re-peek via stable redelivery id `jobId:exit`. In-memory `claimed:Set<string>` replaces journal claim fields (crash clears by definition). | `widget/jobs-widget`, `tasks-overlay` duplication, `clearAllForegroundClaims`, synthetic `session-reaped` completions, tombstone salvage |
| **report (engine side)** — frozen UX strings | single `buildCompletion()` (single+batch), launch/detach/timeout texts, footer-line builder. Emits serializable `ChromeView` (additive `details`) only. | engine `truncateToVisualLines(5)` vs fork `visualPreview`, engine `collapsedElision` vs fork Done/Read/Running, triple-gate `detectDetachedBash` regexes, `bash*DisplayLines` resolver maze |
| **chrome (presentation fork)** — all decoration | single `grammar.verdict.ts` as only verdict/elision/duration/unread source, single `parseDetached()` replacing triple-gate regexes, `PreviewPipe` + `RowCache` with width-bucketed keys so toggle/expand lives only in chrome, stall hint as pure function over peek tail, minimal plain-text fallback behind `chromeAbsent` flag. | mirrored/duplicated builders, engine-held render state |

## Deleted (what disappears and why)

- **Detached supervisor daemon / sqlite WAL / outbox hold-deliver** — new daemon, new failure modes; replaced by atomic JSON + `seen`/`done` + `jobId:exit` dedup. Lightweight `epoch:int` retained only as in-record fencing token.
- **Setsid+killpg pipe-log runner replacing tmux** — loses pty/fullscreen; keep private tmux server.
- **Move to pi-core `BackgroundJobs` host service** — not shippable as extension; replaced by versioned additive records + import-only mode.
- **Shadow-drain / dual-home legacy backfill** — delete outright on major bump (release note: finish legacy jobs first).
- **Disambiguated sessions** — second creator with live owner busy-exits; dead owner takes over in place.
- **Warden-loop / suicide window / `resume.intent`** — nobody-home GC becomes lazy reaper-on-next-start + TTL prune.
- **Reaper/socket-sweep/orphans as modules, `death.json`, synthetic completions, tombstones** — folded into `sweep()` + `janitor()`; reaped-while-running reports as plain `killed, log retained, exit unknown` row in `/orphans`.
- **Coalescing hold (2500ms) + kick-fast-path** — same-tick batch kept, cross-tick hold deleted. *(Needs product sign-off: shipped per UX request.)*
- **Stall detection in engine** — becomes chrome pure function over peek tail. *(Needs product sign-off: just shipped.)*
- **Push polls (`onPoll`, model-vs-display routing, cursors)** — interim output pull-only. *(Needs product sign-off: foreground streaming depends on it.)*
- **Notified-latch state machine + rename-back rollback** — replaced by `seen+done` two-bools; crash re-peeks `.consumed` idempotently.
- **Owner-lock pid+`startTime` matrix, GUID repair-once, nonce options** — `mkdir`-lock + mtime + socket-dead check; portable macOS/Linux.
- **Foreground-claim journal fields + steal timers** — in-memory `claimed:Set` per process.
- **Re-ID / `windowId` in matching/display** — frozen 6hex `job_id`, `details.jobId`-first matching, footer key kept.

## Data contracts (stable, snapshot-tested, byte-identical)

- **Launch (frozen):** `job_id: <6hex>\nlog_path: <path>\nFollow up with /tasks <id> or read <path>.`
- **Completion (frozen, single `buildCompletion()`):** `customType`/`content` order, `details{summary, output, exitCode, status, jobId, command, logPath, displayName, jobs[]}`, outcome enums `timed-out-background` / `detached-background`. Presentation matches on `details.jobId` only.
- **Kill suppression (frozen):** killed rows never deliver; timeout kills append `Command timed out after Ns` before kill; kill txn precedes the signal.
- **Redelivery id (stable):** `jobId:exit` (epoch included where present). Deliverer consumes but sends nothing for `seen` rows; crash re-peek idempotent.
- **Footer (frozen key `backgroundBashTmuxCommands`):** `N background procs: name · id · age…`, cleared at zero.
- **Chrome boundary:** engine emits data + stable model text, zero TUI imports; `ChromeView` additive; grammar/RowCache live in presentation with plain-text fallback.
- **Orphan scope:** fresh process never consumes foreign dirs; completed foreign announced only as trigger-free pointer; exactly-once token moves only under that dir's lock.
- **Identity:** `JobId+logPath` only. **`windowId`/`sessionId` never leave the engine.**
- **Spool:** `XDG_STATE_HOME`-respecting default + override; one `pi-id` = one dir; versioned additive records.
- **Gates:** CC parity suite as ship gate; string snapshots for verdicts/footers.

## Migration (ordered, each independently shippable)

0. **Freeze + snapshot:** extract `buildCompletion()` + launch/timeout/footer builders; string-snapshot CI; `chromeAbsent` fallback. No behavior change. *(Done 2026-09-30: `src/engine/report.ts` hosts the builders; `tests/bg-report.snapshot.test.ts` pins 13 strings; `plainChrome` gates both renderers.)*
1. **Single kill path:** `killGuarded()` (txn under lock → one fenced kill); delete scattered sites + nonce options. Fewer double-kills, silent killed rows. *(Done 2026-09-30: `killJob` → `killGuarded()` (epoch + lock self-check + notified txn + client GUID pre-check + single if-shell); `closeWindow` routed through it; dead `@pi_owner_nonce` write removed; journal nonces kept for verified release/refresh.)*
2. **Two-bools consume:** `seen+done` + rename-once + `jobId:exit` id; deliverer skips `seen`. Crash test: kill -9 between rename and send re-peeks idempotently. *(Done 2026-09-30: `completionPending` + `delivery{}` replaced by `status` + `seen`; rename-back rollback deleted for a redeliver-from-memory queue; exit codes live in `.consumed` files, not the journal.)*
3. **One sweep tick:** collapse reconciler/reaper/socket-sweep/orphans/coalescing/stall/poll into `sweep()` + `store`/`exec` split. *(Sign-off required per item.)* *(Closed 2026-09-30: structural part shipped (shared tick, `consumeReady`, janitor); coalescing hold, push polls, and engine stall detection RETAINED by product decision — each buys live-session behavior worth more than its lines. Not deferred, decided.)*
4. **Chrome-contract split:** `grammar.verdict.ts`, `parseDetached()`, `RowCache` into fork; engine `render.ts` down to truncation+summary; zero-TUI-import lint; additive `ChromeView` details. *(Done 2026-09-30, engine side: `src/engine/grammar.ts` (pure, zero imports) owns verdict/summary/hint/unread/row grammar; messages/widget/overlay/text-list consume it byte-identically; import-boundary lint test; `v: 1` on completion details with guard passthrough. Fork side (`grammar.verdict.ts`, `parseDetached`, RowCache) pending in the claudify repo.)* *(Done 2026-09-30, both sides: engine `grammar.ts` + fork `render/grammar.verdict.ts` (ported, canonical-pointer header); bash verdicts/hints/detached-detection migrated in fork (`parseDetached` single parser); boundary lint + `v: 1` in engine. Deliberately NOT done: deleting engine `render.ts` renderers — the engine stays standalone-rendering per the option-3 positioning; the fork is interchangeable chrome, not a hard dependency.)*
5. **Startup janitor + identity freeze:** takeover-or-busy-exit, TTL prune; delete warden/disambiguated/shadow-drain/death-synth/pid-liveness; `JobId+logPath`-only matching. Major-bump note: finish legacy jobs first. *(In progress 2026-09-30: owner-lock simplified to mkdir+mtime+nonce with signal-0 stall guard; `resolveJobRef` jobId-only with live-tmux `@id` translation; disambiguated sessions deleted (fail closed); shadow-drain deleted (~150 lines); `Session.epoch` + `killGuarded` epoch fence live. Remaining: death-synth → plain killed rows, warden deletion (exit-empty pin), one-shot spool import (no host exists — deferred). *(Done 2026-09-30: death-synth replaced by plain killed rows; warden + watchdog option + helper scripts deleted — bootstrap shell pins sessions (zero-window survival disproven empirically); nobody-home covered by lazy reaper + TTL prune.)*
6. **Parity gate:** CC parity + snapshot suites as required CI; XDG override; `/tasks` peek + `Read` log as the polling contract. *(Done 2026-09-30: `tests/bg-parity.unit.test.ts` (10 headless contract tests) as `npm run test:parity`; XDG-aware spool default (`XDG_STATE_HOME` → `~/.local/share` → tmpdir); peek+`Read` formalized as the interim contract.)*

## Open questions

- `staleAfter` tuning under scheduler stalls vs accumulation rate (GUID gate keeps false-declare fail-closed).
- `flock` optional-best-effort vs `mkdir`-only without a second lock dialect.
- Epoch bump authority on in-place takeover (prove single-writer in janitor path).
- Same-tick batching width without coalescing hold — measure token cost on fan-outs before closing.
- Long-silent-run wake-ups with push polls deleted — chrome-only idle nudge, or do models reliably peek?
- Import-only host interop handshake — spec now or defer until a host exists?
