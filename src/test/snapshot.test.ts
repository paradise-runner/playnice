import assert from "node:assert/strict";
import test from "node:test";
import { Screen } from "../core/screen.js";
import { buildSnapshot, renderAnsiFromModel, snapshotToJson } from "../core/snapshot.js";

async function makeScreen(text: string, cols = 24, rows = 6, scrollback = 50) {
  const screen = new Screen({ cols, rows, scrollback });
  await screen.write(text);
  return screen;
}

function shot(screen: Screen, scrollback = 0) {
  const model = screen.read(scrollback);
  return { model, snap: buildSnapshot({ session: "t", model, settled: true, quietMs: 80, revision: 1, exited: false }) };
}

test("plain text, trailing blanks trimmed", async () => {
  const screen = await makeScreen("hello\r\nworld");
  const { snap } = shot(screen);
  assert.deepEqual(snap.lines, ["hello", "world"]);
  assert.equal(snap.cursor.x, 5);
  assert.equal(snap.cursor.y, 1);
  assert.equal(snap.settled, true);
  assert.doesNotMatch(snap.text, /# attrs/);
});

test("colors become attrs, not noise", async () => {
  const screen = await makeScreen("\x1b[1mBold\x1b[0m \x1b[31mred\x1b[0m \x1b[48;5;22m bg \x1b[0m");
  const { snap } = shot(screen);
  assert.equal(snap.lines[0], "Bold red  bg ");
  assert.match(snap.text, /# attrs\n0:0-3 bold\n0:5-7 fg=1\n0:9-12 bg=22/);
  const json = snapshotToJson(snap) as { styles: { row: number; col: number; width: number }[] };
  assert.deepEqual(
    json.styles.map((s) => [s.row, s.col, s.width]),
    [
      [0, 0, 4],
      [0, 5, 3],
      [0, 9, 4],
    ],
  );
});

test("styling that covers blank cells survives trimming", async () => {
  const screen = await makeScreen("\x1b[44m          \x1b[0m");
  const { snap } = shot(screen);
  assert.equal(snap.lines[0], "          ");
  assert.match(snap.text, /0:0-9 bg=4/);
});

test("foreground-only blanks are trimmed, background blanks are not", async () => {
  const screen = await makeScreen("\x1b[31mred\x1b[0m\x1b[41m   \x1b[0m\x1b[44m  \x1b[0m");
  const { snap } = shot(screen);
  // Foreground-coloured spaces are invisible, background-coloured ones are not.
  assert.equal(snap.lines[0], "red     ");
  assert.equal(snap.lines[0]!.length, 8);
  assert.match(snap.text, /0:3-5 bg=1/);
  assert.match(snap.text, /0:6-7 bg=4/);
});

test("wide characters occupy one cell entry and two columns", async () => {
  const screen = await makeScreen("\x1b[32m日本語\x1b[0m ok");
  const { model, snap } = shot(screen);
  assert.equal(snap.lines[0], "日本語 ok");
  assert.deepEqual(model.lines[0]!.cells.map((c) => c.w), [2, 2, 2, 1, 1, 1]);
  assert.match(snap.text, /0:0-5 fg=2/);
});

test("hash ignores cursor movement but tracks content", async () => {
  const screen = await makeScreen("abc");
  const model = screen.read(0);
  const first = model;
  await screen.write("\x1b[3;3H");
  const second = screen.read(0);
  assert.equal(first.hash, second.hash);
  assert.notEqual(first.cursor.x, second.cursor.x);
  await screen.write("x");
  assert.notEqual(screen.read(0).hash, second.hash);
});

test("alt screen, title and cursor visibility", async () => {
  const screen = await makeScreen("\x1b[?1049h\x1b[?25l\x1b]0;my app\x07full screen");
  const { snap } = shot(screen);
  assert.equal(snap.altScreen, true);
  assert.equal(snap.cursor.visible, false);
  assert.equal(snap.title, "my app");
  assert.match(snap.text, /^# 24x6 alt cursor=hidden/);
});

test("header reports geometry and settle state", async () => {
  const screen = await makeScreen("one\r\ntwo\r\nthree");
  const { snap } = shot(screen, 2);
  assert.match(snap.text, /^# 24x6 main cursor=5,2 settled=80ms\n/);
  // Nothing has scrolled off yet, so there is no scrollback and no marker.
  assert.doesNotMatch(snap.text, /# --- viewport ---/);
});

test("scrollback grows when lines scroll out", async () => {
  const screen = await makeScreen(Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\r\n"), 24, 3);
  const { snap } = shot(screen, 4);
  assert.deepEqual(snap.lines, ["line 7", "line 8", "line 9"]);
  assert.deepEqual(snap.scrollback, ["line 3", "line 4", "line 5", "line 6"]);
  assert.equal(snap.lines.length, 3);
});

test("full keeps trailing blank rows", async () => {
  const screen = await makeScreen("only");
  const model = screen.read(0);
  const trimmed = buildSnapshot({ session: "t", model, settled: true, quietMs: 90, revision: 1, exited: false });
  const full = buildSnapshot({
    session: "t",
    model,
    settled: true,
    quietMs: 90,
    revision: 1,
    exited: false,
    options: { full: true },
  });
  assert.equal(trimmed.lines.length, 1);
  assert.equal(full.lines.length, 6);
});

test("ansi rendering round-trips the colors", async () => {
  const screen = await makeScreen("\x1b[1;31mred bold\x1b[0m plain");
  const { model, snap } = shot(screen);
  const ansi = renderAnsiFromModel(model, snap);
  assert.match(ansi, /\x1b\[0;1;31mred bold\x1b\[0m/);
  assert.match(ansi, /plain/);
});

test("resize reflows and reports new geometry", async () => {
  const screen = await makeScreen("0123456789012345678901234567890", 32, 4);
  assert.equal(screen.read(0).lines[0]!.text.length, 31);
  screen.resize(10, 4);
  const model = screen.read(0);
  assert.equal(model.cols, 10);
  assert.equal(model.lines.length, 4);
});

test("header can be suppressed", async () => {
  const screen = await makeScreen("x");
  const model = screen.read(0);
  const snap = buildSnapshot({
    session: "t",
    model,
    settled: true,
    quietMs: 80,
    revision: 1,
    exited: false,
    options: { header: false, attrs: false },
  });
  assert.equal(snap.text, "x");
});
