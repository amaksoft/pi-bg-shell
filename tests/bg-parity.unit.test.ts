import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveOptions } from "../src/config";
import {
  buildBatchCompletion,
  buildLaunchText,
  buildTimeoutText,
  completionCustomMessage,
  shutdownWarningText,
} from "../src/engine/report";
import {
  createState,
  formatBackgroundProcessStatus,
  requestDetach,
} from "../src/runtime";
import type { ExtensionState } from "../src/engine/types";
import { buildBashToolCallSchema } from "../src/tool-call-schemas";
import { formatTmuxOutputForContext as formatOutput } from "../src/render";

const options = resolveOptions({ outputDir: "/tmp/bg-parity" });

const mockPi = () => {
  const sent: { message: unknown; opts: unknown }[] = [];
  return {
    pi: {
      sendMessage: vi.fn((message: unknown, opts: unknown) => void sent.push({ message, opts })),
    } as unknown as ExtensionAPI,
    sent,
  };
};

const stateWith = (): ExtensionState => {
  const state = createState();
  state.engine = {
    session: {
      piId: "parity",
      spoolDir: "/tmp/bg-parity/sessions/parity",
      sessionName: "pi-bg-parity",
      socketName: "pi-bg-sock-parity",
      sessionGuid: "guid-parity",
      ownerNonce: "nonce-parity",
      epoch: 0,
    },
    runner: { tmux: () => "" },
    reconciler: null,
    widget: null,
  };
  return state;
};

/**
 * Claude-parity ship gate: the user-visible contract in one place. Fast,
 * headless, no timers. If any of these fail, the product broke — not just
 * an implementation detail.
 */
describe("parity gate (Claude-Code contract)", () => {
  it("background launch returns job_id + log_path + follow-up", () => {
    const text = buildLaunchText({
      windowName: "sleep 90",
      windowId: "@1",
      jobId: "a1b2c3",
      logFile: "/tmp/x.out",
      pollSuffix: "",
      followUpLine: "Follow up with /tasks a1b2c3 or read /tmp/x.out.",
    });
    expect(text).toMatch(/job_id: [0-9a-f]{6}/);
    expect(text).toContain("log_path: /tmp/x.out");
    expect(text).toContain("Follow up with /tasks");
  });

  it("run_in_background parses as a background launch", async () => {
    const schema = buildBashToolCallSchema(
      {
        bashToolName: "bash",
        tmuxToolName: "tmux",
        defaultTimeoutSeconds: 30,
        defaultTimeoutAction: "ask",
        maxTimeoutSeconds: 600,
        defaultPollInterval: 0,
        pollContextLines: 30,
        tmuxEnabledActions: ["list", "peek", "kill"],
        bashPollIntervalEnabled: false,
      },
      (message: string) => {
        throw new Error(message);
      },
    );
    const result = await schema.handleInput({ command: "sleep 90", run_in_background: true }, (input) => input);
    expect(result.background).toBeUndefined();
    expect(result.run_in_background).toBe(true);
  });

  it("Ctrl+B demotes every foreground waiter", () => {
    const state = createState();
    state.foregroundRuns.set("a", { command: "sleep 10", startedAt: Date.now() });
    state.foregroundRuns.set("b", { command: "sleep 20", startedAt: Date.now() });
    const detached = requestDetach(state);
    expect(detached.map((d) => d.toolCallId)).toEqual(["a", "b"]);
  });

  it("timeout asks by default (model decides kill vs keep)", () => {
    expect(options.defaultTimeoutAction).toBe("ask");
    const text = buildTimeoutText({
      text: "partial",
      timeoutSeconds: 30,
      pollClause: "",
      hint: "hint",
      timeoutAction: "ask",
      followUpLine: "follow",
      jobId: "a1b2c3",
      logFile: "/tmp/x.out",
    });
    expect(text).toContain("Your call:");
    expect(text).toContain("/tasks a1b2c3");
  });

  it("single completion carries identity + log + fence", () => {
    const message = completionCustomMessage(0, formatOutput("done\n", {}), {
      job: {
        jobId: "a1b2c3",
        session: "s",
        windowId: "@1",
        runId: "a1b2c3",
        outputFile: "/tmp/x.out",
        command: "sleep 60",
        startedAt: Date.now(),
        viaTimeoutDetach: false,
      },
      windowId: "@1",
    }) as { content: string; details: { jobId: string; logPath: string } };
    expect(message.content).toContain("job a1b2c3");
    expect(message.content).toContain("log_path: /tmp/x.out");
    expect(message.content).toContain("```");
    expect(message.details.jobId).toBe("a1b2c3");
  });

  it("batch completion aggregates with worst-exit-wins", () => {
    const block = (jobId: string, exitCode: number) => ({
      jobId,
      command: "cmd",
      exitCode,
      logFile: "/tmp/x.out",
      logTail: "out\n",
      startedAt: Date.now(),
      output: formatOutput("out\n", {}),
    });
    const { message } = buildBatchCompletion([block("aaaaaa", 0), block("bbbbbb", 3)], options);
    const content = (message as { content: string }).content;
    expect(content).toContain("Background bash finished (2 jobs)");
    expect(content).toContain("exit 3");
  });

  it("footer line names jobs with ids and ages", () => {
    const text = formatBackgroundProcessStatus([
      {
        jobId: "a1b2c3",
        session: "s",
        windowId: "@1",
        runId: "a1b2c3",
        outputFile: "/tmp/x.out",
        command: "sleep 60",
        startedAt: Date.now() - 45000,
        viaTimeoutDetach: false,
        backgrounded: true,
      },
    ])!;
    expect(text).toMatch(/^1 background proc: /);
    expect(text).toContain("a1b2c3");
  });

  it("unknown refs stay unknown (never throw, never touch tmux)", async () => {
    const { executeTool } = await import("../src/runtime");
    const state = stateWith();
    const { pi } = mockPi();
    const ctx = { hasUI: false } as never;
    const peeked = executeTool({ action: "peek", window: "zzzzzz" }, ctx, state, pi, options) as {
      content: { text: string }[];
    };
    expect(peeked.content.map((c) => c.text).join("\n")).toContain("Unknown background job: zzzzzz");
  });

  it("stall warnings carry summary + remediation + steer routing", async () => {
    const { deliverStall } = await import("../src/engine/wiring");
    const state = stateWith();
    const { pi, sent } = mockPi();
    deliverStall(
      pi,
      state,
      options,
      {
        jobId: "a1b2c3",
        windowId: "@1",
        command: "cmd",
        status: "running",
        logFile: "/tmp/x.out",
        exitFile: "/tmp/x.exit",
        startedAt: Date.now(),
        spoolDir: "/tmp/bg-parity/sessions/parity",
      },
      "Continue? (y/n) ",
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].opts).toEqual({ triggerTurn: true, deliverAs: "steer" });
  });

  it("shutdown warns with keep-alive pointer, silent when empty", () => {
    expect(shutdownWarningText([])).toBeUndefined();
    expect(shutdownWarningText([{ command: "sleep 60" }])).toContain("leave-running");
  });
});
