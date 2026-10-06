import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureSession, type Runner, type Session } from "../src/engine/session";
import {
  consumeCompletion,
  killGuarded,
  mintJobId,
  peekJob,
  spawnJob,
  waitJob,
} from "../src/engine/jobs";
import { jobJsonPath } from "../src/engine/naming";
import { atomicWriteJson } from "../src/engine/sidecar";
import { readJsonFile, type JobRecord } from "../src/engine/sidecar";

const hasTmux = (): boolean => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const LIVE_TMUX = hasTmux();
const freshRoot = (): string => mkdtempSync(join(tmpdir(), "bg-jobs-"));

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

describe("engine job ids", () => {
  it("mints 6-hex ids, avoiding taken ones", () => {
    const id = mintJobId();
    expect(id).toMatch(/^[0-9a-f]{6}$/);
    expect(mintJobId((taken) => taken === id)).not.toBe(id);
  });
});

describe("engine execution (live)", () => {
  it.skipIf(!LIVE_TMUX)("runs, waits, consumes exactly once", async () => {
    const session = ensure(`bg-exec-${process.pid}-1`);
    try {
      const job = spawnJob(spawnParams(session, "printf 'hello-bg\\n'; exit 3"));
      const waited = await waitJob(job.exitFile, { timeoutMs: 15000 });
      expect(waited).toEqual({ status: "completed", exitCode: 3 });
      const first = consumeCompletion(session, job.jobId);
      expect(first?.exitCode).toBe(3);
      expect(readFileSync(first!.logFile, "utf8")).toContain("hello-bg");
      // Exactly once: second consume is undefined, journal delivered-local.
      expect(consumeCompletion(session, job.jobId)).toBeUndefined();
      const rec = readJsonFile<JobRecord>(jobJsonPath(session.spoolDir, job.jobId))!;
      expect(rec.status).toBe("completed");
      // Exit code lives in the consumed exit file now, not the journal.
      expect(existsSync(`${job.exitFile}.consumed`)).toBe(true);
    } finally {
      direct.tmux(session.socketName, ["kill-server"]);
    }
  }, 30000);

  it.skipIf(!LIVE_TMUX)("peek shows live output; kill suppresses the trap write", async () => {
    const session = ensure(`bg-exec-${process.pid}-2`);
    try {
      const job = spawnJob(spawnParams(session, "echo peek-target; sleep 60"));
      await new Promise((r) => setTimeout(r, 1500));
      const peeked = peekJob(
        session,
        direct,
        { jobId: job.jobId, windowId: job.windowId, command: "echo peek-target; sleep 60", windowName: "bg-test" },
        30,
      );
      expect(peeked).toContain("$ echo peek-target; sleep 60");
      expect(killGuarded(session, direct, job, 300000)).toBe("killed");
      // Journal-first suppression: already killed, consume stays silent...
      const rec = readJsonFile<JobRecord>(jobJsonPath(session.spoolDir, job.jobId))!;
      expect(rec.status).toBe("killed");
      // ...so even when the EXIT trap lands the exit file, consume stays silent.
      await new Promise((r) => setTimeout(r, 1000));
      expect(consumeCompletion(session, job.jobId)).toBeUndefined();
      expect(killGuarded(session, direct, job, 300000)).toBe("already-gone");
    } finally {
      direct.tmux(session.socketName, ["kill-server"]);
    }
  }, 30000);

  it.skipIf(!LIVE_TMUX)("wait times out on a still-running job", async () => {
    const session = ensure(`bg-exec-${process.pid}-3`);
    try {
      const job = spawnJob(spawnParams(session, "sleep 60"));
      try {
        const waited = await waitJob(job.exitFile, { timeoutMs: 800 });
        expect(waited).toEqual({ status: "timeout" });
        const controller = new AbortController();
        controller.abort();
        expect(await waitJob(job.exitFile, { timeoutMs: 5000, signal: controller.signal })).toEqual({
          status: "aborted",
        });
      } finally {
        killGuarded(session, direct, job, 300000);
      }
    } finally {
      direct.tmux(session.socketName, ["kill-server"]);
    }
  }, 30000);
});

