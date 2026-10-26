import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Session } from "../core/session.js";

function has(binary: string): boolean {
  try {
    execFileSync("sh", ["-c", `command -v ${binary}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const VIM = has("vim");

test("drives real vim: insert, save, quit, file on disk is correct", { skip: !VIM && "vim not installed" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "playnice-vim-"));
  const file = join(dir, "note.txt");
  const session = await Session.open({
    id: "vim",
    command: "vim",
    args: ["-u", "NONE", "-N", "-n", file],
    cols: 80,
    rows: 20,
  });
  try {
    const first = await session.snapshot();
    assert.equal(first.altScreen, true);
    // An empty buffer is a column of tildes.
    assert.ok(first.lines.some((line) => line.trim() === "~"), "expected vim's empty-buffer tildes");

    await session.press(["i"]);
    const typed = await session.type("hello from playnice");
    assert.match(typed.snapshot.text, /hello from playnice/);

    const normal = await session.press(["Escape"]);
    // A bare ESC makes vim wait for its ambiguity timeout before redrawing;
    // settling too early would return the stale insert-mode screen.
    assert.ok(
      !normal.snapshot.lines.some((line) => line.includes("-- INSERT --")),
      "leaving insert mode must be reflected in the same screenshot",
    );
    await session.send(":wq");
    const done = await session.wait({ exit: true, timeoutMs: 10_000 });
    assert.equal(done.met, true, "vim should exit after :wq");
    assert.equal(done.snapshot.exitCode, 0);
    assert.equal(readFileSync(file, "utf8").trim(), "hello from playnice");
  } finally {
    await session.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("drives a pager: less opens, scrolls and quits", { skip: !has("less") && "less not installed" }, async () => {
  const session = await Session.open({
    id: "less",
    command: "less",
    args: ["/etc/hosts"],
    cols: 70,
    rows: 12,
  });
  try {
    const first = await session.snapshot();
    assert.equal(first.altScreen, true);
    assert.match(first.text, /localhost|nameserver|#/);
    await session.press(["Space"]);
    await session.press(["q"]);
    const done = await session.wait({ exit: true, timeoutMs: 5000 });
    assert.equal(done.met, true);
    assert.equal(done.snapshot.altScreen, false);
  } finally {
    await session.close();
  }
});
