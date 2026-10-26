import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../cli/index.js", import.meta.url));
const HOME = mkdtempSync(join(tmpdir(), "playnice-cli-"));
const env = { ...process.env, PLAYNICE_HOME: HOME, NO_COLOR: "1" };

interface Run {
  stdout: string;
  stderr: string;
  code: number;
}

function cli(args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { env, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ stdout, stderr, code });
      },
    );
  });
}

after(async () => {
  await cli(["daemon", "stop"]);
  rmSync(HOME, { recursive: true, force: true });
});

test("cli: full session lifecycle over the daemon", async (t) => {
  await t.test("open starts a session and screenshots it", async () => {
    const run = await cli(["open", "--id", "sh", "--cols", "60", "--rows", "12", "--", "/bin/sh"]);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /^# 60x12 main cursor=\d+,\d+/);
    assert.match(run.stderr, /session sh · 60x12 · pid \d+/);
  });

  await t.test("send runs a command and returns the settled screen", async () => {
    const run = await cli(["send", "sh", "echo marker-$((6*7))"]);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /marker-42/);
    assert.match(run.stderr, /changed/);
  });

  await t.test("the session persists across CLI invocations", async () => {
    const run = await cli(["snap", "sh", "--json"]);
    assert.equal(run.code, 0, run.stderr);
    const snapshot = JSON.parse(run.stdout) as {
      session: string;
      cols: number;
      lines: string[];
      settled: boolean;
      styles: unknown[];
    };
    assert.equal(snapshot.session, "sh");
    assert.equal(snapshot.cols, 60);
    assert.ok(snapshot.lines.some((line) => line.includes("marker-42")));
    assert.equal(snapshot.settled, true);
    assert.ok(Array.isArray(snapshot.styles));
  });

  await t.test("keys keep state (C-c returns to a fresh prompt)", async () => {
    const run = await cli(["key", "sh", "C-c"]);
    assert.equal(run.code, 0, run.stderr);
    // bash prints "sh-3.2$", dash prints "$"; both end the line with a prompt.
    assert.match(run.stdout, /[$#]$/m);
  });

  await t.test("resize reflows the pty", async () => {
    const run = await cli(["resize", "sh", "40", "10"]);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /^# 40x10 main/);
  });

  await t.test("wait succeeds on text and fails on timeout", async () => {
    await cli(["send", "sh", "echo wait-marker"]);
    const hit = await cli(["wait", "sh", "--text", "wait-marker", "--timeout", "5000"]);
    assert.equal(hit.code, 0, hit.stderr);
    assert.match(hit.stderr, /condition met/);
    const miss = await cli(["wait", "sh", "--text", "never-going-to-appear", "--timeout", "250"]);
    assert.equal(miss.code, 1);
    assert.match(miss.stderr, /timed out/);
    assert.match(miss.stdout, /^# 40x10/);
  });

  await t.test("shot writes a real PNG", async () => {
    const file = join(HOME, "shot.png");
    const run = await cli(["shot", "sh", "-o", file, "--scale", "1"]);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.stdout.trim(), file);
    const bytes = readFileSync(file);
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  });

  await t.test("ls lists sessions as a table and as JSON", async () => {
    const table = await cli(["ls"]);
    assert.equal(table.code, 0, table.stderr);
    assert.match(table.stdout, /^ID\s+SIZE\s+SCREEN\s+STATUS/m);
    assert.match(table.stdout, /sh\s+40x10\s+main\s+running/);
    const json = await cli(["ls", "--json"]);
    const sessions = JSON.parse(json.stdout) as { id: string }[];
    assert.deepEqual(sessions.map((s) => s.id), ["sh"]);
  });

  await t.test("run captures output and the child's exit code", async () => {
    const ok = await cli(["run", "--cols", "50", "--", "/bin/sh", "-c", "printf 'run-ok\\n'"]);
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /run-ok/);
    const bad = await cli(["run", "--cols", "50", "--", "/bin/sh", "-c", "echo nope >&2; exit 9"]);
    assert.equal(bad.code, 9);
    assert.match(bad.stdout, /nope/);
  });

  await t.test("unknown sessions and options fail with guidance", async () => {
    const missing = await cli(["snap", "nope"]);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /No session "nope"/);
    const badFlag = await cli(["snap", "--nonsense"]);
    assert.equal(badFlag.code, 2);
    assert.match(badFlag.stderr, /Unknown option --nonsense/);
    const badKey = await cli(["key", "sh", "NotAKey"]);
    assert.equal(badKey.code, 1);
    assert.match(badKey.stderr, /Unknown key/);
  });

  await t.test("close removes the session", async () => {
    const run = await cli(["close", "sh"]);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stderr, /closed/);
    const list = await cli(["ls", "--json"]);
    assert.deepEqual(JSON.parse(list.stdout), []);
  });

  await t.test("daemon stop is clean: no process, no socket", async () => {
    const running = await cli(["daemon", "status"]);
    assert.equal(running.code, 0, running.stderr);
    assert.match(running.stdout, /^running/);
    const stopped = await cli(["daemon", "stop"]);
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.match(stopped.stdout, /stopped/);
    const status = await cli(["daemon", "status"]);
    assert.equal(status.code, 1);
    assert.match(status.stdout, /not running/);
    assert.equal(existsSync(join(HOME, "daemon.sock")), false);
    // A later command transparently brings the daemon back.
    const after = await cli(["open", "--id", "again", "--", "/bin/sh"]);
    assert.equal(after.code, 0, after.stderr);
    const close = await cli(["close", "again"]);
    assert.equal(close.code, 0, close.stderr);
  });
});
