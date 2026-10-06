# Proposal: 1:1 tmux sessions per pi session (+ reconciler inside)

Status: BUILT (P0-P3 + legacy deletion complete; 106 tests green, tsc clean).

Build notes (deviations found during implementation, all toward less machinery):
- `set-option` takes ONE option per invocation (live-caught bug): GUID/leave-running/nonce apply as three calls.
- Reclaim beats disambiguate: stale owner + leftover live session re-tags in place; disambiguation survives as unreachable-in-practice fail-safe.
- Unknown pid state reads as ALIVE (fail-safe); only kill-ESRCH or start-mismatch proves death.
- `owner.json`-less lock dirs take over (writer crashed) instead of wedging.
- R4 gate counts @pi_job_id-TAGGED windows; fresh sessions drop the bootstrap window so the gate can fire.
- Forward-to-owner stayed deleted (R2): same-pi-id seconds busy-exit for ALL operations; subagents use distinct pi ids.
- Private servers (R1) made P0 cross-version kills structurally impossible; no flag-day incident possible.
- Legacy e2e retired with the code it specified (excluded from tsc); engine e2e rewrite is the remaining test debt.
- `/orphans` command replaces the proposed `pi --list-orphans` CLI (extensions cannot add argv flags); adopt/salvage/reap wired through it.

Goal: replace the shared-session architecture
with per-pi-session ownership, keeping the user-visible contract byte-identical.

## Problem with current (see docs/review-2026-09-24.md for the full history)

One shared tmux session (`pi-background`, or per-repo with git-root scope) for
all pi sessions. Isolation via window tags + scope filters + in-memory registry
+ disown-before-kill + adoption/retag/pid-parsing. Every silent-loss,
collision, and orphan bug we ever fixed lives in this sharing layer. Neither
git-root anchoring nor cross-session visibility has a Claude Code counterpart:
CC tasks belong to their conversation, period.

## Target

- One tmux session per pi session, with a stable lookup key independent of OS
  pid (see S1). Created lazily on first command; destroyed on shutdown unless
  `shutdownPolicy: leave-running`. Each session lives on its OWN private tmux
  server (`tmux -L pi-bg-<12hex>`); no two pi sessions — and no legacy
  `pi-background` install — ever share a server socket (see S1).
- One window per command (unchanged mechanics: tagged, spool log, exit file).
- Crash/restart: `--continue` (same pi id) reattaches to the surviving tmux
  session and rebuilds the job map from a persistent sidecar (see S2) — no
  spool-name parsing, no retagging, no pid detection for identity.
- Fresh starts (new pi id) stay blind to running foreign sessions (matches CC)
  but MUST NOT kill `leave-running` survivors (see S5).
- Completion: the panel's single reconciler tick per session (watcher hint +
  interval; exactly-once by atomic file consumption of sidecar records).
  The tick owns ALL four delivery paths (no orphaned UX): (a) completion delivery via atomic consume; (b) interim poll check-ins per job (`minimumPollIntervalSeconds`, per-job lines) with `pollDelivery: "model"` (trigger turn) vs `"display"` (trigger-free, UI-idle-only) routing preserved; (c) adopted-orphan silent-poller path (completion-only, no interim polls, latency bounded by `minimumPollIntervalSeconds`); (d) `turn_start` sweep backstop over owned non-foreground exit files. Polls become `peek()` snapshot views fanned out from the tick via `subscribe(filter,cb)` (model/display/silent views), not independent timers. Single-owner fencing guarantees at most one reconciler ever watches a spool
  dir (see S3).
- Kill: kill-window scoped to the owned session GUID, never a bare server-global
  `@windowId` (see S3).
- Registry stays in memory for speed, but every mutation is journaled to the
  sidecar first so `--continue` can rebuild it (see S2).
- Foreground/background separation is kept as an explicit claim flag (see S6);
  the old `owned`/`foregroundExitCodeFiles` sets are replaced by that flag, not
  deleted without successor.
- Contracts frozen: `job_id:`/`log_path:` return text, `tmux-bash-completion`
  shape, `/tasks`, Ctrl+B detach text, `shutdownPolicy`, footer key — EXCEPT the completion-contract Orphan-adoption clause, which S5 deliberately narrows (Session-scope ownership) under the P1 major-version bump.
- Deleted: tmuxWindowScope/sessionScope options, gitRootSessionNameTemplate,
  retagging, parseOwnerPid, disown helpers, poll flavors (single
  silent-capable tick), shared-session QA flake class. Retained in new form:
  reattach-by-sidecar (replaces adoption-by-parsing) and orphan handling per S5.

## S1 — Session identity and lookup (resolves reattach-vs-pid blockers)

