import { sgrFor, styleTokens } from "./screen.js";
import type { ScreenModel } from "./screen.js";
import type { Snapshot, SnapshotOptions, SnapshotRow, StyleRun } from "./types.js";

export interface BuildSnapshotInput {
  session: string;
  model: ScreenModel;
  /** Whether the screen went quiet before this snapshot was taken. */
  settled: boolean;
  /** ms of silence before the snapshot. */
  quietMs: number;
  revision: number;
  exited: boolean;
  exitCode?: number | null;
  signal?: number | null;
  options?: SnapshotOptions;
  /** Also produce an SGR-styled rendering (used by `--ansi` and PNG input). */
  ansi?: boolean;
}

/**
 * Turn an emulated screen into the thing agents actually read.
 *
 * Text is the default because it is ~50-100x cheaper than an image and never
 * ambiguous about cursor position. The `#` lines carry the facts a plain
 * screenshot would hide: geometry, cursor, whether the app is still drawing,
 * and which spans are highlighted — that last one is how a TUI communicates
 * selection and focus without any visible characters changing.
 */
export function buildSnapshot(input: BuildSnapshotInput): Snapshot {
  const { model, options = {} } = input;
  const visible = model.lines.filter((l) => !l.scrollback);
  const scrollback = model.lines.filter((l) => l.scrollback);

  const rowData: SnapshotRow[] = visible.map((line) => ({
    text: line.text,
    runs: line.runs.filter((r) => r.width > 0),
  }));

  let end = rowData.length;
  if (!options.full) {
    while (end > 0 && rowData[end - 1].text === "" && rowData[end - 1].runs.length === 0) end--;
  }
  const trimmed = rowData.slice(0, end);

  const snapshot: Snapshot = {
    session: input.session,
    cols: model.cols,
    rows: model.rows,
    altScreen: model.altScreen,
    cursor: model.cursor,
    title: model.title || undefined,
    settled: input.settled,
    quietMs: input.quietMs,
    exited: input.exited,
    exitCode: input.exitCode ?? null,
    signal: input.signal ?? null,
    revision: input.revision,
    hash: model.hash,
    lines: trimmed.map((r) => r.text),
    rowData: trimmed,
    scrollback: scrollback.map((l) => l.text),
    text: "",
  };

  snapshot.text = renderText(snapshot, { ...options, ansi: input.ansi, model });
  return snapshot;
}

export interface RenderOptions extends SnapshotOptions {
  ansi?: boolean;
  model?: ScreenModel;
}

/** Header line: everything about the screen that the pixels alone don't say. */
export function renderHeader(snap: Snapshot): string {
  const parts: string[] = [`${snap.cols}x${snap.rows}`, snap.altScreen ? "alt" : "main"];
  parts.push(snap.cursor.visible ? `cursor=${snap.cursor.x},${snap.cursor.y}` : "cursor=hidden");
  parts.push(
    snap.settled ? `settled=${Math.round(snap.quietMs)}ms` : `settled=false quiet=${Math.round(snap.quietMs)}ms`,
  );
  if (snap.title) parts.push(`title="${snap.title.replace(/["\u0000-\u001f]/g, " ")}"`);
  if (snap.exited) parts.push(`exit=${snap.exitCode ?? (snap.signal != null ? `signal ${snap.signal}` : "?")}`);
  if (snap.scrollback.length) parts.push(`scrollback=${snap.scrollback.length}`);
  return `# ${parts.join(" ")}`;
}

interface AttrLine {
  from: number;
  to: number;
  col: string;
  tokens: string;
}

function attrLines(rows: SnapshotRow[]): AttrLine[] {
  // Group by (span, style) first so a border column merges vertically instead
  // of repeating once per row. Then order by row for readability.
  const groups = new Map<string, AttrLine[]>();
  rows.forEach((row, rowIndex) => {
    for (const run of row.runs) {
      const tokens = styleTokens(run.style).join(" ");
      if (!tokens) continue;
      const col = run.width === 1 ? `${run.col}` : `${run.col}-${run.col + run.width - 1}`;
      const key = `${col}|${tokens}`;
      const list = groups.get(key) ?? [];
      const last = list[list.length - 1];
      if (last && last.to === rowIndex - 1) last.to = rowIndex;
      else list.push({ from: rowIndex, to: rowIndex, col, tokens });
      groups.set(key, list);
    }
  });
  const all = [...groups.values()].flat();
  all.sort((a, b) => a.from - b.from || Number.parseInt(a.col, 10) - Number.parseInt(b.col, 10));
  return all;
}

