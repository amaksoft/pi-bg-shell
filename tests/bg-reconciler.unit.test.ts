import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ensureSession, type Runner, type Session } from "../src/engine/session";
import {
  clearAllForegroundClaims,
  clearForegroundClaim,
  setForegroundClaim,
  spawnJob,
} from "../src/engine/jobs";
import {
  Reconciler,
  type CompletionItem,
  type JobSnapshot,
} from "../src/engine/reconciler";
import { jobJsonPath } from "../src/engine/naming";
import { atomicWriteJson, readJsonFile, type JobRecord } from "../src/engine/sidecar";

const hasTmux = (): boolean => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const LIVE_TMUX = hasTmux();
const freshRoot = (): string => mkdtempSync(join(tmpdir(), "bg-recon-"));

const direct: Runner = {
  tmux: (socket: string, args: string[]) =>
    execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf-8" }),
};

const ensure = (piId: string): Session =>
  ensureSession({
    piId,
    spoolRoot: freshRoot(),
    shutdownPolicy: "stop-all",
    staleAfterMs: 300000,
    runner: direct,
  });

const spawnParams = (session: Session, command: string) => ({
  session,
  runner: direct,
  tmuxBinary: "tmux",
  command,
  cwd: tmpdir(),
  envDenylist: [] as readonly string[],
  windowName: "bg-test",
});

