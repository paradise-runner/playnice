/**
 * Shared types for playnice.
 *
 * Coordinate convention: every x/y in this package is 0-based and addresses a
 * cell. Column 0 is the leftmost cell, row 0 the topmost visible row. The wire
 * protocols we speak (SGR mouse, CSI) are 1-based, so conversion happens at the
 * boundary only (`src/core/mouse.ts`, `src/core/pty.ts`).
 */

/** Canonical, comparable representation of a cell's visual style. */
export interface CellStyle {
  /** Palette index ("3"), truecolor ("#ff8800"), or undefined for default. */
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  blink?: boolean;
  reverse?: boolean;
  conceal?: boolean;
  strike?: boolean;
  overline?: boolean;
}

export const DEFAULT_STYLE_KEY = "";

/** A maximal horizontal span of cells sharing a non-default style. */
export interface StyleRun {
  /** 0-based inclusive start column. */
  col: number;
  /** Number of cells covered. */
  width: number;
  style: CellStyle;
}

export interface SnapshotRow {
  text: string;
  runs: StyleRun[];
}

export interface SnapshotCursor {
  x: number;
  y: number;
  visible: boolean;
}

export interface Snapshot {
  /** Session id this snapshot came from. */
  session: string;
  cols: number;
  rows: number;
  /** True when the app is on the alternate screen (full-screen TUI). */
  altScreen: boolean;
  cursor: SnapshotCursor;
  /** Window title (OSC 0/2), if the app set one. */
  title?: string;
  /** Whether the screen had been quiet for `quietMs` when this was taken. */
  settled: boolean;
  /** Milliseconds between the last output and this snapshot. */
  quietMs: number;
  /** True when the child process has exited. */
  exited: boolean;
  exitCode?: number | null;
  signal?: number | null;
  /** Monotonic revision, bumped whenever screen content changes. */
  revision: number;
  /** Content hash of the visible screen (cursor excluded). */
  hash: string;
  /** Visible rows, top to bottom, right-trimmed. */
  lines: string[];
  /** Visible rows with style runs attached (parallel to `lines`). */
  rowData: SnapshotRow[];
  /** Extra context lines requested above the viewport. */
  scrollback: string[];
  /** Rendered "screenshot" — what the CLI and MCP tools show by default. */
  text: string;
  /** SGR-styled rendering, present when format `ansi` was requested. */
  ansi?: string;
}

export type SnapshotFormat = "text" | "ansi" | "json";

export interface SnapshotOptions {
  /** Include `# attrs` lines describing colors/reverse video. Default true. */
  attrs?: boolean;
  /** Include the `# screen ...` header line. Default true. */
  header?: boolean;
  /** Number of scrollback lines to include above the viewport. Default 0. */
  scrollback?: number;
  /** Keep trailing blank rows instead of trimming them. Default false. */
  full?: boolean;
}

export interface SettleOptions {
  /** Quiet period in ms that counts as "the app stopped drawing". */
  quietMs?: number;
  /** Give up and return what is on screen. */
  timeoutMs?: number;
}

export interface OpenOptions {
  /** Executable to run. Defaults to $SHELL (or /bin/sh). */
  command?: string;
  args?: string[];
  cwd?: string;
  /** Extra environment variables, merged over the daemon's environment. */
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  /** Scrollback lines to retain in the emulator. Default 2000. */
  scrollback?: number;
  /** Friendly name, used when no explicit id is given. */
  name?: string;
  /** Explicit session id. */
  id?: string;
}

export interface SessionSummary {
  id: string;
  name?: string;
  command: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  altScreen: boolean;
  exited: boolean;
  exitCode?: number | null;
  pid: number;
  createdAt: number;
  lastActivityAt: number;
  /** Seconds since the last output. */
  idleFor: number;
  title?: string;
}

export type MouseButton = "left" | "middle" | "right";

export interface MouseModifiers {
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
}

export interface WaitSpec {
  /** Wait until this literal text is on screen. */
  text?: string;
  /** Wait until this regex matches the screen. */
  regex?: string;
  /** Wait until this text is no longer on screen. */
  gone?: string;
  /** Wait for N ms of output silence. */
  quietMs?: number;
  /** Wait for the child process to exit. */
  exit?: boolean;
  /** Extra predicate on the rendered text. Not available over the wire. */
  predicate?: (snapshot: Snapshot) => boolean;
  timeoutMs?: number;
}

export interface WaitResult {
  met: boolean;
  waitedMs: number;
  reason?: string;
  snapshot: Snapshot;
}
