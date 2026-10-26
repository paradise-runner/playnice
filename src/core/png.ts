import { existsSync } from "node:fs";
import type { Canvas, SKRSContext2D } from "@napi-rs/canvas";
import type { ScreenModel } from "./screen.js";
import type { CellStyle } from "./types.js";

export interface ScreenshotOptions {
  /** Pixel ratio. 2 gives crisp text on every display. Default 2. */
  scale?: number;
  /** Font size in CSS pixels. Default 14. */
  fontSize?: number;
  /** Preferred font families, tried in order. */
  fontFamily?: string[];
  /** Padding around the screen, in CSS pixels. Default 10. */
  padding?: number;
  theme?: Partial<Theme>;
  /** Draw the cursor cell. Default true. */
  cursor?: boolean;
  /** Draw box-drawing/block characters as geometry. Default true. */
  boxDrawing?: boolean;
}

export interface Theme {
  background: string;
  foreground: string;
  cursor: string;
  /** ANSI 0-15. */
  palette: string[];
}

/**
 * Box-drawing, block-element and box-shade characters that are drawn as
 * geometry instead of glyphs.
 */
const BOX_ARMS: Record<string, [up: number, down: number, left: number, right: number]> = {
  // 0 = none, 1 = single, 2 = double
  "─": [0, 0, 1, 1],
  "│": [1, 1, 0, 0],
  "┌": [0, 1, 0, 1],
  "┐": [0, 1, 1, 0],
  "└": [1, 0, 0, 1],
  "┘": [1, 0, 1, 0],
  "├": [1, 1, 0, 1],
  "┤": [1, 1, 1, 0],
  "┬": [0, 1, 1, 1],
  "┴": [1, 0, 1, 1],
  "┼": [1, 1, 1, 1],
  "╴": [0, 0, 1, 0],
  "╵": [1, 0, 0, 0],
  "╶": [0, 0, 0, 1],
  "╷": [0, 1, 0, 0],
  "═": [0, 0, 2, 2],
  "║": [2, 2, 0, 0],
  "╒": [0, 2, 0, 2],
  "╓": [0, 2, 0, 2],
  "╔": [0, 2, 0, 2],
  "╕": [0, 2, 2, 0],
  "╖": [0, 2, 2, 0],
  "╗": [0, 2, 2, 0],
  "╘": [2, 0, 1, 1],
  "╙": [2, 0, 2, 2],
  "╚": [2, 0, 2, 2],
  "╛": [2, 0, 2, 2],
  "╜": [2, 0, 2, 2],
  "╝": [2, 0, 2, 2],
  "╞": [2, 2, 0, 1],
  "╟": [2, 2, 0, 2],
  "╠": [2, 2, 0, 2],
  "╡": [2, 2, 1, 0],
  "╢": [2, 2, 2, 0],
  "╣": [2, 2, 2, 0],
  "╥": [0, 2, 2, 2],
  "╤": [0, 2, 2, 2],
  "╦": [0, 2, 2, 2],
  "╧": [2, 0, 2, 2],
  "╨": [2, 0, 2, 2],
  "╩": [2, 0, 2, 2],
  "╪": [2, 2, 2, 2],
  "╫": [2, 2, 2, 2],
  "╬": [2, 2, 2, 2],
};

const ROUNDED: Record<string, "tl" | "tr" | "bl" | "br"> = {
  "╭": "tl",
  "╮": "tr",
  "╯": "br",
  "╰": "bl",
};

const BLOCKS = new Set([
  "█", "▀", "▄", "▌", "▐", "░", "▒", "▓",
  "▁", "▂", "▃", "▅", "▆", "▇",
  "▏", "▎", "▍", "▋", "▊", "▉",
]);

export function isTerminalArt(ch: string): boolean {
  return ch in BOX_ARMS || ch in ROUNDED || BLOCKS.has(ch);
}