describe("engine consume edge cases (live session, headless files)", () => {
  it.skipIf(!LIVE_TMUX)("torn exit file defers; rename-then-crash recovers", async () => {
    const session = ensure(`bg-exec-${process.pid}-4`);
    try {
      const job = spawnJob(spawnParams(session, "exit 0"));
      // Torn write: consume defers, stays pending.
      writeFileSync(job.exitFile, "par");
      expect(consumeCompletion(session, job.jobId)).toBeUndefined();
      expect(readJsonFile<JobRecord>(jobJsonPath(session.spoolDir, job.jobId))!.status).toBe("running");
      // Crash between rename and journal: exit file already consumed-side,
      // journal still pending -> recovers from .consumed.
      writeFileSync(job.exitFile, "7\n");
      renameSync(job.exitFile, `${job.exitFile}.consumed`);
      const recovered = consumeCompletion(session, job.jobId);
      expect(recovered?.exitCode).toBe(7);
      expect(consumeCompletion(session, job.jobId)).toBeUndefined();
    } finally {
      direct.tmux(session.socketName, ["kill-server"]);
    }
  }, 30000);
});

describe("killGuarded fencing (headless)", () => {
  const fakeSession = (root: string, overrides: Partial<Session> = {}): Session => {
    const spoolDir = join(root, "spool");
    mkdirSync(join(spoolDir, "jobs"), { recursive: true });
    mkdirSync(join(spoolDir, "session.lock"), { recursive: true });
    return {
      piId: "kg-1",
      spoolDir,
      sessionName: "pi-bg-kg-1",
      socketName: "pi-bg-sock-kg-1",
      sessionGuid: "guid-kg-1",
      ownerNonce: "nonce-kg-1",
      epoch: 0,
      ...overrides,
    };
  };

  const writeSessionJson = (session: Session, epoch = 0): void => {
    atomicWriteJson(join(session.spoolDir, "session.json"), {
      piId: session.piId,
      sessionName: session.sessionName,
      sessionGuid: session.sessionGuid,
      tmuxServer: `-L ${session.socketName}`,
      shutdownPolicy: "stop-all",
      version: 1,
      createdAt: new Date().toISOString(),
      ownerNonce: session.ownerNonce,
      state: "active",
      epoch,
    });
  };

  const writeLock = (session: Session, nonce: string, freshHeartbeat: boolean): void => {
    atomicWriteJson(join(session.spoolDir, "session.lock", "owner.json"), {
      pid: process.pid,
      processStartTimeMs: Date.now(),
      nonce,
      heartbeatAt: new Date().toISOString(),
    });
    writeFileSync(join(session.spoolDir, "session.lock", "heartbeat"), "");
    const stamp = freshHeartbeat ? new Date() : new Date(0);
    utimesSync(join(session.spoolDir, "session.lock", "heartbeat"), stamp, stamp);
  };

  const writeJob = (session: Session, jobId: string): void => {
    const exitFile = join(session.spoolDir, "jobs", `${jobId}.exit`);
    writeFileSync(`${exitFile}.out`, "log\n");
    atomicWriteJson(join(session.spoolDir, "jobs", `${jobId}.json`), {
      jobId,
      windowId: "@1",
      command: "sleep 60",
      startedAt: Date.now(),
      spoolLog: `${exitFile}.out`,
      exitFile,
      foregroundClaim: false,
      status: "running",
      seen: false,
    });
  };

  const calls: string[][] = [];
  const runner: Runner = {
    tmux: (socket: string, args: string[]) => (calls.push([socket, ...args]), ""),
  };

  it("refuses a live foreign lock holder without touching tmux or journal", () => {
    const root = freshRoot();
    const session = fakeSession(root);
    writeSessionJson(session);
    writeLock(session, "foreign-nonce", true);
    writeJob(session, "kg0001");
    calls.length = 0;
    expect(killGuarded(session, runner, { jobId: "kg0001", windowId: "@1" }, 300000)).toBe("refused");
    expect(calls).toEqual([]);
    const record = readJsonFile<JobRecord>(jobJsonPath(session.spoolDir, "kg0001"));
    expect(record?.status).toBe("running");
    expect(record?.seen).toBeFalsy();
  });

  it("refuses when the dir epoch moved under the session object", () => {
    const root = freshRoot();
    const session = fakeSession(root);
    writeSessionJson(session, 3);
    writeLock(session, session.ownerNonce, true);
    writeJob(session, "kg0002");
    calls.length = 0;
    expect(killGuarded(session, runner, { jobId: "kg0002", windowId: "@1" }, 300000)).toBe("refused");
    expect(calls).toEqual([]);
  });

  it("refuses on GUID mismatch from the pre-check", () => {
    const root = freshRoot();
    const session = fakeSession(root);
    writeSessionJson(session);
    writeLock(session, session.ownerNonce, true);
    writeJob(session, "kg0003");
    const lying: Runner = {
      tmux: (socket: string, args: string[]) => {
        calls.push([socket, ...args]);
        if (args[0] === "display-message") return "other-guid";
        return "";
      },
    };
    calls.length = 0;
    expect(killGuarded(session, lying, { jobId: "kg0003", windowId: "@1" }, 300000)).toBe("refused");
    expect(calls.some((c) => c.includes("kill-window") || c.includes("if-shell"))).toBe(false);
    const record = readJsonFile<JobRecord>(jobJsonPath(session.spoolDir, "kg0003"));
    expect(record?.status).toBe("running");
  });

  it("proceeds for the lock holder and latches the txn", () => {
    const root = freshRoot();
    const session = fakeSession(root);
    writeSessionJson(session);
    writeLock(session, session.ownerNonce, true);
    writeJob(session, "kg0004");
    calls.length = 0;
    expect(killGuarded(session, runner, { jobId: "kg0004", windowId: "@1" }, 300000)).toBe("killed");
    expect(calls.some((c) => c.includes("if-shell"))).toBe(true);
    const record = readJsonFile<JobRecord>(jobJsonPath(session.spoolDir, "kg0004"));
    expect(record?.status).toBe("killed");
    expect(record?.seen).toBe(true);
  });
});

