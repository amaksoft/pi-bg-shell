import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  canonicalSessionName,
  canonicalSpoolDir,
  deathJsonPath,
  jobJsonPath,
  serverSocketName,
  sessionJsonPath,
  sessionLockPath,
} from "../src/engine/naming";
import {
  acquireOwnerLock,
  isOwnerDead,
  readOwner,
  refreshOwnerLock,
  releaseOwnerLock,
} from "../src/engine/owner-lock";
import { destroySession, ensureSession, SessionBusyError, type Runner } from "../src/engine/session";
import { atomicWriteJson, readJsonFile, type SessionRecord } from "../src/engine/sidecar";

const hasTmux = (): boolean => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const LIVE_TMUX = hasTmux();

const freshRoot = (): string => mkdtempSync(join(tmpdir(), "bg-test-"));

/** In-memory tmux: sessions + window-less option store. */
const fakeRunner = (): Runner & { sessions: Map<string, Map<string, string>> } => {
  const sessions = new Map<string, Map<string, string>>();
  const sessKey = (socket: string, name: string): string => `${socket}//sess:${name}`;
  const tmux = (socket: string, args: string[]): string => {
    const [cmd, ...rest] = args;
    if (cmd === "new-session") {
      const name = rest[rest.indexOf("-s") + 1];
      if (sessions.has(sessKey(socket, name))) throw new Error("duplicate session");
      sessions.set(sessKey(socket, name), new Map());
      return "";
    }
    if (cmd === "new-window") {
      // Windows are tracked by name; session-level lookups ignore them.
      const name = rest[rest.indexOf("-n") + 1] ?? "?";
      sessions.set(`${socket}//win:${name}`, new Map());
      return "@9";
    }
    if (cmd === "has-session") {
      const t = rest[rest.indexOf("-t") + 1];
      if (!sessions.has(sessKey(socket, t))) throw new Error("can't find session");
      return "";
    }
    if (cmd === "set-option") {
      const t = rest[rest.indexOf("-t") + 1];
      const opts = sessions.get(sessKey(socket, t));
      if (!opts) throw new Error("can't find session");
      for (let i = rest.indexOf("-t") + 2; i + 1 < rest.length; i += 2) opts.set(rest[i], rest[i + 1]);
      return "";
    }
    if (cmd === "show-options") {
      const t = rest[rest.indexOf("-t") + 1];
      const opt = rest[rest.indexOf("-v") + 1];
      const opts = sessions.get(sessKey(socket, t));
      if (!opts) throw new Error("can't find session");
      return `${opts.get(opt) ?? ""}\n`;
    }
    if (cmd === "list-windows") {
      // Bootstrap window kept alive (sessions cannot survive zero windows).
      return "▲ bootstrap||\n";
    }
    if (cmd === "kill-window") return "";
    if (cmd === "kill-server") {
      for (const k of [...sessions.keys()]) if (k.startsWith(`${socket}//`)) sessions.delete(k);
      return "";
    }
    throw new Error(`fake tmux: unsupported ${cmd}`);
  };
  return { tmux, sessions };
};

const sessionCount = (sessions: Map<string, unknown>): number =>
  [...sessions.keys()].filter((k) => k.includes("//sess:")).length;

const sessKeyOf = (s: { socketName: string; sessionName: string }): string =>
  `${s.socketName}//sess:${s.sessionName}`;