function drawTerminalArt(
  ctx: SKRSContext2D,
  ch: string,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  fontSize: number,
  theme: Theme,
): boolean {
  const cx = Math.round(x + w / 2);
  const cy = Math.round(y + h / 2);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;

  const rounded = ROUNDED[ch];
  if (rounded) {
    const rx = w / 2;
    const ry = h / 2;
    let ecx = cx;
    let ecy = cy;
    let start = 0;
    let end = 0;
    if (rounded === "tl") [ecx, ecy, start, end] = [x + w, y + h, Math.PI, Math.PI * 1.5];
    if (rounded === "tr") [ecx, ecy, start, end] = [x, y + h, Math.PI * 1.5, Math.PI * 2];
    if (rounded === "br") [ecx, ecy, start, end] = [x, y, 0, Math.PI * 0.5];
    if (rounded === "bl") [ecx, ecy, start, end] = [x + w, y, Math.PI * 0.5, Math.PI];
    ctx.lineWidth = Math.max(1, fontSize / 14);
    ctx.beginPath();
    ctx.ellipse(ecx, ecy, rx, ry, 0, start, end);
    ctx.stroke();
    ctx.restore();
    return true;
  }

  const arms = BOX_ARMS[ch];
  if (arms) {
    const [up, down, left, right] = arms;
    const t = Math.max(1, Math.round(fontSize / 14));
    const gap = t + 1.5;
    // A double arm is two parallel lines; the centre line is shared by singles.
    const line = (x1: number, y1: number, x2: number, y2: number) => {
      ctx.lineWidth = t;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    };
    const vertical = (style: number) => {
      if (style === 1) line(cx, y, cx, y + h);
      else if (style === 2) {
        line(cx - gap, y, cx - gap, y + h);
        line(cx + gap, y, cx + gap, y + h);
      }
    };
    const horizontal = (style: number) => {
      if (style === 1) line(x, cy, x + w, cy);
      else if (style === 2) {
        line(x, cy - gap, x + w, cy - gap);
        line(x, cy + gap, x + w, cy + gap);
      }
    };
    // Corners need the arms to stop at the crossing, not overshoot it.
    if (up) {
      if (up === 1) line(cx, y, cx, cy);
      else {
        line(cx - gap, y, cx - gap, cy);
        line(cx + gap, y, cx + gap, cy);
      }
    }
    if (down) {
      if (down === 1) line(cx, cy, cx, y + h);
      else {
        line(cx - gap, cy, cx - gap, y + h);
        line(cx + gap, cy, cx + gap, y + h);
      }
    }
    if (left) {
      if (left === 1) line(x, cy, cx, cy);
      else {
        line(x, cy - gap, cx, cy - gap);
        line(x, cy + gap, cx, cy + gap);
      }
    }
    if (right) {
      if (right === 1) line(cx, cy, x + w, cy);
      else {
        line(cx, cy - gap, x + w, cy - gap);
        line(cx, cy + gap, x + w, cy + gap);
      }
    }
    ctx.restore();
    return true;
  }

  if (BLOCKS.has(ch)) {
    const full = (alpha: number, rect: [number, number, number, number]) => {
      ctx.globalAlpha = alpha;
      ctx.fillRect(...rect);
    };
    switch (ch) {
      case "█":
        ctx.fillRect(x, y, w, h);
        break;
      case "▀":
        ctx.fillRect(x, y, w, h / 2);
        break;
      case "▄":
        ctx.fillRect(x, y + h / 2, w, h / 2);
        break;
      case "▌":
        ctx.fillRect(x, y, w / 2, h);
        break;
      case "▐":
        ctx.fillRect(x + w / 2, y, w / 2, h);
        break;
      case "░":
        ctx.globalAlpha = 0.25;
        ctx.fillRect(x, y, w, h);
        break;
      case "▒":
        ctx.globalAlpha = 0.5;
        ctx.fillRect(x, y, w, h);
        break;
      case "▓":
        ctx.globalAlpha = 0.75;
        ctx.fillRect(x, y, w, h);
        break;
      default: {
        // Bottom-aligned eighths (▁▂▃▅▆▇) and left-aligned eighths (▏▎▍▋▊▉).
        const eighths: Record<string, number> = {
          "▁": 1, "▂": 2, "▃": 3, "▅": 5, "▆": 6, "▇": 7,
          "▏": 1, "▎": 2, "▍": 3, "▋": 5, "▊": 6, "▉": 7,
        };
        const n = eighths[ch] ?? 1;
        if ("▁▂▃▅▆▇".includes(ch)) ctx.fillRect(x, y + h - (h * n) / 8, w, (h * n) / 8);
        else ctx.fillRect(x, y, (w * n) / 8, h);
        break;
      }
    }
    ctx.restore();
    return true;
  }

  ctx.restore();
  return false;
}