- Canonical session name is pid-free: `pi-bg-<pi-session-id>`.
- Private server per session (R1): every session lives on its own tmux server, socket name `pi-bg-<12hex>` where `<12hex>` is the first 12 hex of sha256(pi-id) (short hash keeps the socket path under the 108-char Unix limit). All tmux invocations for that session pass `-L pi-bg-<12hex>` (in-session processes inherit the right socket via `$TMUX`, so the warden needs no flag). Disambiguated sessions (stale-owner-leftover case) get their own socket `pi-bg-<12hex>-p<pid>-<rand4>`. Consequences: old code on the default server can neither list nor address private sessions — P0 cross-version wrong-window kill is impossible by construction; recycled window ids cannot cross sessions because sessions do not share a server; the reaper enumerates sockets by prefix scan of the tmux socket dir (`$TMUX_TMPDIR` or platform default). Cost (~one tmux server per pi session, MBs each) is accepted: it buys the strongest isolation primitive tmux offers. This supersedes the earlier shared-server decision.
- The creating OS pid is NEVER part of the lookup key. If creation collides with a live tmux session of the same name, the second creator MUST first attempt the owner lock (S3) on `<spool>/<pi-id>/session.lock` via a non-blocking exclusive-flock attempt plus a `heartbeatAt`-vs-`reaperStaleAfter` check: if the holder's heartbeat is fresh (or the flock is held) the claimant MUST busy-exit ("session busy, original pi still alive") and MUST NOT create a second session — silent fragmentation of one conversation's jobs across two sessions/spool dirs is prohibited (see same-pi-id rule below). Only when the lock is acquirable AND stale — BOTH the non-blocking flock attempt succeeds AND `heartbeatAt` is older than `reaperStaleAfter` per the S4 conjunction (owner provably dead) — yet the tmux name is still live (leftover session) may the second creator fall back to a disambiguated name `pi-bg-<pi-id>-p<pid>-<rand4>`, which owns a fully separate spool dir `<spool>/<pi-id>-p<pid>-<rand4>/` with its own `session.json` (`{ piId, disambiguatedFrom: <pi-id>, sessionName, sessionGuid, ... }`), its own `jobs/` namespace (jobIds may collide textually but are isolated by dir), and its own `session.lock`. Two live reconcilers therefore never share `session.json`, `jobs/*.json`, or a lock — the S1/S3 split-brain is closed by construction. The suffix is disambiguation-only, never a lookup key.
- Same-pi-id concurrency rule (no fragmentation): two processes sharing one pi id NEVER both own sessions/reconcilers concurrently. Session/reconciler creation against a live owner always busy-exits ("session busy, original pi still alive") and MUST NOT auto-split the job map. Owner-dead — the ONLY gate that permits the S1 disambiguated fallback or any `--continue`/adopt takeover — is defined exactly as the S4 conjunction: (a) a non-blocking exclusive-flock attempt on that spool dir's `session.lock` SUCCEEDS (no live holder) AND (b) `heartbeatAt` is older than `reaperStaleAfter`. Either condition alone is insufficient: a just-crashed owner leaves the flock free but the heartbeat fresh (or vice versa under scheduler stall), and an OR gate would let a second creator split into `pi-bg-<id>-p*` while the old session is still live/repairable, fragmenting one pi id across two spool dirs/job maps. Same-pi-id second-process operability (defined, no forwarding — S1 R2): `spawn` (and any reconciler/session creation) from a non-owner sharing the pi id busy-exits EXACTLY like creation ("session busy, original pi still alive"); `status`/`peek`/`list` are read-only via the sidecar plus a tmux snapshot and MUST NOT take `session.lock`, refresh the heartbeat, or consume exit files; `kill` does NOT busy-exit — it proceeds via the S3 single guarded kill-window command (server-side predicate) AFTER journaling `status: 'killed'` per S2/S3 UNDER that dir's `session.lock` (bounded blocking wait, never busy-exit, never heartbeat refresh), so a second attachment can always kill a runaway job while the fenced reconciler observes the killed journal under the same lock and suppresses delivery. Rationale: forwarding was a sharing mechanism smuggled into an isolation design, and every open crash-safety blocker lived in it. Subagents SHOULD use distinct pi ids (own session, own private server, own spool dir, no contention at all) plus `--list-orphans` / `--adopt-orphan` for cross-session visibility, but correctness no longer rests on that assertion — a same-pi-id sharer gets defined read+kill, never a hard-fail on kill. `/tasks` and the footer therefore always show the full job map of the single owned spool dir.
- No `owner.sock` (R2): with forwarding deleted there is no inter-process socket and no stale-sock lifecycle. Same-pi-id second-process rule is spawn/creation busy-exits, status/peek read-only without the lock, kill via the S3 guarded command under `session.lock` with a bounded wait (see same-pi-id rule above); cross-session visibility is `--list-orphans` / `--adopt-orphan` only.
- `--continue` (same pi id) resolves its server socket `pi-bg-<12hex(pi-id)>` (scanning `pi-bg-<12hex>-p*` sockets for disambiguated leftovers), then its session by exact name inside, and selects the entry whose sidecar (`<spool>/<pi-id>/session.json`, or `<spool>/<pi-id>-p*-*/session.json` for disambiguated leftovers) lists that pi id and whose owner lock (S3) is acquirable AND stale per the S4 conjunction (non-blocking flock succeeds AND `heartbeatAt` older than `reaperStaleAfter`). Deterministic winner: the canonical `<spool>/<pi-id>/` entry wins whenever its session is live; disambiguated dirs are considered only if the canonical entry is missing/dead, newest `createdAt` first. It never guesses by pid substring; live-job ownership is never silently merged across sibling dirs (see S5 for the completed-orphan cross-sibling report rule, which reports completions without merging live watch sets).
- Strict deterministic single-name lookup is explicitly rejected: it strands
  the surviving session whenever the continued process has a new pid, leaving
  a live orphan plus an empty new session.

## S2 — Crash recovery via persistent sidecar (resolves identity-loss blocker)

The in-memory registry alone is unsound across crashes. Therefore:

- Each session owns exactly one spool dir. Canonical: `<spool>/<pi-id>/`; disambiguated (S1 stale-owner-leftover case only): `<spool>/<pi-id>-p<pid>-<rand4>/`. Each dir is self-contained:
  - `session.json`: `{ piId, disambiguatedFrom? (only on disambiguated dirs), sessionName, sessionGuid (random at create),
    tmuxServer (`-L pi-bg-<12hex>`, always private; see S1), shutdownPolicy, version: 2,
    createdAt, ownerNonce, state: 'creating' | 'active' }`, fsynced at session creation.
  - `jobs/<jobId>.json`: `{ jobId, windowId, spoolLog, exitFile,
    completionPending: bool, foregroundClaim: bool, claimHeartbeatAt?, status: 'running' | 'killed' | 'done',
    delivery: { state: 'pending-local' | 'delivered-local',
      exitCode?, tailPtr?, completedAt? } }`, fsynced at
    spawn before the window starts; updated atomically (write-tmp + fsync + rename)
    on state transitions. Kill suppression is journaled: the killer MUST write
    `status: 'killed'` (completionPending=false) via tmp+fsync+rename BEFORE
    issuing the S3 guarded kill-window (Blocker: Frozen Kill). A `killed` record is
    terminal — excluded from rebuild watching, reconciler sweeps, interim polls,
    `turn_start` backstop, and `--adopt-orphan` adoption; any EXIT-trap late write
    of the exit file after the kill journal is ignored (never consumed, never
    delivered, unlinked on sweep). Completion delivery is ordered intent-before-consume:
    the deliverer MUST first run `parseExitCode(exitFile)` to a successful parse (torn-write guard) — on parse failure (partial/torn write, garbage) it MUST leave the exit file in place, stage NO delivery-intent, write NO `*.consumed` marker, and retry on the next tick. ONLY after a successful parse, the deliverer MUST fsync the delivery-intent update to `jobs/<jobId>.json`
    (`delivery.exitCode/tailPtr/completedAt` staged, state still `pending-local`)
    via tmp+fsync+rename, THEN do the atomic `rename(exitFile -> exitFile.consumed)`,
    THEN mark `delivery.state: 'delivered-local'` via tmp+fsync+rename. The consume rename is therefore gated on parse success: garbage never converts a retryable torn write into a terminal `consumed` marker. Rebuild rule:
    presence of `exitFile.consumed` (or absence of `exitFile` with a staged intent)
    is authoritative — the record MUST be treated as delivered even if the crash
    landed between rename and the final journal update, so recovery neither
    duplicates nor loses (Blocker: consume/journal crash window).
  - `session.lock`: the S3 owner lock for THIS dir only (disambiguated dirs have their own lock; locks are never shared across dirs).