describe("destroySession fencing (headless)", () => {
  const fakeSession = (root: string): Session => {
    const spoolDir = join(root, "spool");
    mkdirSync(join(spoolDir, "jobs"), { recursive: true });
    mkdirSync(join(spoolDir, "session.lock"), { recursive: true });
    atomicWriteJson(join(spoolDir, "session.lock", "owner.json"), {
      nonce: "nonce-d",
      heartbeatAt: new Date().toISOString(),
    });
    writeFileSync(join(spoolDir, "session.lock", "heartbeat"), "");
    return {
      piId: "dd-1",
      spoolDir,
      sessionName: "pi-bg-dd-1",
      socketName: "pi-bg-sock-dd-1",
      sessionGuid: "guid-dd-1",
      ownerNonce: "nonce-d",
      epoch: 0,
    };
  };

  it("skips kill-server on GUID mismatch but still releases its lock", async () => {
    const { destroySession } = await import("../src/engine/session");
    const root = freshRoot();
    const session = fakeSession(root);
    const calls: string[][] = [];
    const runner: Runner = {
      tmux: (socket: string, args: string[]) => {
        calls.push([socket, ...args]);
        if (args[0] === "display-message") return "foreign-guid";
        return "";
      },
    };
    destroySession(session, runner, false);
    expect(calls.some((c) => c.includes("kill-server"))).toBe(false);
    expect(existsSync(join(session.spoolDir, "session.lock"))).toBe(false);
  });

  it("kills on GUID match", async () => {
    const { destroySession } = await import("../src/engine/session");
    const root = freshRoot();
    const session = fakeSession(root);
    const calls: string[][] = [];
    const runner: Runner = {
      tmux: (socket: string, args: string[]) => {
        calls.push([socket, ...args]);
        if (args[0] === "display-message") return session.sessionGuid;
        return "";
      },
    };
    destroySession(session, runner, false);
    expect(calls.some((c) => c.includes("kill-server"))).toBe(true);
  });
});

