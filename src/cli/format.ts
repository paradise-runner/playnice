import { snapshotToJson } from "../core/snapshot.js";
import type { ActionResult } from "../core/session.js";
import type { SessionSummary, Snapshot } from "../core/types.js";

const useColor = (): boolean =>
  Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb";

const dim = (text: string): string => (useColor() ? `\x1b[2m${text}\x1b[0m` : text);

export interface PrintOptions {
  json?: boolean;
  ansi?: boolean;
  quiet?: boolean;
}

/** Print a snapshot: rendered text by default, SGR or JSON on request. */
export function printSnapshot(snapshot: Snapshot, opts: PrintOptions = {}): void {
  if (opts.quiet) return;
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(snapshotToJson(snapshot), null, 2)}\n`);
    return;
  }
  const body = opts.ansi ? snapshot.ansi ?? snapshot.text : snapshot.text;
  process.stdout.write(body.endsWith("\n") ? body : `${body}\n`);
}

/**
 * Print the result of an action. The screen itself goes to stdout (so it can be
 * piped), the metadata an agent needs to decide what to do next goes to stderr.
 */
export function printAction(action: ActionResult, opts: PrintOptions = {}): void {
  const status = [
    action.changed ? "changed" : "no-change",
    action.settled ? `settled ${Math.round(action.waitedMs)}ms` : "still-drawing",
    `rev ${action.snapshot.revision}`,
  ].join(" · ");
  process.stderr.write(`${dim(`# ${action.snapshot.session} ${status}`)}\n`);
  printSnapshot(action.snapshot, opts);
}

export function formatSessionTable(sessions: SessionSummary[]): string {
  if (!sessions.length) return "no sessions";
  const rows = sessions.map((s) => {
    const cmd = [s.command, ...s.args].join(" ");
    const status = s.exited ? `exited(${s.exitCode ?? "?"})` : "running";
    const alt = s.altScreen ? "alt" : "main";
    return {
      id: s.id,
      size: `${s.cols}x${s.rows}`,
      screen: alt,
      status,
      idle: `${s.idleFor}s`,
      pid: String(s.pid),
      title: truncate(s.title ?? "", 28),
      cmd: truncate(cmd, 40),
    };
  });
  const headers = { id: "ID", size: "SIZE", screen: "SCREEN", status: "STATUS", idle: "IDLE", pid: "PID", title: "TITLE", cmd: "COMMAND" };
  const keys = Object.keys(headers) as (keyof typeof headers)[];
  const widths = new Map<keyof typeof headers, number>();
  for (const key of keys) {
    widths.set(key, Math.max(headers[key].length, ...rows.map((r) => r[key].length)));
  }
  const line = (row: Record<string, string>) =>
    keys.map((key) => row[key].padEnd(widths.get(key) ?? 0)).join("  ").trimEnd();
  return [line(headers), ...rows.map((row) => line(row as unknown as Record<string, string>))].join("\n");
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function note(message: string): void {
  process.stderr.write(`${dim(`# ${message}`)}\n`);
}

export function fail(message: string, exitCode = 1): never {
  process.stderr.write(`playnice: ${message}\n`);
  process.exit(exitCode);
}
