import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { resolveOptions } from "../src/config";
import { createState } from "../src/runtime";
import { adoptOrphanDir, releaseAdoptedDirs, restoreAdoptedDirs, scanOrphanDirs } from "../src/engine/orphans";
import { acquireOwnerLock } from "../src/engine/owner-lock";
import { registerOrphansCommand } from "../src/tools/orphans-command";
import { atomicWriteJson, type JobRecord, type SessionRecord } from "../src/engine/sidecar";
import type { Session } from "../src/engine/session";
import { Reconciler } from "../src/engine/reconciler";
import { killTask, listTasks, peekTask } from "../src/engine/wiring";

const freshRoot = (): string => mkdtempSync(join(tmpdir(), "bg-orph-"));

const options = (outputDir: string) => resolveOptions({ outputDir });

const writeSession = (spoolDir: string, piId: string, policy = "stop-all"): void => {
  mkdirSync(join(spoolDir, "jobs"), { recursive: true });
  mkdirSync(join(spoolDir, "session.lock"), { recursive: true });
  const record: SessionRecord = {
    piId,
    sessionName: `pi-bg-${piId}`,
    sessionGuid: `guid-${piId}`,
    tmuxServer: `-L pi-bg-sock-${piId}`,
    shutdownPolicy: policy,
    version: 1,
    createdAt: new Date().toISOString(),
    ownerNonce: `nonce-${piId}`,
    state: "active",
  };
  atomicWriteJson(join(spoolDir, "session.json"), record);
};

const writeOwner = (spoolDir: string, kind: "live" | "dead"): void => {
  if (kind === "live") {
    acquireOwnerLock(join(spoolDir, "session.lock"), 300000);
    return;
  }
  atomicWriteJson(join(spoolDir, "session.lock", "owner.json"), {
    pid: 1 << 24,
    processStartTimeMs: 1,
    nonce: "dead",
    heartbeatAt: new Date(0).toISOString(),
  });
  writeFileSync(join(spoolDir, "session.lock", "heartbeat"), "");
  writeFileSync(join(spoolDir, "heartbeat"), "");
  const old = new Date(0);
  utimesSync(join(spoolDir, "session.lock", "heartbeat"), old, old);
  utimesSync(join(spoolDir, "heartbeat"), old, old);
};

const writeJob = (spoolDir: string, jobId: string, opts: { exitCode?: number; log?: string } = {}): void => {
  const exitFile = join(spoolDir, "jobs", `${jobId}.exit`);
  const logFile = `${exitFile}.out`;
  writeFileSync(logFile, opts.log ?? `log-${jobId}\n`);
  if (opts.exitCode !== undefined) writeFileSync(exitFile, `${opts.exitCode}\n`);
  const record: JobRecord = {
    jobId,
    windowId: "@1",
    command: `cmd-${jobId}`,
    spoolLog: logFile,
    exitFile,
    foregroundClaim: false,
    startedAt: Date.now(),
    status: "running",
    seen: false,
  };
  atomicWriteJson(join(spoolDir, "jobs", `${jobId}.json`), record);
};

const ownSession = (spoolRoot: string, piId: string): { state: ReturnType<typeof createState>; session: Session } => {
  const spoolDir = join(spoolRoot, piId);
  writeSession(spoolDir, piId);
  writeOwner(spoolDir, "live");
  // The session carries the nonce its lock was acquired with (as ensureSession
  // returns it); a mismatched nonce reads as takeover loss to killGuarded.
  const owner = JSON.parse(readFileSync(join(spoolDir, "session.lock", "owner.json"), "utf8")) as { nonce: string };
  const session = {
    piId,
    spoolDir,
    sessionName: `pi-bg-${piId}`,
    socketName: `pi-bg-sock-${piId}`,
    sessionGuid: `guid-${piId}`,
    ownerNonce: owner.nonce,
    epoch: 0,
  } as Session;
  const state = createState();
  // A real (never started) reconciler: adopt watches dirs on the shared tick.
  const reconciler = new Reconciler(session, { onCompletions: () => {}, onPoll: () => {} });
  state.engine = { session, runner: { tmux: () => "" }, reconciler, widget: null };
  return { state, session };
};

