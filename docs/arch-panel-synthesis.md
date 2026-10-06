# pi-bg-shell: Single-Writer JobService + Tick Reconciler

> **Historical note (2026-09-29):** this doc predates the decoupling pass
> (vendor removal, adapter rewrites, MIT licensing — see NOTICE.md). Remediation
> advice referencing `vendor/`, UNLICENSED, or redistribution permission is
> superseded; findings about engine behavior remain valid.

## Principles (7)

1. **Single writer:** Only `store.ts:JobService` mutates jobs. Watcher/poll/sweep/`turn_start` are lossy kicks that enqueue `reconciler.ts:reconcile()`, never send directly. *(Lens 1+2 win over 3's racing consumers; structural once beats CAS-race.)*
2. **Ground truth on every tick:** Reconciler re-reads `spool/` + `backend.list()`; no reactive sends. *(All agree; Lens 1 wording kept.)*
3. **Explicit states, no sets:** `Starting→Running→Completing→Completed|Failed`, `Running→Killing→Killed`, `Running↔Lost→Running`. Deletes `owned/foregroundExitCodeFiles`, `foregroundRuns/detachRequested`, `backgroundJobs` maps. *(Lens 1 states win; Lens 2 simplification: `detached` is a boolean flag on Running, not a state — halves transitions.)*
4. **Exactly-once by CAS + remove-before-kill:** `Running→Completing` and `Running→Killing` are atomic claims; losers drop. Kill/disown revokes delivery token *before* kill-window so late EXIT-trap writes find no claimant. *(Fusion of all three.)*
5. **Backend port, engine never imports tmux:** `backend/process-backend.ts` interface (`spawn/kill/peek/close/list/health`); `tmux-backend.ts` hides `|||`-scrape, quoting, sanitize, pgroup kill. `fake-backend.ts` for unit tests. *(Lens 2 hexagonal wins over 1's gateway-only; LocalBackend deferred to post-migration.)*
6. **Contract frozen v1:** `job_id:`+`log_path:` text, `tmux-bash-completion/v1` + `tmux-bash-poll/v1` shapes, `/tasks`, footer key, `shutdownPolicy` unchanged unless versioned. Guarded by contract tests. *(Lens 3 versioning wins; append-only fields.)*
7. **Delete-or-justify:** One session per pi process (delete `tmuxWindowScope git-root/all`, `tmuxSessionScope`, `gitRootSessionNameTemplate` — Lens 2 wins for de-entanglement); TypeBox canonical, zod derived at build via generator + snapshot test (Lens 3 wins over 1's zod-source: pi-core is TypeBox-native); `renderers/messages` → `present.ts` pure formatters, engine emits `CompletionEvent` only (unanimous).

## Target module layout

- `src/jobs/store.ts` — `JobService`: `Map<jobId,{handle,exitPath,logPath,command,detached,state}>`; sole `transition()` + `consume()` CAS; terminal `forgetJob()` only from `Completed/Failed/Killed`.
- `src/jobs/reconciler.ts` — only loop: `tick()` every 1s (unref'd) + `turn_start` kick + fs-hint kick. Diffs store vs backend vs spool; emits heartbeats/display-hints; calls `CompletionStore.consume()`.
- `src/jobs/spool.ts` — atomic exit write (`tmp+rename`), strict integer parse (retry next tick), `runDir` lifecycle, prune (`outputDir`+`preserveOutputFiles` only).
- `src/backend/process-backend.ts` — `ProcessBackend` interface. `tmux-backend.ts` (all CLI scraping, typed parse+retry), `fake-backend.ts` (in-memory, injects UNKNOWN/torn-write/down), `local-backend.ts` (stubbed, Phase 4).
- `src/jobs/subscribe.ts` — `subscribe(filter,cb)`: snapshot `Job[]` + `onEvent(transition)`; single ticker fans model/display/silent views. Polls become `peek()`, not timers.
- `src/tools-adapter.ts` — thin `bash/tmux/bg/tasks/Ctrl+B/shutdown` → store ops; `foreground = spawn + waitFor(jobId)` with `detached` cancel flag; preserves text shapes.
- `src/schema.ts` — TypeBox source, zod derived generator; `src/present.ts` — `present(job,event)→{text,details}`; `src/config-facade.ts` — keeps 30 keys aliased, groups `spool/tmux/reconcile/ui` presets (~10 effective, rest deprecated).

## Job state machine

```
Starting → Running → Completing → Completed (keeps .out spool, backend.close, forget)
                 ↘ Completing → Failed (strict-parse fail, tmux down, syntax fail — never silent)
Running → Killing → Killed (kill/disown/shutdown/reaper; no completion)
Running ↔ Lost → Running (tmux alive ∉ store, or owner-pid dead; re-tag same jobId, resume)
Running.detached=true (Ctrl+B during waitFor; same row, delivery continues as background)
```

Ownership = row state; no adoption pass beyond `reconcile()` diff.

## Completion-delivery design

Single `CompletionBus.tick()` inside reconciler is the sole producer. Flow: stat exit-file → strict parse → `CompletionStore.consume(exitPath)` CAS `Running→Completing` (first wins) → send exactly one `tmux-bash-completion {triggerTurn,followUp}` + toast → `backend.close()` per `autoClose` → `Completing→Completed` → `forgetJob()`. Poll/display/silent subscribers only read snapshots via `subscribe()`; fs.watch (if kept) is a kick, not a sender. `Killing` pre-claim guarantees kill-race silence.

## 4-phase migration (vitest green each step)

- **P0 Shadow:** Add `store/reconciler/spool/backend-fake` beside `runtime.ts`; `reconcileMode=off` dark-runs tick, asserts parity with watcher/pollers. Delete nothing. Gate: full vitest + contract-text snapshot tests frozen.
- **P1 Single completion:** Route watcher/sweep/3-poller callbacks through `reconcile()+consume()`; polls → `peek()` views. Delete: `pendingPollTimers`, `pollDelivery/minimumPollInterval/foregroundUpdateMs` logic, `sweepTimer` separate path, per-path `closeWindow/updateStatus` sends. Keep compat text.
- **P2 Single owner:** Replace `disownWindowExitFiles/forgetJobsForWindow/stopAllJobs/reapDeadWindows/adoptOrphanWindows`, `retagging/parseOwnerPid`, scope opts with `store.transition()+backend.*`; collapse foreground/`Ctrl+B` onto `spawn+waitFor`; fold `renderers/messages` → `present.ts`; add TypeBox-generator. Delete: `owned/foregroundExitCodeFiles`, `foregroundRuns/detachRequested`, `tmuxWindowScope/*SessionScope*`, `pane_pid` scrape, standalone reaper, `vendor/zod-tool-call`, `|||/sanitize` inline copies.
- **P3 Cutover:** Delete `watcher+restartWatching`, 3 poller files, legacy `runtime.ts` paths; flip `reconcileMode` default; convert 80% live-tmux tests to `FakeBackend` units, keep 1 live smoke (quarantine nightly). Bump the contract version only if text changed.

## Top 3 risks + mitigations

1. **Silent loss on torn write / missed wake-up:** keep EXIT-trap-only writer + `tmp+rename` + strict-parse-retry; tick re-reads truth so no subscription to lose. Contract test: partial-write fixture must defer, not send.
2. **Kill/disown double-send race:** enforce `remove-before-kill` in one `JobService.stop()` method; test: kill within 50ms of exit-write → zero completions, late trap ignored.
3. **Scope/config breakage (git-root sessions, 30 opts):** facade aliases old keys with deprecation warnings; e2e covers `leave-running` + `session_start` reconcile (`unknown live→add, dead w/o exit→reap`). If smoke fails, flag-off rollback is one env var.
