import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Session } from "../core/session.js";

const MENU = fileURLToPath(new URL("./fixtures/menu.js", import.meta.url));
const PROMPT = fileURLToPath(new URL("./fixtures/prompt.js", import.meta.url));

async function openMenu(cols = 60, rows = 14): Promise<Session> {
  return Session.open({ id: "menu", command: process.execPath, args: [MENU], cols, rows });
}

test("opens a full-screen TUI: alt screen, box, highlighted selection", async () => {
  const session = await openMenu();
  try {
    const snap = await session.snapshot();
    assert.equal(snap.altScreen, true);
    assert.equal(snap.cols, 60);
    assert.equal(snap.rows, 14);
    assert.match(snap.lines[0]!, /playnice demo/);
    assert.match(snap.lines[1]!, /Files/);
    assert.match(snap.lines[4]!, /Quit/);
    assert.match(snap.lines[6]!, /ready/);
    // The selected row is reverse video: only visible through attrs.
    assert.match(snap.text, /^1:1-45 reverse$/m);
    assert.equal(snap.settled, true);
  } finally {
    await session.close();
  }
});

test("keys move the selection and the snapshot follows", async () => {
  const session = await openMenu();
  try {
    const first = await session.snapshot();
    const before = first.text;
    const action = await session.press(["Down"]);
    assert.equal(action.changed, true);
    assert.equal(action.settled, true);
    assert.match(action.snapshot.text, /2:\d+-\d+ .*reverse/);
    assert.doesNotMatch(action.snapshot.text, /1:\d+-\d+ .*reverse/);
    assert.equal(action.snapshot.revision, first.revision + 1);

    await session.press(["j"]); // vim-style navigation must work too
    assert.match((await session.snapshot()).lines[6]!, /selected Settings/);
    await session.press(["k", "k"]);
    assert.match((await session.snapshot()).lines[6]!, /selected Files/);
    assert.notEqual(before, (await session.snapshot()).text);
  } finally {
    await session.close();
  }
});

test("clicking a row selects it (SGR mouse, 0-based coordinates)", async () => {
  const session = await openMenu();
  try {
    const action = await session.click(6, 3);
    assert.equal(action.changed, true);
    assert.match(action.snapshot.lines[6]!, /clicked Settings at 6,3/);
    assert.match(action.snapshot.text, /3:\d+-\d+ .*reverse/);
  } finally {
    await session.close();
  }
});

test("drag and wheel are accepted without breaking the app", async () => {
  const session = await openMenu();
  try {
    await session.drag(2, 2, 8, 2);
    const snap = await session.snapshot();
    assert.equal(snap.altScreen, true);
    await session.wheel(5, 3, "down", 2);
    assert.equal((await session.snapshot()).altScreen, true);
  } finally {
    await session.close();
  }
});

test("bracketed paste arrives as one edit", async () => {
  const session = await openMenu();
  try {
    const action = await session.paste("first line\nsecond line");
    assert.match(action.snapshot.lines[6]!, /pasted 22 chars: first line/);
  } finally {
    await session.close();
  }
});

test("resize reflows the app (SIGWINCH path)", async () => {
  const session = await openMenu();
  try {
    const action = await session.resize(40, 10);
    assert.equal(action.snapshot.cols, 40);
    assert.equal(action.snapshot.rows, 10);
    assert.match(action.snapshot.lines[6]!, /resized 40x10/);
  } finally {
    await session.close();
  }
});

test("wait: text appears, and missing text times out with a usable snapshot", async () => {
  const session = await openMenu();
  try {
    const hit = await session.wait({ text: "ready", timeoutMs: 2000 });
    assert.equal(hit.met, true);
    assert.ok(hit.waitedMs >= 0);
    const miss = await session.wait({ text: "definitely-not-here", timeoutMs: 150 });
    assert.equal(miss.met, false);
    assert.equal(miss.reason, "timeout");
    assert.match(miss.snapshot.lines[0]!, /playnice demo/);
  } finally {
    await session.close();
  }
});

