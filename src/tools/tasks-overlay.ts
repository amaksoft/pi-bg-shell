import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  SelectList,
  Text,
  matchesKey,
  type SelectItem,
} from "@earendil-works/pi-tui";
import { resolveDisplayName } from "../engine/grammar";
import { overlayRowLabel, formatAge } from "../engine/grammar";

/**
 * /tasks as a nested overlay (pi-subagents parity): job list with keyboard
 * nav, Enter drills into a live-log detail view, double-K kills in place.
 * Stays inside the overlay — nothing dumps into the transcript — until Esc.
 */

export interface OverlayJobRow {
  jobId: string;
  windowId: string;
  name?: string;
  command: string;
  status: string;
  logFile: string;
  startedAt: number;
  unread?: boolean;
}

export interface TasksOverlayDeps {
  getRows: () => OverlayJobRow[];
  getLogTail: (jobId: string, maxLines: number) => string;
  onKill: (jobId: string) => boolean;
  orphanPointer: string;
}

type Mode = { kind: "list" } | { kind: "detail"; jobId: string; killArmed: boolean; scrollBack: number };

const DETAIL_LOG_LINES = 200;
const DETAIL_VIEW_LINES = 12;


export class TasksOverlay {
  private mode: Mode = { kind: "list" };
  private container = new Container();
  private selectList: SelectList | null = null;
  private autoTimer: ReturnType<typeof setInterval> | undefined;
  private savedIndex = 0;

  constructor(
    private readonly tui: { requestRender: () => void },
    private readonly theme: Theme,
    private readonly deps: TasksOverlayDeps,
    private readonly done: (result: void) => void,
    private readonly autoRefreshMs = 2000,
  ) {
    this.rebuild();
    this.startAutoRefresh();
  }

  /**
   * Live refresh while open: re-read rows on an interval so completions
   * appear/disappear without closing. Selection + scroll offset survive
   * rebuilds; elapsed ages tick via render-time Date.now(). Stops on done.
   */
  private startAutoRefresh(): void {
    if (this.autoTimer) return;
    this.autoTimer = setInterval(() => {
      try {
        // Rebuild every fire: ages tick, completions appear/disappear,
        // detail tails grow. Selection + scroll offset survive (see rebuild).
        this.rebuild();
        this.tui.requestRender();
      } catch {
        // Refresh is best-effort; manual keys always work.
      }
    }, this.autoRefreshMs);
    if (typeof this.autoTimer.unref === "function") this.autoTimer.unref();
  }

  private stopAutoRefresh(): void {
    if (this.autoTimer) clearInterval(this.autoTimer);
    this.autoTimer = undefined;
  }

  private finish(): void {
    this.stopAutoRefresh();
    this.done();
  }

  private rowLabel(row: OverlayJobRow): string {
    const cmd = resolveDisplayName(row.command, row.name).slice(0, 44);
    const age = formatAge(Date.now() - row.startedAt);
    return overlayRowLabel(cmd, row.jobId, age, { unread: row.unread });
  }