/**
 * The default rendering.
 *
 * ```
 * # 100x30 alt cursor=4,9 settled=71ms title="playnice demo"
 * ┌─ Files ────────┐┌─ Preview ──────────────┐
 * │ main.ts        ││ export const x = 1;    │
 * │ readme.md      ││                        │
 * └────────────────┘└────────────────────────┘
 * # attrs
 * 1:0-15 bold
 * 2:1-14 reverse
 * ```
 */
export function renderText(snap: Snapshot, options: RenderOptions = {}): string {
  const lines: string[] = [];
  if (options.header !== false) lines.push(renderHeader(snap));

  if (snap.scrollback.length) {
    lines.push(...snap.scrollback);
    lines.push("# --- viewport ---");
  }
  lines.push(...snap.lines);

  if (options.attrs !== false) {
    const attrs = attrLines(snap.rowData);
    if (attrs.length) {
      lines.push("# attrs");
      const shown = attrs.slice(0, 60);
      for (const a of shown) {
        const where = a.from === a.to ? `${a.from}` : `${a.from}-${a.to}`;
        lines.push(`${where}:${a.col} ${a.tokens}`);
      }
      if (attrs.length > shown.length) lines.push(`# ... ${attrs.length - shown.length} more`);
    }
  }
  return lines.join("\n");
}

/** SGR-annotated rendering: paste into a terminal to see the real colors. */
export function renderAnsiFromModel(model: ScreenModel, snap: Snapshot): string {
  const out: string[] = [];
  if (snap.scrollback.length) {
    out.push(...snap.scrollback.map((s) => s + "\x1b[0m"));
    out.push(`\x1b[2m# --- viewport ---\x1b[0m`);
  }
  const visible = model.lines.filter((l) => !l.scrollback);
  for (let i = 0; i < snap.lines.length; i++) {
    const line = visible[i];
    if (!line) {
      out.push(snap.lines[i] + "\x1b[0m");
      continue;
    }
    let current = "";
    let text = "";
    for (const cell of line.cells) {
      const sgr = cell.style ? sgrFor(cell.style) : "";
      if (sgr !== current) {
        text += `\x1b[0${sgr ? `;${sgr}` : ""}m`;
        current = sgr;
      }
      text += cell.ch;
    }
    out.push(text + "\x1b[0m");
  }
  return out.join("\n");
}

export interface JsonStyleRun {
  row: number;
  col: number;
  width: number;
  style: Record<string, string | true>;
}

/** Machine-friendly form: flat style runs are easy to assert on. */
export function snapshotToJson(snap: Snapshot): Record<string, unknown> {
  const styles: JsonStyleRun[] = [];
  snap.rowData.forEach((row, rowIndex) => {
    for (const run of row.runs) {
      styles.push({
        row: rowIndex,
        col: run.col,
        width: run.width,
        style: run.style as Record<string, string | true>,
      });
    }
  });
  return {
    session: snap.session,
    cols: snap.cols,
    rows: snap.rows,
    altScreen: snap.altScreen,
    cursor: snap.cursor,
    title: snap.title ?? null,
    settled: snap.settled,
    quietMs: snap.quietMs,
    exited: snap.exited,
    exitCode: snap.exitCode ?? null,
    signal: snap.signal ?? null,
    revision: snap.revision,
    hash: snap.hash,
    scrollback: snap.scrollback,
    lines: snap.lines,
    styles,
    text: snap.text,
  };
}

/** Rows that differ between two snapshots, 0-based, inclusive. */
export function changedRows(before: string[], after: string[]): number[] {
  const out: number[] = [];
  const n = Math.max(before.length, after.length);
  for (let i = 0; i < n; i++) {
    if ((before[i] ?? "") !== (after[i] ?? "")) out.push(i);
  }
  return out;
}

/** Find every occurrence of `needle` in the rendered screen. */
export function findInLines(
  lines: string[],
  needle: string,
): { row: number; col: number }[] {
  const hits: { row: number; col: number }[] = [];
  if (!needle) return hits;
  lines.forEach((line, row) => {
    let from = 0;
    for (;;) {
      const at = line.indexOf(needle, from);
      if (at === -1) break;
      hits.push({ row, col: at });
      from = at + 1;
    }
  });
  return hits;
}

export type { StyleRun };