describe("killGuarded failure restore (headless)", () => {
  const fakeSession = (root: string): Session => {
    const spoolDir = join(root, "spool");
    mkdirSync(join(spoolDir, "jobs"), { recursive: true });
    mkdirSync(join(spoolDir, "session.lock"), { recursive: true });
    return {
      piId: "kr-1",
      spoolDir,
      sessionName: "pi-bg-kr-1",
      socketName: "pi-bg-sock-kr-1",
      sessionGuid: "guid-kr-1",
      ownerNonce: "nonce-kr-1",
      epoch: 0,
    };
  };

  const writeSessionJson = (session: Session): void => {
    atomicWriteJson(join(session.spoolDir, "session.json"), {
      piId: session.piId,
      sessionName: session.sessionName,
      sessionGuid: session.sessionGuid,
      tmuxServer: `-L ${session.socketName}`,
      shutdownPolicy: "stop-all",
      version: 1,
      createdAt: new Date().toISOString(),
      ownerNonce: session.ownerNonce,
      state: "active",
      epoch: 0,
    });
  };

  const writeJob = (session: Session, jobId: string): void => {
    const exitFile = join(session.spoolDir, "jobs", `${jobId}.exit`);
    writeFileSync(`${exitFile}.out`, "log\n");
    atomicWriteJson(join(session.spoolDir, "jobs", `${jobId}.json`), {
      jobId,
      windowId: "@1",
      command: "sleep 60",
      startedAt: Date.now(),
      spoolLog: `${exitFile}.out`,
      exitFile,
      foregroundClaim: false,
      status: "running",
      seen: false,
    });
  };

  it("restores running+unseen when the kill throws with the window alive", async () => {
    const { killGuarded, markJobNotified } = await import("../src/engine/jobs");
    const root = freshRoot();
    const session = fakeSession(root);
    writeSessionJson(session);
    writeJob(session, "kr0001");
    // Flaky tmux: GUID pre-check passes, if-shell throws EACCES, window alive.
    const runner: Runner = {
      tmux: (socket: string, args: string[]) => {
        if (args[0] === "display-message" && String(args[args.length - 1]).includes("@pi_guid")) {
          return session.sessionGuid;
        }
        if (args[0] === "display-message") return "@1";
        throw new Error("EACCES: permission denied");
      },
    };
    expect(killGuarded(session, runner, { jobId: "kr0001", windowId: "@1" }, 300000)).toBe("refused");
    const record = readJsonFile<JobRecord>(jobJsonPath(session.spoolDir, "kr0001"));
    expect(record?.status).toBe("running");
    expect(record?.seen).toBe(false);
  });

  it("preserves a pre-existing latch across the restore", async () => {
    const { killGuarded, markJobNotified } = await import("../src/engine/jobs");
    const root = freshRoot();
    const session = fakeSession(root);
    writeSessionJson(session);
    writeJob(session, "kr0002");
    markJobNotified(session, "kr0002"); // peeked earlier: already seen
    const runner: Runner = {
      tmux: (socket: string, args: string[]) => {
        if (args[0] === "display-message" && String(args[args.length - 1]).includes("@pi_guid")) {
          return session.sessionGuid;
        }
        if (args[0] === "display-message") return "@1";
        throw new Error("EACCES: permission denied");
      },
    };
    expect(killGuarded(session, runner, { jobId: "kr0002", windowId: "@1" }, 300000)).toBe("refused");
    const record = readJsonFile<JobRecord>(jobJsonPath(session.spoolDir, "kr0002"));
    expect(record?.status).toBe("running");
    expect(record?.seen).toBe(true);
  });
});

describe("killGuarded post-kill verify (headless)", () => {
  const fakeSession = (root: string): Session => {
    const spoolDir = join(root, "spool");
    mkdirSync(join(spoolDir, "jobs"), { recursive: true });
    mkdirSync(join(spoolDir, "session.lock"), { recursive: true });
    return {
      piId: "kv-1",
      spoolDir,
      sessionName: "pi-bg-kv-1",
      socketName: "pi-bg-sock-kv-1",
      sessionGuid: "guid-kv-1",
      ownerNonce: "nonce-kv-1",
      epoch: 0,
    };
  };

  const writeAll = (session: Session, jobId: string): void => {
    atomicWriteJson(join(session.spoolDir, "session.json"), {
      piId: session.piId,
      sessionName: session.sessionName,
      sessionGuid: session.sessionGuid,
      tmuxServer: `-L ${session.socketName}`,
      shutdownPolicy: "stop-all",
      version: 1,
      createdAt: new Date().toISOString(),
      ownerNonce: session.ownerNonce,
      state: "active",
      epoch: 0,
    });
    atomicWriteJson(join(session.spoolDir, "session.lock", "owner.json"), {
      nonce: session.ownerNonce,
      heartbeatAt: new Date().toISOString(),
    });
    writeFileSync(join(session.spoolDir, "session.lock", "heartbeat"), "");
    const exitFile = join(session.spoolDir, "jobs", `${jobId}.exit`);
    writeFileSync(`${exitFile}.out`, "log\n");
    atomicWriteJson(join(session.spoolDir, "jobs", `${jobId}.json`), {
      jobId,
      windowId: "@1",
      command: "sleep 60",
      startedAt: Date.now(),
      spoolLog: `${exitFile}.out`,
      exitFile,
      foregroundClaim: false,
      status: "running",
      seen: false,
    });
  };

  it("refuses + restores when the window survives a successful if-shell (predicate miss)", async () => {
    const { killGuarded } = await import("../src/engine/jobs");
    const root = freshRoot();
    const session = fakeSession(root);
    writeAll(session, "kv0001");
    // if-shell exits 0 but the window is still there (GUID predicate missed).
    const runner: Runner = {
      tmux: (socket: string, args: string[]) => {
        if (args[0] === "display-message" && String(args[args.length - 1]).includes("@pi_guid")) {
          return session.sessionGuid;
        }
        if (args[0] === "display-message") return "@1";
        return "";
      },
    };
    expect(killGuarded(session, runner, { jobId: "kv0001", windowId: "@1" }, 300000)).toBe("refused");
    const record = readJsonFile<JobRecord>(jobJsonPath(session.spoolDir, "kv0001"));
    expect(record?.status).toBe("running");
    expect(record?.seen).toBe(false);
  });
});