  private rebuild(): void {
    const th = this.theme;
    const mode = this.mode;
    const container = new Container();
    if (mode.kind === "list") {
      const rows = this.deps.getRows();
      container.addChild(new Text(th.fg("accent", th.bold("Background shell jobs"))));
      if (rows.length === 0) {
        container.addChild(new Text(""));
        container.addChild(new Text(th.fg("muted", `No background shell jobs.${this.deps.orphanPointer}`)));
        container.addChild(new Text(""));
      } else {
        const items: SelectItem[] = rows.map((row) => ({
          value: row.jobId,
          label: this.rowLabel(row),
          description: row.logFile,
        }));
        const selectList = new SelectList(items, Math.min(items.length, 10), {
          selectedPrefix: (text) => th.fg("accent", text),
          selectedText: (text) => th.fg("accent", text),
          description: (text) => th.fg("muted", text),
          scrollInfo: (text) => th.fg("dim", text),
          noMatch: (text) => th.fg("warning", text),
        });
        selectList.onSelect = (item) => {
          this.mode = { kind: "detail", jobId: item.value, killArmed: false, scrollBack: 0 };
          this.rebuild();
          this.tui.requestRender();
        };
        selectList.onCancel = () => this.finish();
        selectList.onSelectionChange = (item) => {
          const idx = rows.findIndex((r) => r.jobId === item.value);
          if (idx >= 0) this.savedIndex = idx;
        };
        selectList.setSelectedIndex(Math.min(this.savedIndex, Math.max(0, rows.length - 1)));
        this.selectList = selectList;
        container.addChild(selectList);
      }
      container.addChild(
        new Text(th.fg("dim", rows.length === 0 ? "Esc close" : "↑↓ navigate • Enter peek • Esc close")),
      );
    } else {
      const jobId = mode.jobId;
      const rows = this.deps.getRows();
      const found = rows.find((r) => r.jobId === jobId);
      container.addChild(new Text(th.fg("accent", th.bold(`Job ${jobId}`))));
      if (!found) {
        container.addChild(new Text(th.fg("warning", "Finished or killed — no longer tracked.")));
      } else {
        const age = formatAge(Date.now() - found.startedAt);
        container.addChild(new Text(`$ ${found.command.split("\n")[0].slice(0, 60)}`));
        container.addChild(
          new Text(th.fg("muted", `window ${found.windowId} · ${age} · ${found.status}`)),
        );
        container.addChild(new Text(th.fg("dim", `log: ${found.logFile}`)));
        const tail = this.deps.getLogTail(jobId, DETAIL_LOG_LINES);
        const lines = tail.length > 0 ? tail.split("\n") : ["(no output yet)"];
        const mode = this.mode;
        const back = mode.kind === "detail" ? mode.scrollBack : 0;
        const start = Math.max(0, lines.length - DETAIL_VIEW_LINES - back);
        const view = lines.slice(start, start + DETAIL_VIEW_LINES);
        if (start > 0) view.unshift(th.fg("dim", `↑ ${start} more line(s) above`));
        container.addChild(new Text(view.join("\n")));
      }
      const armed = mode.killArmed;
      container.addChild(
        new Text(
          th.fg(
            armed ? "warning" : "dim",
            armed ? "Press K again to confirm kill • Esc back" : "K kill • R refresh • ↑↓ scroll • Esc back",
          ),
        ),
      );
    }
    this.container = container;
  }

  render(width: number): string[] {
    return this.container.render(truncateWidth(width));
  }

  invalidate(): void {
    this.container.invalidate();
  }

  handleInput(data: string): void {
    const mode = this.mode;
    if (mode.kind === "list") {
      if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
        this.finish();
        return;
      }
      this.selectList?.handleInput(data);
      this.tui.requestRender();
      return;
    }
    // Detail mode.
    if (matchesKey(data, "escape")) {
      this.mode = { kind: "list" };
      this.rebuild(); // rebuilds a fresh SelectList; Esc in list closes
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "r")) {
      mode.scrollBack = 0;
      mode.killArmed = false;
      this.rebuild();
      this.tui.requestRender();
      return;
    }
    if (data === "k" || data === "K") {
      if (!mode.killArmed) {
        mode.killArmed = true;
        this.rebuild();
        this.tui.requestRender();
        return;
      }
      const ok = this.deps.onKill(mode.jobId);
      void ok;
      this.mode = { kind: "list" };
      this.rebuild();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "up")) {
      mode.scrollBack += 1;
      mode.killArmed = false;
      this.rebuild();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "down")) {
      mode.scrollBack = Math.max(0, mode.scrollBack - 1);
      mode.killArmed = false;
      this.rebuild();
      this.tui.requestRender();
      return;
    }
    this.tui.requestRender();
  }
}

const truncateWidth = (width: number): number => Math.max(20, Math.min(width, 100));