describe("engine reconciler (live)", () => {
  it.skipIf(!LIVE_TMUX)("delivers each completion exactly once across ticks", async () => {
    const session = ensure(`bg-recon-${process.pid}-1`);
    const completions: { jobId: string; exitCode: number }[] = [];
    const polls: { jobId: string; text: string }[] = [];
    const recon = new Reconciler(
      session,
      {
        onCompletions: (items: CompletionItem[]) => {
          for (const item of items) completions.push({ jobId: item.job.jobId, exitCode: item.exitCode });
        },
        onPoll: (job: JobSnapshot, text: string) => {
          polls.push({ jobId: job.jobId, text });
        },
      },
      { tickMs: 50, minimumPollIntervalSeconds: 0, completionTailBytes: 8000 },
    );
    try {
      const job = spawnJob(spawnParams(session, "echo interim; sleep 1; echo done; exit 5"));
      // Poll while running: interim output fans out, completion pending.
      await new Promise((r) => setTimeout(r, 700));
      recon.tick();
      expect(completions).toEqual([]);
      // Wait for exit, tick twice: exactly one completion.
      await new Promise((r) => setTimeout(r, 1500));
      recon.tick();
      recon.tick();
      recon.tick();
      expect(completions).toEqual([{ jobId: job.jobId, exitCode: 5 }]);
      void polls; // interim polls are timing-dependent; completion is the contract
    } finally {
      recon.stop();
      direct.tmux(session.socketName, ["kill-server"]);
    }
  }, 30000);

  it.skipIf(!LIVE_TMUX)("foreground claim blocks the tick; stale claim is stolen", async () => {
    const session = ensure(`bg-recon-${process.pid}-2`);
    const completions: string[] = [];
    const recon = new Reconciler(
      session,
      {
        onCompletions: (items: CompletionItem[]) => {
          for (const item of items) completions.push(item.job.jobId);
        },
        onPoll: () => {},
      },
      { tickMs: 50, minimumPollIntervalSeconds: 60, completionTailBytes: 8000 },
    );
    try {
      const job = spawnJob(spawnParams(session, "exit 9"));
      await new Promise((r) => setTimeout(r, 800));
      // Live claim: tick must skip.
      expect(setForegroundClaim(session.spoolDir, job.jobId)).toBe(true);
      recon.tick();
      expect(completions).toEqual([]);
      // Demote: tick delivers.
      clearForegroundClaim(session.spoolDir, job.jobId);
      recon.tick();
      expect(completions).toEqual([job.jobId]);

      // Stale claim (waiter died without demoting): tick steals and delivers.
      const job2 = spawnJob(spawnParams(session, "exit 11"));
      await new Promise((r) => setTimeout(r, 800));
      setForegroundClaim(session.spoolDir, job2.jobId);
      const rec = readJsonFile<JobRecord>(jobJsonPath(session.spoolDir, job2.jobId))!;
      const { atomicWriteJson } = await import("../src/engine/sidecar");
      rec.claimHeartbeatAt = new Date(Date.now() - 3600000).toISOString();
      atomicWriteJson(jobJsonPath(session.spoolDir, job2.jobId), rec);
      recon.tick();
      expect(completions).toEqual([job.jobId, job2.jobId]);
    } finally {
      recon.stop();
      direct.tmux(session.socketName, ["kill-server"]);
    }
  }, 30000);

  it.skipIf(!LIVE_TMUX)("torn exit file defers without delivery", async () => {
    const session = ensure(`bg-recon-${process.pid}-3`);
    const completions: string[] = [];
    const recon = new Reconciler(
      session,
      {
        onCompletions: (items: CompletionItem[]) => {
          for (const item of items) completions.push(item.job.jobId);
        },
        onPoll: () => {},
      },
      { tickMs: 50, minimumPollIntervalSeconds: 60, completionTailBytes: 8000 },
    );
    try {
      const job = spawnJob(spawnParams(session, "sleep 30"));
      try {
        writeFileSync(job.exitFile, "to");
        recon.tick();
        expect(completions).toEqual([]);
        expect(
          readJsonFile<JobRecord>(jobJsonPath(session.spoolDir, job.jobId))!.status,
        ).toBe("running");
      } finally {
        const { killGuarded } = await import("../src/engine/jobs");
        killGuarded(session, direct, job, 300000);
      }
    } finally {
      recon.stop();
      direct.tmux(session.socketName, ["kill-server"]);
    }
  }, 30000);

  it.skipIf(!LIVE_TMUX)("coalesces simultaneous completions into one callback", async () => {
    const session = ensure(`bg-recon-${process.pid}-5`);
    const batches: { jobId: string; exitCode: number }[][] = [];
    const recon = new Reconciler(
      session,
      {
        onCompletions: (items: CompletionItem[]) => {
          batches.push(items.map((item) => ({ jobId: item.job.jobId, exitCode: item.exitCode })));
        },
        onPoll: () => {},
      },
      { tickMs: 50, minimumPollIntervalSeconds: 60, completionTailBytes: 8000 },
    );
    try {
      const ids = [0, 1, 2].map(() => spawnJob(spawnParams(session, "exit 0")).jobId);
      // All three finish before the first tick: one batch, all ids.
      await new Promise((r) => setTimeout(r, 1200));
      recon.tick();
      expect(batches).toHaveLength(1);
      expect(batches[0].map((b) => b.jobId).sort()).toEqual([...ids].sort());
      expect(batches[0].every((b) => b.exitCode === 0)).toBe(true);
      recon.tick();
      expect(batches).toHaveLength(1); // exactly once
    } finally {
      recon.stop();
      direct.tmux(session.socketName, ["kill-server"]);
    }
  }, 30000);

  it("holds delivery while peers run, then merges stragglers", async () => {
    const root = freshRoot();
    const spoolDir = join(root, "pi-coal");
    mkdirSync(join(spoolDir, "jobs"), { recursive: true });
    mkdirSync(join(spoolDir, "session.lock"), { recursive: true });
    const writeJob = (jobId: string, exitCode?: number): void => {
      const exitFile = join(spoolDir, "jobs", `${jobId}.exit`);
      writeFileSync(`${exitFile}.out`, `log-${jobId}\n`);
      if (exitCode !== undefined) writeFileSync(exitFile, `${exitCode}\n`);
      atomicWriteJson(join(spoolDir, "jobs", `${jobId}.json`), {
        jobId,
        windowId: "@1",
        command: `cmd-${jobId}`,
        startedAt: Date.now(),
        spoolLog: `${exitFile}.out`,
        exitFile,
        foregroundClaim: false,
        status: "running",
        seen: false,
      });
    };
    writeJob("aaaaaa", 0);
    writeJob("bbbbbb"); // still running: forces the hold
    const batches: string[][] = [];
    const recon = new Reconciler(
      { spoolDir } as Session,
      {
        onCompletions: (items: CompletionItem[]) => void batches.push(items.map((i) => i.job.jobId)),
        onPoll: () => {},
      },
      { tickMs: 50, minimumPollIntervalSeconds: 60, completionTailBytes: 8000, completionCoalesceMs: 120 },
    );
    try {
      recon.tick();
      expect(batches).toEqual([]); // held: a peer is still running
      // Straggler lands mid-window; the next interval tick merges it.
      writeJob("cccccc", 0);
      recon.tick();
      expect(batches).toEqual([]); // still holding
      await new Promise((r) => setTimeout(r, 300));
      expect(batches).toHaveLength(1);
      expect([...batches[0]].sort()).toEqual(["aaaaaa", "cccccc"]);
      recon.tick();
      expect(batches).toHaveLength(1); // exactly once
    } finally {
      recon.stop();
    }
  });

  it("delivers immediately when nothing else is pending", () => {
    const root = freshRoot();
    const spoolDir = join(root, "pi-coal-1");
    mkdirSync(join(spoolDir, "jobs"), { recursive: true });
    mkdirSync(join(spoolDir, "session.lock"), { recursive: true });
    const exitFile = join(spoolDir, "jobs", "dddddd.exit");
    writeFileSync(`${exitFile}.out`, "log\n");
    writeFileSync(exitFile, "0\n");
    atomicWriteJson(join(spoolDir, "jobs", "dddddd.json"), {
      jobId: "dddddd", windowId: "@1", command: "cmd", startedAt: Date.now(),
      spoolLog: `${exitFile}.out`, exitFile,
      foregroundClaim: false, status: "running", seen: false,
    });
    const batches: string[][] = [];
    const recon = new Reconciler(
      { spoolDir } as Session,
      {
        onCompletions: (items: CompletionItem[]) => void batches.push(items.map((i) => i.job.jobId)),
        onPoll: () => {},
      },
      { tickMs: 50, minimumPollIntervalSeconds: 60, completionTailBytes: 8000, completionCoalesceMs: 60000 },
    );
    try {
      recon.tick(); // last job: no hold despite the 60s window
      expect(batches).toEqual([["dddddd"]]);
    } finally {
      recon.stop();
    }
  });

  it("redelivers from memory when delivery throws (no rollback)", async () => {
    const root = freshRoot();
    const spoolDir = join(root, "pi-rb");
    mkdirSync(join(spoolDir, "jobs"), { recursive: true });
    mkdirSync(join(spoolDir, "session.lock"), { recursive: true });
    const exitFile = join(spoolDir, "jobs", "ffffff.exit");
    writeFileSync(`${exitFile}.out`, "log\n");
    writeFileSync(exitFile, "0\n");
    atomicWriteJson(join(spoolDir, "jobs", "ffffff.json"), {
      jobId: "ffffff", windowId: "@1", command: "cmd", startedAt: Date.now(),
      spoolLog: `${exitFile}.out`, exitFile,
      foregroundClaim: false, status: "running", seen: false,
    });
    const batches: string[][] = [];
    let failDelivery = true;
    const recon = new Reconciler(
      { spoolDir } as Session,
      {
        onCompletions: (items: CompletionItem[]) => {
          if (failDelivery) throw new Error("sendMessage down");
          batches.push(items.map((i) => i.job.jobId));
        },
        onPoll: () => {},
      },
      { tickMs: 50, minimumPollIntervalSeconds: 60, completionTailBytes: 8000, completionCoalesceMs: 0 },
    );
    try {
      recon.tick(); // consumes, throws, queues for redelivery
      expect(batches).toEqual([]);
      // Consume stands: done, exit stays consumed-side.
      expect(existsSync(exitFile)).toBe(false);
      expect(readJsonFile<JobRecord>(jobJsonPath(spoolDir, "ffffff"))!.status).toBe("completed");
      failDelivery = false;
      recon.tick(); // redelivers exactly once from memory
      expect(batches).toEqual([["ffffff"]]);
      recon.tick();
      expect(batches).toHaveLength(1);
    } finally {
      recon.stop();
    }
  });

  it("finalizes phantom jobs (crashed before any window existed)", () => {
    const root = freshRoot();
    const spoolDir = join(root, "pi-phantom");
    mkdirSync(join(spoolDir, "jobs"), { recursive: true });
    mkdirSync(join(spoolDir, "session.lock"), { recursive: true });
    atomicWriteJson(join(spoolDir, "jobs", "eeeeee.json"), {
      jobId: "eeeeee", windowId: "", command: "cmd", startedAt: Date.now(),
      spoolLog: join(spoolDir, "jobs", "eeeeee.exit.out"),
      exitFile: join(spoolDir, "jobs", "eeeeee.exit"),
      foregroundClaim: false, status: "running", seen: false,
    });
    const batches: string[][] = [];
    const recon = new Reconciler(
      { spoolDir } as Session,
      {
        onCompletions: (items: CompletionItem[]) => void batches.push(items.map((i) => i.job.jobId)),
        onPoll: () => {},
      },
      { tickMs: 50, minimumPollIntervalSeconds: 60, completionTailBytes: 8000 },
    );
    try {
      recon.tick();
      expect(batches).toEqual([]); // never ran: nothing to deliver
      const record = readJsonFile<JobRecord>(jobJsonPath(spoolDir, "eeeeee"))!;
      expect(record.status).toBe("killed");
    } finally {
      recon.stop();
    }
  });

  it("kick flushes held items immediately", async () => {
    const root = freshRoot();
    const spoolDir = join(root, "pi-coal-2");
    mkdirSync(join(spoolDir, "jobs"), { recursive: true });
    mkdirSync(join(spoolDir, "session.lock"), { recursive: true });
    const exitFile = join(spoolDir, "jobs", "eeeeee.exit");
    writeFileSync(`${exitFile}.out`, "log\n");
    writeFileSync(exitFile, "0\n");
    const pending = (jobId: string, exit?: number): void => {
      const ef = join(spoolDir, "jobs", `${jobId}.exit`);
      writeFileSync(`${ef}.out`, "log\n");
      if (exit !== undefined) writeFileSync(ef, `${exit}\n`);
      atomicWriteJson(join(spoolDir, "jobs", `${jobId}.json`), {
        jobId, windowId: "@1", command: "cmd", startedAt: Date.now(),
        spoolLog: `${ef}.out`, exitFile: ef,
        foregroundClaim: false, status: "running", seen: false,
      });
    };
    pending("eeeeee", 0);
    pending("ffffff"); // peer forces the hold
    const batches: string[][] = [];
    const recon = new Reconciler(
      { spoolDir } as Session,
      {
        onCompletions: (items: CompletionItem[]) => void batches.push(items.map((i) => i.job.jobId)),
        onPoll: () => {},
      },
      { tickMs: 50, minimumPollIntervalSeconds: 60, completionTailBytes: 8000, completionCoalesceMs: 60000 },
    );
    try {
      recon.tick();
      expect(batches).toEqual([]);
      recon.kick(); // user active: no waiting
      expect(batches).toEqual([["eeeeee"]]);
    } finally {
      recon.stop();
    }
  });

  it.skipIf(!LIVE_TMUX)("clearAllForegroundClaims resets crashed waiters", async () => {
    const session = ensure(`bg-recon-${process.pid}-4`);
    try {
      const job = spawnJob(spawnParams(session, "sleep 30"));
      try {
        setForegroundClaim(session.spoolDir, job.jobId);
        expect(clearAllForegroundClaims(session.spoolDir)).toBe(1);
        expect(clearAllForegroundClaims(session.spoolDir)).toBe(0);
      } finally {
        const { killGuarded } = await import("../src/engine/jobs");
        killGuarded(session, direct, job, 300000);
      }
    } finally {
      direct.tmux(session.socketName, ["kill-server"]);
    }
  }, 30000);
});

