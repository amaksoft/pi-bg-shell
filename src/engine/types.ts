import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JobsWidget } from "../tools/jobs-widget";
import type { Reconciler } from "./reconciler";
import type { Runner, Session } from "./session";

/**
 * Shared kernel types (Phase 4 layering): the structural contract between
 * the engine core, the runtime surfaces, and tools. Type-only module —
 * zero runtime imports, so it can be referenced from anywhere without
 * creating cycles. The remaining runtime↔wiring VALUE flow (tool ops down,
 * delivery/status up) is acknowledged coupling, not accidental.
 */

export type TmuxReadiness = { ok: true; version: string } | { ok: false; error: string };

export type BackgroundJob = {
  /** Engine marker: job lives on the private 1:1 session (peek/kill route there). */
  engine?: { spoolDir: string };
  /** True once backgrounded (started as such or demoted). Widget shows only these. */
  backgrounded?: boolean;
  jobId: string;
  session: string;
  windowId: string;
  runId: string;
  outputFile?: string;
  command: string;
  name?: string;
  startedAt: number;
  viaTimeoutDetach: boolean;
};

export type ForegroundRun = {
  command: string;
  name?: string;
  startedAt: number;
};

export type ExtensionState = {
  statusContext: ExtensionContext | null;
  backgroundJobs: Map<string, BackgroundJob>;
  /** In-flight foreground runs by tool-call ID (insertion-ordered, oldest first). */
  foregroundRuns: Map<string, ForegroundRun>;
  /** Tool-call IDs whose foreground wait must detach to background (Ctrl+B). */
  detachRequested: Set<string>;
  /** Cached tmux presence/version probe (refreshed on session_start). */
  tmuxReady: TmuxReadiness | null;
  /** Engine 1:1 session (private server + sidecar). Null when the engine is down. */
  engine: {
    session: Session;
    runner: Runner;
    reconciler: Reconciler | null;
    widget: JobsWidget | null;
    /** Adopted foreign dirs: dir -> session + takeover nonce. */
    adopted?: Map<string, { session: Session; ownerNonce: string }>;
  } | null;
};