export const DEFAULT_THEME: Theme = {
  background: "#1b1b1f",
  foreground: "#d6d6d6",
  cursor: "#7aa2f7",
  palette: [
    "#1b1b1f",
    "#e06c75",
    "#98c379",
    "#e5c07b",
    "#61afef",
    "#c678dd",
    "#56b6c2",
    "#dcdfe4",
    "#5c6370",
    "#ff7b86",
    "#b5e890",
    "#f5d38a",
    "#7cc0ff",
    "#e09ce6",
    "#6fd0dc",
    "#ffffff",
  ],
};

const KNOWN_PATHS = [
  "/System/Library/Fonts/Menlo.ttc",
  "/System/Library/Fonts/Monaco.ttf",
  "/Library/Fonts/Andale Mono.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
  "/usr/share/fonts/dejavu/DejaVuSansMono.ttf",
  "/usr/share/fonts/TTF/DejaVuSansMono.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf",
  "/usr/share/fonts/truetype/ubuntu/UbuntuMono-R.ttf",
  "C:\\Windows\\Fonts\\consola.ttf",
];

type CanvasModule = typeof import("@napi-rs/canvas");

let canvasModule: Promise<CanvasModule> | undefined;

/**
 * Loaded on demand: the daemon should not pay for a rasterizer (and its native
 * font stack) unless someone actually asks for a PNG.
 */
async function loadCanvas(): Promise<CanvasModule> {
  canvasModule ??= import("@napi-rs/canvas");
  return canvasModule;
}

const PREFERRED = [
  "Menlo",
  "SF Mono",
  "Monaco",
  "JetBrains Mono",
  "Fira Code",
  "Cascadia Mono",
  "Consolas",
  "DejaVu Sans Mono",
  "Liberation Mono",
  "Ubuntu Mono",
  "Andale Mono",
  "Courier New",
];

const FALLBACKS = [
  // Another monospace first: box-drawing and symbols then keep their metrics.
  "Monaco",
  "Courier New",
  "Andale Mono",
  "DejaVu Sans Mono",
  "Liberation Mono",
  "Hiragino Sans GB",
  "PingFang SC",
  "Noto Sans CJK SC",
  "Source Han Sans SC",
  "Microsoft YaHei",
  "Apple Color Emoji",
  "Segoe UI Emoji",
  "Noto Color Emoji",
  "Symbol",
  "sans-serif",
];

/** Terminal fonts rarely cover CJK or emoji; Skia falls back per glyph when the
 *  font list names more than one family. */
