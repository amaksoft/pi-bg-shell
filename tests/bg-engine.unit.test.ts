import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveOptions } from "../src/config";
import { createState } from "../src/runtime";
import { ensureSession, type Runner, type Session } from "../src/engine/session";
import {
  deliverCompletion,
  killTask,
  listTasks,
  peekTask,
  runBashJob,
  syncJobToState,
} from "../src/engine/wiring";
import { spawnJob } from "../src/engine/jobs";

const hasTmux = (): boolean => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const LIVE_TMUX = hasTmux();
const freshRoot = (): string => mkdtempSync(join(tmpdir(), "bg-eng-"));

const direct: Runner = {
  tmux: (socket: string, args: string[]) =>
    execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf-8" }),
};

const options = resolveOptions({
  bashToolName: "bash",
  tmuxToolName: "tmux",
  defaultTimeoutSeconds: 30,
  defaultTimeoutAction: "background",
  maxTimeoutSeconds: 60,
  defaultPollInterval: 0,
});

const setup = (piId: string) => {
  const session = ensureSession({
    piId,
    spoolRoot: freshRoot(),
    shutdownPolicy: "stop-all",
    staleAfterMs: 300000,
    runner: direct,
  });
  const state = createState();
  state.engine = { session, runner: direct, reconciler: null, widget: null };
  const sent: { message: unknown; opts: unknown }[] = [];
  const pi = { sendMessage: vi.fn((message: unknown, opts: unknown) => void sent.push({ message, opts })) } as unknown as ExtensionAPI;
  const ctx = {
    cwd: tmpdir(),
    hasUI: true,
    ui: { setStatus: vi.fn(), notify: vi.fn(), confirm: vi.fn(), select: vi.fn() },
    sessionManager: { getSessionId: () => piId },
  } as unknown as ExtensionContext;
  return { session, state, pi, sent, ctx };
};

const teardown = (session: Session) => {
  try {
    direct.tmux(session.socketName, ["kill-server"]);
  } catch {
    // Gone already.
  }
};