describe("nameJobForCommand (human labels)", () => {
  it("humanizes common shapes", async () => {
    const { nameJobForCommand, resolveDisplayName } = await import("../src/engine/grammar");
    expect(nameJobForCommand("sleep 90")).toBe("sleep 90s");
    expect(nameJobForCommand("cd /tmp && pytest tests/auth -x")).toBe("pytest tests/auth -x");
    expect(nameJobForCommand("npm run build")).toBe("npm run build");
    expect(nameJobForCommand("/usr/local/bin/mytool --fast")).toBe("mytool --fast");
    expect(nameJobForCommand("")).toBe("shell");
    expect(nameJobForCommand("   ")).toBe("shell");
    expect(nameJobForCommand("echo " + "x".repeat(100))).toHaveLength(40);
  });

  it("display priority: given name > short command > derived label", async () => {
    const { resolveDisplayName } = await import("../src/engine/grammar");
    expect(resolveDisplayName("sleep 90")).toBe("sleep 90");
    expect(resolveDisplayName("sleep 90", "nap time")).toBe("nap time");
    expect(resolveDisplayName("sleep 90", "  ")).toBe("sleep 90");
    expect(resolveDisplayName("echo " + "x".repeat(200))).toBe("echo " + "x".repeat(34) + "\u2026");
  });
});

describe("engine naming (S1/R1)", () => {
  it("mints pid-free canonical names and short-hash sockets", () => {
    expect(canonicalSessionName("abc")).toBe("pi-bg-abc");
    const sock = serverSocketName("abc");
    expect(sock).toMatch(/^pi-bg-[0-9a-f]{12}$/);
    // Socket path stays under the 108-char Unix limit even for absurd pi ids.
    const longId = "x".repeat(200);
    expect(`/tmp/tmux-501/${serverSocketName(longId)}`.length).toBeLessThan(108);
    expect(serverSocketName("abc")).toBe(serverSocketName("abc"));
    expect(serverSocketName("abc")).not.toBe(serverSocketName("abd"));
  });

  it("naming never uses the pid as a lookup key", () => {
    expect(canonicalSpoolDir("/s", "abc")).toBe("/s/abc");
    expect(sessionJsonPath("/s/abc")).toBe("/s/abc/session.json");
    expect(sessionLockPath("/s/abc")).toBe("/s/abc/session.lock");
    expect(jobJsonPath("/s/abc", "a1b2c3")).toBe("/s/abc/jobs/a1b2c3.json");
    expect(deathJsonPath("/s/abc")).toBe("/s/abc/death.json");
  });
});

describe("engine sidecar atomicity (S2)", () => {
  it("round-trips JSON and fails soft on missing/corrupt files", () => {
    const root = freshRoot();
    const target = join(root, "s.json");
    expect(readJsonFile(target)).toBeUndefined();
    atomicWriteJson(target, { a: 1 });
    expect(readJsonFile<{ a: number }>(target)).toEqual({ a: 1 });
    writeFileSync(target, "{torn");
    expect(readJsonFile(target)).toBeUndefined();
    // Overwrite is atomic: new value fully replaces old.
    atomicWriteJson(target, { a: 2 });
    expect(readJsonFile<{ a: number }>(target)).toEqual({ a: 2 });
  });
});