function resolveFont(mod: CanvasModule, requested: string[] | undefined): { family: string; stack: string } {
  const { GlobalFonts } = mod;
  const available = new Set<string>(GlobalFonts.families.map((f) => String(f.family)));
  const withFallbacks = (family: string): { family: string; stack: string } => {
    const extras = FALLBACKS.filter((name) => available.has(name));
    const stack = [`"${family}"`, ...extras.map((name) => `"${name}"`), "monospace"].join(", ");
    return { family, stack };
  };

  for (const name of requested ?? []) {
    if (available.has(name)) return withFallbacks(name);
  }
  for (const name of PREFERRED) {
    if (available.has(name)) return withFallbacks(name);
  }
  for (const path of KNOWN_PATHS) {
    if (!existsSync(path)) continue;
    const registered = GlobalFonts.registerFromPath(path);
    if (registered) {
      // FontKey carries the family name the platform resolved.
      const family = (registered as unknown as { family?: string }).family;
      if (family && available.has(family)) return withFallbacks(family);
      const match = GlobalFonts.families.find((f) => f.family === family);
      if (match) return withFallbacks(match.family);
    }
  }
  // Last resort: let the platform substitute; layout may drift but it renders.
  return { family: "monospace", stack: "monospace" };
}

const CUBE = [0, 95, 135, 175, 215, 255];

/** Resolve an ANSI colour id ("3", "#ff8800") to a CSS colour. */
export function colorToCss(color: string | undefined, theme: Theme, fallback: "fg" | "bg"): string {
  if (!color) return fallback === "fg" ? theme.foreground : theme.background;
  if (color.startsWith("#")) return color;
  const idx = Number(color);
  if (!Number.isFinite(idx)) return fallback === "fg" ? theme.foreground : theme.background;
  if (idx < 16) return theme.palette[idx] ?? (fallback === "fg" ? theme.foreground : theme.background);
  if (idx < 232) {
    const n = idx - 16;
    const r = CUBE[Math.floor(n / 36) % 6];
    const g = CUBE[Math.floor(n / 6) % 6];
    const b = CUBE[n % 6];
    return `rgb(${r},${g},${b})`;
  }
  if (idx < 256) {
    const level = 8 + (idx - 232) * 10;
    return `rgb(${level},${level},${level})`;
  }
  return fallback === "fg" ? theme.foreground : theme.background;
}

function fontSpec(style: CellStyle | undefined, size: number, stack: string): string {
  const parts: string[] = [];
  if (style?.italic) parts.push("italic");
  if (style?.bold) parts.push("bold");
  parts.push(`${size}px`);
  parts.push(stack);
  return parts.join(" ");
}

/**
 * Rasterize the emulated screen.
 *
 * Text snapshots are the default because they are cheap and exact, but colour,
 * alignment and unicode width are genuinely visual properties. This is the
 * "screenshot" half of the pair.
 */
