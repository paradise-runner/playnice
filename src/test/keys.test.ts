import assert from "node:assert/strict";
import test from "node:test";
import { encodeKeys, encodeText, parseKey, unescape } from "../core/keys.js";

const seq = (spec: string, app = false) => parseKey(spec, { applicationCursorKeys: app }).sequence;

test("named keys", () => {
  assert.equal(seq("Enter"), "\r");
  assert.equal(seq("Tab"), "\t");
  assert.equal(seq("Escape"), "\x1b");
  assert.equal(seq("Backspace"), "\x7f");
  assert.equal(seq("Delete"), "\x1b[3~");
  assert.equal(seq("F5"), "\x1b[15~");
  assert.equal(seq("Space"), " ");
  assert.equal(seq("Home"), "\x1b[H");
  assert.equal(seq("Home", true), "\x1bOH");
});

test("key names are forgiving", () => {
  assert.equal(seq("arrow up"), seq("Up"));
  assert.equal(seq("ARROWUP"), seq("Up"));
  assert.equal(seq("page down"), seq("PageDown"));
  assert.equal(seq("Esc"), "\x1b");
  assert.equal(seq("del"), "\x1b[3~");
});

test("application cursor keys switch arrows to SS3", () => {
  assert.equal(seq("Up"), "\x1b[A");
  assert.equal(seq("Up", true), "\x1bOA");
  assert.equal(seq("Left", true), "\x1bOD");
});

test("modifier chords", () => {
  assert.equal(seq("C-c"), "\x03");
  assert.equal(seq("Ctrl+c"), "\x03");
  assert.equal(seq("ctrl-c"), "\x03");
  assert.equal(seq("C-d"), "\x04");
  assert.equal(seq("C-["), "\x1b");
  assert.equal(seq("C-]"), "\x1d");
  assert.equal(seq("C-S-a"), "\x01");
  assert.equal(seq("Alt-x"), "\x1bx");
  assert.equal(seq("M-x"), "\x1bx");
  assert.equal(seq("Shift+Tab"), "\x1b[Z");
  assert.equal(seq("Ctrl+Up"), "\x1b[1;5A");
  assert.equal(seq("Shift+Left"), "\x1b[1;2D");
  assert.equal(seq("Alt+F5"), "\x1b[15;3~");
});

test("literal characters and raw escapes", () => {
  assert.equal(seq("a"), "a");
  assert.equal(seq("?"), "?");
  assert.equal(seq("Shift+a"), "A");
  assert.equal(seq("+"), "+");
  assert.equal(seq("\\x1b[A"), "\x1b[A");
  assert.equal(seq("\\e"), "\x1b");
  assert.equal(unescape("a\\tb"), "a\tb");
});

test("unknown keys fail loudly with guidance", () => {
  assert.throws(() => seq("Nonsense"), /Unknown key: "Nonsense".*chord/);
});

test("encodeKeys and encodeText", () => {
  assert.equal(encodeKeys(["Down", "Down", "Enter"]), "\x1b[B\x1b[B\r");
  assert.equal(encodeText("hi"), "hi");
  assert.equal(encodeText("a\r\nb"), "a\rb");
  assert.equal(encodeText("a\nb"), "a\nb");
  // With bracketed paste available, multi-line text is wrapped instead of
  // becoming a burst of Enter presses.
  assert.equal(encodeText("a\nb", { bracketedPaste: true }), "\x1b[200~a\nb\x1b[201~");
  assert.equal(encodeText("plain", { bracketedPaste: true }), "plain");
});