test("exiting restores the screen; the final frame keeps the exit code", async () => {
  const session = await openMenu();
  const action = await session.press(["C-c"]);
  assert.equal(action.snapshot.exited, true);
  assert.equal(action.snapshot.exitCode, 0);
  assert.equal(action.snapshot.altScreen, false);
  assert.match(action.snapshot.text, /bye from playnice demo/);
  assert.match(action.snapshot.text, /exit=0/);
  await session.close();
});

test("line-oriented CLI: send types an answer, exit code is captured", async () => {
  const session = await Session.open({
    id: "prompt",
    command: process.execPath,
    args: [PROMPT],
    cols: 60,
    rows: 10,
  });
  try {
    const first = await session.snapshot();
    assert.match(first.text, /Name\?/);
    const answered = await session.send("Ada");
    assert.match(answered.snapshot.text, /Hello, Ada!/);
    assert.match(answered.snapshot.text, /Confirm\?/);
    const declined = await session.send("n");
    assert.equal(declined.snapshot.exitCode, 2);
    assert.match(declined.snapshot.text, /Cancelled/);
  } finally {
    await session.close();
  }
});

test("typing without Enter does not submit", async () => {
  const session = await Session.open({ id: "prompt", command: process.execPath, args: [PROMPT] });
  try {
    const typed = await session.type("Ada");
    assert.doesNotMatch(typed.snapshot.text, /Hello, Ada!/);
    assert.match(typed.snapshot.text, /Name\?/);
    assert.match(typed.snapshot.text, /Ada/);
    const submitted = await session.press(["Enter"]);
    assert.match(submitted.snapshot.text, /Hello, Ada!/);
  } finally {
    await session.close();
  }
});

test("screenshot produces a real PNG", async () => {
  const session = await openMenu();
  try {
    const png = await session.screenshot({ scale: 1, fontSize: 10 });
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.ok(png.byteLength > 1000, `png too small: ${png.byteLength}`);
  } finally {
    await session.close();
  }
});

test("a command that fails is still readable", async () => {
  const session = await Session.open({
    id: "fail",
    command: "/bin/sh",
    args: ["-c", "echo before; echo oops >&2; exit 7"],
    cols: 60,
    rows: 8,
  });
  try {
    const waiter = await session.wait({ exit: true, timeoutMs: 5000 });
    assert.equal(waiter.met, true);
    assert.equal(waiter.snapshot.exitCode, 7);
    assert.match(waiter.snapshot.text, /oops/);
  } finally {
    await session.close();
  }
});

test("writing to an exited session fails with a clear message", async () => {
  const session = await Session.open({ id: "gone", command: "/bin/sh", args: ["-c", "exit 0"] });
  await session.wait({ exit: true, timeoutMs: 5000 });
  await assert.rejects(async () => session.send("hi"), /has exited/);
  await session.close();
});

test("wait still finds text printed immediately before exit", async () => {
  const session = await Session.open({
    id: "tail",
    command: "/bin/sh",
    args: ["-c", "echo first-line; echo final-line"],
    cols: 40,
    rows: 8,
  });
  try {
    const result = await session.wait({ text: "final-line", timeoutMs: 5000 });
    assert.equal(result.met, true, "text printed just before exit must be findable");
    assert.equal(result.snapshot.exited, true);
  } finally {
    await session.close();
  }
});

test("large output does not deadlock or lose the tail", async () => {
  const session = await Session.open({
    id: "big",
    command: "/bin/sh",
    args: ["-c", "for i in $(seq 1 3000); do echo line-$i; done"],
    cols: 40,
    rows: 10,
  });
  try {
    const waited = await session.wait({ text: "line-3000", timeoutMs: 20_000 });
    assert.equal(waited.met, true, "the final line must survive 3000 lines of output");
  } finally {
    await session.close();
  }
});
