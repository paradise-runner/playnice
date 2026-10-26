/**
 * A small but genuinely TUI-ish app used by the test suite.
 *
 * Exercises the things that matter for playnice: alternate screen, reverse
 * video selection, mouse reporting (SGR 1006), bracketed paste, SIGWINCH
 * reflow, and a clean exit that restores the screen.
 */
import { stdin, stdout } from "node:process";

const items = ["Files", "Search", "Settings", "Quit"];
let selected = 0;
let status = "ready";
let cols = stdout.columns ?? 80;
let rows = stdout.rows ?? 24;
let finished = false;

function frame(): string {
  const inner = Math.max(24, Math.min(cols - 2, 46));
  const title = "─ playnice demo ─";
  const fill = Math.max(0, inner - title.length - 1);
  const out: string[] = [];
  out.push(`\x1b[1;36m╭${title}${"─".repeat(fill)}╮\x1b[0m`);
  for (let i = 0; i < items.length; i++) {
    const label = ` ${items[i]}`.padEnd(inner - 1);
    const body = i === selected ? `\x1b[7m${label}\x1b[0m` : label;
    out.push(`\x1b[1;36m│\x1b[0m${body}\x1b[1;36m│\x1b[0m`);
  }
  out.push(`\x1b[1;36m╰${"─".repeat(inner)}╯\x1b[0m`);
  out.push(`\x1b[2m${status}\x1b[0m`);
  return `\x1b[1;1H${out.join("\r\n")}\x1b[0m`;
}

function draw(): void {
  stdout.write(frame());
}

function cleanup(code: number, message: string): void {
  if (finished) return;
  finished = true;
  stdout.write("\x1b[0m\x1b[?25h\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[?1049l");
  // Flush before exiting: process.exit() would drop the buffered write.
  stdout.write(`${message}\n`, () => process.exit(code));
}

function select(index: number): void {
  selected = (index + items.length) % items.length;
  status = `selected ${items[selected]}`;
  draw();
}

function activate(): void {
  status = `activated ${items[selected]}`;
  draw();
  if (items[selected] === "Quit") setTimeout(() => cleanup(0, "bye from playnice demo"), 20);
}

function onMouse(button: number, x: number, y: number, release: boolean): void {
  if (release || button !== 0) return;
  // Rows: 0 title, 1..4 items. Columns: 0 border, 1..inner content.
  const index = y - 1;
  if (index < 0 || index >= items.length) return;
  selected = index;
  status = `clicked ${items[selected]} at ${x},${y}`;
  draw();
  if (items[selected] === "Quit") setTimeout(() => cleanup(0, "bye from playnice demo"), 20);
}

/** Split a chunk into whole escape sequences and single characters. */
function tokenize(buffer: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < buffer.length) {
    if (buffer[i] === "\x1b") {
      const match = /^\x1b\[[0-9;?<>]*[A-Za-z~]/.exec(buffer.slice(i));
      if (match) {
        out.push(match[0]);
        i += match[0].length;
        continue;
      }
      out.push(buffer.slice(i, i + 2));
      i += 2;
      continue;
    }
    out.push(buffer[i]);
    i += 1;
  }
  return out;
}

function handle(buffer: string): void {
  // Bracketed paste first: it can contain anything else.
  const paste = /\x1b\[200~([\s\S]*?)\x1b\[201~/.exec(buffer);
  if (paste) {
    const text = paste[1];
    status = `pasted ${text.length} chars: ${text.split(/\r?\n/)[0].slice(0, 20)}`;
    draw();
    return;
  }
  for (const token of tokenize(buffer)) {
    if (token === "q" || token === "\x03") {
      cleanup(0, "bye from playnice demo");
      return;
    }
    const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(token);
    if (mouse) {
      const button = Number(mouse[1]) & 3;
      onMouse(button, Number(mouse[2]) - 1, Number(mouse[3]) - 1, mouse[4] === "m");
      continue;
    }
    if (token === "j" || token === "\x1b[B") select(selected + 1);
    else if (token === "k" || token === "\x1b[A") select(selected - 1);
    else if (token === "\r") activate();
  }
}

stdout.write("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[?2004h\x1b[2J");
draw();

stdin.setRawMode(true);
stdin.setEncoding("utf8");
stdin.resume();
// Arrow keys arrive as one escape sequence; coalesce what one read delivers.
stdin.on("data", (chunk: string) => handle(chunk));

process.on("SIGWINCH", () => {
  cols = stdout.columns ?? cols;
  rows = stdout.rows ?? rows;
  status = `resized ${cols}x${rows}`;
  stdout.write("\x1b[2J");
  draw();
});