- Atomic creation order (crash window defined, no unkillable sessions): (1) generate `sessionGuid` + `ownerNonce` locally; (2) `mkdir -p <own-spool-dir>`, write `session.json` with `state: 'creating'` via tmp+fsync+rename (intent published before tmux exists); (3) `tmux -L <sock> new-session -s <sessionName>`, then immediately `set-option @pi_guid <guid> @pi_leave_running <policy> @pi_owner_nonce <nonce>` and read-back-verify in the same step; (4) rewrite `session.json` to `state: 'active'` via tmp+fsync+rename. Crash recovery on `--continue`/reaper: sidecar `creating` with no live session => discard + recreate; live session with missing/mismatched `@pi_guid` but matching `sessionName` + held/acquirable lock for its spool dir => the lock holder repairs by re-applying `set-option @pi_guid` from `session.json` and re-verifying (exactly once) before any kill; only if repair fails is the session treated as foreign (never killed blindly, surfaced via `--list-orphans`). The GUID check can therefore never permanently strand an unkillable session.
- `--continue` with a new runDir rebuilds `jobId -> { window, spool, exitFile }`
  exclusively from its OWN dir's `jobs/*.json` (never across dirs), then reconciles each record against live
  tmux state (`list-windows` on the owned session), the exit files, AND `*.consumed` markers. No
  spool-filename parsing, no retagging. Rebuild MUST: (a) crash-recover every `status: 'killed'` record, never blind-drop (closes journal-first kill crash strand): a crash between the killed journal and the guarded kill leaves a LIVE window whose record reads terminal `killed`, which a blind drop would strand untracked (no sweep/backstop/adopt watches it, no reachable kill path). Rebuild MUST therefore verify each `killed` record against live tmux state (`list-windows` on the owned session): if the window is still live, rebuild MUST re-issue the S3 single guarded kill-window command for that record (idempotent, server-side GUID predicate, still under suppression — reconciler never delivers it, late EXIT-trap exit-file writes stay ignored/unlinked); if the window is already gone, drop the record from the watch set. Killed jobs still never resurrect as pending/delivered — the only post-rebuild action on a `killed` row is a suppressed re-kill or a drop; (b) treat any record with a sibling `exitFile.consumed` present as `delivered-local` regardless of the journaled `delivery.state` (crash landed between rename and final journal update — do not re-deliver, do not lose: just complete the journal to `delivered-local`). As part of rebuild it force-clears every `foregroundClaim` to false (see S6): no live foreground waiter survives a crash, so the reconciler becomes the defined new owner of all pending completions.
- Without this sidecar, completions after crash would be emitted without a
  jobId (breaking frozen `tmux-bash-completion` jobId matching) or lost; that
  failure mode is closed by construction here.

## S3 — Single-owner fencing; session-scoped kills (resolves split-brain blocker)

- Every owned session has an owner lock `<own-spool-dir>/session.lock` (canonical `<spool>/<pi-id>/session.lock`; disambiguated dirs their own) holding
  `{ pid, processStartTime (bootid+starttime where available), nonce,
  heartbeatAt }`. The active reconciler holds an exclusive non-blocking flock
  on it and refreshes `heartbeatAt` every tick.
- A second process claiming the same pi id (`--continue` while the original is
  still alive, or two processes sharing one pi id) MUST attempt the lock for that spool dir first via a non-blocking exclusive-flock attempt plus the `heartbeatAt` check (owner-dead = flock acquirable AND heartbeat older than `reaperStaleAfter`, per S4 — never an OR):
  if the holder's heartbeat is fresh (or the flock is held), the claimant
  refuses to start a second reconciler — a session/reconciler-creation or `spawn` attempt
  exits with "session busy, original
  pi still alive" instead of duplicating completions and kills. Defined second-process operability (no forwarding, S1 R2): read-only `status`/`peek`/`list` proceed WITHOUT the lock (sidecar + tmux snapshot, never consume, never refresh heartbeat); `kill` NEVER busy-exits — it proceeds via the single guarded kill-window command below after journaling the S2 killed state UNDER `session.lock` (bounded blocking wait; safe alongside the fenced reconciler because both sides serialize on the same lock — see Mutual exclusion). The claimant MUST NOT auto-create the S1 disambiguated session in this live-owner case (that would fragment the job map and share nothing but confuse `--continue`); the disambiguated fallback is allowed ONLY for the stale-lock + live-name-leftover case defined in S1, where the original owner is dead and the two reconcilers still never share a spool dir or lock.