export async function renderPng(model: ScreenModel, options: ScreenshotOptions = {}): Promise<Buffer> {
  const mod = await loadCanvas();
  const { createCanvas } = mod;
  const theme: Theme = { ...DEFAULT_THEME, ...options.theme };
  const scale = options.scale ?? 2;
  const fontSize = options.fontSize ?? 14;
  const padding = options.padding ?? 10;
  const { stack } = resolveFont(mod, options.fontFamily);

  const probe = createCanvas(10, 10).getContext("2d");
  probe.font = fontSpec(undefined, fontSize, stack);
  const advance = probe.measureText("M").width;
  const cellWidth = Math.max(1, Math.round(advance * 100) / 100);
  const cellHeight = Math.round(fontSize * 1.35);
  const cols = model.cols;
  const rows = model.rows;

  const width = Math.ceil(cols * cellWidth + padding * 2);
  const height = Math.ceil(rows * cellHeight + padding * 2);
  const canvas: Canvas = createCanvas(Math.round(width * scale), Math.round(height * scale));
  const ctx: SKRSContext2D = canvas.getContext("2d");
  ctx.scale(scale, scale);
  ctx.textBaseline = "middle";
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, width, height);

  const visible = model.lines.filter((l) => !l.scrollback);

  // Backgrounds first, so glyphs from neighbouring cells never get covered.
  ctx.fillStyle = theme.background;
  for (let row = 0; row < visible.length && row < rows; row++) {
    const line = visible[row];
    const y = padding + row * cellHeight;
    let col = 0;
    for (const cell of line.cells) {
      const style = cell.style;
      if (style && (style.bg || style.reverse)) {
        const bg = style.reverse
          ? colorToCss(style.fg, theme, "fg")
          : colorToCss(style.bg, theme, "bg");
        if (bg !== theme.background) {
          ctx.fillStyle = bg;
          const w = Math.max(1, cell.w) * cellWidth;
          ctx.fillRect(padding + col * cellWidth, y, w, cellHeight);
        }
      }
      col += Math.max(1, cell.w);
    }
  }

  // Box drawing and block elements are geometry, not glyphs: fonts size them
  // for their own line box, which leaves visible gaps at any cell height.
  // Drawing them as lines is what terminal emulators do, and it is the
  // difference between a screenshot that looks right and one that does not.
  if (options.boxDrawing !== false) {
    for (let row = 0; row < visible.length && row < rows; row++) {
      const line = visible[row];
      const top = padding + row * cellHeight;
      let col = 0;
      for (const cell of line.cells) {
        const w = Math.max(1, cell.w);
        const x = padding + col * cellWidth;
        const fg = cell.style?.reverse
          ? colorToCss(cell.style.bg, theme, "bg")
          : colorToCss(cell.style?.fg, theme, "fg");
        if (drawTerminalArt(ctx, cell.ch, x, top, w * cellWidth, cellHeight, fg, fontSize, theme)) {
          // handled as geometry
        }
        col += w;
      }
    }
  }

  for (let row = 0; row < visible.length && row < rows; row++) {
    const line = visible[row];
    const y = padding + row * cellHeight + cellHeight / 2;
    let col = 0;
    for (const cell of line.cells) {
      const style = cell.style;
      const w = Math.max(1, cell.w);
      const x = padding + col * cellWidth;
      col += w;
      if (!cell.ch || cell.ch === " ") continue;
      if (style?.conceal) continue;
      if (options.boxDrawing !== false && isTerminalArt(cell.ch)) continue;

      const fg = style && style.reverse
        ? colorToCss(style.bg, theme, "bg")
        : colorToCss(style?.fg, theme, "fg");
      ctx.save();
      ctx.font = fontSpec(style, fontSize, stack);
      ctx.fillStyle = fg;
      if (style?.dim) ctx.globalAlpha = 0.6;
      if (style?.bold) {
        ctx.strokeStyle = fg;
        ctx.lineWidth = 0.6;
      }
      ctx.fillText(cell.ch, x, y);
      ctx.restore();

      if (style?.underline) {
        ctx.fillStyle = fg;
        ctx.fillRect(x, y + cellHeight / 2 - 1.5, w * cellWidth - 1, 1);
      }
      if (style?.strike) {
        ctx.fillStyle = fg;
        ctx.fillRect(x, y, w * cellWidth - 1, 1);
      }
    }
  }

  if (options.cursor !== false && model.cursor.visible) {
    const { x, y } = model.cursor;
    if (x >= 0 && x < cols && y >= 0 && y < rows) {
      const px = padding + x * cellWidth;
      const py = padding + y * cellHeight;
      ctx.fillStyle = theme.cursor;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(px, py, cellWidth, cellHeight);
      ctx.globalAlpha = 1;
      const line = visible[y];
      let text = "";
      if (line) {
        // Find the glyph under the cursor (cells are trimmed, so guard).
        let col = 0;
        for (const cell of line.cells) {
          const w = Math.max(1, cell.w);
          if (x >= col && x < col + w) {
            text = cell.ch;
            break;
          }
          col += w;
        }
      }
      if (text && text !== " ") {
        ctx.fillStyle = theme.background;
        ctx.font = fontSpec(undefined, fontSize, stack);
        ctx.fillText(text, px, py + cellHeight / 2);
      }
    }
  }

  return canvas.toBuffer("image/png");
}