describe("stall detection (headless)", () => {
  const fakeSession = (root: string): Session => {
    const spoolDir = join(root, "spool");
    mkdirSync(join(spoolDir, "jobs"), { recursive: true });
    return {
      piId: "stall-1",
      spoolDir,
      sessionName: "pi-bg-stall-1",
      socketName: "pi-bg-sock-stall-1",
      sessionGuid: "guid-stall-1",
      ownerNonce: "nonce-stall-1",
      epoch: 0,
    };
  };

  const writeRunningJob = (session: Session, jobId: string, log: string): void => {
    const logFile = join(session.spoolDir, `${jobId}.out`);
    writeFileSync(logFile, log);
    const exitFile = join(session.spoolDir, "jobs", `${jobId}.exit`);
    atomicWriteJson(join(session.spoolDir, "jobs", `${jobId}.json`), {
      jobId,
      windowId: "@1",
      command: "sleep 60",
      startedAt: Date.now(),
      spoolLog: logFile,
      exitFile,
      foregroundClaim: false,
      status: "running",
      seen: false,
    });
  };

  const track = () => {
    const stalled: { jobId: string; tail: string }[] = [];
    const completed: string[] = [];
    return {
      stalled,
      callbacks: {
        onCompletions: (items: CompletionItem[]) => {
          for (const item of items) completed.push(item.job.jobId);
        },
        onPoll: () => {},
        onStall: (job: JobSnapshot, tail: string) => void stalled.push({ jobId: job.jobId, tail }),
      },
      completed,
    };
  };

  const opts = { tickMs: 50, minimumPollIntervalSeconds: 3600, completionTailBytes: 8000, stallPromptThresholdMs: 1000 };

  it("warns once on a static prompt tail, never latches or consumes", () => {
    vi.useFakeTimers();
    try {
      const root = freshRoot();
      const session = fakeSession(root);
      writeRunningJob(session, "aa0001", "working...\nContinue? (y/n) ");
      const { stalled, callbacks, completed } = track();
      const recon = new Reconciler(session, callbacks, opts);
      recon.tick(); // tracks size
      expect(stalled).toEqual([]);
      vi.advanceTimersByTime(2000);
      recon.tick(); // static past threshold + prompt tail -> warn
      expect(stalled).toHaveLength(1);
      expect(stalled[0].jobId).toBe("aa0001");
      expect(stalled[0].tail).toContain("Continue?");
      recon.tick(); // same size -> no second warning
      expect(stalled).toHaveLength(1);
      expect(completed).toEqual([]);
      // Journal untouched: still running, never latched.
      const record = readJsonFile<JobRecord>(jobJsonPath(session.spoolDir, "aa0001"));
      expect(record?.status).toBe("running");
      expect(record?.seen).toBeFalsy();
      recon.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays silent on growing logs, plain tails, and disabled thresholds", () => {
    vi.useFakeTimers();
    try {
      const root = freshRoot();
      const session = fakeSession(root);
      writeRunningJob(session, "bb0002", "working...\n");
      writeRunningJob(session, "cc0003", "working...\nstill going\n");
      const { stalled, callbacks } = track();
      const recon = new Reconciler(session, callbacks, opts);
      recon.tick();
      vi.advanceTimersByTime(2000);
      // Grow one log: growth resets its clock.
      writeFileSync(join(session.spoolDir, "bb0002.out"), "working...\nmore\n");
      recon.tick();
      expect(stalled).toEqual([]);
      recon.stop();
      // Disabled threshold: never warns even on a prompt tail.
      writeRunningJob(session, "dd0004", "stuck here\nOverwrite? ");
      const t2 = track();
      const recon2 = new Reconciler(session, t2.callbacks, { ...opts, stallPromptThresholdMs: 0 });
      recon2.tick();
      vi.advanceTimersByTime(5000);
      recon2.tick();
      expect(t2.stalled).toEqual([]);
      recon2.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("finished jobs complete instead of stalling", () => {
    const root = freshRoot();
    const session = fakeSession(root);
    writeRunningJob(session, "ee0005", "done?\nContinue? ");
    writeFileSync(join(session.spoolDir, "jobs", "ee0005.exit"), "0\n");
    const { stalled, callbacks, completed } = track();
    const recon = new Reconciler(session, callbacks, opts);
    try {
      recon.tick();
      expect(completed).toEqual(["ee0005"]);
      expect(stalled).toEqual([]);
    } finally {
      recon.stop();
    }
  });
});

describe("rollback (headless)", () => {
  it("redelivers suppressed items from memory when delivery throws", () => {
    const delivered: { jobId: string; suppressed?: boolean }[] = [];
    const root = freshRoot();
    const spoolDir = join(root, "spool");
    mkdirSync(join(spoolDir, "jobs"), { recursive: true });
    const session: Session = {
      piId: "rb-1",
      spoolDir,
      sessionName: "pi-bg-rb-1",
      socketName: "pi-bg-sock-rb-1",
      sessionGuid: "guid-rb-1",
      ownerNonce: "nonce-rb-1",
      epoch: 0,
    };
    const logFile = join(spoolDir, "ff0001.out");
    writeFileSync(logFile, "done\n");
    const exitFile = join(spoolDir, "jobs", "ff0001.exit");
    writeFileSync(exitFile, "0\n");
    atomicWriteJson(join(spoolDir, "jobs", "ff0001.json"), {
      jobId: "ff0001",
      windowId: "@1",
      command: "true",
      startedAt: Date.now(),
      spoolLog: logFile,
      exitFile,
      foregroundClaim: false,
      status: "running",
      seen: true,
    });
    let threw = false;
    const recon = new Reconciler(
      session,
      {
        onCompletions: (items) => {
          for (const item of items) delivered.push({ jobId: item.job.jobId, suppressed: item.suppressed });
          threw = true;
          throw new Error("sendMessage down");
        },
        onPoll: () => {},
      },
      { tickMs: 50, minimumPollIntervalSeconds: 3600, completionTailBytes: 8000 },
    );
    try {
      recon.tick(); // consume (suppressed) -> callback throws -> queued
      expect(threw).toBe(true);
      expect(delivered).toEqual([{ jobId: "ff0001", suppressed: true }]);
      const record = readJsonFile<JobRecord>(jobJsonPath(spoolDir, "ff0001"));
      // No rollback: consume stands, latch intact, exit stays consumed.
      expect(record?.status).toBe("completed");
      expect(record?.seen).toBe(true);
      expect(existsSync(exitFile)).toBe(false);
      expect(existsSync(`${exitFile}.consumed`)).toBe(true);
    } finally {
      recon.stop();
    }
  });
});

describe("shared tick (headless)", () => {
  const fakeSession = (root: string, id: string): Session => {
    const spoolDir = join(root, id);
    mkdirSync(join(spoolDir, "jobs"), { recursive: true });
    return {
      piId: id,
      spoolDir,
      sessionName: `pi-bg-${id}`,
      socketName: `pi-bg-sock-${id}`,
      sessionGuid: `guid-${id}`,
      ownerNonce: `nonce-${id}`,
      epoch: 0,
    };
  };

  const writeDone = (session: Session, jobId: string, code: number): void => {
    const exitFile = join(session.spoolDir, "jobs", `${jobId}.exit`);
    writeFileSync(`${exitFile}.out`, `out-${jobId}\n`);
    writeFileSync(exitFile, `${code}\n`);
    atomicWriteJson(join(session.spoolDir, "jobs", `${jobId}.json`), {
      jobId,
      windowId: "@1",
      command: `cmd-${jobId}`,
      startedAt: Date.now(),
      spoolLog: `${exitFile}.out`,
      exitFile,
      foregroundClaim: false,
      status: "running",
      seen: false,
    });
  };

  const writeRunning = (session: Session, jobId: string, log: string): void => {
    const logFile = join(session.spoolDir, `${jobId}.out`);
    writeFileSync(logFile, log);
    atomicWriteJson(join(session.spoolDir, "jobs", `${jobId}.json`), {
      jobId,
      windowId: "@1",
      command: `cmd-${jobId}`,
      startedAt: Date.now(),
      spoolLog: logFile,
      exitFile: join(session.spoolDir, "jobs", `${jobId}.exit`),
      foregroundClaim: false,
      status: "running",
      seen: false,
    });
  };

  it("one tick delivers from own + watched dirs together", () => {
    const root = freshRoot();
    const primary = fakeSession(root, "own");
    const adopted = fakeSession(root, "foreign");
    writeDone(primary, "aa0001", 0);
    writeDone(adopted, "bb0002", 3);
    const delivered: { jobId: string; exitCode: number }[] = [];
    const recon = new Reconciler(
      primary,
      {
        onCompletions: (items: CompletionItem[]) => {
          for (const item of items) delivered.push({ jobId: item.job.jobId, exitCode: item.exitCode });
        },
        onPoll: () => {},
      },
      { tickMs: 50, minimumPollIntervalSeconds: 3600, completionTailBytes: 8000, completionCoalesceMs: 0 },
    );
    try {
      recon.watch(adopted.spoolDir, adopted, adopted.ownerNonce);
      recon.tick();
      expect(delivered).toEqual([
        { jobId: "aa0001", exitCode: 0 },
        { jobId: "bb0002", exitCode: 3 },
      ]);
      // Snapshots carry their dir (per-dir consume + cleanup downstream).
      recon.tick();
      expect(delivered).toHaveLength(2); // nothing re-peeked
    } finally {
      recon.stop();
    }
  });

  it("unwatch silences a dir (no polls, no retained cursor state)", () => {
    const root = freshRoot();
    const primary = fakeSession(root, "own");
    const adopted = fakeSession(root, "foreign");
    writeRunning(adopted, "cc0003", "hello\n");
    const polls: string[] = [];
    const recon = new Reconciler(
      primary,
      {
        onCompletions: () => {},
        onPoll: (job) => void polls.push(job.jobId),
      },
      { tickMs: 50, minimumPollIntervalSeconds: 0, completionTailBytes: 8000 },
    );
    try {
      recon.watch(adopted.spoolDir, adopted, adopted.ownerNonce);
      recon.tick(); // poll cursor set, poll emitted
      expect(polls).toEqual(["cc0003"]);
      recon.unwatch(adopted.spoolDir);
      writeFileSync(join(adopted.spoolDir, "cc0003.out"), "hello\nmore\n");
      recon.tick(); // unwatched: silent despite growth
      expect(polls).toEqual(["cc0003"]);
    } finally {
      recon.stop();
    }
  });
});

describe("fencing behaviors (headless)", () => {
  const fakeSession = (root: string, id: string): Session => {
    const spoolDir = join(root, id);
    mkdirSync(join(spoolDir, "jobs"), { recursive: true });
    mkdirSync(join(spoolDir, "session.lock"), { recursive: true });
    return {
      piId: id,
      spoolDir,
      sessionName: `pi-bg-${id}`,
      socketName: `pi-bg-sock-${id}`,
      sessionGuid: `guid-${id}`,
      ownerNonce: `nonce-${id}`,
      epoch: 0,
    };
  };

  const writeLock = (session: Session, nonce: string, stale: boolean): void => {
    atomicWriteJson(join(session.spoolDir, "session.lock", "owner.json"), {
      nonce,
      heartbeatAt: new Date().toISOString(),
    });
    writeFileSync(join(session.spoolDir, "session.lock", "heartbeat"), "");
    if (stale) {
      const old = new Date(0);
      utimesSync(join(session.spoolDir, "session.lock", "heartbeat"), old, old);
    }
  };

  const writeDone = (session: Session, jobId: string): void => {
    const exitFile = join(session.spoolDir, "jobs", `${jobId}.exit`);
    writeFileSync(`${exitFile}.out`, "out\n");
    writeFileSync(exitFile, "0\n");
    atomicWriteJson(join(session.spoolDir, "jobs", `${jobId}.json`), {
      jobId,
      windowId: "@1",
      command: "cmd",
      startedAt: Date.now(),
      spoolLog: `${exitFile}.out`,
      exitFile,
      foregroundClaim: false,
      status: "running",
      seen: false,
    });
  };

  const callbacks = (delivered: string[][]) => ({
    onCompletions: (items: CompletionItem[]) => void delivered.push(items.map((i) => i.job.jobId)),
    onPoll: () => {},
  });

  it("same jobId in two dirs delivers twice (dir-keyed hold)", () => {
    const root = freshRoot();
    const primary = fakeSession(root, "own");
    const adopted = fakeSession(root, "foreign");
    writeDone(primary, "aa0001");
    writeDone(adopted, "aa0001");
    const delivered: string[][] = [];
    const recon = new Reconciler(primary, callbacks(delivered), {
      tickMs: 50,
      minimumPollIntervalSeconds: 3600,
      completionTailBytes: 8000,
      completionCoalesceMs: 0,
    });
    try {
      recon.watch(adopted.spoolDir, adopted, adopted.ownerNonce);
      recon.tick();
      expect(delivered).toEqual([["aa0001", "aa0001"]]);
    } finally {
      recon.stop();
    }
  });

  it("heartbeat touch lands on the gating lock file", () => {
    const root = freshRoot();
    const session = fakeSession(root, "hb");
    writeLock(session, session.ownerNonce, true);
    const recon = new Reconciler(
      session,
      { onCompletions: () => {}, onPoll: () => {} },
      { tickMs: 50, minimumPollIntervalSeconds: 3600, completionTailBytes: 8000 },
      session.ownerNonce,
    );
    try {
      recon.tick();
      const age = Date.now() - statSync(join(session.spoolDir, "session.lock", "heartbeat")).mtimeMs;
      expect(age).toBeLessThan(60000);
    } finally {
      recon.stop();
    }
  });

  it("tick stops watching a dir whose epoch moved (takeover loss)", () => {
    const root = freshRoot();
    const primary = fakeSession(root, "own");
    const adopted = fakeSession(root, "foreign");
    writeDone(adopted, "bb0002");
    const delivered: string[][] = [];
    const recon = new Reconciler(primary, callbacks(delivered), {
      tickMs: 50,
      minimumPollIntervalSeconds: 3600,
      completionTailBytes: 8000,
      completionCoalesceMs: 0,
    });
    try {
      recon.watch(adopted.spoolDir, adopted, adopted.ownerNonce);
      // Simulate takeover elsewhere: epoch moves behind our back.
      atomicWriteJson(join(adopted.spoolDir, "session.json"), {
        piId: adopted.piId,
        sessionName: adopted.sessionName,
        sessionGuid: adopted.sessionGuid,
        tmuxServer: `-L ${adopted.socketName}`,
        shutdownPolicy: "stop-all",
        version: 1,
        createdAt: new Date().toISOString(),
        ownerNonce: "someone-else",
        state: "active",
        epoch: 7,
      });
      recon.tick();
      // Unwatched on epoch move: nothing consumed, nothing delivered.
      expect(delivered).toEqual([]);
      expect(existsSync(join(adopted.spoolDir, "jobs", "bb0002.exit"))).toBe(true);
    } finally {
      recon.stop();
    }
  });
});

describe("slow tick (headless)", () => {
  it("fires at most once per window, disabled at 0, never throws", () => {
    vi.useFakeTimers();
    try {
      const root = freshRoot();
      const spoolDir = join(root, "spool");
      mkdirSync(join(spoolDir, "jobs"), { recursive: true });
      const session = {
        piId: "slow-1",
        spoolDir,
        sessionName: "pi-bg-slow-1",
        socketName: "pi-bg-sock-slow-1",
        sessionGuid: "guid-slow-1",
        ownerNonce: "nonce-slow-1",
        epoch: 0,
      } as Session;
      let calls = 0;
      const recon = new Reconciler(
        session,
        {
          onCompletions: () => {},
          onPoll: () => {},
          onStall: () => {},
          onSlowTick: () => void (calls += 1),
        },
        { tickMs: 50, minimumPollIntervalSeconds: 3600, completionTailBytes: 8000, slowTickMs: 1000 },
      );
      try {
        recon.tick(); // first tick fires (no prior stamp)
        expect(calls).toBe(1);
        recon.tick(); // same window: silent
        expect(calls).toBe(1);
        vi.advanceTimersByTime(1500);
        recon.tick(); // next window: fires once
        expect(calls).toBe(2);
      } finally {
        recon.stop();
      }
      // Disabled config never fires.
      let disabledCalls = 0;
      const recon2 = new Reconciler(
        session,
        {
          onCompletions: () => {},
          onPoll: () => {},
          onSlowTick: () => void (disabledCalls += 1),
        },
        { tickMs: 50, minimumPollIntervalSeconds: 3600, completionTailBytes: 8000 },
      );
      try {
        vi.advanceTimersByTime(600000);
        recon2.tick();
        expect(disabledCalls).toBe(0);
      } finally {
        recon2.stop();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
