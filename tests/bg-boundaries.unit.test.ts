import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { resolveOptions } from "../src/config";
import { registerMessageRenderers } from "../src/renderers/messages";

const root = join(__dirname, "..", "src");

const tsFiles = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "tools" || entry === "renderers") continue;
      out.push(...tsFiles(path));
    } else if (entry.endsWith(".ts")) {
      out.push(path);
    }
  }
  return out;
};

describe("import boundaries (Phase 4)", () => {
  it("engine core never imports TUI (chrome lives in surfaces + fork)", () => {
    const core = [
      ...tsFiles(join(root, "engine")),
      join(root, "config.ts"),
      join(root, "tool-call.ts"),
      join(root, "tool-call-schemas.ts"),
      join(root, "tmux-utils.ts"),
      join(root, "system-prompt.ts"),
    ];
    const offenders = core.filter((path) => readFileSync(path, "utf8").includes("@earendil-works/pi-tui"));
    expect(offenders).toEqual([]);
  });

  it("grammar.ts is import-free (pure data, portable to the fork)", () => {
    const source = readFileSync(join(root, "engine", "grammar.ts"), "utf8");
    expect(source).not.toMatch(/^import /m);
  });
});

describe("chrome-view version", () => {
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as unknown as Theme;
  const options = resolveOptions({ outputDir: "/tmp/bg-bound-test" });

  type Renderer = (
    message: { details?: unknown; content?: string },
    opts: { expanded: boolean },
    theme: Theme,
  ) => { render: (width: number) => string[] };

  const capture = () => {
    const renderers = new Map<string, Renderer>();
    const pi = {
      registerMessageRenderer: vi.fn((type: string, fn: Renderer) => void renderers.set(type, fn)),
    };
    registerMessageRenderers(pi as never, options);
    return renderers;
  };

  it("guards pass v through and default pre-version rows to 1", () => {
    const renderers = capture();
    const render = renderers.get("tmux-bash-completion")!;
    const base = {
      summary: "Background bash finished",
      output: { lines: [{ kind: "output", text: "x" }], empty: false },
      exitCode: 0,
      status: "success",
    };
    const withV = render({ details: { ...base, v: 1 }, content: "raw" }, { expanded: false }, theme);
    expect(withV.render(80).join("\n")).toContain("Ran 1 shell command");
    // Pre-version rows (no v field) still render: default applies.
    const withoutV = render({ details: base, content: "raw" }, { expanded: false }, theme);
    expect(withoutV.render(80).join("\n")).toContain("Ran 1 shell command");
  });
});
