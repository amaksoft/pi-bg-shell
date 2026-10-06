# Completion contract (engine → presentation)

Stability contract for `@owlburtoe/pi-claudify` adapters (and any other consumer)
of bg-shell background-job lifecycle events. Fields marked **stable** will not be
renamed without a major version bump; `customType` strings are part of the contract.

## Completion wake-up

When a background job's process exits, the engine sends at most one message
(zero when the outcome was already surfaced — latched reads and deliberate kills).
Singleton completions steer mid-turn (the agent reacts between tool calls):

```ts
pi.sendMessage(message, { triggerTurn: true, deliverAs: "steer" });
```

Multi-job batches keep one combined follow-up turn:

```ts
pi.sendMessage(message, { triggerTurn: true, deliverAs: "followUp" });
```

and (unless `notifyOnCompletion: false`) one toast per batch:

```ts
ctx.ui.notify("Background bash finished: <command>", "info" | "error");
```

One producer, one shape: the single shared tick peeks exit files,
holds briefly for stragglers (backlog-aware coalescing, default 2500ms),
then consumes (atomic rename) and delivers. **At most one** completion per
job; a delivery throw redelivers the same in-memory items on a later tick
(no journal rollback — consumed rows stay consumed).

### Seen latch (stable)

Any path that surfaces the outcome sets a journal-durable `seen` flag
*before* delivery: reading a finished job (`/tasks` peek), or deliberately
killing it (latch precedes the kill). The tick still consumes and cleans up
latched jobs (window closed, registry row dropped) but sends **no message**
and no toast for them. Finished-but-undelivered rows list as `, unread`
in text surfaces and `· unread` in the `/tasks` overlay.

### `tmux-bash-completion` (stable)

```ts
{
  customType: "tmux-bash-completion",   // stable
  content: string,                       // stable first line, append-only below it
  details: {
    v: number,                           // chrome-view schema version (additive; readers ignore unknown fields)
    summary: string,                     // "Background bash finished" | "Background bash failed" (stable)
    output: BashOutputRenderDetails,     // stable shape (rendered by registerMessageRenderer)
    exitCode: number,                    // stable (worst exit wins in batches)
    status: "success" | "failed",        // stable
    jobId?: string,                      // 6-hex opaque id; absent for pre-registry windows
    command?: string,                    // original command (for row matching)
    logPath?: string,                    // stable spool path — Read it for full output
    windowId?: string,                   // raw tmux @{id} (debug/attach only)
    displayName?: string,                // human label for grouped summaries
    jobs?: { jobId, command, exitCode, logPath, tail }[],  // batches only
  },
  display: true,                         // transcript entry
}
```

Content layout, singleton (stable order):

```text
Background bash finished
job a1b2c3 ($ pnpm dev)        # only when job identity is known
log_path: /…/jobs/a1b2c3.exit.out
                               # only when job identity is known
```{fenced full output}```         # omitted when output is empty
```

Content layout, batch (stable order): `Background bash finished (N jobs)`,
then one block per job (`job <id> ($ <cmd>): exit <code>`,
`log_path:`, fenced tail or `(no output)`).

**Matching rule for presentation:** match completions to detached rows by
`details.jobId`. Fall back to `details.command` prefix match only when `jobId`
is absent (unmanaged windows).

## Stall warnings

`customType: "tmux-bash-stall"` (stable). When a running job's log goes
static past `stallPromptThresholdSeconds` (default 120s) with an
interactive-prompt tail (`(y/n)`, `Do you…?`, `Press Enter`, …), the tick
sends one steer warning per log size with the tail plus remediation
(re-run piped or non-interactive). Warnings never consume, never latch:
a later real completion still notifies.

Timeout kills append `Command timed out after Ns` to the log first, so the
model can tell a timeout kill apart from a normal failure by reading the
tail.

## Presentation fallback

`plainChrome: true` renders completion and poll messages as unstyled model
text (no expandable blocks, no chrome) — the minimal present for
chrome-absent environments. Content strings are identical; only the
component changes.

## Poll check-ins

`customType: "tmux-bash-poll"` (stable). Interim output fans out from the
same reconciler tick (best-effort slices, never consumed). `pollDelivery:
"model"` (default) wakes the model each tick (clamped ≥
`minimumPollIntervalSeconds`, default 10s); `"display"` posts trigger-free
updates only while the UI is idle. No stability promise on poll cadence.
Polls are advisory: `/tasks` peek plus `Read` on `log_path` are the reliable
interim-output contract — anything the model must not miss lives there.
Standalone `poll`/`unpoll`/`list-polls` tool actions are retired (the tick
owns interim output); their schema entries are removed.

## Kill semantics (stable)

