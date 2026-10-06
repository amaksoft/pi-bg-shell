import { describe, expect, it, vi } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { resolveOptions } from "../src/config";
import { registerMessageRenderers } from "../src/renderers/messages";

const theme = {
  fg: (_c: string, t: string) => t,
  bold: (t: string) => t,
} as unknown as Theme;

const options = resolveOptions({ outputDir: "/tmp/bg-render-test" });

type Renderer = (
  message: { details?: unknown; content?: string },
  opts: { expanded: boolean },
  theme: Theme,
) => { render: (width: number) => string[]; handleMouse?: (event: { type: string }) => unknown };

const capture = () => {
  const renderers = new Map<string, Renderer>();
  const pi = {
    registerMessageRenderer: vi.fn((type: string, fn: Renderer) => void renderers.set(type, fn)),
  };
  registerMessageRenderers(pi as never, options);
  return renderers.get("tmux-bash-completion")!;
};

const lines = (texts: string[]) => texts.map((text) => ({ kind: "output", text }));

const details = (
  texts: string[],
  status: "success" | "failed" = "success",
  exitCode = 0,
  extra: Record<string, unknown> = {},
) => ({
  summary: "Background bash finished",
  output: { lines: lines(texts), empty: texts.length === 0 },
  exitCode,
  status,
  jobId: "aaaaaa",
  command: "sleep 60",
  logPath: "/tmp/x.out",
  windowId: "@1",
  ...extra,
});