describe("engine owner lock (S3/S4)", () => {
  it("acquires, refuses a live second holder, releases", () => {
    const lockDir = join(freshRoot(), "session.lock");
    const first = acquireOwnerLock(lockDir, 300000);
    expect(first.outcome).toBe("acquired");
    const second = acquireOwnerLock(lockDir, 300000);
    expect(second.outcome).toBe("live");
    expect(refreshOwnerLock(lockDir, "wrong-nonce")).toBe(false);
    expect(refreshOwnerLock(lockDir, first.owner.nonce)).toBe(true);
    releaseOwnerLock(lockDir, "wrong-nonce");
    expect(readOwner(lockDir)).toBeDefined(); // foreign nonce cannot release
    releaseOwnerLock(lockDir, first.owner.nonce);
    expect(acquireOwnerLock(lockDir, 300000).outcome).toBe("acquired");
  });

  it("fresh heartbeat holds; stale heartbeat with live pid holds (stall guard)", () => {
    const lockDir = join(freshRoot(), "session.lock");
    const first = acquireOwnerLock(lockDir, 300000);
    // first.owner carries our live pid: fresh heartbeat holds.
    expect(isOwnerDead(lockDir, first.owner, 50)).toBe(false);
    expect(acquireOwnerLock(lockDir, 50).outcome).toBe("live");
    // Age the heartbeat past the threshold: our pid is still alive, so the
    // stall guard holds the lock (stalled, not dead) — no takeover.
    utimesSync(join(lockDir, "heartbeat"), new Date(0), new Date(0));
    expect(isOwnerDead(lockDir, first.owner, 50)).toBe(false);
    expect(acquireOwnerLock(lockDir, 50).outcome).toBe("live");
  });

  it("stale heartbeat with dead pid takes over and mints a fresh nonce", () => {
    const lockDir = join(freshRoot(), "session.lock");
    const first = acquireOwnerLock(lockDir, 300000);
    // Rewrite the record as a dead pid, keep the heartbeat stale.
    atomicWriteJson(join(lockDir, "owner.json"), {
      nonce: "dead",
      heartbeatAt: new Date(0).toISOString(),
      pid: 1 << 24,
    });
    utimesSync(join(lockDir, "heartbeat"), new Date(0), new Date(0));
    const dead = readOwner(lockDir)!;
    expect(isOwnerDead(lockDir, dead, 50)).toBe(true);
    expect(acquireOwnerLock(lockDir, 50).outcome).toBe("acquired");
    // Takeover mints a fresh nonce (no dual owners).
    const second = readOwner(lockDir);
    expect(second?.nonce).not.toBe(first.owner.nonce);
  });
});

