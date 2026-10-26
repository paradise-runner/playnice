import { createHash } from "node:crypto";
import xt from "@xterm/headless";
import type { Terminal as XTermTerminal, IBufferCell, IBufferLine } from "@xterm/headless";
import type { CellStyle, SnapshotCursor, StyleRun } from "./types.js";

// @xterm/headless is CommonJS; named imports break under Node ESM.
const { Terminal } = xt as unknown as { Terminal: typeof XTermTerminal };

export interface ScreenCell {
  /** Text of the cell. Wide characters live in the head cell only. */
  ch: string;
  /** Column width: 1, or 2 for CJK/emoji. */
  w: number;
  /** undefined when the cell is visually default. */
  style?: CellStyle;
}

export interface ScreenLine {
  /** Cells from column 0 up to the last non-default one (right-trimmed). */
  cells: ScreenCell[];
  /** Plain text of the row. */
  text: string;
  /** Maximal styled spans, in column order. */
  runs: StyleRun[];
  /** Number of columns the row occupies after trimming. */
  width: number;
  /** Absolute buffer index, for stable diagnostics. */
  index: number;
  /** True for rows above the visible viewport. */
  scrollback: boolean;
}

export interface ScreenModel {
  cols: number;
  rows: number;
  altScreen: boolean;
  cursor: SnapshotCursor;
  title: string | undefined;
  lines: ScreenLine[];
  /** Content hash of the viewport; cursor position is excluded so blinking
   *  cursors never look like activity. */
  hash: string;
  synchronizedOutput: boolean;
  mouseTracking: string;
  bracketedPaste: boolean;
  applicationCursorKeys: boolean;
}

interface StyleBucket {
  style: CellStyle;
  key: string;
}

const DEFAULT_BUCKET: StyleBucket = { style: {}, key: "" };

function colorId(cell: IBufferCell, kind: "fg" | "bg"): string | undefined {
  if (kind === "fg") {
    if (cell.isFgDefault()) return undefined;
    const v = cell.getFgColor();
    return cell.isFgRGB() ? `#${v.toString(16).padStart(6, "0")}` : String(v);
  }
  if (cell.isBgDefault()) return undefined;
  const v = cell.getBgColor();
  return cell.isBgRGB() ? `#${v.toString(16).padStart(6, "0")}` : String(v);
}

/** Compact, comparable description of a cell's appearance. */
export function styleOf(cell: IBufferCell): StyleBucket {
  // The is*() accessors return bit fields, not booleans.
  const bold = cell.isBold() !== 0;
  const dim = cell.isDim() !== 0;
  const italic = cell.isItalic() !== 0;
  const underline = cell.isUnderline() !== 0;
  const blink = cell.isBlink() !== 0;
  const reverse = cell.isInverse() !== 0;
  const conceal = cell.isInvisible() !== 0;
  const strike = cell.isStrikethrough() !== 0;
  const overline = cell.isOverline() !== 0;
  const fg = colorId(cell, "fg");
  const bg = colorId(cell, "bg");

  if (
    !bold && !dim && !italic && !underline && !blink && !reverse && !conceal && !strike && !overline && !fg && !bg
  ) {
    return DEFAULT_BUCKET;
  }

  const style: CellStyle = {};
  if (fg) style.fg = fg;
  if (bg) style.bg = bg;
  if (bold) style.bold = true;
  if (dim) style.dim = true;
  if (italic) style.italic = true;
  if (underline) style.underline = true;
  if (blink) style.blink = true;
  if (reverse) style.reverse = true;
  if (conceal) style.conceal = true;
  if (strike) style.strike = true;
  if (overline) style.overline = true;

  const flags =
    (bold ? "b" : "") + (dim ? "d" : "") + (italic ? "i" : "") +
    (underline ? "u" : "") + (blink ? "k" : "") + (reverse ? "r" : "") +
    (conceal ? "v" : "") + (strike ? "s" : "") + (overline ? "o" : "");
  return { style, key: `${flags}|${fg ?? ""}|${bg ?? ""}` };
}

