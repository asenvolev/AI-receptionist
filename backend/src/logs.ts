import { format } from "node:util";

const MAX_LINES = 300;
const lines: string[] = [];

/** Recent log lines, newest last. Kept in memory only; gone after a restart. */
export function recentLogs(): string[] {
  return [...lines];
}

export function recordLog(level: string, args: unknown[]): void {
  const time = new Date().toISOString().slice(11, 19);
  lines.push(`${time} ${level === "log" ? "" : `${level.toUpperCase()} `}${format(...args)}`);
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
}

/** Mirror console output into the in-memory buffer (still printed as usual). */
export function captureConsole(): void {
  for (const level of ["log", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      recordLog(level, args);
      original(...args);
    };
  }
}