- Kill path (journaled suppression + atomic compare-and-kill; no verify-then-kill TOCTOU): kill is two ordered steps. Step 1 (journal first, UNDER `session.lock`): the killer MUST acquire that spool dir's `session.lock` (blocking with a bounded wait; kill NEVER busy-exits — a live reconciler holds the lock only across one tick, so the wait is one tick at most) and, while HOLDING the lock, write `status: 'killed'` (`completionPending=false`, staged delivery-intent cleared if present) to `jobs/<jobId>.json` via tmp+fsync+rename BEFORE touching tmux — this is the suppression tombstone. The reconciler, rebuild, sweep, interim polls, backstop, and adopt paths MUST all skip `killed` records, and any EXIT-trap late write of the exit file after this journal is ignored (never consumed/delivered, unlinked on sweep), so a `--continue` rebuild after a crash can never resurrect a killed job as pending. Step 2 (guarded kill): never `kill-window -t @<rawId>` on a shared server, and never `display-message` (verify) + `kill-window`/`kill-session` as two client round-trips. A recycled window id (`@N`) or session-name reuse landing between a separate verify and kill could pass the GUID check yet kill a sibling/new job's window. All kills therefore execute as a SINGLE tmux-server-side guarded command so the GUID comparison and the kill share one server round-trip with no client gap: e.g. `tmux if-shell -t <sessionName>:<windowId> '[ "#{session_name}:#{@pi_guid}" = "<expectedName>:<expectedGuid>" ]' 'kill-window -t <sessionName>:<windowId>'` (and the `kill-session -t <sessionName>` analogue guarding on `#{session_name}:#{@pi_guid}`). The tmux server evaluates the predicate and the kill from one queued command, so a recycle that lands between two client invocations cannot slip through — a stale target fails the in-server predicate and nothing is killed. If the predicate fails because `@pi_guid` is missing (crash between `new-session` and `set-option`), the lock-holding owner repairs it once from `session.json` and retries the single guarded command; only a genuine mismatch aborts the kill and marks the job row for resync, never retried blindly. Second-process kills (S1 defined operability) use this same Step-1-under-lock + Step-2-guarded-command form — they acquire `session.lock` with a bounded blocking wait (never busy-exit on kill), never steal ownership, and never refresh the heartbeat. Mutual exclusion (closes kill/consume TOCTOU, preserves frozen Kill suppress-completion): the reconciler's full consume sequence — read `status`, stage delivery-intent, `rename(exitFile -> exitFile.consumed)`, mark `delivered-local` — MUST execute while HOLDING that dir's `session.lock`, re-checking `status: 'killed'` under lock immediately before the parse-gated intent stage (S2 torn-write guard); the killer's journal likewise executes under the same lock, checking `delivery.state` under lock (already `delivered-local` => kill is a post-completion window-cleanup no-op, never a re-delivery; staged-but-unrenamed intent => the killer's `killed` write clears the staged fields in the same rename, so the reconciler's post-lock re-check sees `killed` and skips the rename). Lock-free journaling is explicitly rejected: without the shared lock the reconciler can read `killed=false`, then interleave with the killer's rename, delivering a completion for a killed job or clobbering the staged intent. The S4 reaper and the S4.1 `pi --warden-kill` helper MUST use this same guarded form (warden: `kill-session` variant only). Residual risk (tmux `if-shell` predicate-vs-kill is server-serialized, not a true CAS register) is accepted: the recycle window collapses from unbounded client scheduling delay to one server command-queue step, and any failure mode is fail-closed (no kill), never wrong-window kill.
- `kill(pid,0)` is never used as an ownership signal (see S4 for why).

## S4 — Reaper liveness without pid-reuse races; flag-day rule (resolves reaper blockers)

`kill(pid,0)`/ESRCH on the pid embedded in the old name is rejected as the
reaper signal because: PID reuse spares dead sessions forever (leak) or kills
the wrong session on name collision; EPERM vs ESRCH differs across
users/containers; and mixed-version coexistence is safe by construction (sessions live on private `-L` servers the old code never addresses — see S1).

- Liveness = lockfile + start-time nonce, not pid alone. A session is
  reaper-eligible only if ALL hold: (a) its name matches `pi-bg-*` (never the
  legacy `pi-background*` names — see flag-day below); (b) the exclusive flock
  is acquirable (no live holder); (c) `heartbeatAt` is older than
  `reaperStaleAfter` (default 5 min); AND (d) the recorded
  `(pid, processStartTime)` no longer corresponds to a live process with the
  same start time (mismatch or gone = dead; same pid with DIFFERENT start time
  = recycled = treated as dead owner, but the session is only reaped if (b)
  and (c) also hold, so a live new holder is never killed).
- Reaper kill uses the S3 session-scoped + GUID-checked kill, session by
  session, never by raw window id.
- `leave-running` sessions are NEVER reaper-eligible (see S5): the reaper
  skips any session whose `session.json` or live `@pi_leave_running` option
  says `leave-running`, regardless of owner liveness.
- Flag-day / mixed-version rule (P0): the new reaper scopes to `-L pi-bg-*` server sockets (prefix scan of the tmux socket dir) and only matches
  `pi-bg-*` names and only reads engine sidecars; during P0 it ignores legacy
  `pi-background*` sessions entirely (old code owns them). Old code only knows
  the legacy names and never matches `pi-bg-*`. `session.json.version`
  distinguishes them; a missing sidecar means "not ours, do not reap." No
  silent cross-version kills. From P1 on (old code deleted), the bounded legacy adopt-or-reap rule in Migration replaces the P0 ignore-legacy stance so upgraded `leave-running` survivors are never stranded.

## S4.1 — Warden window: self-pinning, self-burying sessions (replaces any external watchdog)

No cron, launchd, systemd, or standalone script: each `pi-bg-*` session
carries its own executioner as a real tmux window named `▲ pi-bg-control`,
created alongside the session and running a POSIX-sh sleep loop. It does two jobs:

1. **Pins the session alive.** A tmux session evaporates when its last window
   closes (`exit-empty`) — the flake behind the "can't find session"
   sightings. The warden window means zero job windows no longer means a
   dead session while the owner lives.