- `tmux kill` (job ID or window ID) and `/tasks` kill **suppress the completion
  wake-up**: the journal flips to `killed` before `kill-window`, so the EXIT
  trap's late write finds no owner and stays silent by construction.
  Kills are GUID-guarded single-round-trip commands (no verify-then-kill gap).
  The `notified` latch is set before the kill as well, so adopted and
  restored sessions agree the death was deliberate.
- Shutdown: same suppression (server destroyed, unless `leave-running`).
- Natural exit, nonzero exit, timeout-demote, and Ctrl+B-demote **always** send
  exactly one completion (batched when peers finish together).

## Footer status (stable key)

The engine publishes footer status under key `"backgroundBashTmuxCommands"`
(exported as `BACKGROUND_BASH_STATUS_KEY` from `src/config.ts`; value like
`"2 background procs: dev-server · a1b2c3 · 3m, tests · b2c3d4 · 40s"`,
first 3 jobs then `+N more`, cleared when the last job exits/is killed). The
leading count is machine-readable (Claudify parses it for its own `Bg:`
segment); the names (command · jobId · age) are for humans. Custom footers
may read it via `footerData.getExtensionStatuses().get(BACKGROUND_BASH_STATUS_KEY)`.

## Detached-row data (tool results, stable)

- Background launch result text always contains `job_id: <6-hex>` and
  `log_path: <path>` lines plus a `Follow up with /tasks <id> or read
  <path>.` verb; tool `details` is `undefined`.
- Timeout-demote and Ctrl+B-demote results carry
  `details.outcome: "timed-out-background" | "detached-background"` respectively
  plus `details.displayName` (given name > short command > derived label).
  Render the background (non-duration) row for any defined `outcome`.
- Timeout without an explicit action asks the model (`timeoutAction: "ask"`,
  the default): demote + `Your call: leave it running … or kill it now with
  /tasks <id>.`

## Orphan adoption (Session-scope ownership)

1:1 sessions own their completions; a fresh process never sweeps foreign
spool dirs. On `session_start` the engine only rebuilds its OWN dir; the
reaper kills+tombstones dead sessions but never delivers. Foreign completions
surface explicitly:

- `/orphans` lists lingering foreign sessions (live/dead, running/done
  counts, tombstoned) with an orphan pointer in `/tasks` when foreign work
  is pending.
- Adopt takes the dir lock (owner-dead gate: acquirable flock AND stale
  heartbeat), consumes completed exit files (exactly-once, original jobIds),
  salvages tombstoned running rows as synthetic `session-reaped` completions
  (terminal status + log tail, exit explicitly unknown), and watches the rest
  on the shared tick (one loop per process; per-dir state keyed by dir).
- `leave-running` survivors are adopted, never auto-killed.
- Adoptions persist in the session sidecar and are restored on restart
  (before the reaper runs, so the live lock protects them); each restore
  re-runs the owner-dead gate, so a dir taken elsewhere is skipped.

## Missed-delivery backstop

No single observation can be lost: exit files persist until atomically
renamed, and nothing is consumed while held. Every `turn_start` kicks the
tick (flushing held stragglers immediately); shutdown stops the tick after a
final flush. There is no rollback: consumed rows stay consumed (`done`), and
a delivery throw redelivers the same in-memory items on a later tick. A crash
between rename and journal-write recovers by re-peeking the `.consumed` file;
a crash after a completed consume is already terminal state, and the `seen`
flag suppresses already-surfaced outcomes on any redelivery.

## Retention

Completed jobs are forgotten from the in-memory registry at completion; the
transcript entry plus the spool log are the history. Tombstoned spool dirs
under `<outputDir>/sessions` are pruned on session start when older than
`preservedOutputRetentionDays` (default 7, `0` = keep forever), and the total
is capped by `maxPreservedOutputMb` (default 256, oldest first, `0` =
uncapped). Live dirs are never pruned.

GC is continuous, not startup-only: every 5 minutes of wall-clock the tick
re-runs the socket sweep, the retention prune, and the reaper, so a
long-running session converges debris (dead sockets, tombstones, dead
foreign sessions) without waiting for the next restart. All probes run
silent — tmux errors are captured for parsing, never printed.

## Session scope

Completions deliver to the session that launched the job (or its explicit
adopter). A new process never learns prior jobs' outcomes except through
`--continue` (same pi id, full sidecar rebuild) or `--adopt-orphan` — use
`Read` on the spool path or `/tasks`/`/orphans` to catch up.

## Explicit non-contract

- Raw tmux window IDs (`@123`) are engine internals; never display them as
  primary identity (attach hints excepted).
- Tick cadence, coalescing window, spool directory layout, and tmux server
  names may change.
- `backgroundJobs` registry is session-scoped and cleared on shutdown; job IDs
  from older transcripts resolve to "no longer running", never to a new job
  (IDs are random per launch; cross-dir collisions keep the first owner).