/** SGR parameter string (without the `ESC [ ... m` wrapper) for a style. */
export function sgrFor(style: CellStyle): string {
  if (!style) return "";
  const parts: string[] = [];
  if (style.bold) parts.push("1");
  if (style.dim) parts.push("2");
  if (style.italic) parts.push("3");
  if (style.underline) parts.push("4");
  if (style.blink) parts.push("5");
  if (style.reverse) parts.push("7");
  if (style.conceal) parts.push("8");
  if (style.strike) parts.push("9");
  if (style.overline) parts.push("53");
  if (style.fg) parts.push(colorParams(style.fg, 38));
  if (style.bg) parts.push(colorParams(style.bg, 48));
  return parts.join(";");
}

function colorParams(color: string, base: number): string {
  if (color.startsWith("#")) {
    const n = parseInt(color.slice(1), 16);
    return `${base};2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
  }
  const idx = Number(color);
  if (idx < 8) return String(base - 8 + idx); // 30-37 / 40-47
  if (idx < 16) return String(base + 52 + (idx - 8)); // 90-97 / 100-107
  return `${base};5;${idx}`;
}

/** Human-readable style tokens, e.g. ["bold", "fg=2"]. */
export function styleTokens(style: CellStyle): string[] {
  const out: string[] = [];
  if (style.bold) out.push("bold");
  if (style.dim) out.push("dim");
  if (style.italic) out.push("italic");
  if (style.underline) out.push("underline");
  if (style.blink) out.push("blink");
  if (style.reverse) out.push("reverse");
  if (style.conceal) out.push("conceal");
  if (style.strike) out.push("strike");
  if (style.overline) out.push("overline");
  if (style.fg) out.push(`fg=${style.fg}`);
  if (style.bg) out.push(`bg=${style.bg}`);
  return out;
}

export interface ScreenOptions {
  cols: number;
  rows: number;
  scrollback?: number;
}

/**
 * The emulated terminal: a pty's byte stream goes in, a readable grid comes out.
 * Holds no pty itself, so it can also replay recorded sessions.
 */
export class Screen {
  readonly term: XTermTerminal;
  private title: string | undefined;
  private cursorVisible = true;
  /** Tail kept to catch mode sequences split across chunk boundaries. */
  private scanTail = "";
  private disposed = false;

  constructor(opts: ScreenOptions) {
    this.term = new Terminal({
      cols: opts.cols,
      rows: opts.rows,
      scrollback: opts.scrollback ?? 2000,
      allowProposedApi: true,
      // Agents read final state, so keep SGR colors exactly as the app sent them.
      drawBoldTextInBrightColors: false,
      convertEol: false,
    });
    this.term.onTitleChange((title) => {
      this.title = title;
    });
  }

  get cols(): number {
    return this.term.cols;
  }

  get rows(): number {
    return this.term.rows;
  }

  write(data: string): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.scan(data);
    return new Promise((resolve) => {
      this.term.write(data, () => resolve());
    });
  }

  /** Track cursor visibility; xterm does not surface DECTCEM. */
  private scan(data: string): void {
    const haystack = this.scanTail + data;
    let idx = 0;
    for (;;) {
      const h = haystack.indexOf("\x1b[?25", idx);
      if (h === -1) break;
      const next = haystack[h + 5];
      if (next === "h") this.cursorVisible = true;
      else if (next === "l") this.cursorVisible = false;
      idx = h + 5;
    }
    // Keep enough tail to match a sequence split across chunks.
    this.scanTail = haystack.slice(-8);
  }

  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows);
  }

  dispose(): void {
    this.disposed = true;
    this.term.dispose();
  }

  /** True when the app is on the alternate screen buffer. */
  get altScreen(): boolean {
    return this.term.buffer.active.type === "alternate";
  }

  /** Bracketed paste (DECSET 2004) — text with newlines must be wrapped. */
  get bracketedPaste(): boolean {
    return this.term.modes.bracketedPasteMode;
  }

  /** Application cursor keys (DECCKM) — arrows become SS3 sequences. */
  get applicationCursorKeys(): boolean {
    return this.term.modes.applicationCursorKeysMode;
  }

  /** Read the visible screen (plus optional scrollback) and hash it. */
  read(scrollbackLines = 0): ScreenModel {
    const buffer = this.term.buffer.active;
    const { cols, rows } = this.term;
    const top = buffer.viewportY;
    const lines: ScreenLine[] = [];
    const amount = Math.max(0, scrollbackLines);

    for (let index = Math.max(0, top - amount); index < top + rows; index++) {
      const line = buffer.getLine(index);
      if (!line) continue;
      lines.push(this.readLine(line, index, cols, index < top));
    }

    const cursor: SnapshotCursor = {
      x: buffer.cursorX,
      y: buffer.cursorY,
      visible: this.cursorVisible,
    };

    return {
      cols,
      rows,
      altScreen: buffer.type === "alternate",
      cursor,
      title: this.title,
      lines,
      hash: hashLines(lines.filter((l) => !l.scrollback), cols, buffer.type === "alternate"),
      synchronizedOutput: this.term.modes.synchronizedOutputMode,
      mouseTracking: this.term.modes.mouseTrackingMode,
      bracketedPaste: this.term.modes.bracketedPasteMode,
      applicationCursorKeys: this.term.modes.applicationCursorKeysMode,
    };
  }

  private readLine(line: IBufferLine, index: number, cols: number, scrollback: boolean): ScreenLine {
    const nullCell = this.term.buffer.active.getNullCell();
    const raw: ScreenCell[] = [];
    const runs: StyleRun[] = [];

    let runStart = -1;
    let runKey = "";
    let runStyle: CellStyle = {};
    let runWidth = 0;

    for (let col = 0; col < cols; col++) {
      const cell = line.getCell(col, nullCell);
      if (!cell) {
        raw.push({ ch: " ", w: 1 });
        continue;
      }
      const w = cell.getWidth();
      if (w === 0) continue; // continuation of a wide character
      const bucket = styleOf(cell);
      const ch = cell.getChars() || " ";
      const entry: ScreenCell = { ch, w };
      if (bucket.key) entry.style = bucket.style;
      raw.push(entry);

      if (bucket.key !== runKey) {
        if (runStart >= 0) runs.push({ col: runStart, width: runWidth, style: runStyle });
        runStart = bucket.key ? col : -1;
        runKey = bucket.key;
        runStyle = bucket.style;
        runWidth = bucket.key ? w : 0;
      } else if (runStart >= 0) {
        runWidth += w;
      }
    }
    if (runStart >= 0) runs.push({ col: runStart, width: runWidth, style: runStyle });

    // Trim trailing blanks that cannot be seen. A blank is content when it
    // carries a background, reverse video, or a decoration — that is how TUIs
    // paint panels, selections and rules. A blank that only has a foreground
    // colour is invisible, and editors colour their whole line range: trimming
    // those keeps screenshots from carrying a screenful of dead spaces.
    let keep = 0;
    for (let i = 0; i < raw.length; i++) {
      const cell = raw[i];
      const s = cell.style;
      const visible = s ? Boolean(s.bg || s.reverse || s.underline || s.strike || s.overline || s.conceal) : false;
      if (visible || (cell.ch !== " " && cell.ch !== "")) keep = i + 1;
    }

    const cells = raw.slice(0, keep);
    return {
      cells,
      text: cells.map((c) => c.ch).join(""),
      runs: runs.filter((r) => r.col < keep),
      width: keep,
      index,
      scrollback,
    };
  }
}

function hashLines(lines: ScreenLine[], cols: number, alt: boolean): string {
  const h = createHash("sha1");
  h.update(`${cols}:${lines.length}:${alt ? "alt" : "main"}\u0000`);
  for (const line of lines) {
    h.update(line.text);
    h.update("\u0001");
    for (const run of line.runs) {
      const s = run.style;
      h.update(`${run.col},${run.width},${s.fg ?? ""},${s.bg ?? ""}`);
      if (s.bold) h.update("b");
      if (s.dim) h.update("d");
      if (s.italic) h.update("i");
      if (s.underline) h.update("u");
      if (s.reverse) h.update("r");
      if (s.strike) h.update("s");
      h.update(";");
    }
    h.update("\u0002");
  }
  return h.digest("base64url").slice(0, 16);
}
