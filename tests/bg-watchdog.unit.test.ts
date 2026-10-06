import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { acquireOwnerLock } from "../src/engine/owner-lock";
import { defaultReaperProbes, pruneSpool, runReaper, type ReaperProbes } from "../src/engine/reaper";
import type { Runner, Session } from "../src/engine/session";
import { Reconciler } from "../src/engine/reconciler";
import { atomicWriteJson, type SessionRecord } from "../src/engine/sidecar";
import { tmuxSocketDir } from "../src/engine/naming";

const hasTmux = (): boolean => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const LIVE_TMUX = hasTmux();
const freshRoot = (): string => mkdtempSync(join(tmpdir(), "bg-wd-"));

// Socket isolation: every tmux server in this file lives under a temp
// TMUX_TMPDIR, so interrupted runs can never leak wd-* files into the real
// socket dir. Per-call env (never global mutation) keeps parallel files safe.
const ISO_TMUX_DIR = mkdtempSync(join(tmpdir(), "bg-tmux-iso-"));
const isoEnv = () => ({ ...process.env, TMUX_TMPDIR: ISO_TMUX_DIR });
const tmuxIso = (args: string[], opts?: { stdio?: "ignore" }) =>
  execFileSync("tmux", args, { encoding: "utf-8", ...opts, env: isoEnv() });

afterAll(() => {
  try {
    rmSync(ISO_TMUX_DIR, { recursive: true, force: true });
  } catch {
    // Best effort.
  }
});

// Effective socket dir: tmux appends a per-UID `tmux-<uid>` segment under
// TMUX_TMPDIR (same rule as src/engine/naming.ts tmuxSocketDir). Resolved by
// scanning so tests never duplicate that rule.
const isoSockDir = (): string => {
  for (const entry of readdirSync(ISO_TMUX_DIR, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith("tmux-")) return join(ISO_TMUX_DIR, entry.name);
  }
  return ISO_TMUX_DIR;
};
const isoSockPath = (sock: string): string => join(isoSockDir(), sock);

const direct: Runner = {
  tmux: (socket: string, args: string[]) =>
    execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf-8" }),
};

/** Headless engine spool dir with a controllable owner record. */
const fakeSpoolDir = (
  root: string,
  piId: string,
  opts: { shutdownPolicy?: string; owner?: "live" | "dead" | "none"; guid?: string },
): string => {
  const dir = join(root, piId);
  mkdirSync(join(dir, "jobs"), { recursive: true });
  mkdirSync(join(dir, "session.lock"), { recursive: true });
  const guid = opts.guid ?? `guid-${piId}`;
  const record: SessionRecord = {
    piId,
    sessionName: `pi-bg-${piId}`,
    sessionGuid: guid,
    tmuxServer: `-L pi-bg-sock-${piId}`,
    shutdownPolicy: opts.shutdownPolicy ?? "stop-all",
    version: 1,
    createdAt: new Date().toISOString(),
    ownerNonce: `nonce-${piId}`,
    state: "active",
  };
  atomicWriteJson(join(dir, "session.json"), record);
  if (opts.owner === "live") {
    acquireOwnerLock(join(dir, "session.lock"), 300000);
  } else if (opts.owner === "dead") {
    atomicWriteJson(join(dir, "session.lock", "owner.json"), {
      pid: 1 << 24,
      processStartTimeMs: 1,
      nonce: `dead-${piId}`,
      heartbeatAt: new Date(0).toISOString(),
    });
    writeFileSync(join(dir, "session.lock", "heartbeat"), "");
    writeFileSync(join(dir, "heartbeat"), "");
    const old = new Date(0);
    utimesSync(join(dir, "session.lock", "heartbeat"), old, old);
    utimesSync(join(dir, "heartbeat"), old, old);
  }
  return dir;
};

const fakeProbes = (live: Map<string, { sessions: string[]; guids: Map<string, string> }>): ReaperProbes & { killed: string[] } => {
  const killed: string[] = [];
  return {
    killed,
    listSockets: () => [...live.keys()],
    listSessions: (socket: string) => live.get(socket)?.sessions ?? [],
    sessionGuid: (socket: string, session: string) => live.get(socket)?.guids.get(session),
    killServer: (socket: string) => {
      killed.push(socket);
      live.delete(socket);
    },
  };
};