2. **Suicides the session when the owner is gone AND the session is empty of job windows (R4: container GC only).** The owner touches
   `<sessiondir>/heartbeat` every slow tick (and a `--continue` winner refreshes each parked sibling's heartbeat/`parked-by` marker per S5, which counts as owner-alive). The warden checks its mtime each
   cycle (`wardenCycleSeconds`, default 60s); after `wardenMissThreshold`
   (default 10) CONSECUTIVE stale checks it runs `tmux kill-session` against
   its own session id, self-resolved via `tmux display-message -p '#S'` (plus
   a `pi-bg-*` name sanity check, never a raw id).

Design rules:

- **No pid logic in the warden.** Owner-alive = heartbeat fresh. A crashed pi
  stops touching the file; pid reuse cannot fool an mtime check. The S4
  pid+start-time fencing stays on the in-pi reaper path only — clean separation.
- **Sleep-safe by counting, not wall-clock.** Consecutive stale checks
  separated by sleeps: if the box sleeps, the warden sleeps too, so wake-up
  never reads as owner death.
- **Threshold ordering:** 10 × 60s ≈ 10 min exceeds `reaperStaleAfter`
  (5 min), so whenever ANY pi process is running, the in-pi reaper gets first
  shot; the warden only fires in the nobody-home case the reaper cannot cover.
- **`--continue` disarms it.** Resume refreshes the heartbeat; the warden
  stands down. Crash-then-resume kills nothing.
- **Container GC only (R4: never kill running jobs).** The warden gates suicide on the session containing NO job windows besides itself (`▲ pi-bg-control`). Rationale (CC parity): killing running user work as garbage collection has no CC counterpart and unbounded regret cost (a 3-hour run murdered because nobody `--continue`d within 10 minutes); CC keeps orphans running and lets the returning user decide. Running-job orphans therefore linger for `--continue`/adopt exactly like CC, with the S4 reaper long threshold (`danglingAfter`, days) + `--list-orphans` surfacing as the backstop instead of the executioner. The warden keeps its session-pinning benefit (exit-empty can no longer evaporate a live-but-idle session) and gains a zero-regret kill condition: a session with no job windows holds no user work, only the warden itself.
- **`leave-running` sends it dormant.** The warden exits itself; the session
  then lives exactly as long as its job windows via natural `exit-empty`
  evaporation. Intentional survivors need no executioner.
- **Stable-surface filtering (warden is invisible).** The `▲ pi-bg-control` window is excluded by exact name from EVERY user/machine-visible surface: `/tasks` job lists, footer `backgroundBashTmuxCommands` counts, reconciler sweeps (completion consume, interim `pollDelivery` check-ins, adopted-orphan silent polls, `turn_start` backstop), `session.json`/`jobs/*.json` job-map rebuilds, and GUID verification. Footer counts and `/tasks` output are therefore byte-identical with or without the warden. The reconciler never consumes, polls, or kills the warden window; kills target job windows only.
- **Gated (non-racy) suicide — resume-intent-before-lock + kill holds the dir lock across verify+kill.** The warden MUST NOT `kill-session` on mtime staleness alone, and MUST NOT check-then-kill with the lock released. Lock+heartbeat alone cannot detect a resumer starved on the lock: `--continue` blocking on `session.lock` cannot refresh the heartbeat, so a warden that only checks lock-acquirable + heartbeat-stale would kill a session whose live owner has already returned (destroying running jobs S5 promises survive — data loss, not delay). The race is closed by a resume-intent published BEFORE the lock attempt. `--continue`/adopt protocol (ordered, mandatory — unified lock protocol, closes busy-exit vs blocking contradiction): (0) non-blocking probe FIRST — attempt the non-blocking exclusive-flock on that dir's `session.lock` plus the `heartbeatAt`-vs-`reaperStaleAfter` check (S4 conjunction). If the owner is LIVE (flock held OR heartbeat fresh), busy-exit ("session busy, original pi still alive"), publish NO `resume.intent`, touch NOTHING; (i) only when the probe shows owner-dead (flock acquirable AND heartbeat stale) publish resume intent — write `<spooldir>/resume.intent` (`{ pid, nonce, at }`, tmp+fsync+rename) AND touch the heartbeat file — BEFORE the bounded acquire in (ii); (ii) then acquire `session.lock` via a BOUNDED timed wait with re-probe loop — never an indefinite blocking acquire (closes concurrent-continuer deadlock: two `--continue`s passing step-0 together would otherwise both publish intent, then the loser would block forever on the winner's continuously-held reconciler flock — a hung pi process violating the S1/S3 no-concurrent-owner rule, whose never-unlinked fresh intent would also permanently abort warden kills). Wait at most `resumeAcquireTimeout` (default 30s, > one reconciler tick + one S3 kill critical section) in short polls (~500ms-1s), each poll a non-blocking exclusive-flock attempt: on success proceed to (iii); on each failed poll re-check heartbeat freshness — if another resumer won (heartbeat/`heartbeatAt` now fresh) unlink ONLY its own `resume.intent` (nonce match) and busy-exit ("session busy, original pi still alive"); on timeout with the lock still held likewise unlink own intent and busy-exit. No path in (ii) blocks indefinitely while another party holds the lock; (iii) then refresh `heartbeatAt`/heartbeat-mtime under lock and unlink its own `resume.intent` on success. A `--continue` against a live owner therefore busy-exits exactly like S1/S3 creation/spawn instead of hanging on the lock, and the warden's intent gate below fires only on the stale-takeover path where intent was actually published. After `wardenMissThreshold` consecutive stale mtime checks AND a job-window count of zero besides the warden window itself (R4 gate — via `list-windows` on the owned session, warden name excluded), the warden MUST delegate the kill to the bundled `pi --warden-kill <spooldir>` helper, which executes atomically under the S3 exclusive flock on that dir's `session.lock`: (0) re-verify zero job windows (warden excluded) — a spawn that landed between the warden's check and the lock acquisition aborts the kill and restarts the miss counter; (1) record pre-lock generation (heartbeat-mtime + `resume.intent` mtime/absence); non-blocking flock attempt — if it FAILS (live owner/reconciler holds the lock) abort immediately, stand down, restart the miss counter; (2) while STILL HOLDING the lock, re-verify all gates — `heartbeatAt`/heartbeat-mtime still older than `reaperStaleAfter` AND pre-lock vs under-lock heartbeat generation unchanged (mtime match), AND NO fresh `resume.intent` present (any `resume.intent` newer than the pre-lock read, or younger than `reaperStaleAfter` + one `wardenCycleSeconds` slack, aborts the kill — this catches the resumer that published intent before blocking on the lock, even though it never got to refresh the heartbeat), AND NO fresh S5 `parked-by` marker present (a `--continue` winner's sibling-park counts exactly like a live owner: abort, stand down, restart the miss counter), AND the live session's `@pi_guid` still equals `sessionGuid` in that dir's `session.json` (same S3 check — never kill a recycled/repaired foreign session); a stale `resume.intent` (older than the slack window, crashed resumer that never acquired the lock) is unlinked under lock and does not block the kill; (3) only if every gate still holds, issue `tmux -L <own-sock> kill-session` against the GUID-verified session id WHILE STILL HOLDING the lock, then release. (Inside the warden window `$TMUX` already addresses the right server; the helper takes the socket explicitly.) Ordering guarantee: a resumer that starts before the warden's under-lock re-verify has already published intent, so the warden aborts and the promised survivors live; a resumer that starts after the kill finds its session dead and takes the S1 disambiguated path — but that path is now taken ONLY when no live resumer was starved, never as an admitted kill-the-returning-owner outcome. If any gate fails the warden stands down and restarts its miss counter. The warden unlinks nothing except stale `resume.intent` files under lock.
- **Tombstone (death.json): the tmux-model equivalent of CC's free salvage.** CC gets post-crash salvageability from the OS (children die with the parent, files remain); our container outlives its owner and dies by a different hand (warden), so the kill must be recorded — otherwise a later session cannot distinguish "owner died 2 min ago, jobs resumable" from "warden killed this 3 days ago, windows gone." The `pi --warden-kill` helper, WHILE STILL HOLDING the dir lock and BEFORE `kill-session`, writes `<spooldir>/death.json` via tmp+fsync+rename: `{ killedAt, reason: 'owner-gone' | 'reaped', missCount, jobs: [{ jobId, lastState, exitFilePresent }] }`. Cost: one JSON write on a path that already holds the lock.
- **Salvage protocol (whoever finds a tombstoned dir — `--continue` or `--adopt-orphan`):** (a) exit file present but unconsumed → report once via the normal S5 adopt path (exactly-once intact — the warden never consumes); (b) row was `running` → windows are definitively gone, so no resume: deliver a SYNTHETIC killed completion (reason `session-reaped`, `.out` tail attached, exit code explicitly unknown, never fabricated) through the background delivery path — terminal status + retained log, CC-equivalent, never silence; (c) tombstoned dirs age into the normal retention prune, bounding the salvage window. Precedence (crash between tombstone write and kill): live session + fresh heartbeat beats the tombstone — successful reattach deletes it as stale; the tombstone is honored only when the session is actually gone.
- **No `flock(1)` dependency in the warden** (absent on macOS): the gate's non-blocking lock probe runs via the bundled `pi --check-owner-dead <spooldir>` helper (same S4 conjunction logic as the in-pi reaper), not `flock(1)`. The warden itself never consumes exit files, never touches the sidecar, and never kills anything but its own GUID-verified session — so it cannot split-brain against the S3-fenced reconciler.
- **Graceful degradation, layered:** user kills the warden window → the live
  owner recreates it on the next tick; owner gone too → the in-pi reaper
  catches the session on the next pi start (S4). Every layer's failure drops
  to the next layer, never to silence.
