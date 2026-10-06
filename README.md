# pi-bg-shell

tmux-backed background shell execution for pi with Claude-Code-like UX:
`Ctrl+B` send-to-background, timeout-detaches, output-file `Read`,
`bg`/`tmux` list/peek/stop, `/tasks` list, footer indicator, completion
follow-ups + toasts, orphan reattach across sessions.

> **License:** MIT (see `LICENSE`). This project began as a fork of
> `richardgill/pi-extensions` (`extensions/tmux-bash` @ `8eda59a`) and has
> since been fully decoupled: no upstream code remains (see `NOTICE.md`).
> Install with `pi install npm:@amaksoft/pi-bg-shell`.

## Divergence plan (CC parity, full engine MVP)

Upstream already provides: `bash` replacement on tmux, `background` + `timeoutAction`,
`tmux` list/peek/kill (+opt-in poll), completion follow-ups, footer status,
parity e2e vs native bash.

Engine features (done ✓, todo ○):

1. ✓ `run_in_background` alias (CC tool grammar) + stable **opaque job IDs**
2. ✓ Spool log path returned on every background launch — model retrieves via plain
   `Read` (CC post-2.1.277; no blocking `TaskOutput`)
3. ✓ `Ctrl+B` promotion of a foregrounded engine-owned execution to background
   (bare `Ctrl+B` is best-effort inside nested tmux — prefix conflict)
4. ✓ `/tasks` command (alias `/bashes`) — snapshot list, then Peek output or Kill job per selection
   (`/tasks <job_id>` asks to confirm, then kills; `@window` refs accepted;
   dismissing the picker does nothing)
5. ✓ Completion contract for presentation: `docs/completion-contract.md`
   (stable `tmux-bash-completion` shape with job identity; kill suppresses
   wake-up; footer key; detached-row outcome values)
6. ✓ Shutdown policy setting (`shutdownPolicy: "stop-all"` default, opt-in
   `"leave-running"`) + dead-window reaper on startup + kill-switch env
   `PI_BG_DISABLE=1|true|yes` (extension registers nothing, native bash untouched)
7. ✓ Non-git cwd support (base directory = git root, else launch cwd, for session
   naming, window cwd, and scope filtering)
8. ✓ Orphan reattach: `leave-running`/crash survivors rejoin with stable identity
   + resumed completions (silent watch); `bg` tool alias; completion toasts
   (`notifyOnCompletion`, default on)

## Layout

- `src/` — engine (`engine/` session core, `tools/` commands, `renderers/`)
- `tests/` — unit suite (162 tests, must stay green)
- `docs/` — completion contract + architecture notes

## Security notes
- Engine windows inherit the pi process environment (minus bookkeeping vars).
  Secrets in env reach the spool script and logs — same exposure as running the
  command in your own shell; spool dirs are `0700`, scripts are `0700`.
- `outputDir` must not be a symlink (refused loudly); default is `$XDG_STATE_HOME/pi-bg-shell` (else `~/.local/share/pi-bg-shell`). Prefer a private dir via config for sensitive work.
- Kill-switch: `PI_BG_DISABLE=1|true|yes` (case-insensitive) disables the
  extension entirely, leaving native bash untouched.

## Dev

```bash
bun install
bun run check   # tsc --noEmit
bun run test    # vitest, unit only (e2e excluded — needs bootable pi + tmux)
```

Clone and load locally without installing:

```bash
git clone https://github.com/amaksoft/pi-bg-shell.git
cd pi-bg-shell
bun install
pi --no-extensions -e ./src/index.ts
```

Or point `-e` at an installed copy.

## Config reference

Settings live in `~/.pi/agent/tmux-bash.jsonc` (all optional, defaults shown).
Only non-defaults worth knowing:

| Key | Default | Notes |
|-----|---------|-------|
| `shutdownPolicy` | `"stop-all"` | `"leave-running"` keeps the session after quit (rejoin via `--continue`, adopt via `/orphans`) |
| `defaultTimeoutAction` | `"ask"` | `"kill"` terminates on timeout, `"background"` always demotes; `"ask"` (default) demotes and lets the model decide kill vs keep on the next turn |
| `defaultTimeoutSeconds` / `maxTimeoutSeconds` | `30` / `600` | Foreground wait before `timeoutAction` |
| `notifyOnCompletion` | `true` | Toast on job completion (transcript turn carries details) |
| `preservedOutputRetentionDays` / `maxPreservedOutputMb` | `7` / `256` | Retention prune over tombstoned spool dirs (live dirs never pruned) |
| `pollDelivery` | `"model"` | `"display"` posts check-ins without waking the model |
| `ownerStaleAfterMs` | `300000` | Owner-dead threshold: stale heartbeat plus signal-0 stall guard (reaper, adopt, kills) |
| `detachShortcut` | `"ctrl+b"` | `false` disables. Note: pi has no contextual-shortcut API, so the key is claimed globally and shadows `tui.editor.cursorLeft` (pi reports the conflict at startup and honors this extension). Set `false` if you live on emacs cursor keys — backgrounding still works via `run_in_background`, timeout-detach, and `/tasks`. |
| `tmuxBinary` | `"tmux"` | Path to the tmux binary when it is not on `PATH` |
| `bashToolName` / `tmuxToolName` / `bgToolName` | `"bash"` / `"tmux"` / `"bg"` | Rename registered tools (`bg` is a pure alias of `tmux`: same backend, one copy of guidelines) |
| `tmuxEnabledActions` | `["list", "peek", "kill"]` | Subset of tmux actions to register; empty disables the `tmux`/`bg` tools (the `bash` tool is unaffected) |
| `stallPromptThresholdSeconds` | `120` | Static-log stall warnings (`0` disables) |
| `plainChrome` | `false` | Render completion/poll messages as unstyled text (minimal presents) |

Deleted with the legacy engine (major cleanup): `tmuxSessionScope`, `globalTmuxSessionName`, `tmuxWindowScope`, `gitRootTmuxSessionNameTemplate`, `sessionPerPiSession`, `reapDeadWindows`. One tmux session per pi session on a private server — no scopes, no sharing, no filters.

Env: `PI_BG_DISABLE=1|true|yes` disables the extension entirely.
Requires `tmux >= 3.0` on PATH (Unix only — Windows gets a clear error, not a
crash; a missing/old tmux fails every call with an actionable message).

## Troubleshooting

- `Not in scope / no longer running` → the window closed; check transcript + log.
- `No background session` → start a new bash command to create one.
- E2E suites need a bootable pi + tmux (rewrite pending).
- `/tasks` lists shell jobs; task-tracker items live in the pi-tasks widget.
  Subagent rows are not merged (separate stores, deliberate).