const mockPi = () => {
  const sent: { message: unknown; opts: unknown }[] = [];
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  const pi = {
    sendMessage: vi.fn((message: unknown, opts: unknown) => void sent.push({ message, opts })),
    registerCommand: vi.fn((name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => void commands.set(name, def.handler)),
  } as unknown as ExtensionAPI;
  return { pi, sent, commands };
};

describe("engine registry collision", () => {
  it("keep-first wins across dirs, delivery unaffected", async () => {
    const { syncJobToState } = await import("../src/engine/wiring");
    const root = freshRoot();
    const { state } = ownSession(root, "own-1");
    const mk = (dir: string, piId: string): void => {
      mkdirSync(join(dir, "jobs"), { recursive: true });
      const exitFile = join(dir, "jobs", "aaaaaa.exit");
      writeFileSync(`${exitFile}.out`, "log\n");
      atomicWriteJson(join(dir, "jobs", "aaaaaa.json"), {
        jobId: "aaaaaa", windowId: "@1", command: `cmd-${piId}`, startedAt: Date.now(),
        spoolLog: `${exitFile}.out`, exitFile,
        foregroundClaim: false, status: "running", seen: false,
      });
    };
    mk(join(root, "own-1"), "own-1");
    mk(join(root, "foreign-1"), "foreign-1");
    syncJobToState(state, { spoolDir: join(root, "own-1") } as Session, "aaaaaa");
    expect(state.backgroundJobs.get("aaaaaa")?.command).toBe("cmd-own-1");
    syncJobToState(state, { spoolDir: join(root, "foreign-1") } as Session, "aaaaaa");
    // Collision: first owner kept, lookup never silently retargets.
    expect(state.backgroundJobs.get("aaaaaa")?.command).toBe("cmd-own-1");
  });
});

describe("engine adopted routing", () => {
  it("peek/kill/list resolve adopted jobs via their own dir and socket", async () => {
    const { peekTask, killTask, listTasks } = await import("../src/engine/wiring");
    const root = freshRoot();
    const { state } = ownSession(root, "own-1");
    const calls: { socket: string; args: string[] }[] = [];
    state.engine!.runner = { tmux: (socket: string, args: string[]) => (calls.push({ socket, args }), "") };
    const foreign = join(root, "foreign-1");
    writeSession(foreign, "foreign-1");
    writeOwner(foreign, "dead");
    writeJob(foreign, "eeeeee", {});
    const { pi } = mockPi();
    const adopted = adoptOrphanDir(pi, state, options(root), foreign);
    expect(adopted.adopted).toBe(true);
    // Peek reads the adopted journal (not the owned dir).
    const peeked = peekTask(state, "eeeeee", 10);
    expect(peeked).toContain("log_path:");
    expect(peeked).toContain("eeeeee");
    // List surfaces adopted rows.
    expect(listTasks(state).map((r) => r.jobId)).toContain("eeeeee");
    // Kill marks the adopted journal and addresses the adopted socket.
    expect(killTask(state, options(root), "eeeeee")).toBe(true);
    // Guarded kill goes to the adopted socket (if-shell form), never own.
    expect(calls.some((c) => c.socket === "pi-bg-sock-foreign-1")).toBe(true);
    expect(calls.some((c) => c.socket === "pi-bg-sock-own-1")).toBe(false);
    expect(state.backgroundJobs.has("eeeeee")).toBe(false);
    releaseAdoptedDirs(state);
  });
});

describe("engine orphan scan", () => {
  it("lists foreign dirs with counts, excludes own + other namespaces", () => {
    const root = freshRoot();
    const own = join(root, "own-1");
    writeSession(own, "own-1");
    writeOwner(own, "live");
    const foreign = join(root, "foreign-1");
    writeSession(foreign, "foreign-1");
    writeOwner(foreign, "dead");
    writeJob(foreign, "aaaaaa", { exitCode: 0 });
    writeJob(foreign, "bbbbbb", {});
    const liveForeign = join(root, "foreign-2");
    writeSession(liveForeign, "foreign-2");
    writeOwner(liveForeign, "live");
    mkdirSync(join(root, "legacy-junk"));
    writeFileSync(join(root, "legacy-junk", "x.txt"), "x");

    const rows = scanOrphanDirs(root, "own-1", 50);
    expect(rows.map((r) => r.piId).sort()).toEqual(["foreign-1", "foreign-2"]);
    const f1 = rows.find((r) => r.piId === "foreign-1")!;
    expect(f1.ownerDead).toBe(true);
    expect(f1.pendingCompleted).toBe(1);
    expect(f1.running).toBe(1);
    expect(rows.find((r) => r.piId === "foreign-2")!.ownerDead).toBe(false);
  });
});

describe("engine adopt", () => {
  it("refuses live owners", () => {
    const root = freshRoot();
    const { state } = ownSession(root, "own-1");
    const foreign = join(root, "foreign-1");
    writeSession(foreign, "foreign-1");
    writeOwner(foreign, "live");
    const { pi } = mockPi();
    const result = adoptOrphanDir(pi, state, options(root), foreign);
    expect(result.adopted).toBe(false);
    expect(result.error).toContain("alive");
  });

  it("delivers completed once with original ids; running stays watched", () => {
    const root = freshRoot();
    const { state } = ownSession(root, "own-1");
    const foreign = join(root, "foreign-1");
    writeSession(foreign, "foreign-1");
    writeOwner(foreign, "dead");
    writeJob(foreign, "aaaaaa", { exitCode: 2, log: "adopted-output\n" });
    writeJob(foreign, "bbbbbb", {});
    const { pi, sent } = mockPi();
    try {
      const result = adoptOrphanDir(pi, state, options(root), foreign);
      expect(result.adopted).toBe(true);
      expect(result.deliveredCompleted).toEqual(["aaaaaa"]);
      expect(result.stillRunning).toEqual(["bbbbbb"]);
      const completions = sent.filter(
        (s) => (s.message as { customType?: string }).customType === "tmux-bash-completion",
      );
      expect(completions).toHaveLength(1);
      expect((completions[0].message as { content: string }).content).toContain("job aaaaaa");
      expect((completions[0].message as { content: string }).content).toContain("adopted-output");
      expect(completions[0].opts).toEqual({ triggerTurn: true, deliverAs: "steer" });
      // Adopted rows visible in the shared registry with the engine marker.
      expect(state.backgroundJobs.get("bbbbbb")?.engine?.spoolDir).toBe(foreign);
      expect(state.engine?.adopted?.has(foreign)).toBe(true);
    } finally {
      releaseAdoptedDirs(state);
      expect(state.engine?.adopted?.size ?? 0).toBe(0);
    }
  });

  it("settles tombstoned running rows as plain killed rows (no fake completion)", () => {
    const root = freshRoot();
    const { state } = ownSession(root, "own-1");
    const foreign = join(root, "foreign-1");
    writeSession(foreign, "foreign-1");
    writeOwner(foreign, "dead");
    writeJob(foreign, "cccccc", { log: "last-words\n" });
    atomicWriteJson(join(foreign, "death.json"), {
      killedAt: new Date().toISOString(),
      reason: "owner-gone",
      missCount: 10,
      jobs: [{ jobId: "cccccc", lastState: "running", exitFilePresent: false }],
    });
    const { pi, sent } = mockPi();
    try {
      const result = adoptOrphanDir(pi, state, options(root), foreign);
      expect(result.adopted).toBe(true);
      expect(result.salvagedRunning).toEqual(["cccccc"]);
      // No fabricated completion report for a death nobody observed.
      const completions = sent.filter(
        (s) => (s.message as { customType?: string }).customType === "tmux-bash-completion",
      );
      expect(completions).toHaveLength(0);
      const journal = JSON.parse(readFileSync(join(foreign, "jobs", "cccccc.json"), "utf8")) as JobRecord;
      expect(journal.status).toBe("killed");
      // Log retained for forensics; the tombstoned dir still lists in /orphans.
    } finally {
      releaseAdoptedDirs(state);
    }
  });
});

describe("/orphans command", () => {
  it("lists foreign sessions headlessly", async () => {
    const root = freshRoot();
    const spoolRoot = join(root, "sessions");
    mkdirSync(spoolRoot, { recursive: true });
    const { state } = ownSession(spoolRoot, "own-1");
    const foreign = join(spoolRoot, "foreign-9");
    writeSession(foreign, "foreign-9");
    writeOwner(foreign, "dead");
    writeJob(foreign, "dddddd", {});
    const { pi, commands } = mockPi();
    const notified: { text: string; kind: string }[] = [];
    registerOrphansCommand(pi, state, options(root));
    const ctx = {
      hasUI: false,
      ui: { notify: (text: string, kind: string) => void notified.push({ text, kind }) },
      sessionManager: { getSessionId: () => "own-1" },
    } as unknown as ExtensionCommandContext;
    await commands.get("orphans")!("", ctx);
    expect(notified).toHaveLength(1);
    expect(notified[0].text).toContain("foreign-9");
    expect(readFileSync(join(spoolRoot, "foreign-9", "jobs", "dddddd.json"), "utf8")).toBeDefined();
  });
});

describe("engine adopted restore", () => {
  it("restores dirs remembered in the sidecar, skips live and missing", () => {
    const root = freshRoot();
    const { state } = ownSession(root, "own-1");
    const dead = join(root, "foreign-dead");
    writeSession(dead, "foreign-dead");
    writeOwner(dead, "dead");
    writeJob(dead, "bbbbbb", {});
    const live = join(root, "foreign-live");
    writeSession(live, "foreign-live");
    writeOwner(live, "live");
    // Remember all three in our own sidecar (as persistAdoptedDir would).
    const ownRecord = readFileSync(join(root, "own-1", "session.json"), "utf8");
    const parsed = JSON.parse(ownRecord) as SessionRecord;
    parsed.adoptedDirs = [dead, live, join(root, "foreign-gone")];
    writeFileSync(join(root, "own-1", "session.json"), JSON.stringify(parsed));
    const { pi } = mockPi();
    const result = restoreAdoptedDirs(pi, state, options(root));
    expect(result.restored).toEqual([dead]);
    expect(result.skipped.map((s) => s.spoolDir).sort()).toEqual([join(root, "foreign-gone"), live].sort());
    expect(state.engine?.adopted?.has(dead)).toBe(true);
    expect(state.engine?.adopted?.has(live)).toBe(false);
  });

  it("is a no-op without an active engine", () => {
    const state = createState();
    const { pi } = mockPi();
    expect(restoreAdoptedDirs(pi, state, options(freshRoot()))).toEqual({ restored: [], skipped: [] });
  });
});

describe("notified latch (headless)", () => {
  const readJournal = (spoolDir: string, jobId: string): JobRecord =>
    JSON.parse(readFileSync(join(spoolDir, "jobs", `${jobId}.json`), "utf8")) as JobRecord;

  it("peek on a finished job latches; peek on a running job does not", () => {
    const root = freshRoot();
    const { state } = ownSession(root, "own-1");
    const spoolDir = join(root, "own-1");
    state.engine!.runner = { tmux: () => "pane-text\n" };
    writeJob(spoolDir, "ccccc1", { exitCode: 0, log: "done\n" });
    writeJob(spoolDir, "ccccc2", { log: "still running\n" });
    const done = peekTask(state, "ccccc1", 10);
    expect(done).toContain("log_path:");
    expect(readJournal(spoolDir, "ccccc1").seen).toBe(true);
    const running = peekTask(state, "ccccc2", 10);
    expect(running).toContain("log_path:");
    expect(readJournal(spoolDir, "ccccc2").seen).toBeFalsy();
  });

  it("kill latches before killing", () => {
    const root = freshRoot();
    const { state } = ownSession(root, "own-1");
    const spoolDir = join(root, "own-1");
    const calls: string[][] = [];
    state.engine!.runner = {
      tmux: (socket: string, args: string[]) => (calls.push([socket, ...args]), ""),
    };
    writeJob(spoolDir, "ddddd1", { log: "running\n" });
    expect(killTask(state, options(root), "ddddd1")).toBe(true);
    expect(readJournal(spoolDir, "ddddd1").seen).toBe(true);
    // Guarded kill goes through the if-shell form.
    expect(calls.some((c) => c.includes("if-shell"))).toBe(true);
  });

  it("suppressed completions clean up silently (no message, no toast)", async () => {
    const { deliverCompletions } = await import("../src/engine/wiring");
    const root = freshRoot();
    const { state } = ownSession(root, "own-1");
    state.engine!.runner = { tmux: () => "" };
    const sent: unknown[] = [];
    const notified: unknown[] = [];
    const pi = {
      sendMessage: vi.fn((message: unknown) => void sent.push(message)),
    } as unknown as ExtensionAPI;
    // Toast would go through the status context; leave it null (no UI).
    state.backgroundJobs.set("eeeee1", {
      jobId: "eeeee1",
      session: "pi-bg-own-1",
      windowId: "@1",
      runId: "eeeee1",
      outputFile: join(root, "own-1", "jobs", "eeeee1.exit.out"),
      command: "sleep 60",
      startedAt: Date.now(),
      viaTimeoutDetach: false,
      backgrounded: true,
      engine: { spoolDir: join(root, "own-1") },
    });
    writeJob(join(root, "own-1"), "eeeee1", { exitCode: 0, log: "done\n" });
    deliverCompletions(pi, state, options(root), [
      {
        job: {
          jobId: "eeeee1",
          windowId: "@1",
          command: "sleep 60",
          status: "completed",
          logFile: join(root, "own-1", "jobs", "eeeee1.exit.out"),
          exitFile: join(root, "own-1", "jobs", "eeeee1.exit"),
          startedAt: Date.now(),
          spoolDir: join(root, "own-1"),
        },
        exitCode: 0,
        logTail: "done\n",
        suppressed: true,
      },
    ]);
    expect(sent).toEqual([]);
    expect(notified).toEqual([]);
    expect(state.backgroundJobs.has("eeeee1")).toBe(false);
    void notified;
  });

  it("list marks finished-but-undelivered rows unread", () => {
    const root = freshRoot();
    const { state } = ownSession(root, "own-1");
    const spoolDir = join(root, "own-1");
    writeJob(spoolDir, "fffff1", { exitCode: 0, log: "done\n" });
    writeJob(spoolDir, "fffff2", { log: "running\n" });
    const rows = listTasks(state);
    expect(rows.find((r) => r.jobId === "fffff1")?.unread).toBe(true);
    expect(rows.find((r) => r.jobId === "fffff2")?.unread).toBeFalsy();
  });
});

describe("latch follow-ups (headless)", () => {
  const snap = (spoolDir: string, jobId: string, command: string) => ({
    jobId,
    windowId: "@1",
    command,
    status: "completed",
    logFile: join(spoolDir, "jobs", `${jobId}.exit.out`),
    exitFile: join(spoolDir, "jobs", `${jobId}.exit`),
    startedAt: Date.now(),
    spoolDir,
  });

  const bgRow = (spoolDir: string, jobId: string) => ({
    jobId,
    session: "pi-bg-own-1",
    windowId: "@1",
    runId: jobId,
    outputFile: join(spoolDir, "jobs", `${jobId}.exit.out`),
    command: `cmd-${jobId}`,
    startedAt: Date.now(),
    viaTimeoutDetach: false,
    backgrounded: true,
    engine: { spoolDir },
  });

  it("mixed batches message only live jobs; suppressed jobs tear down silently", async () => {
    const { deliverCompletions } = await import("../src/engine/wiring");
    const root = freshRoot();
    const { state } = ownSession(root, "own-1");
    const spoolDir = join(root, "own-1");
    state.engine!.runner = { tmux: () => "" };
    const sent: { message: { content: string }; opts: unknown }[] = [];
    const pi = {
      sendMessage: vi.fn((message: { content: string }, opts: unknown) => void sent.push({ message, opts })),
    } as unknown as ExtensionAPI;
    for (const id of ["mix001", "mix002", "mix003"]) {
      state.backgroundJobs.set(id, bgRow(spoolDir, id));
      writeJob(spoolDir, id, { exitCode: 0, log: `out-${id}\n` });
    }
    deliverCompletions(pi, state, options(root), [
      { job: snap(spoolDir, "mix001", "cmd-mix001"), exitCode: 0, logTail: "out-mix001\n", suppressed: true },
      { job: snap(spoolDir, "mix002", "cmd-mix002"), exitCode: 0, logTail: "out-mix002\n" },
      { job: snap(spoolDir, "mix003", "cmd-mix003"), exitCode: 1, logTail: "out-mix003\n" },
    ]);
    expect(sent).toHaveLength(1);
    expect(sent[0].message.content).not.toContain("mix001");
    expect(sent[0].message.content).toContain("mix002");
    expect(sent[0].message.content).toContain("mix003");
    // Batch of two live jobs stays on the follow-up turn.
    expect(sent[0].opts).toEqual({ triggerTurn: true, deliverAs: "followUp" });
    for (const id of ["mix001", "mix002", "mix003"]) {
      expect(state.backgroundJobs.has(id)).toBe(false);
    }
  });

  it("adopted jobs finishing after adopt latch the adopted journal", () => {
    const root = freshRoot();
    const { state } = ownSession(root, "own-1");
    state.engine!.runner = { tmux: () => "pane-text\n" };
    const foreign = join(root, "foreign-2");
    writeSession(foreign, "foreign-2");
    writeOwner(foreign, "dead");
    // Running at adopt time (adopt delivers only already-finished rows).
    writeJob(foreign, "eeeeee", { log: "adopted-output\n" });
    const { pi } = mockPi();
    expect(adoptOrphanDir(pi, state, options(root), foreign).adopted).toBe(true);
    // Takeover bumps the dir epoch (stalled ex-owners see the move and stop).
    const adoptedRecord = JSON.parse(readFileSync(join(foreign, "session.json"), "utf8")) as SessionRecord;
    expect(adoptedRecord.epoch).toBe(1);
    expect(state.engine?.adopted?.get(foreign)?.session.epoch).toBe(1);
    // Finishes after adoption: peek latches the ADOPTED journal.
    writeFileSync(join(foreign, "jobs", "eeeeee.exit"), "0\n");
    expect(peekTask(state, "eeeeee", 10)).toContain("log_path:");
    const adopted = JSON.parse(readFileSync(join(foreign, "jobs", "eeeeee.json"), "utf8")) as JobRecord;
    expect(adopted.seen).toBe(true);
    // No such job in the owned journal.
    expect(existsSync(join(root, "own-1", "jobs", "eeeeee.json"))).toBe(false);
  });

  it("manual kills leave no timeout marker", () => {
    const root = freshRoot();
    const { state } = ownSession(root, "own-1");
    state.engine!.runner = { tmux: () => "" };
    const spoolDir = join(root, "own-1");
    writeJob(spoolDir, "ggggg1", { log: "running\n" });
    expect(killTask(state, options(root), "ggggg1")).toBe(true);
    expect(readFileSync(join(spoolDir, "jobs", "ggggg1.exit.out"), "utf8")).not.toContain("timed out");
  });

  it("unknown ids never touch tmux", () => {
    const root = freshRoot();
    const { state } = ownSession(root, "own-1");
    const calls: unknown[][] = [];
    state.engine!.runner = {
      tmux: (...args: unknown[]) => (calls.push(args), ""),
    };
    expect(killTask(state, options(root), "zzzzzz")).toBe(false);
    expect(peekTask(state, "zzzzzz", 10)).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("deliverStall sends a steer warning with remediation", async () => {
    const { deliverStall } = await import("../src/engine/wiring");
    const root = freshRoot();
    const { state } = ownSession(root, "own-1");
    const sent: { message: { customType: string; content: string }; opts: unknown }[] = [];
    const pi = {
      sendMessage: vi.fn((message: { customType: string; content: string }, opts: unknown) => void sent.push({ message, opts })),
    } as unknown as ExtensionAPI;
    deliverStall(pi, state, options(root), snap(join(root, "own-1"), "hhhhh1", "cmd-hhhhh1"), "Continue? (y/n) ");
    expect(sent).toHaveLength(1);
    expect(sent[0].message.customType).toBe("tmux-bash-stall");
    expect(sent[0].message.content).toContain("hhhhh1");
    expect(sent[0].message.content).toContain("log_path:");
    expect(sent[0].message.content).toContain("non-interactive");
    expect(sent[0].opts).toEqual({ triggerTurn: true, deliverAs: "steer" });
  });

  it("list text marks unread rows", async () => {
    const { executeTool } = await import("../src/runtime");
    const root = freshRoot();
    const { state } = ownSession(root, "own-1");
    const spoolDir = join(root, "own-1");
    writeJob(spoolDir, "iiiii1", { exitCode: 0, log: "done\n" });
    writeJob(spoolDir, "iiiii2", { log: "running\n" });
    const ctx = { hasUI: false } as unknown as Parameters<typeof executeTool>[1];
    const pi = { sendMessage: vi.fn() } as unknown as ExtensionAPI;
    const result = executeTool({ action: "list" }, ctx, state, pi, options(root)) as { content: { text: string }[] };
    const text = result.content.map((c) => c.text).join("\n");
    expect(text).toContain("iiiii1");
    expect(text).toMatch(/iiiii1.*unread/);
    expect(text).not.toMatch(/iiiii2.*unread/);
  });
});

describe("janitor (headless)", () => {
  it("janitorStart runs adopt/reap/prune/sweep/drain without a live engine failure; janitorStop tears down", async () => {
    const { janitorStart, janitorStop } = await import("../src/engine/janitor");
    const root = freshRoot();
    const { state } = ownSession(root, "own-1");
    const { pi } = mockPi();
    const opts = options(root);
    // Must not throw with no adopted dirs and empty/default tmux server.
    janitorStart(pi, state, opts);
    expect(state.engine).not.toBeNull();
    janitorStop(state, false);
    expect(state.engine).toBeNull();
    // Idempotent: stopping twice is safe.
    janitorStop(state, false);
    expect(state.engine).toBeNull();
  });
});
