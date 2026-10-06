import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { createState } from "../src/runtime";
import { JOBS_WIDGET_KEY, JobsWidget } from "../src/tools/jobs-widget";

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as unknown as Theme;
const tui = { requestRender: vi.fn(), terminal: { columns: 80 } } as unknown as TUI;

const freshRoot = (): string => mkdtempSync(join(tmpdir(), "bg-widget-"));

const addJob = (state: ReturnType<typeof createState>, root: string, id: string, command: string, log?: string) => {
  const logFile = join(root, `${id}.out`);
  writeFileSync(logFile, log ?? "");
  state.backgroundJobs.set(id, {
    jobId: id,
    session: "pi-bg-s",
    windowId: "@1",
    runId: id,
    outputFile: logFile,
    command,
    startedAt: Date.now() - 45000,
    viaTimeoutDetach: false,
    backgrounded: true,
    engine: { spoolDir: root },
  });
};

describe("jobs widget (headless)", () => {
  it("registers under the widget key and renders nothing when empty", () => {
    const state = createState();
    const widget = new JobsWidget(state);
    const setWidget = vi.fn();
    widget.attach({ setWidget });
    expect(setWidget).toHaveBeenCalledOnce();
    expect(setWidget.mock.calls[0][0]).toBe(JOBS_WIDGET_KEY);
    const factory = setWidget.mock.calls[0][1] as (tui: TUI, theme: Theme) => {
      render: (width: number) => string[];
      invalidate: () => void;
    };
    const component = factory(tui, theme);
    expect(component.render(80)).toEqual([]);
    widget.detach({ setWidget });
    expect(setWidget).toHaveBeenCalledTimes(2);
    expect(setWidget.mock.calls[1][1]).toBeUndefined();
  });

  it("renders running rows with command, id, elapsed, and tail", () => {
    const root = freshRoot();
    const state = createState();
    addJob(state, root, "aaaaaa", "sleep 90", "starting\nworking hard\n");
    const widget = new JobsWidget(state);
    const lines = (widget as unknown as { render: (theme: Theme, width: number) => string[] }).render(theme, 80);
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain("sleep 90");
    expect(lines[0]).toContain("aaaaaa");
    expect(lines[0]).toContain("45s");
    expect(lines[1]).toContain("working hard");
  });

  it("finished rows linger then clear across turns", () => {
    const state = createState();
    const widget = new JobsWidget(state);
    const render = (widget as unknown as { render: (theme: Theme, width: number) => string[] }).render.bind(widget);
    widget.noteFinished("bbbbbb", "sleep 30", 0, 30000);
    expect(render(theme, 80).join("\n")).toContain("exit 0");
    widget.ageFinished(); // 1 turn lingered
    expect(render(theme, 80)).toEqual([]);
    widget.noteFinished("cccccc", "pytest", 1, 120000);
    expect(render(theme, 80).join("\n")).toContain("exit 1");
    widget.ageFinished();
    expect(render(theme, 80).join("\n")).toContain("exit 1"); // errors linger 2
    widget.ageFinished();
    expect(render(theme, 80)).toEqual([]);
  });

  it("hides foreground (un-backgrounded) rows", () => {
    const root = freshRoot();
    const state = createState();
    addJob(state, root, "eeeeee", "sleep 60");
    const row = state.backgroundJobs.get("eeeeee")!;
    row.backgrounded = false; // still foregrounded: call row owns it
    const widget = new JobsWidget(state);
    const lines = (widget as unknown as { render: (theme: Theme, width: number) => string[] }).render(theme, 80);
    expect(lines).toEqual([]);
    row.backgrounded = true; // demoted: widget picks it up
    expect(
      (widget as unknown as { render: (theme: Theme, width: number) => string[] }).render(theme, 80).join("\n"),
    ).toContain("eeeeee");
  });

  it("caps rows with overflow pointer", () => {
    const root = freshRoot();
    const state = createState();
    for (let i = 0; i < 8; i++) addJob(state, root, `id${i}000`, `cmd ${i}`);
    const widget = new JobsWidget(state);
    const lines = (widget as unknown as { render: (theme: Theme, width: number) => string[] }).render(theme, 80);
    expect(lines.some((l) => l.includes("+2 more (see /tasks)"))).toBe(true);
  });

  it("poke starts a refresh interval only when non-empty", () => {
    vi.useFakeTimers();
    try {
      const state = createState();
      const widget = new JobsWidget(state);
      (widget as unknown as { tui: TUI }).tui = tui;
      widget.attach({ setWidget: vi.fn() });
      widget.poke();
      expect(vi.getTimerCount()).toBe(0); // empty: no timer
      addJob(state, freshRoot(), "dddddd", "sleep 1");
      widget.poke();
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(3000);
      expect(tui.requestRender).toHaveBeenCalled();
      // Detached (e.g. shutdown): poke never restarts the timer.
      widget.detach({ setWidget: vi.fn() });
      widget.poke();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("jobs widget slots", () => {
  it("paints failed finished rows with the error slot, ok rows dim", () => {
    const recording = {
      fg: (c: string, t: string) => `<${c}>${t}`,
      bold: (t: string) => t,
    } as unknown as Theme;
    const state = createState();
    const widget = new JobsWidget(state);
    const render = (widget as unknown as { render: (theme: Theme, width: number) => string[] }).render.bind(widget);
    widget.noteFinished("ok0001", "true", 0, 1000);
    widget.noteFinished("bad002", "false", 1, 2000);
    const lines = render(recording, 80);
    expect(lines.some((l) => l.includes("<dim>") && l.includes("exit 0"))).toBe(true);
    expect(lines.some((l) => l.includes("<error>") && l.includes("exit 1"))).toBe(true);
    expect(lines.some((l) => l.includes("<warning>"))).toBe(false);
  });
});