describe("engine engine wiring (live)", () => {
  it.skipIf(!LIVE_TMUX)("background start returns frozen contract text + syncs registry", async () => {
    const { session, state, ctx, pi } = setup(`bg-eng-${process.pid}-1`);
    try {
      const result = await runBashJob(
        { command: "sleep 30", background: true, timeout: 30 },
        "tool-1",
        undefined,
        undefined,
        pi,
        ctx,
        state,
        options,
      );
      const text = (result.content[0] as { text: string }).text;
      expect(text).toMatch(/^Started in background tmux window: /);
      expect(text).toMatch(/job_id: [0-9a-f]{6}/);
      expect(text).toMatch(/log_path: /);
      expect(text).toContain("Result will be reported when it finishes.");
      expect(text).toContain("Follow up with /tasks");
      const jobId = text.match(/job_id: ([0-9a-f]{6})/)![1];
      const row = state.backgroundJobs.get(jobId);
      expect(row?.engine?.spoolDir).toBe(session.spoolDir);
      expect(row?.command).toBe("sleep 30");
      expect(row?.backgrounded).toBe(true);
      // Footer status sees engine jobs through the shared registry.
      expect(ctx.ui.setStatus).toHaveBeenCalled();
      // /tasks helpers work off the sidecar.
      expect(listTasks(state).map((r) => r.jobId)).toContain(jobId);
      expect(peekTask(state, jobId, 10)).toContain("$ sleep 30");
      expect(killTask(state, options, jobId)).toBe(true);
      expect(state.backgroundJobs.has(jobId)).toBe(false);
    } finally {
      teardown(session);
    }
  }, 30000);

  it.skipIf(!LIVE_TMUX)("first streaming slice carries the detach hint (once)", async () => {
    const { session, state, ctx, pi } = setup(`bg-eng-${process.pid}-7`);
    try {
      const updates: { content: { type: string; text?: string }[] }[] = [];
      const onUpdate = vi.fn((update: { content: { type: string; text?: string }[] }) => void updates.push(update));
      await runBashJob(
        { command: "for i in 1 2 3 4; do echo line$i; sleep 0.4; done", background: false, timeout: 30, timeoutAction: "kill" },
        "tool-7",
        undefined,
        onUpdate as never,
        pi,
        ctx,
        state,
        options,
      );
      const texts = updates.flatMap((u) => u.content.map((c) => c.text ?? ""));
      const hinted = texts.filter((t) => t.includes("(ctrl+b to background)"));
      expect(texts.length).toBeGreaterThan(0);
      expect(hinted).toHaveLength(1);
    } finally {
      teardown(session);
    }
  }, 30000);

  it.skipIf(!LIVE_TMUX)("no detach hint when the shortcut is disabled", async () => {
    const { session, state, ctx, pi } = setup(`bg-eng-${process.pid}-8`);
    try {
      const updates: { content: { type: string; text?: string }[] }[] = [];
      const onUpdate = vi.fn((update: { content: { type: string; text?: string }[] }) => void updates.push(update));
      const noHint = resolveOptions({ outputDir: freshRoot(), detachShortcut: false });
      await runBashJob(
        { command: "for i in 1 2; do echo line$i; sleep 0.4; done", background: false, timeout: 30, timeoutAction: "kill" },
        "tool-8",
        undefined,
        onUpdate as never,
        pi,
        ctx,
        state,
        noHint,
      );
      const texts = updates.flatMap((u) => u.content.map((c) => c.text ?? ""));
      expect(texts.join("\n")).not.toContain("to background)");
    } finally {
      teardown(session);
    }
  }, 30000);

  it.skipIf(!LIVE_TMUX)("foreground quick command returns output text", async () => {
    const { session, state, ctx, pi } = setup(`bg-eng-${process.pid}-2`);
    try {
      const result = await runBashJob(
        { command: "echo fore-v2", background: false, timeout: 30, timeoutAction: "kill" },
        "tool-2",
        undefined,
        undefined,
        pi,
        ctx,
        state,
        options,
      );
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("fore-v2");
      expect(state.backgroundJobs.size).toBe(0);
    } finally {
      teardown(session);
    }
  }, 30000);

  it.skipIf(!LIVE_TMUX)("foreground timeout demotes with frozen text + job refs", async () => {
    const { session, state, ctx, pi } = setup(`bg-eng-${process.pid}-3`);
    try {
      const result = await runBashJob(
        { command: "sleep 30", background: false, timeout: 1, timeoutAction: "background" },
        "tool-3",
        undefined,
        undefined,
        pi,
        ctx,
        state,
        options,
      );
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("Still running after 1s in background tmux");
      expect(text).toMatch(/job_id: [0-9a-f]{6}/);
      expect(text).toMatch(/log_path: /);
      expect(text).toContain("Follow up with /tasks");
      expect((result.details as { outcome: string }).outcome).toBe("timed-out-background");
      expect(state.backgroundJobs.get(text.match(/job_id: ([0-9a-f]{6})/)![1])?.backgrounded).toBe(true);
      expect((result.details as { displayName: string }).displayName).toBe("sleep 30");
    } finally {
      teardown(session);
    }
  }, 30000);

  it.skipIf(!LIVE_TMUX)("timeout ask demotes and lets the model decide", async () => {
    const { session, state, ctx, pi } = setup(`bg-eng-${process.pid}-10`);
    try {
      const result = await runBashJob(
        { command: "sleep 30", background: false, timeout: 1, timeoutAction: "ask" },
        "tool-10",
        undefined,
        undefined,
        pi,
        ctx,
        state,
        options,
      );
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("Still running after 1s in background tmux");
      expect(text).toContain("Your call: leave it running");
      expect(text).toContain(`/tasks`);
      const jobId = text.match(/job_id: ([0-9a-f]{6})/)![1];
      // Demoted, not killed: survives for the model's next move.
      expect(state.backgroundJobs.get(jobId)?.backgrounded).toBe(true);
      expect((result.details as { outcome: string }).outcome).toBe("timed-out-background");
    } finally {
      teardown(session);
    }
  }, 30000);

  it.skipIf(!LIVE_TMUX)("Ctrl+B detach returns frozen agency text", async () => {
    const { session, state, ctx, pi } = setup(`bg-eng-${process.pid}-4`);
    try {
      const controller = new AbortController();
      const pending = runBashJob(
        { command: "sleep 30", background: false, timeout: 30, timeoutAction: "background" },
        "tool-4",
        controller.signal,
        undefined,
        pi,
        ctx,
        state,
        options,
      );
      await new Promise((r) => setTimeout(r, 1200));
      // Ctrl+B: the shortcut handler flags the tool call; the wait demotes.
      state.detachRequested.add("tool-4");
      const result = await pending;
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("The user pressed Ctrl+B and moved this command to the background themselves");
      expect(text).toMatch(/job_id: [0-9a-f]{6}/);
      expect(text).toContain("Follow up with /tasks");
      expect((result.details as { outcome: string }).outcome).toBe("detached-background");
      expect((result.details as { displayName: string }).displayName).toBe("sleep 30");
      expect(state.backgroundJobs.get(text.match(/job_id: ([0-9a-f]{6})/)![1])?.backgrounded).toBe(true);
    } finally {
      teardown(session);
    }
  }, 30000);

  it.skipIf(!LIVE_TMUX)("delivery sends frozen follow-up + toast, forgets the job", async () => {
    const { session, state, ctx, pi, sent } = setup(`bg-eng-${process.pid}-5`);
    try {
      const job = spawnJob({
        session,
        runner: direct,
        tmuxBinary: "tmux",
        command: "echo deliver-me; exit 4",
        cwd: tmpdir(),
        envDenylist: [],
        windowName: "bg-test",
      });
      syncJobToState(state, session, job.jobId);
      // Simulate the reconciler having consumed the exit file already.
      const { consumeCompletion } = await import("../src/engine/jobs");
      consumeCompletion(session, job.jobId);
      deliverCompletion(
        pi,
        state,
        options,
        {
          jobId: job.jobId,
          windowId: job.windowId,
          command: "echo deliver-me; exit 4",
          status: "completed",
          logFile: job.logFile,
          exitFile: job.exitFile,
          startedAt: Date.now(),
          spoolDir: session.spoolDir,
        },
        4,
      );
      expect(sent).toHaveLength(1);
      const message = sent[0].message as { customType: string; content: string };
      expect(message.customType).toBe("tmux-bash-completion");
      expect(message.content).toContain("job " + job.jobId);
      expect(message.content).toContain(`log_path: ${job.logFile}`);
      expect(message.content).toContain("deliver-me");
      // Singleton completions steer mid-turn (patty-bg-tasks parity).
      expect(sent[0].opts).toEqual({ triggerTurn: true, deliverAs: "steer" });
      expect(state.backgroundJobs.has(job.jobId)).toBe(false);
    } finally {
      teardown(session);
    }
  }, 30000);

  it.skipIf(!LIVE_TMUX)("batch delivery sends one follow-up for many jobs", async () => {
    const { session, state, ctx, pi, sent } = setup(`bg-eng-${process.pid}-9`);
    try {
      const { deliverCompletions } = await import("../src/engine/wiring");
      const { consumeCompletion } = await import("../src/engine/jobs");
      const mk = (tag: string, code: number) => {
        const job = spawnJob({
          session,
          runner: direct,
          tmuxBinary: "tmux",
          command: `echo ${tag}; exit ${code}`,
          cwd: tmpdir(),
          envDenylist: [],
          windowName: "bg-test",
        });
        syncJobToState(state, session, job.jobId);
        return job;
      };
      const a = mk("batch-a", 0);
      const b = mk("batch-b", 3);
      await new Promise((r) => setTimeout(r, 1200));
      // Exit codes come from the consume itself now (the journal no
      // longer stores them; the .consumed file is the record).
      const done = new Map([
        [a.jobId, consumeCompletion(session, a.jobId)],
        [b.jobId, consumeCompletion(session, b.jobId)],
      ]);
      deliverCompletions(
        pi,
        state,
        options,
        [a, b].map((job) => ({
          job: {
            jobId: job.jobId,
            windowId: job.windowId,
            command: "echo",
            status: "completed",
            logFile: job.logFile,
            exitFile: job.exitFile,
            startedAt: Date.now(),
            spoolDir: session.spoolDir,
          },
          exitCode: done.get(job.jobId)?.exitCode ?? -1,
          logTail: `batch-${job.jobId}`,
        })),
      );
      expect(sent).toHaveLength(1);
      const message = sent[0].message as { customType: string; content: string; details: { exitCode: number; status: string } };
      expect(message.customType).toBe("tmux-bash-completion");
      expect(message.content).toContain("Background bash finished (2 jobs)");
      expect(message.content).toContain(`job ${a.jobId}`);
      expect(message.content).toContain(`job ${b.jobId}`);
      expect(message.content).toContain("exit 3");
      expect(message.details.exitCode).toBe(3); // worst wins
      expect(message.details.status).toBe("failed");
      expect(sent[0].opts).toEqual({ triggerTurn: true, deliverAs: "followUp" });
      expect(state.backgroundJobs.has(a.jobId)).toBe(false);
      expect(state.backgroundJobs.has(b.jobId)).toBe(false);
    } finally {
      teardown(session);
    }
  }, 30000);

});