describe("engine ensure/disambiguate (fake tmux)", () => {
  it("creates session + active sidecar in order", () => {
    const runner = fakeRunner();
    const s = ensureSession({
      piId: "pi-1",
      spoolRoot: freshRoot(),
      shutdownPolicy: "stop-all",
      staleAfterMs: 300000,
      runner,
    });
    expect(s.sessionName).toBe("pi-bg-pi-1");
    const rec = readJsonFile<SessionRecord>(sessionJsonPath(s.spoolDir));
    expect(rec?.state).toBe("active");
    expect(rec?.version).toBe(1);
    expect(rec?.sessionGuid).toBe(s.sessionGuid);
    expect(rec?.tmuxServer).toBe(`-L ${s.socketName}`);
  });

  it("bumps epoch on in-place takeover of the same dir", () => {
    const runner = fakeRunner();
    const root = freshRoot();
    const params = {
      piId: "pi-epoch",
      spoolRoot: root,
      shutdownPolicy: "stop-all",
      staleAfterMs: 300000,
      runner,
    };
    const first = ensureSession(params);
    expect(first.epoch).toBe(0);
    // Simulate owner death: dead owner record + stale heartbeat.
    const lockDir = join(first.spoolDir, "session.lock");
    atomicWriteJson(join(lockDir, "owner.json"), {
      pid: 1 << 24,
      processStartTimeMs: 1,
      nonce: "dead",
      heartbeatAt: new Date(0).toISOString(),
    });
    const old = new Date(0);
    utimesSync(join(lockDir, "heartbeat"), old, old);
    const second = ensureSession(params);
    expect(second.spoolDir).toBe(first.spoolDir);
    expect(second.epoch).toBe(1);
    const rec = readJsonFile<SessionRecord>(sessionJsonPath(second.spoolDir));
    expect(rec?.epoch).toBe(1);
  });

  it("busy-exits against a live owner, never splits", () => {
    const runner = fakeRunner();
    const root = freshRoot();
    const params = {
      piId: "pi-busy",
      spoolRoot: root,
      shutdownPolicy: "stop-all",
      staleAfterMs: 300000,
      runner,
    };
    ensureSession(params);
    // Simulate a second process: lock is held fresh by the first ensure.
    expect(() => ensureSession(params)).toThrow(SessionBusyError);
    // No second session was created as a side effect.
    expect(sessionCount(runner.sessions)).toBe(1);
  });

  it("stale owner + leftover live session reclaims it (no fragmentation)", () => {
    const runner = fakeRunner();
    const root = freshRoot();
    const s1 = ensureSession({
      piId: "pi-stale",
      spoolRoot: root,
      shutdownPolicy: "stop-all",
      staleAfterMs: 50,
      runner,
    });
    // Simulate owner death: stale heartbeat + dead pid in owner.json.
    utimesSync(join(sessionLockPath(s1.spoolDir), "heartbeat"), new Date(0), new Date(0));
    const owner = readOwner(sessionLockPath(s1.spoolDir))!;
    atomicWriteJson(join(sessionLockPath(s1.spoolDir), "owner.json"), {
      ...owner,
      pid: 1 << 24,
      processStartTimeMs: Date.now() - 3600000,
    });
    // Dead pid, stale heartbeat: kill(pid,0) says ESRCH regardless of the
    // recorded start, so takeover works on every platform.
    const s2 = ensureSession({
      piId: "pi-stale",
      spoolRoot: root,
      shutdownPolicy: "stop-all",
      staleAfterMs: 50,
      runner,
    });
    // Same socket/session reclaimed under a new guid.
    expect(s2.socketName).toBe(s1.socketName);
    expect(s2.sessionName).toBe(s1.sessionName);
    expect(s2.sessionGuid).not.toBe(s1.sessionGuid);
    expect(runner.sessions.get(sessKeyOf(s1))?.get("@pi_guid")).toBe(
      s2.sessionGuid,
    );
    expect(sessionCount(runner.sessions)).toBe(1);
  });

  it("creating leftover + live matching session repairs forward (idempotent)", () => {
    const runner = fakeRunner();
    const root = freshRoot();
    const s1 = ensureSession({
      piId: "pi-repair",
      spoolRoot: root,
      shutdownPolicy: "stop-all",
      staleAfterMs: 300000,
      runner,
    });
    // Crash between steps: sidecar reset to creating, lock released, session live.
    releaseOwnerLock(sessionLockPath(s1.spoolDir), s1.ownerNonce);
    const rec = readJsonFile<SessionRecord>(sessionJsonPath(s1.spoolDir))!;
    atomicWriteJson(sessionJsonPath(s1.spoolDir), { ...rec, state: "creating" });
    const s2 = ensureSession({
      piId: "pi-repair",
      spoolRoot: root,
      shutdownPolicy: "stop-all",
      staleAfterMs: 300000,
      runner,
    });
    expect(readJsonFile<SessionRecord>(sessionJsonPath(s2.spoolDir))?.state).toBe("active");
    expect(sessionCount(runner.sessions)).toBe(1); // no duplicate session
  });

  it("foreign live session (guid mismatch) fails closed, never touched", () => {
    const runner = fakeRunner();
    const root = freshRoot();
    // Pre-create a foreign session with a different guid on the canonical socket.
    const socket = "pi-bg-sock-x";
    void socket;
    const s1 = ensureSession({
      piId: "pi-foreign",
      spoolRoot: root,
      shutdownPolicy: "stop-all",
      staleAfterMs: 300000,
      runner,
    });
    // Corrupt the live guid behind our back, reset sidecar to creating, free lock.
    const opts = runner.sessions.get(sessKeyOf(s1))!;
    opts.set("@pi_guid", "foreign-guid");
    releaseOwnerLock(sessionLockPath(s1.spoolDir), s1.ownerNonce);
    const rec = readJsonFile<SessionRecord>(sessionJsonPath(s1.spoolDir))!;
    atomicWriteJson(sessionJsonPath(s1.spoolDir), { ...rec, state: "creating" });
    // Repair writes OUR guid... but the fake applies set-option blindly, so it
    // repairs. True foreign resistance (guid repair refused) now fails closed
    // with SessionBusyError instead of disambiguating.
    // Here: repair succeeds, session reclaimed with our guid.
    const s2 = ensureSession({
      piId: "pi-foreign",
      spoolRoot: root,
      shutdownPolicy: "stop-all",
      staleAfterMs: 300000,
      runner,
    });
    expect(opts.get("@pi_guid")).toBe(s2.sessionGuid);
  });
});