- **Observability:** the warden logs only lifecycle events (start, stand-down,
  suicide) to `<spool>/warden.log`; kill-switch `watchdog: off` (same spirit
  as `PI_BG_DISABLE`) disables creation.

## S5 — Leave-running / orphan contract (resolves stranded-survivor blockers)

Frozen contract: `leave-running` windows, crash orphans, and completed
orphans rejoin/report via adoption; `extension.ts` promises jobs survive.

- Fresh start with a NEW pi id: stays blind to foreign sessions — RUNNING or COMPLETED — and must not destroy or consume them. The
  pid-reaper killing `leave-running` survivors after quit + fresh start is
  prohibited: those sessions are exempt per S4, so RUNNING survivors linger by design until
  the user `--continue`s (same pi id) or explicitly adopts/cleans them. Killing
  windows that were promised to survive and delivering zero completions is
  silent data loss and is closed here. Startup sweep is OWN-dir-only: a fresh start sweeps only its OWN spool dir (`<spool>/<new-pi-id>/`, normally empty at startup) via its own reconciler holding its own `session.lock`; it NEVER renames/consumes exit files in a FOREIGN spool dir. Foreign completed orphans wait unconsumed for their owner's `--continue` (same pi id) or an explicit `--adopt-orphan` (which first acquires that dir's S3 `session.lock` and runs the S4 owner-dead test below), and report exactly once there with their original jobIds. Fresh-start surfacing (opt-out, never silent): blindness is to ownership, not to awareness — a fresh start MUST still emit a trigger-free display-only notice (UI-idle-only, never a trigger turn: `pollDelivery: "display"` routing) plus the `/tasks` one-line pointer below whenever lingering foreign dirs with unconsumed completed exit files exist ("N orphaned session(s) with pending completions — see `pi --list-orphans`"), so persisted-but-never-delivered is announced without stealing the exactly-once token. CONTRACT AMENDMENT (major bump at P1, which already ships "delete scope options (major version)"): this deliberately narrows the frozen completion-contract Orphan-adoption clause ("Completed orphans of ANY scope whose exit file already exists report once, immediately" on `session_start`). Under 1:1 sessions the clause becomes Session-scope ownership — "completed orphans report once, immediately, to the OWNING session on its `--continue`, to the explicit `--adopt-orphan` holder, or as a trigger-free foreign-completion POINTER on any fresh-start `session_start`; a foreign fresh-start `session_start` never consumes/delivers foreign completions itself." The prior foreign fresh-start consume-and-deliver sweep is explicitly rejected as the mechanism (it stole the exactly-once token without holding the dir's lock and misdelivered completions into the wrong conversation, violating Session-scope), and the contract text is updated to say so instead of claiming "no contract break." Consumers that relied on foreign fresh-start report-once MUST migrate to `--continue` / `--adopt-orphan` / `--list-orphans` (below); the version bump signals the change.
- Owner-dead gate (no stealing from live owners): NO startup or adopt path may consume an exit file in a dir it does not own unless that dir passes the S4 liveness test — the exclusive flock on that dir's `session.lock` must be acquirable (no live holder) AND `heartbeatAt` must be older than `reaperStaleAfter`. Any dir whose flock is held or whose heartbeat is fresh is skipped unconditionally, so a new-pi-id startup can never win an atomic-rename race against the live owner's reconciler tick for a just-completed job (no misdelivery into the wrong conversation, no stranded owner with a consumed exit file). Even when the gate passes, consumption happens only under that dir's lock by a single fenced reconciler (`--continue` owner or `--adopt-orphan` holder) — never by a blind fresh-start rename — preserving S3's at-most-one-reconciler-per-spool-dir guarantee and the exactly-once token.
- `--continue` (SAME pi id): full adoption from the OWN dir's sidecar (S2) — live
  orphans resume watching; completed orphans (exit file present, completion
  not yet consumed) each report exactly once via the normal reconciler path
  with their original jobIds — AND cross-sibling completed-orphan sweep (no stranded sibling dirs): where S1 split-brain left `pi-bg-<id>-p*` sibling dirs for the SAME pi id, `--continue` MUST, after winning the canonical/newest live dir for live-job ownership, additionally sweep every OTHER sibling dir for that pi id that passes the S4 owner-dead gate (flock acquirable AND heartbeat stale), acquiring each sibling's `session.lock` in turn and consuming+delivering ONLY its already-completed orphans (exit file present, `delivery.state: pending-local`, `status` not `killed`) exactly once with original jobIds under that dir's fenced reconciler. Live/running rows in non-winning siblings are NOT merged or watched (live ownership stays single-dir per S1 — listed via `--list-orphans` for manual `--adopt-orphan`/cleanup); `killed` and already-`delivered-local` records are skipped. Sibling-warden auto-park (closes abandoned-sibling suicide — no manual step required): winning `--continue` MUST, in the same pass, fence every non-winning sibling dir for that pi id whose S4 gate reads owner-dead — acquire that sibling's `session.lock`, refresh its heartbeat/`heartbeatAt`, and write a `parked-by` marker (`{ winnerDir, at }`, tmp+fsync+rename) ordering the sibling's S4.1 warden dormant (the warden treats a fresh `parked-by`/heartbeat exactly like a live owner: stand down, restart its miss counter, never `kill-session`). Parked siblings therefore keep their RUNNING sessions pinned (no `exit-empty` evaporation, no warden suicide) while staying unwatched until explicit `--adopt-orphan`/cleanup; the park is refreshed on each winning-tick heartbeat touch and expires with it, so a parked sibling re-arms its warden automatically if the winner itself dies (no stranded pin). This satisfies the AMENDED completion-contract orphan-adoption clause (Session-scope ownership per the P1 major bump above: report once to the owning session via `--continue`/`--adopt-orphan` plus the fresh-start trigger-free pointer, never via a foreign fresh-start consuming sweep).
- Explicit orphan controls (no new magic): `/tasks` shows only the current
  session's jobs (CC parity) AND surfaces the blind-foreign-completion caveat: when lingering foreign `leave-running` dirs exist, `/tasks` prints a one-line pointer ("N orphaned session(s) with pending completions — see `pi --list-orphans`") without merging their rows, so a silent fresh start is never mistaken for "nothing completed." A separate opt-in `pi --list-orphans` /
  `--adopt-orphan <pi-id>` surfaces lingering `leave-running` sessions from
  other pi ids — including their pending-COMPLETED counts from unconsumed exit files — for manual adoption or cleanup. Auto-adopting foreign running
  sessions into a new pi id is rejected (breaks CC blindness); auto-killing
  them is rejected (breaks `leave-running`).
- Accepted-risk note (rationale recorded, not an open question): between quit
  and `--continue`/adopt, a `leave-running` survivor's future completions wait
  unconsumed in its own spool dir; a fresh pi id announces them only via the trigger-free pointer/notice above (never consuming or delivering them) until the owner returns or someone explicitly adopts. This
  is the CC-parity cost of per-conversation ownership, and it is safe (not
  lossy) because the records persist in the sidecar until the fenced owner consumes them exactly once — but it IS a user-visible behavior change versus the frozen report-once-on-any-`session_start` promise, hence the P1 major-version bump and the `/tasks` + `--list-orphans` surfacing above (no silent reinterpretation).

## S6 — Foreground vs reconciler mutex (resolves double-delivery blocker)

Deleting `owned`/`foregroundExitCodeFiles` with no successor lets the
foreground blocking wait and the reconciler tick both own the same job row:
duplicate `tmux-bash-completion` or a swallowed foreground result, with no
defined owner for Ctrl+B / timed-out-background texts.

- Replacement mutex: each job record carries `foregroundClaim: bool` (+ `claimHeartbeatAt`)
  (in-memory + sidecar `jobs/<jobId>.json`). The foreground waiter sets the
  claim before blocking on the exit file, refreshes `claimHeartbeatAt` every poll interval while waiting, and clears it on demote/exit; the reconciler tick skips every row
  with `foregroundClaim=true` and a fresh heartbeat.
- Exactly-once: whoever owns the row consumes the exit file by atomic rename
  and unlinks; watcher/sweep paths skip claimed rows by the same flag. The
  old "waiter unlinks; watcher skips foreground" separation is preserved under
  the new name.
- Crash recovery (no stranded completions): `foregroundClaim` is a volatile in-process lease — the sidecar copy exists only so a live reconciler in the SAME process skips claimed rows. On every `--continue` rebuild all claims are force-cleared to false (no waiter thread survives a crash, so the reconciler is the defined new owner and delivers the pending completions). Within a live process, a claim whose `claimHeartbeatAt` is older than `claimStealAfter` (waiter thread died without demoting) is stealable by the reconciler, which clears the flag and owns completion. `claimStealAfter` is NOT a fixed 30s: it is `max(30s, minimumPollIntervalSeconds * 3 + 15s slack)`, recomputed from live config on every tick. The local waiter refreshes `claimHeartbeatAt` every tick, so at least ~3 refreshes land inside any steal window. A scheduling stall shorter than the slack cannot make a live waiter look dead; a stall longer than `claimStealAfter` is defined as waiter death and the reconciler steals exactly once. A crashed waiter can therefore delay but never strand a completion, and a slow-but-live waiter is never stolen.
- Text ownership: Ctrl+B detach text and foreground result text are owned by
  the foreground waiter; timed-out-background ("still running in background")
  text is owned by the waiter at the moment it demotes the row (it clears
  `foregroundClaim` on demotion so the reconciler can then own completion).
  The reconciler never emits foreground texts and the waiter never emits
  background completions.
- No cross-process claims (R2): waiter and tick always live in the same process — there is no forwarding path, so no claim propagation over sockets, no `claim-heartbeat` stream, no `claim-lost` replies.
- No forwarded waits (R2): Ctrl+B detach is a purely local demote (see Text ownership); remote-delivery journaling, ack/replay, and sequenced interim forwarding are deleted with the socket.
## Migration (suite green throughout; contract text frozen except the S5 orphan-clause amendment on the P1 major bump)

- P0: pid-free naming (S1) + sidecar journal (S2) + owner lock (S3) + GUID-set
  at create, behind a flag (`sessionPerPiSession: false` default); old path
  untouched. New reaper ships disabled. Legacy drain — atomic, idempotent, reachable, and code-fenced (no stranded in-flight jobs at the flip): BEFORE the P1 default flip, new code ships a legacy-drain path — it enumerates legacy `pi-background*` sessions/windows WITHOUT killing or consuming them, and backfills `jobs/*.json`-equivalent records (jobId, windowId, spoolLog, exitFile, `completionPending: true`) PARTITIONED BY TAG (R3): each legacy window already carries `@pi-tmux-bash-pi-session-id`, which defines the owning engine spool dir (`<spool>/<legacy-pi-id>/`, one `legacy-drain.json` receipt per dir); untagged legacy windows backfill into `<spool>/legacy-untagged/` for `--list-orphans` surfacing. Reachability (cross-server windows cannot `move-window` across tmux servers, so the drain MUST NOT pretend to relocate them): each backfilled record keeps its origin (`tmuxServer: default`, `legacySession`, `legacyWindowId`) and the owning engine spool dir dual-homes until the drained set closes — its fenced reconciler/reaper holds a default-server control handle PURELY for the drained windows (list/poll/kill by legacy name + window inventory per the P1 legacy rule, never a raw-id kill on a engine private server) while all NEW spawns go to the dir's private `-L` server/session. Drained records therefore stay completable (exit-file consume under that dir's S3 lock) and killable (default-server handle) to the engine owner; the handle is dropped per-record on completion/kill and entirely once the receipt's job set closes. Each backfilled record is written via tmp+fsync+rename (crash-safe, re-runnable: re-running the drain skips jobIds that already exist and re-verifies the rest, never duplicating ownership), and a completed drain fsyncs a `legacy-drain.json` receipt into the engine spool dir (`{ legacySessionsSeen: [...], jobCount, completedAt, drainVersion }`). Drain runs explicitly (`pi --drain-legacy`) and the flip is gated in CODE, not just the rollout checklist: engine-default new-session creation MUST probe `list-sessions` for legacy `pi-background*` sessions at startup, and if any are present without a matching verified drain receipt (receipt absent, stale inventory, count mismatch on re-probe, or any backfilled window no longer listable from the default-server handle), it MUST refuse the engine default and fail closed ("legacy sessions present — run `pi --drain-legacy` first") rather than starting engine sessions whose in-flight legacy jobs have no reachable engine sidecar (lost jobId match, missed exactly-once completion, unreachable kill path) or double-consuming alongside the old watcher (duplicated ownership: old watcher + new tick both consume). A crash between partial backfill and flip therefore leaves no verified receipt, so the gate keeps refusing until a re-run completes — partial state can never flip.