describe("completion block (claudify mirror grammar)", () => {
  it("single success collapses to aggregate header + verdict, no preview", () => {
    const render = capture();
    const texts = Array.from({ length: 10 }, (_, i) => `line-${i + 1}`);
    const component = render({ details: details(texts), content: "raw" }, { expanded: false }, theme);
    const collapsed = component.render(80).join("\n");
    // Greyed substitution with command name (falls back to raw command here).
    expect(collapsed).toContain("⏺ Bash(Ran 1 shell command: sleep 60 · job aaaaaa)");
    expect(collapsed).toContain("Done (10 lines)");
    expect(collapsed).toContain("⎿");
    expect(collapsed).toContain("(ctrl+o to expand)");
    expect(collapsed).not.toContain("line-10"); // no preview until expanded
    expect(collapsed).not.toContain("click or ctrl");
  });

  it("aggregate header prefers the display name", () => {
    const render = capture();
    const component = render(
      { details: details(["x"], "success", 0, { displayName: "auth tests" }), content: "raw" },
      { expanded: false },
      theme,
    );
    expect(component.render(80).join("\n")).toContain("⏺ Bash(Ran 1 shell command: auth tests · job aaaaaa)");
  });

  it("single failure renders red verdict with keyboard hint", () => {
    const render = capture();
    const component = render(
      { details: details(["boom"], "failed", 3), content: "raw" },
      { expanded: false },
      theme,
    );
    const collapsed = component.render(80).join("\n");
    expect(collapsed).toContain("⏺ Bash(Ran 1 shell command: sleep 60 · job aaaaaa)");
    expect(collapsed).toContain("Exit 3");
    expect(collapsed).toContain("(ctrl+o to expand)");
  });

  it("click toggles between verdict-only and full output, no hints", () => {
    const render = capture();
    const texts = Array.from({ length: 10 }, (_, i) => `line-${i + 1}`);
    const component = render({ details: details(texts), content: "raw" }, { expanded: false }, theme);
    component.handleMouse?.({ type: "click" });
    const expanded = component.render(80).join("\n");
    expect(expanded).toContain("line-1");
    expect(expanded).toContain("line-10");
    expect(expanded).not.toContain("ctrl+o");
    component.handleMouse?.({ type: "click" });
    const back = component.render(80).join("\n");
    expect(back).not.toContain("line-1");
    expect(back).toContain("(ctrl+o to expand)");
  });

  it("initializes open from pi's expanded flag", () => {
    const render = capture();
    const component = render(
      { details: details(["line-one"]), content: "raw" },
      { expanded: true },
      theme,
    );
    expect(component.render(80).join("\n")).toContain("line-one");
  });

  it("empty output renders a static verdict with no hint", () => {
    const render = capture();
    const component = render({ details: details([]), content: "raw" }, { expanded: false }, theme);
    const text = component.render(80).join("\n");
    expect(text).toContain("⏺ Bash(Ran 1 shell command: sleep 60 · job aaaaaa)");
    expect(text).toContain("Done (0 lines)");
    expect(text).not.toContain("ctrl+o");
  });

  it("batch collapses to one aggregate line, expands to per-job blocks", () => {
    const render = capture();
    const jobs = [
      { jobId: "aaaaaa", command: "sleep 60", exitCode: 0, logPath: "/tmp/a.out", tail: "" },
      { jobId: "bbbbbb", command: "pytest auth", exitCode: 0, logPath: "/tmp/b.out", tail: "ok\n" },
      { jobId: "cccccc", command: "build", exitCode: 1, logPath: "/tmp/c.out", tail: "boom\n" },
    ];
    const component = render({ details: details([], "failed", 1, { jobs }), content: "raw" }, { expanded: false }, theme);
    const collapsed = component.render(80).join("\n");
    expect(collapsed).toContain("⏺ Bash(Ran 3 shell commands)");
    expect(collapsed).toContain("Exit 1");
    expect(collapsed).toContain("(ctrl+o to expand)");
    expect(collapsed).not.toContain("job aaaaaa"); // per-job rows live in content

    component.handleMouse?.({ type: "click" });
    const expanded = component.render(80).join("\n");
    expect(expanded).toContain("⏺ Bash($ sleep 60 · job aaaaaa)");
    expect(expanded).toContain("⏺ Bash($ pytest auth · job bbbbbb)");
    expect(expanded).toContain("⏺ Bash($ build · job cccccc)");
    expect(expanded).toContain("Done (1 lines)");
    expect(expanded).toContain("ok");
    expect(expanded).toContain("(no output)");
    expect(expanded).not.toContain("ctrl+o");
  });

  it("all-success batch aggregates without failure verdict", () => {
    const render = capture();
    const jobs = [
      { jobId: "aaaaaa", command: "sleep 60", exitCode: 0, logPath: "/tmp/a.out", tail: "" },
      { jobId: "bbbbbb", command: "sleep 60", exitCode: 0, logPath: "/tmp/b.out", tail: "" },
    ];
    const component = render({ details: details([], "success", 0, { jobs }), content: "raw" }, { expanded: false }, theme);
    const collapsed = component.render(80).join("\n");
    expect(collapsed).toContain("⏺ Bash(Ran 2 shell commands)");
    expect(collapsed).toContain("Done");
    expect(collapsed).not.toContain("failed");
    expect(collapsed).not.toContain("Exit");
  });

  it("degrades to raw content on reshaped details", () => {
    const render = capture();
    const component = render({ details: { nope: true }, content: "fallback-text" }, { expanded: false }, theme);
    expect(component.render(80).join("\n")).toContain("fallback-text");
  });
});

describe("plain-chrome fallback", () => {
  const plainOptions = resolveOptions({ outputDir: "/tmp/bg-render-test", plainChrome: true });

  const capturePlain = () => {
    const renderers = new Map<string, Renderer>();
    const pi = {
      registerMessageRenderer: vi.fn((type: string, fn: Renderer) => void renderers.set(type, fn)),
    };
    registerMessageRenderers(pi as never, plainOptions);
    return renderers;
  };

  it("renders completion content verbatim without blocks", () => {
    const renderers = capturePlain();
    const render = renderers.get("tmux-bash-completion")!;
    const component = render(
      { details: details(["line-one", "line-two"]), content: "raw model text" },
      { expanded: false },
      theme,
    );
    expect(component.render(80).join("\n").trimEnd()).toBe("raw model text");
  });

  it("renders poll content verbatim without blocks", () => {
    const renderers = capturePlain();
    const render = renderers.get("tmux-bash-poll")!;
    const component = render(
      { details: { nope: true }, content: "poll model text" },
      { expanded: false },
      theme,
    );
    expect(component.render(80).join("\n").trimEnd()).toBe("poll model text");
  });
});
