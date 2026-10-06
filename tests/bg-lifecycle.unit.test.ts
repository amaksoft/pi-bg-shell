import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { resolveOptions } from "../src/config";
import { isBackgroundShellDisabled, tmuxBash } from "../src/extension";
import { shutdownWarningText } from "../src/engine/report";
import { createState } from "../src/runtime";
import { registerTasksCommand } from "../src/tools/tasks-command";
import { acquireOwnerLock } from "../src/engine/owner-lock";
import { atomicWriteJson, type JobRecord, type SessionRecord } from "../src/engine/sidecar";

const hasTmux = (): boolean => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const LIVE_TMUX = hasTmux();
const freshRoot = (): string => mkdtempSync(join(tmpdir(), "bg-life-"));

type Handler = (event: unknown, ctx: unknown) => Promise<void>;

const mockPi = () => {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  const pi = {
    on: vi.fn((event: string, handler: Handler) => void handlers.set(event, handler)),
    registerTool: vi.fn(),
    registerCommand: vi.fn((name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => void commands.set(name, def.handler)),
    registerShortcut: vi.fn(),
    registerMessageRenderer: vi.fn(),
    sendMessage: vi.fn(),
  } as unknown as ExtensionAPI;
  return { pi, handlers, commands };
};

const mockCtx = (piId: string, ui?: Record<string, unknown>) => ({
  cwd: tmpdir(),
  hasUI: true,
  ui: {
    setStatus: vi.fn(),
    notify: vi.fn(),
    confirm: vi.fn(async () => false),
    select: vi.fn(async () => undefined),
    setWidget: vi.fn(),
    ...ui,
  },
  sessionManager: { getSessionId: () => piId },
});

describe("engine extension lifecycle (live)", () => {
  it.skipIf(!LIVE_TMUX)("start creates session+server; shutdown destroys them", async () => {
    const outputDir = freshRoot();
    const { pi, handlers } = mockPi();
    tmuxBash({ outputDir })(pi);
    const ctx = mockCtx(`bg-life-${process.pid}-1`) as never;

    await handlers.get("session_start")!({}, ctx);
    // Widget attached (glanceable rows); detach on shutdown is best-effort.
    expect((ctx as unknown as { ui: { setWidget: ReturnType<typeof vi.fn> } }).ui.setWidget).toHaveBeenCalled();
    const spoolDir = join(outputDir, "sessions", `bg-life-${process.pid}-1`);
    expect(existsSync(join(spoolDir, "session.json"))).toBe(true);
    const session = JSON.parse(readFileSync(join(spoolDir, "session.json"), "utf8"));
    // No warden window (Phase 5 deleted the warden); the bootstrap shell
    // stays instead — tmux sessions cannot survive zero windows, and it
    // holds no job (invisible to /tasks, footer, delivery).
    const sock = session.tmuxServer.replace("-L ", "");
    const windows = String(
      execFileSync("tmux", ["-L", sock, "list-windows", "-F", "#{window_name}"]),
    )
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    expect(windows).toHaveLength(1);
    expect(windows[0]).not.toContain("▲ pi-bg-control");

    await handlers.get("turn_start")!({}, ctx);

    await handlers.get("session_shutdown")!({}, ctx);
    expect(() =>
      execFileSync("tmux", ["-L", session.tmuxServer.replace("-L ", ""), "has-session"], { stdio: "ignore" }),
    ).toThrow();
    expect(existsSync(join(spoolDir, "session.lock", "owner.json"))).toBe(false);
  });

  it.skipIf(!LIVE_TMUX)("second start against a live owner fails open without throwing", async () => {
    const outputDir = freshRoot();
    const { pi, handlers } = mockPi();
    tmuxBash({ outputDir })(pi);
    const ctx = mockCtx(`bg-life-${process.pid}-2`) as never;
    await handlers.get("session_start")!({}, ctx);
    // Same pi id, lock still held by this process: busy-exit path, no throw.
    await handlers.get("session_start")!({}, ctx);
    await handlers.get("session_shutdown")!({}, ctx);
  });
});

describe("requestDetach backgrounds all foreground runs at once", () => {
  it("flags every waiter, not just the most recent", async () => {
    const { requestDetach } = await import("../src/runtime");
    const state = createState();
    expect(requestDetach(state)).toEqual([]);
    state.foregroundRuns.set("tool-a", { command: "sleep 10", startedAt: Date.now() });
    state.foregroundRuns.set("tool-b", { command: "sleep 20", startedAt: Date.now() });
    const detached = requestDetach(state);
    expect(detached.map((d) => d.toolCallId)).toEqual(["tool-a", "tool-b"]);
    expect(state.detachRequested.has("tool-a")).toBe(true);
    expect(state.detachRequested.has("tool-b")).toBe(true);
  });
});

describe("/tasks (headless)", () => {
  const buildState = (root: string, piId: string, jobs: { id: string; command: string }[]) => {
    const spoolDir = join(root, piId);
    mkdirSync(join(spoolDir, "jobs"), { recursive: true });
    mkdirSync(join(spoolDir, "session.lock"), { recursive: true });
    const record: SessionRecord = {
      piId,
      sessionName: `pi-bg-${piId}`,
      sessionGuid: `guid-${piId}`,
      tmuxServer: `-L pi-bg-sock-${piId}`,
      shutdownPolicy: "stop-all",
      version: 1,
      createdAt: new Date().toISOString(),
      ownerNonce: "n",
      state: "active",
    };
    atomicWriteJson(join(spoolDir, "session.json"), record);
    acquireOwnerLock(join(spoolDir, "session.lock"), 300000);
    // The session carries its lock's real nonce (as ensureSession returns it).
    const owner = JSON.parse(
      readFileSync(join(spoolDir, "session.lock", "owner.json"), "utf8"),
    ) as { nonce: string };
    const state = createState();
    state.engine = {
      session: {
        piId,
        spoolDir,
        sessionName: record.sessionName,
        socketName: `pi-bg-sock-${piId}`,
        sessionGuid: record.sessionGuid,
        ownerNonce: owner.nonce,
        epoch: 0,
      },
      runner: { tmux: () => "" },
      reconciler: null,
      widget: null,
    };
    for (const job of jobs) {
      const exitFile = join(spoolDir, "jobs", `${job.id}.exit`);
      writeFileSync(`${exitFile}.out`, `out-${job.id}\n`);
      const rec: JobRecord = {
        jobId: job.id,
        windowId: "@1",
        command: job.command,
        startedAt: Date.now(),
        spoolLog: `${exitFile}.out`,
        exitFile,
        foregroundClaim: false,
        status: "running",
        seen: false,
      };
      atomicWriteJson(join(spoolDir, "jobs", `${job.id}.json`), rec);
      state.backgroundJobs.set(job.id, {
        jobId: job.id,
        session: record.sessionName,
        windowId: "@1",
        runId: job.id,
        outputFile: `${exitFile}.out`,
        command: job.command,
        startedAt: Date.now(),
        viaTimeoutDetach: false,
        engine: { spoolDir },
      });
    }
    return state;
  };

  const setup = (jobs: { id: string; command: string }[]) => {
    const root = freshRoot();
    const state = buildState(root, "tasks-pi", jobs);
    const options = resolveOptions({ outputDir: root });
    const notified: { text: string; kind: string }[] = [];
    const handlers = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
    const pi = {
      registerCommand: vi.fn((name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
        void handlers.set(name, def.handler),
      ),
    } as unknown as ExtensionAPI;
    registerTasksCommand(pi, state, options);
    return { state, options, notified, handlers, root };
  };

  const ctxWith = (ui: Record<string, unknown>) =>
    ({
      hasUI: true,
      ui: {
        setStatus: vi.fn(),
        notify: vi.fn(),
        confirm: vi.fn(),
        select: vi.fn(),
        custom: vi.fn(async () => undefined),
        ...ui,
      },
      sessionManager: { getSessionId: () => "tasks-pi" },
    }) as unknown as ExtensionCommandContext;

  it("opens the overlay browser; Enter drills into live-log detail", async () => {
    const { handlers, state } = setup([{ id: "aaaaaa", command: "sleep 60" }]);
    const { TasksOverlay } = await import("../src/tools/tasks-overlay");
    let component: InstanceType<typeof TasksOverlay> | undefined;
    let doneCalled = false;
    const custom = vi.fn((factory: (tui: unknown, theme: unknown, kb: unknown, done: () => void) => unknown) => {
      component = factory(
        { requestRender: () => {} },
        { fg: (_c: string, t: string) => t, bold: (t: string) => t },
        {},
        () => void (doneCalled = true),
      ) as InstanceType<typeof TasksOverlay>;
      return Promise.resolve();
    });
    await handlers.get("tasks")!("", ctxWith({ custom }));
    expect(custom).toHaveBeenCalledOnce();
    expect(component).toBeDefined();
    // List shows the job; Enter (first row) drills into detail with live log.
    expect(component!.render(80).join("\n")).toContain("aaaaaa");
    component!.handleInput("\r");
    const detail = component!.render(80).join("\n");
    expect(detail).toContain("Job aaaaaa");
    expect(detail).toContain("out-aaaaaa");
    expect(detail).toContain("log:");
    // Esc backs out to the list; Esc again closes.
    component!.handleInput("\x1b");
    expect(component!.render(80).join("\n")).toContain("aaaaaa");
    component!.handleInput("\x1b");
    expect(doneCalled).toBe(true);
    expect(state.backgroundJobs.has("aaaaaa")).toBe(true); // peeking never kills
  });

  it("double-K kills in place and forgets the job", async () => {
    const { handlers, state, options } = setup([{ id: "bbbbbb", command: "sleep 60" }]);
    const { TasksOverlay } = await import("../src/tools/tasks-overlay");
    let component: InstanceType<typeof TasksOverlay> | undefined;
    const custom = vi.fn((factory: (tui: unknown, theme: unknown, kb: unknown, done: () => void) => unknown) => {
      component = factory(
        { requestRender: () => {} },
        { fg: (_c: string, t: string) => t, bold: (t: string) => t },
        {},
        () => {},
      ) as InstanceType<typeof TasksOverlay>;
      return Promise.resolve();
    });
    // Drive the command-wired overlay end to end: Enter, K, K.
    await handlers.get("tasks")!("", ctxWith({ custom }));
    component!.handleInput("\r"); // detail for bbbbbb (only row)
    component!.handleInput("k"); // arm
    expect(component!.render(80).join("\n")).toContain("Press K again");
    component!.handleInput("k"); // confirm -> command's onKill (killTask)
    expect(state.backgroundJobs.has("bbbbbb")).toBe(false);
    expect(component!.render(80).join("\n")).toContain("No background shell jobs.");
  });

  it("empty list renders inside the overlay (never a bare toast)", async () => {
    const { handlers } = setup([]);
    const { TasksOverlay } = await import("../src/tools/tasks-overlay");
    let component: InstanceType<typeof TasksOverlay> | undefined;
    const custom = vi.fn((factory: (tui: unknown, theme: unknown, kb: unknown, done: () => void) => unknown) => {
      component = factory(
        { requestRender: () => {} },
        { fg: (_c: string, t: string) => t, bold: (t: string) => t },
        {},
        () => {},
      ) as InstanceType<typeof TasksOverlay>;
      return Promise.resolve();
    });
    await handlers.get("tasks")!("", ctxWith({ custom }));
    expect(component!.render(80).join("\n")).toContain("No background shell jobs.");
  });

  it("overlay refreshes live: jobs appear and disappear without input", async () => {
    vi.useFakeTimers();
    try {
      const { handlers, state, options } = setup([{ id: "aaaaaa", command: "sleep 60" }]);
      const { TasksOverlay } = await import("../src/tools/tasks-overlay");
      const { killTask } = await import("../src/engine/wiring");
      let component: InstanceType<typeof TasksOverlay> | undefined;
      const renders: string[][] = [];
      const custom = vi.fn((factory: (tui: unknown, theme: unknown, kb: unknown, done: () => void) => unknown) => {
        component = factory(
          { requestRender: () => void renders.push(component!.render(80)) },
          { fg: (_c: string, t: string) => t, bold: (t: string) => t },
          {},
          () => {},
        ) as InstanceType<typeof TasksOverlay>;
        return Promise.resolve();
      });
      await handlers.get("tasks")!("", ctxWith({ custom }));
      expect(component!.render(80).join("\n")).toContain("aaaaaa");
      // A completion lands while open: next refresh drops the row, no keys.
      killTask(state, options, "aaaaaa");
      await vi.advanceTimersByTimeAsync(2500);
      expect(component!.render(80).join("\n")).toContain("No background shell jobs.");
      expect(renders.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports unknown refs and empty lists (with orphan pointer)", async () => {
    const { handlers, notified, root } = setup([]);
    // Foreign pending dir under outputDir/sessions -> pointer text.
    const foreign = join(root, "sessions", "foreign-1");
    mkdirSync(join(foreign, "jobs"), { recursive: true });
    mkdirSync(join(foreign, "session.lock"), { recursive: true });
    atomicWriteJson(join(foreign, "session.json"), {
      piId: "foreign-1",
      sessionName: "pi-bg-foreign-1",
      sessionGuid: "g",
      tmuxServer: "-L pi-bg-sock-x",
      shutdownPolicy: "stop-all",
      version: 1,
      createdAt: new Date().toISOString(),
      ownerNonce: "n",
      state: "active",
    } as SessionRecord);
    const exitFile = join(foreign, "jobs", "ff0001.exit");
    writeFileSync(`${exitFile}.out`, "foreign out\n");
    atomicWriteJson(join(foreign, "jobs", "ff0001.json"), {
      jobId: "ff0001",
      windowId: "@1",
      command: "foreign cmd",
      spoolLog: `${exitFile}.out`,
      exitFile,
      foregroundClaim: false,
      startedAt: Date.now(),
      status: "running",
      seen: false,
    } as JobRecord);
    const notify = vi.fn((text: string, kind: string) => void notified.push({ text, kind }));
    const custom = vi.fn(async () => undefined);
    await handlers.get("tasks")!("", ctxWith({ notify, custom }));
    // Empty list opens the overlay browser (with orphan pointer inside),
    // never a bare toast.
    expect(custom).toHaveBeenCalledOnce();
    expect(notified).toEqual([]);
    await handlers.get("tasks")!("zzzzzz", ctxWith({ notify, custom }));
    expect(notified[0].text).toContain("Unknown background job: zzzzzz");
    expect(notified[0].text).toContain("/orphans");
  });
});

describe("kill-switch and shutdown text (unchanged)", () => {
  it("PI_BG_DISABLE=1 registers nothing", async () => {
    process.env.PI_BG_DISABLE = "1";
    try {
      const { pi } = mockPi();
      tmuxBash({})(pi);
      expect(pi.registerTool).not.toHaveBeenCalled();
    } finally {
      delete process.env.PI_BG_DISABLE;
    }
  });

  it("shutdown warning names jobs and the keep-alive setting", () => {
    expect(shutdownWarningText([])).toBeUndefined();
    expect(
      shutdownWarningText([{ command: "sleep 60" }, { name: "n", command: "x" }]),
    ).toContain("Stopped 2 background jobs");
  });
});

describe("task ref normalization", () => {
  it("accepts uppercase hex job ids by normalizing", async () => {
    const { resolveTaskRef } = await import("../src/runtime");
    const state = createState();
    state.backgroundJobs.set("a1b2c3", {
      jobId: "a1b2c3",
      session: "s",
      windowId: "@1",
      runId: "a1b2c3",
      command: "sleep 60",
      startedAt: Date.now(),
      viaTimeoutDetach: false,
      engine: { spoolDir: "/tmp/bg-hex" },
    });
    const options = { tmuxBinary: "tmux" } as never;
    expect(resolveTaskRef(state, options, "A1B2C3")?.jobId).toBe("a1b2c3");
    expect(resolveTaskRef(state, options, "a1b2c3")?.jobId).toBe("a1b2c3");
    expect(resolveTaskRef(state, options, "zzzzzz")).toBeUndefined();
  });

  it("display polls send after bounded idle retries", async () => {
    const { sendPollMessageWhenIdle } = await import("../src/runtime");
    const sent: unknown[] = [];
    const pi = { sendMessage: vi.fn((m: unknown) => void sent.push(m)) } as never;
    const state = createState();
    state.statusContext = { isIdle: () => false, hasUI: true } as never;
    sendPollMessageWhenIdle(pi, state, { content: "x" } as never, 0);
    expect(sent).toHaveLength(1);
  });
});