- P1: flip default; delete scope options (major version — this is also the train carrying the S5 orphan-report-once contract amendment above); migrate live tests
  off shared-server fixtures onto private per-run servers (already the pattern).
  Flag-day rule (S4) active from here. Post-delete legacy cleanup (no invisible leakers): after old code is deleted, legacy `pi-background*` survivors have no owner — so from P1 on, the engine reaper/adopt path GAINS a bounded legacy rule to replace the P0 "ignore legacy entirely" stance: `pi --list-orphans` enumerates legacy `pi-background*` sessions (read-only, via `list-sessions`), and `pi --adopt-orphan` / the S4 reaper may claim-or-reap them under the SAME S3/S4-equivalent gate (no live owner evidence + stale activity) with GUID checks skipped only because legacy sessions carry no `@pi_guid` (name-match + window inventory instead, never a raw-id kill). `leave-running` legacy survivors are adopted, never auto-killed, preserving the `extension.ts` survive promise across the upgrade.
- P2: collapse watcher/poller/sweep into the single reconciler tick with the
  foreground-claim skip (S6); the tick MUST implement all four owned paths (completion consume, per-job `pollDelivery` model/display interim check-ins with interval/lines preserved, adopted-orphan silent-poller completion-only path, `turn_start` sweep backstop) so foreground-streaming/polling UX has no unowned path; delete disown/forget scatter and retag/adopt-by-
  parsing (replaced by sidecar reattach S2 + orphan controls S5, with the owner/`--adopt-orphan` fenced path preserving the AMENDED report-once clause under the Session-scope ownership rule carried by the P1 major bump).