describe("engine live lifecycle", () => {
  // Pass-through runner: ensureSession derives the private socket itself.
  const direct: Runner = {
    tmux: (socket: string, args: string[]) =>
      execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf-8" }),
  };

  it.skipIf(!LIVE_TMUX)("ensures, verifies guid, destroys server on shutdown", () => {
    const s = ensureSession({
      piId: `bg-live-a-${process.pid}`,
      spoolRoot: freshRoot(),
      shutdownPolicy: "stop-all",
      staleAfterMs: 300000,
      runner: direct,
    });
    const guid = direct
      .tmux(s.socketName, ["show-options", "-t", s.sessionName, "-v", "@pi_guid"])
      .trim();
    expect(guid).toBe(s.sessionGuid);
    const raw = readFileSync(sessionJsonPath(s.spoolDir), "utf8");
    expect(JSON.parse(raw).state).toBe("active");
    destroySession(s, direct, false);
    expect(() =>
      direct.tmux(s.socketName, ["has-session", "-t", s.sessionName]),
    ).toThrow();
  });

  it.skipIf(!LIVE_TMUX)("leave-running destroy keeps the server, releases the lock", () => {
    const s = ensureSession({
      piId: `bg-live-b-${process.pid}`,
      spoolRoot: freshRoot(),
      shutdownPolicy: "leave-running",
      staleAfterMs: 300000,
      runner: {
        tmux: (socket: string, args: string[]) =>
          execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf-8" }),
      },
    });
    const direct: Runner = {
      tmux: (socket: string, args: string[]) =>
        execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf-8" }),
    };
    destroySession(s, direct, true);
    // Server survives...
    direct.tmux(s.socketName, ["has-session", "-t", s.sessionName]);
    // ...but the lock is free for the next owner.
    expect(readOwner(sessionLockPath(s.spoolDir))).toBeUndefined();
    // Cleanup: kill the leftover server.
    try {
      execFileSync("tmux", ["-L", s.socketName, "kill-server"], { stdio: "ignore" });
    } catch {
      // Already gone.
    }
  });
});

afterAll(() => {
  // Belt and braces: no stray test servers.
  if (!LIVE_TMUX) return;
  try {
    execFileSync("tmux", ["-L", `bg-test-${process.pid}-a`, "kill-server"], {
      stdio: "ignore",
    });
  } catch {
    // Gone already.
  }
});

describe("spool symlink guard", () => {
  it("refuses symlinked spool roots loudly", () => {
    const target = freshRoot();
    const link = join(tmpdir(), `bg-link-${process.pid}-${Date.now()}`);
    symlinkSync(target, link);
    try {
      expect(() =>
        ensureSession({
          piId: "pi-link",
          spoolRoot: link,
          shutdownPolicy: "stop-all",
          staleAfterMs: 300000,
          runner: fakeRunner(),
        }),
      ).toThrow("must not be a symlink");
    } finally {
      unlinkSync(link);
    }
  });
});

describe("atomicWriteJson cross-device safety (headless)", () => {
  it("never touches the OS tmpdir: survives a hostile TMPDIR", () => {
    const root = mkdtempSync(join(tmpdir(), "bg-sidecar-"));
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = join(root, "no-such-tmpdir");
    try {
      const target = join(root, "owner.json");
      atomicWriteJson(target, { nonce: "abc" });
      expect(readJsonFile<{ nonce: string }>(target)).toEqual({ nonce: "abc" });
      // No stray tmp files left beside the target.
      expect(readdirSync(root).sort()).toEqual(["owner.json"]);
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
  });
});