describe("engine reaper (headless)", () => {
  it("reaps dead non-leave-running sessions with tombstones, spares the rest", () => {
    const root = freshRoot();
    const dead = fakeSpoolDir(root, "dead-1", { owner: "dead" });
    const live = fakeSpoolDir(root, "live-1", { owner: "live" });
    const leave = fakeSpoolDir(root, "leave-1", { owner: "dead", shutdownPolicy: "leave-running" });
    const ghost = fakeSpoolDir(root, "ghost-1", { owner: "dead" });
    mkdirSync(join(root, "not-a-session"));
    writeFileSync(join(root, "not-a-session", "junk.txt"), "x");

    const liveMap = new Map([
      ["pi-bg-sock-dead-1", { sessions: ["pi-bg-dead-1"], guids: new Map([["pi-bg-dead-1", "guid-dead-1"]]) }],
      ["pi-bg-sock-live-1", { sessions: ["pi-bg-live-1"], guids: new Map([["pi-bg-live-1", "guid-live-1"]]) }],
      ["pi-bg-sock-leave-1", { sessions: ["pi-bg-leave-1"], guids: new Map([["pi-bg-leave-1", "guid-leave-1"]]) }],
      // ghost-1: server already gone (crash took the server too).
    ]);
    const probes = fakeProbes(liveMap);
    const result = runReaper(root, 50, probes);

    expect(result.reaped.map((r) => r.spoolDir).sort()).toEqual([dead, ghost].sort());
    expect(probes.killed).toEqual(["pi-bg-sock-dead-1"]); // ghost needed no kill
    expect(result.skippedLive).toEqual([live]);
    expect(result.skippedLeaveRunning).toEqual([leave]);
    expect(result.errors).toEqual([]);
    // Tombstones written for both reaped dirs.
    for (const dir of [dead, ghost]) {
      const death = JSON.parse(readFileSync(join(dir, "death.json"), "utf8"));
      expect(death.reason).toBe("reaped");
      expect(death.killedAt).toBeDefined();
    }
    // Live + leave-running dirs untouched.
    expect(existsSync(join(live, "death.json"))).toBe(false);
    expect(existsSync(join(leave, "death.json"))).toBe(false);
  });

  it("refuses GUID-mismatched sessions (recycled/foreign)", () => {
    const root = freshRoot();
    const dir = fakeSpoolDir(root, "recy-1", { owner: "dead" });
    const liveMap = new Map([
      ["pi-bg-sock-recy-1", { sessions: ["pi-bg-recy-1"], guids: new Map([["pi-bg-recy-1", "WRONG-GUID"]]) }],
    ]);
    const probes = fakeProbes(liveMap);
    const result = runReaper(root, 50, probes);
    expect(result.reaped).toEqual([]);
    expect(probes.killed).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toContain("guid mismatch");
    expect(existsSync(join(dir, "death.json"))).toBe(false);
  });
});

describe("engine retention prune", () => {
  it("prunes only old tombstoned dirs, caps size oldest-first", () => {
    const root = freshRoot();
    const oldDeath = join(root, "old-1");
    mkdirSync(oldDeath, { recursive: true });
    writeFileSync(join(oldDeath, "death.json"), "{}");
    const ancient = new Date(Date.now() - 30 * 86400000);
    utimesSync(join(oldDeath, "death.json"), ancient, ancient);
    const freshDeath = join(root, "fresh-1");
    mkdirSync(freshDeath, { recursive: true });
    writeFileSync(join(freshDeath, "death.json"), "{}");
    const live = join(root, "live-1");
    mkdirSync(live, { recursive: true });
    writeFileSync(join(live, "session.json"), "{}");
    utimesSync(join(live, "session.json"), ancient, ancient); // old but NOT tombstoned

    const pruned = pruneSpool(root, 7, 256);
    expect(pruned).toEqual([oldDeath]);
    expect(existsSync(oldDeath)).toBe(false);
    expect(existsSync(freshDeath)).toBe(true);
    expect(existsSync(live)).toBe(true);
  });

  it("caps total size by oldest tombstone first", () => {
    const root = freshRoot();
    for (const [name, ageDays] of [["t1", 6], ["t2", 5]] as [string, number][]) {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "death.json"), "{}");
      writeFileSync(join(dir, "big.out"), "x".repeat(100));
      const t = new Date(Date.now() - ageDays * 86400000);
      utimesSync(join(dir, "death.json"), t, t);
    }
    // maxMb: 0 disables the cap; tiny cap prunes oldest first (t1, 6d).
    expect(pruneSpool(root, 7, 0)).toEqual([]);
    const pruned = pruneSpool(root, 7, 0.0001);
    expect(pruned.length).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(root, "t1"))).toBe(false);
  });
});

describe("engine socket isolation (live)", () => {
  it.skipIf(!LIVE_TMUX)("test servers live under the isolated dir, never the real one", () => {
    const sock = `wd-iso-${process.pid}`;
    try {
      tmuxIso(["-L", sock, "new-session", "-d", "-x", "80", "-y", "24"]);
      expect(existsSync(isoSockPath(sock))).toBe(true);
      expect(existsSync(join(tmuxSocketDir(), sock))).toBe(false);
    } finally {
      try {
        tmuxIso(["-L", sock, "kill-server"], { stdio: "ignore" });
      } catch {
        // Gone already.
      }
      try {
        unlinkSync(isoSockPath(sock));
      } catch {
        // Already gone — fine.
      }
    }
    expect(existsSync(isoSockPath(sock))).toBe(false);
  });
});
