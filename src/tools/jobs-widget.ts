import { truncateToWidth } from "@earendil-works/pi-tui";
import { finishedRowSegments, overflowSegments, formatAge } from "../engine/grammar";
import { readLastLine } from "../engine/log-tail";
import { resolveDisplayName } from "../engine/grammar";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { BackgroundJob, ExtensionState } from "../engine/types";

/**
 * Phase 1: glanceable jobs widget (pi-subagents parity). Persistent rows near
 * the editor via setWidget — running jobs with spinner/elapsed/tail, finished
 * jobs lingering briefly. Reads live state every render; caches nothing
 * styled. No extension wiring yet (phase 2).
 */

export const JOBS_WIDGET_KEY = "pi-bg-shell.jobs";

const SPINNER = ["◐", "◓", "◑", "◒"];
const MAX_ROWS = 6;

interface FinishedRow {
  jobId: string;
  command: string;
  exitCode: number;
  elapsedMs: number;
  turnsLeft: number;
}

type WidgetUI = {
  setWidget: (
    key: string,
    content: ((tui: TUI, theme: Theme) => { render: (width: number) => string[]; invalidate: () => void; dispose?: () => void }) | undefined,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ) => void;
};


/** Bounded last-line read: tail 4KB only, never the whole log. */
export class JobsWidget {
  private tui: TUI | undefined;
  private attached = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private frame = 0;
  private finished = new Map<string, FinishedRow>();

  constructor(
    private readonly state: ExtensionState,
    private readonly placement: "aboveEditor" | "belowEditor" = "belowEditor",
  ) {}

  attach(ui: WidgetUI): void {
    this.attached = true;
    ui.setWidget(
      JOBS_WIDGET_KEY,
      (tui, theme) => {
        this.tui = tui as TUI;
        return {
          render: (width: number) => this.render(theme, width),
          invalidate: () => {},
          dispose: () => {
            if (this.tui === tui) this.tui = undefined;
          },
        };
      },
      { placement: this.placement },
    );
  }

  detach(ui: WidgetUI): void {
    ui.setWidget(JOBS_WIDGET_KEY, undefined);
    this.stopTimer();
    this.tui = undefined;
    this.attached = false;
  }

  /** Called on background completion (engine delivery paths, phase 2). */
  noteFinished(jobId: string, command: string, exitCode: number, elapsedMs: number): void {
    this.finished.set(jobId, {
      jobId,
      command,
      exitCode,
      elapsedMs,
      turnsLeft: exitCode === 0 ? 1 : 2,
    });
    this.poke();
  }

  /** Called on turn_start (after the reconciler kick). */
  ageFinished(): void {
    for (const [id, row] of this.finished) {
      row.turnsLeft -= 1;
      if (row.turnsLeft <= 0) this.finished.delete(id);
    }
  }

  /** (Re)start the refresh interval while anything is shown. */
  poke(): void {
    // Detached (e.g. shutdown flush calling noteFinished after detach):
    // never restart the timer on a dead widget.
    if (!this.attached) return;
    if (this.timer) return;
    if (this.isEmpty()) return;
    this.timer = setInterval(() => {
      this.frame += 1;
      if (this.isEmpty()) {
        this.stopTimer();
        return;
      }
      try {
        (this.tui as { requestRender?: () => void } | undefined)?.requestRender?.();
      } catch {
        // Render loop is best-effort; the next tick retries.
      }
    }, 1000);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private backgroundedJobs(): BackgroundJob[] {
    // Backgrounded only: foreground runs are visible in their own call rows.
    return [...this.state.backgroundJobs.values()]
      .filter((job) => job.backgrounded === true)
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  private isEmpty(): boolean {
    return this.backgroundedJobs().length === 0 && this.finished.size === 0;
  }

  /** Package-visible for tests (live state read happens here in prod). */
  render(theme: Theme, width: number): string[] {
    if (this.isEmpty()) return [];
    const now = Date.now();
    const lines: string[] = [];
    const jobs = this.backgroundedJobs();
    const shown = jobs.slice(0, MAX_ROWS);
    for (const job of shown) {
      const cmd = resolveDisplayName(job.command, job.name).slice(0, 40);
      const age = formatAge(now - job.startedAt);
      const frame = SPINNER[this.frame % SPINNER.length];
      lines.push(
        `${theme.fg("accent", frame)} ${theme.bold(cmd)} ${theme.fg("dim", `· ${job.jobId} · ${age}`)}`,
      );
      const tail = readLastLine(job.outputFile);
      if (tail.length > 0) lines.push(theme.fg("dim", `  ⎿ ${tail}`));
    }
    if (jobs.length > MAX_ROWS) {
      const overflow = overflowSegments(jobs.length - MAX_ROWS);
      lines.push(`  ${theme.fg("dim", overflow[0].text)}`);
    }
    for (const row of this.finished.values()) {
      const painted = finishedRowSegments(row.command, row.exitCode, formatAge(row.elapsedMs));
      lines.push(theme.fg(painted[0].tone, painted[0].text));
    }
    const w = Math.max(20, width);
    return lines.map((line) => truncateToWidth(line, w));
  }
}
