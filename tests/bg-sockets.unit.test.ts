import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SOCKET_PREFIXES,
  SOCKET_MIN_AGE_MS,
  sweepDeadSockets,
  type DeadSocketProbes,
  type SocketEntry,
} from "../src/engine/reaper";

const hasTmux = (): boolean => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const LIVE_TMUX = hasTmux();
const freshDir = (): string => mkdtempSync(join(tmpdir(), "bg-sock-"));

/** Socket-like file with a controlled mtime. */
const touchSock = (dir: string, name: string, ageMs: number): void => {
  const path = join(dir, name);
  writeFileSync(path, "x");
  const t = new Date(Date.now() - ageMs);
  utimesSync(path, t, t);
};

const OLD = SOCKET_MIN_AGE_MS + 60_000;

/** Fake probes over a temp dir: liveness scripted per socket, unlink real. */
const fakeProbes = (
  dir: string,
  states: Record<string, "live" | "dead" | "unknown">,
  opts: { unlinkThrows?: string[] } = {},
): DeadSocketProbes & { unlinked: string[] } => {
  const unlinked: string[] = [];
  return {
    unlinked,
    listSocketEntries(): SocketEntry[] {
      const out: SocketEntry[] = [];
      for (const name of readdirSync(dir)) {
        const st = statSync(join(dir, name));
        out.push({ name, mtimeMs: st.mtimeMs, isDirectory: st.isDirectory() });
      }
      return out;
    },
    socketState: (socket: string) => states[socket] ?? "unknown",
    unlinkSocket: (socket: string) => {
      if (opts.unlinkThrows?.includes(socket)) throw new Error("EACCES: permission denied");
      unlinked.push(socket);
      unlinkSync(join(dir, socket));
    },
  };
};

const fakeEntries = (dir: string, names: string[], ageMs: number): SocketEntry[] =>
  names.map((name) => ({ name, mtimeMs: Date.now() - ageMs, isDirectory: false }));

describe("engine socket sweep (headless)", () => {
  it("collects old dead sockets in our namespace", () => {
    const dir = freshDir();
    touchSock(dir, "pi-bg-deadbeef01", OLD);
    const probes = fakeProbes(dir, { "pi-bg-deadbeef01": "dead" });
    const result = sweepDeadSockets("tmux", {
      minAgeMs: 0,
      probes: { ...probes, listSocketEntries: () => fakeEntries(dir, ["pi-bg-deadbeef01"], OLD) },
    });
    expect(result.collected).toEqual(["pi-bg-deadbeef01"]);
    expect(probes.unlinked).toEqual(["pi-bg-deadbeef01"]);
    expect(existsSync(join(dir, "pi-bg-deadbeef01"))).toBe(false);
    expect(result.errors).toEqual([]);
  });

  it("skips live servers even when old", () => {
    const dir = freshDir();
    touchSock(dir, "pi-bg-live01", OLD);
    const probes = fakeProbes(dir, { "pi-bg-live01": "live" });
    const result = sweepDeadSockets("tmux", {
      minAgeMs: 0,
      probes: { ...probes, listSocketEntries: () => fakeEntries(dir, ["pi-bg-live01"], OLD) },
    });
    expect(result.collected).toEqual([]);
    expect(result.skippedLive).toEqual(["pi-bg-live01"]);
    expect(existsSync(join(dir, "pi-bg-live01"))).toBe(true);
  });

  it("never touches foreign namespaces", () => {
    const dir = freshDir();
    const foreign = ["default", "cc-wheel", "perf-scroll", "other"];
    for (const name of foreign) touchSock(dir, name, OLD);
    const probes = fakeProbes(dir, {});
    const result = sweepDeadSockets("tmux", {
      minAgeMs: 0,
      probes: { ...probes, listSocketEntries: () => fakeEntries(dir, foreign, OLD) },
    });
    expect(result.collected).toEqual([]);
    expect(result.skippedLive).toEqual([]);
    expect(result.errors).toEqual([]);
    for (const name of foreign) expect(existsSync(join(dir, name))).toBe(true);
    expect(probes.unlinked).toEqual([]);
  });

  it("skips fresh sockets (startup race)", () => {
    const dir = freshDir();
    touchSock(dir, "pi-bg-fresh01", 0);
    const probes = fakeProbes(dir, { "pi-bg-fresh01": "dead" });
    // Even a dead probe must not collect a fresh file: the server may still
    // be coming up and the probe may be racing it.
    const result = sweepDeadSockets("tmux", {
      probes: {
        ...probes,
        listSocketEntries: () => [{ name: "pi-bg-fresh01", mtimeMs: Date.now(), isDirectory: false }],
      },
    });
    expect(result.collected).toEqual([]);
    expect(result.skippedFresh).toEqual(["pi-bg-fresh01"]);
    expect(existsSync(join(dir, "pi-bg-fresh01"))).toBe(true);
  });

  it("skips unknown liveness (fail-safe)", () => {
    const dir = freshDir();
    touchSock(dir, "pi-bg-mystery01", OLD);
    const probes = fakeProbes(dir, { "pi-bg-mystery01": "unknown" });
    const result = sweepDeadSockets("tmux", {
      minAgeMs: 0,
      probes: { ...probes, listSocketEntries: () => fakeEntries(dir, ["pi-bg-mystery01"], OLD) },
    });
    expect(result.collected).toEqual([]);
    expect(result.skippedUnknown).toEqual(["pi-bg-mystery01"]);
    expect(existsSync(join(dir, "pi-bg-mystery01"))).toBe(true);
  });

  it("reports unlink failures without touching siblings", () => {
    const dir = freshDir();
    touchSock(dir, "pi-bg-locked01", OLD);
    touchSock(dir, "pi-bg-free01", OLD);
    const probes = fakeProbes(
      dir,
      { "pi-bg-locked01": "dead", "pi-bg-free01": "dead" },
      { unlinkThrows: ["pi-bg-locked01"] },
    );
    const result = sweepDeadSockets("tmux", {
      minAgeMs: 0,
      probes: {
        ...probes,
        listSocketEntries: () => fakeEntries(dir, ["pi-bg-locked01", "pi-bg-free01"], OLD),
      },
    });
    expect(result.collected).toEqual(["pi-bg-free01"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].socket).toBe("pi-bg-locked01");
    expect(existsSync(join(dir, "pi-bg-locked01"))).toBe(true);
    expect(existsSync(join(dir, "pi-bg-free01"))).toBe(false);
  });

  it("refuses directories under our prefix", () => {
    const dir = freshDir();
    mkdirSync(join(dir, "pi-bg-notasocket"));
    const probes = fakeProbes(dir, { "pi-bg-notasocket": "dead" });
    const result = sweepDeadSockets("tmux", {
      minAgeMs: 0,
      probes: {
        ...probes,
        listSocketEntries: () => [{ name: "pi-bg-notasocket", mtimeMs: Date.now() - OLD, isDirectory: true }],
      },
    });
    expect(result.collected).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(existsSync(join(dir, "pi-bg-notasocket"))).toBe(true);
  });

  it("returns empty on an unreadable socket dir", () => {
    const probes = fakeProbes(freshDir(), {});
    const result = sweepDeadSockets("tmux", {
      probes: { ...probes, listSocketEntries: () => undefined as never },
    });
    expect(result).toEqual({ collected: [], skippedLive: [], skippedFresh: [], skippedUnknown: [], errors: [] });
  });

  it("exposes sane defaults", () => {
    expect(DEFAULT_SOCKET_PREFIXES).toEqual(["pi-bg-"]);
    expect(SOCKET_MIN_AGE_MS).toBeGreaterThanOrEqual(60_000);
  });
});

