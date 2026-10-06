import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";

/**
 * Single home for log-tail reads. Four functions, four contracts — callers
 * pick by need, never reimplement:
 * - readTailLines: last N content lines (tools, delivery text).
 * - readLastLine: last non-blank line, bounded I/O (per-render previews).
 * - readByteSlice: fd range read, "" on error (poll cursors).
 * - readByteTail: fd tail read, "" on error (completion/stall tails).
 */

export const readTailLines = (logFile: string | undefined, maxLines: number): string => {
  if (!logFile || !existsSync(logFile)) return "";
  try {
    const lines = readFileSync(logFile, "utf8").split("\n");
    // Drop the trailing empty element from a final newline.
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-maxLines).join("\n");
  } catch {
    return "";
  }
};

export const readLastLine = (logFile: string | undefined): string => {
  if (!logFile || !existsSync(logFile)) return "";
  try {
    const size = statSync(logFile).size;
    if (size === 0) return "";
    const start = Math.max(0, size - 4096);
    const fd = openSync(logFile, "r");
    try {
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      const lines = buf
        .toString("utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      return lines.length > 0 ? lines[lines.length - 1].slice(0, 100) : "";
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
};

export const readByteSlice = (path: string, from: number, to: number): string => {
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(Math.max(0, to - from));
      readSync(fd, buf, 0, buf.length, from);
      return buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
};

export const readByteTail = (logFile: string, maxBytes: number): string => {
  try {
    const size = statSync(logFile).size;
    const start = Math.max(0, size - maxBytes);
    return readByteSlice(logFile, start, size);
  } catch {
    return "";
  }
};