describe("timeout-kill marker (live)", () => {
  it.skipIf(!LIVE_TMUX)("timeout kills leave a marker the model can tell apart", async () => {
    const { session, state, ctx, pi } = setup(`bg-eng-${process.pid}-9`);
    try {
      await expect(
        runBashJob(
          { command: "sleep 30", timeout: 1, timeoutAction: "kill" },
          "tool-9",
          undefined,
          undefined,
          pi,
          ctx,
          state,
          options,
        ),
      ).rejects.toThrow("Command timed out after 1 seconds");
      // The marker lands in the spool log before the kill.
      const journals = readdirSync(join(session.spoolDir, "jobs")).filter((f) => f.endsWith(".json"));
      expect(journals.length).toBeGreaterThan(0);
      const logs = journals.map((f) => {
        const record = JSON.parse(readFileSync(join(session.spoolDir, "jobs", f), "utf8")) as { spoolLog: string };
        return readFileSync(record.spoolLog, "utf8");
      });
      expect(logs.some((log) => log.includes("Command timed out after 1s"))).toBe(true);
    } finally {
      teardown(session);
    }
  }, 30000);
});

describe("window-id resolution (live)", () => {
  it.skipIf(!LIVE_TMUX)("peek by @id resolves through live tmux, unknown @id stays unknown", async () => {
    const { executeTool } = await import("../src/runtime");
    const { session, state, ctx, pi } = setup(`bg-eng-${process.pid}-10`);
    try {
      const result = await runBashJob(
        { command: "sleep 30", background: true, timeout: 30 },
        "tool-10",
        undefined,
        undefined,
        pi,
        ctx,
        state,
        options,
      );
      const jobId = (/job_id: ([0-9a-f]{6})/.exec(
        (result.content[0] as { text: string }).text,
      )!)[1];
      const row = state.backgroundJobs.get(jobId)!;
      // Live @id resolves to the job (log line present in peek text).
      const peeked = executeTool(
        { action: "peek", window: row.windowId },
        ctx,
        state,
        pi,
        options,
      ) as { content: { text: string }[] };
      expect(peeked.content.map((c) => c.text).join("\n")).toContain("log_path:");
      // Unknown @id never touches the registry: unknown, no throw.
      const missing = executeTool({ action: "peek", window: "@999999" }, ctx, state, pi, options) as {
        content: { text: string }[];
        isError?: boolean;
      };
      expect(missing.isError).toBe(true);
      expect(killTask(state, options, jobId)).toBe(true);
    } finally {
      teardown(session);
    }
  }, 30000);
});

describe("no-engine error (headless)", () => {
  it("reports the actionable tmux cause instead of the generic absence", async () => {
    const state = createState(); // no engine wired
    const badTmuxOptions = resolveOptions({ tmuxBinary: "definitely-not-tmux-xyz" });
    const pi = { sendMessage: vi.fn() } as unknown as ExtensionAPI;
    const ctx = { cwd: tmpdir() } as unknown as ExtensionContext;
    const result = await runBashJob(
      { command: "echo hello", timeout: 10, timeoutAction: "background" },
      "tool-no-engine",
      undefined,
      undefined,
      pi,
      ctx,
      state,
      badTmuxOptions,
    );
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("tmux not found");
    expect(text).toContain("Install tmux >= 3.0");
  });
});