describe("engine socket sweep (live)", () => {
  it.skipIf(!LIVE_TMUX)("collects a kill -9 ghost, spares a live server and foreign files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bg-sock-live-"));
    const prev = process.env.TMUX_TMPDIR;
    process.env.TMUX_TMPDIR = dir;
    // Effective dir per tmux's rule (TMUX_TMPDIR + per-UID segment).
    const effDir = join(dir, `tmux-${process.getuid?.() ?? 0}`);
    const ghost = `pi-bg-ghost-${process.pid}`;
    const live = `pi-bg-live-${process.pid}`;
    try {
      execFileSync("tmux", ["-L", ghost, "new-session", "-d", "-x", "80", "-y", "24"]);
      execFileSync("tmux", ["-L", live, "new-session", "-d", "-x", "80", "-y", "24"]);
      writeFileSync(join(effDir, "default"), "x");
      const old = new Date(Date.now() - 3600000);
      utimesSync(join(effDir, "default"), old, old);
      // Unclean death: SIGKILL leaves the socket file behind.
      const pid = Number(
        String(execFileSync("tmux", ["-L", ghost, "display-message", "-p", "#{pid}"], { encoding: "utf-8" })).trim(),
      );
      process.kill(pid, "SIGKILL");
      // Poll until tmux itself reports no-server (server truly gone).
      const deadline = Date.now() + 10_000;
      for (;;) {
        try {
          execFileSync("tmux", ["-L", ghost, "list-sessions"], { stdio: "ignore" });
        } catch {
          break;
        }
        if (Date.now() > deadline) throw new Error("ghost server survived SIGKILL");
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(existsSync(join(effDir, ghost))).toBe(true);
      // minAgeMs 0: the age gate is covered by fake tests; here we prove the
      // real liveness probe distinguishes dead from live.
      const result = sweepDeadSockets("tmux", { minAgeMs: 0 });
      expect(result.collected).toEqual([ghost]);
      expect(result.skippedLive).toEqual([live]);
      expect(existsSync(join(effDir, ghost))).toBe(false);
      expect(existsSync(join(effDir, live))).toBe(true);
      expect(existsSync(join(effDir, "default"))).toBe(true);
    } finally {
      try {
        execFileSync("tmux", ["-L", live, "kill-server"], { stdio: "ignore" });
      } catch {
        // Gone already.
      }
      try {
        execFileSync("tmux", ["-L", ghost, "kill-server"], { stdio: "ignore" });
      } catch {
        // Gone already.
      }
      if (prev === undefined) delete process.env.TMUX_TMPDIR;
      else process.env.TMUX_TMPDIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
