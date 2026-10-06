import { describe, expect, it } from "vitest";
import { resolveOptions } from "../src/config";
import {
  buildBatchCompletion,
  buildLaunchText,
  buildTimeoutText,
  shutdownWarningText,
  completionCustomMessage,
  type BatchBlock,
} from "../src/engine/report";
import { formatBackgroundProcessStatus } from "../src/runtime";
import { formatTmuxOutputForContext as formatOutput } from "../src/render";

const options = resolveOptions({ outputDir: "/tmp/bg-report-snap" });

const block = (overrides: Partial<BatchBlock> = {}): BatchBlock => ({
  jobId: "aaaaaa",
  command: "sleep 60",
  exitCode: 0,
  logFile: "/tmp/x.out",
  logTail: "line-1\nline-2\n",
  startedAt: 1700000000000,
  output: formatOutput("line-1\nline-2\n", {
    fullOutputPath: "/tmp/x.out",
    truncationOptions: { maxLines: 20, maxBytes: 51200 },
  }),
  ...overrides,
});

describe("report builders (frozen strings)", () => {
  it("launch text", () => {
    expect(
      buildLaunchText({
        windowName: "sleep 60",
        windowId: "@1",
        jobId: "aaaaaa",
        logFile: "/tmp/x.out",
        pollSuffix: "",
        followUpLine: "Follow up with /tasks aaaaaa or read /tmp/x.out.",
      }),
    ).toMatchSnapshot();
  });

  it("timeout text (ask + background variants)", () => {
    expect(
      buildTimeoutText({
        text: "partial out",
        timeoutSeconds: 30,
        pollClause: "",
        hint: "Use tmux peek/list/kill to inspect or stop it. Result will be reported when it finishes.",
        timeoutAction: "ask",
        followUpLine: "Follow up with /tasks aaaaaa or read /tmp/x.out.",
        jobId: "aaaaaa",
        logFile: "/tmp/x.out",
      }),
    ).toMatchSnapshot();
    expect(
      buildTimeoutText({
        text: "",
        timeoutSeconds: 30,
        pollClause: " and polling every 10s",
        hint: "Result will be reported when it finishes.",
        timeoutAction: "background",
        followUpLine: "Follow up with /tasks aaaaaa or read /tmp/x.out.",
        jobId: "aaaaaa",
        logFile: "/tmp/x.out",
      }),
    ).toMatchSnapshot();
  });

  it("single completion (success, failed, empty)", () => {
    expect(
      completionCustomMessage(0, block().output, {
        job: {
          jobId: "aaaaaa",
          session: "pi-bg-s",
          windowId: "@1",
          runId: "aaaaaa",
          outputFile: "/tmp/x.out",
          command: "sleep 60",
          startedAt: 1700000000000,
          viaTimeoutDetach: false,
        },
        windowId: "@1",
      }).content,
    ).toMatchSnapshot();
    expect(
      completionCustomMessage(3, formatOutput("boom\n", {}), { windowId: "@9" }).content,
    ).toMatchSnapshot();
  });

  it("batch completion message + notify label", () => {
    const second = block({
      jobId: "bbbbbb",
      command: "pytest auth",
      name: "auth tests",
      exitCode: 1,
      logFile: "/tmp/y.out",
      logTail: "boom\n",
      output: formatOutput("boom\n", {}),
    });
    const { message, notifyLabel, worst } = buildBatchCompletion([block(), second], options);
    expect((message as { content: string }).content).toMatchSnapshot();
    expect((message as { details: unknown }).details).toMatchSnapshot();
    expect({ notifyLabel, worst }).toMatchSnapshot();
  });

  it("footer status line", () => {
    expect(
      formatBackgroundProcessStatus([
        {
          jobId: "aaaaaa",
          session: "s",
          windowId: "@1",
          runId: "aaaaaa",
          command: "sleep 60",
          startedAt: Date.now() - 45000,
          viaTimeoutDetach: false,
          backgrounded: true,
        },
      ]),
    ).toMatchSnapshot();
    expect(formatBackgroundProcessStatus([])).toMatchSnapshot();
  });

  it("shutdown warning", () => {
    expect(shutdownWarningText([])).toMatchSnapshot();
    expect(shutdownWarningText([{ command: "sleep 60" }])).toMatchSnapshot();
    expect(
      shutdownWarningText([
        { command: "a" },
        { command: "b" },
        { command: "c" },
        { name: "n", command: "d" },
      ]),
    ).toMatchSnapshot();
  });
});