- P3: enable stale-session reaper with lockfile/start-time liveness and the
  `leave-running` exemption (S4–S5); remove pid-parsing-for-adoption (already
  dead by P2). Ship the warden window (S4.1): heartbeat touch on the slow
  tick, warden creation with the session, suicide + dormancy paths, layered
  fallback to the S4 reaper.

## Open questions for reviewers — all closed by this revision

1. Socket strategy: RE-DECIDED (R1, supersedes the prior shared-server call) — private tmux server per pi session (`-L pi-bg-<12hex>`). The P0 old-kills-new blocker (old `kill-window -t @id` landing on recycled ids in new sessions) is impossible across server sockets, which is stronger than any naming discipline; the ~MBs-per-server cost is accepted. `$TMUX` inheritance keeps in-session helpers flag-free; the 108-char socket-path limit is respected via the 12-hex hash.
2. `--continue` reattach vs fresh-start blindness: DECIDED — same-id
   `--continue` fully reattaches via sidecar (S2); new-id fresh starts stay
   blind to running sessions but never kill `leave-running` survivors (S5).
3. Leave-running + quit + fresh start: DECIDED — orphan lingers until
   `--continue`/adopt/cleanup; reaper exempt (S4–S5). No silent kills.
4. Foreground-as-blocking-wait: DECIDED — allowed only with the S6 claim-flag
   mutex preserving the current exactly-once separation. If S6 proves risky in
   review, fallback is keeping the current foreground path untouched.
