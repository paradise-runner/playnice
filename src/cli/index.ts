#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DaemonClient, waitForShutdown } from "../daemon/client.js";
import { homeDir, logPath, socketPath } from "../core/paths.js";
import { snapshotToJson } from "../core/snapshot.js";
import { VERSION } from "../core/version.js";
import type { ActionResult } from "../core/session.js";
import { bool, list, num, parseArgs, str, UsageError, type OptionSpecs } from "./args.js";
import { fail, formatSessionTable, note, printJson, printSnapshot } from "./format.js";

// ---------------------------------------------------------------------- setup

function takeHome(argv: string[]): { home?: string; argv: string[] } {
  const out: string[] = [];
  let home: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--home") {
      home = argv[++i];
      continue;
    }
    if (token.startsWith("--home=")) {
      home = token.slice("--home=".length);
      continue;
    }
    out.push(token);
  }
  return { home, argv: out };
}

function wantsHelp(argv: string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

const globalSpecs: OptionSpecs = {
  json: { type: "boolean", alias: "J", help: "machine-readable output" },
  quiet: { type: "boolean", alias: "q", help: "suppress the screenshot" },
};

const snapshotSpecs: OptionSpecs = {
  ...globalSpecs,
  id: { type: "string", alias: "s", help: "session id (or omit when only one is open)" },
  ansi: { type: "boolean", help: "SGR-coloured screenshot" },
  scrollback: { type: "number", help: "include N lines above the viewport" },
  attrs: { type: "boolean", help: "include the # attrs block (default on)" },
  header: { type: "boolean", help: "include the # header line (default on)" },
  full: { type: "boolean", help: "keep trailing blank rows" },
};

const actionSpecs: OptionSpecs = {
  ...globalSpecs,
  id: { type: "string", alias: "s" },
  settle: { type: "number", help: "ms of quiet that counts as finished (default 75)" },
  timeout: { type: "number", help: "max ms to wait for the screen to settle (default 1500)" },
};

const HELP: Record<string, string> = {
  open: `playnice open [options] [--] [command [args...]]

Start a program in a fresh pseudo-terminal. With no command, starts $SHELL.
Prints the first screenshot.

  --id <id>          session id (default: from --name, else t1, t2, ...)
  --name <name>      friendly name, also used as the default id
  --cols <n>         width in cells (default 100)
  --rows <n>         height in cells (default 30)
  --cwd <dir>        working directory
  --env K=V          extra environment variable (repeatable)
  --scrollback <n>   emulator scrollback lines (default 2000)`,
  send: `playnice send [session] <text...>

Type text and press Enter, then print the settled screenshot.
Use --no-enter (or \`playnice type\`) to type without submitting.`,
  type: `playnice type [session] <text...>

Type literal text without pressing Enter (passwords, incremental search).`,
  paste: `playnice paste [session] <text...>

Deliver text as one bracketed paste when the app supports it (harnesses,
editors, anything that enables mode 2004). Falls back to plain typing.`,
  key: `playnice key [session] <key...>

Press named keys: Enter, Tab, Escape, Backspace, Delete, Up/Down/Left/Right,
Home, End, PageUp, PageDown, F1..F12, Space, C-c, Alt+x, Shift+Tab, or a raw
escape like '\\x1b[A'.`,
  click: `playnice click [session] <x> <y> [--button left|middle|right] [--double]

Click cell (x, y), 0-based from the top-left. Only meaningful for apps that
enable mouse reporting (most TUIs do).`,
  drag: `playnice drag [session] <x1> <y1> <x2> <y2>

Press, move and release the left button — for selection and reordering.`,
  scroll: `playnice scroll [session] <x> <y> [--up [n]] [--down [n]]

Send wheel events at (x, y). Defaults to one notch down.`,
  snap: `playnice snap [session] [--ansi] [--scrollback n] [--full]

Print the current screenshot without doing anything first.
Text is the default; --ansi keeps colours; --json gives the full structure.`,
  shot: `playnice shot [session] [-o <file.png>] [--scale 2] [--font-size 14]

Render a real PNG of the screen (colors, cursor, unicode width) and print its
path. Use --stdout for base64, --json for metadata.`,
  wait: `playnice wait [session] [--text <s>] [--regex <re>] [--gone <s>] [--quiet <ms>] [--exit]

Block until all conditions hold, then print the screenshot. Exits 1 on timeout
(and still prints what is on screen). Default timeout: 10s.`,
  resize: `playnice resize [session] <cols> <rows>

Resize the pty. TUIs reflow; good for checking responsive layouts.`,
  close: `playnice close [session]

Terminate the session and print its final screenshot.`,
  ls: `playnice ls [--json]

List open sessions with size, screen type, status and idle time.`,
  run: `playnice run [options] -- <command> [args...]

Open, wait for the command to exit, print the final screen, close.
The exit code is the command's (124 on timeout). For one-shot CLI checks.`,
  daemon: `playnice daemon <start|stop|status|log>

The daemon owns the ptys so sessions survive across CLI calls and are shared
with the MCP server. It starts automatically.`,
  mcp: `playnice mcp

Run an MCP server on stdio that exposes the same actions as tools.
Add to your agent config, e.g. { "command": "playnice", "args": ["mcp"] }.`,
};

function commandHelp(name: string): string {
  return HELP[name] ?? "Unknown command";
}

function printHelp(name?: string): void {
  if (name) {
    process.stdout.write(`${commandHelp(name)}\n`);
    return;
  }
  process.stdout.write(`playnice ${VERSION} — playwright for terminals

Usage: playnice <command> [options]

Sessions
  open      start a program or shell and screenshot it
  ls        list open sessions
  close     kill a session
  run       run a command to completion and show the final screen

Driving
  send      type text + Enter
  type      type text without Enter
  key       press named keys (C-c, Down, Escape, F5...)
  click     click a cell (x, y)
  drag      press, move, release
  scroll    wheel up/down
  resize    resize the pty

Seeing
  snap      screenshot the current screen (text, --ansi, --json)
  shot      render a PNG

Waiting
  wait      block until text appears, disappears, or output goes quiet

Integrations
  mcp       MCP server on stdio
  daemon    start|stop|status|log

Global
  --home <dir>   state directory (default $PLAYNICE_HOME or ~/.playnice)
  --json         machine-readable output
  --quiet        no screenshot
  --help         this text, or \`playnice help <command>\`

Coordinates are 0-based cells from the top-left. Screenshots start with a
'# 100x30 alt cursor=4,9 settled=71ms' header followed by the screen, then
'# attrs' lines describing highlights that text alone cannot show.

The common loop:  open → snap → key/click/send → snap ...
`);
}

// ------------------------------------------------------------------- helpers

function intArg(value: string | undefined, name: string): number {
  if (value === undefined) throw new UsageError(`missing ${name}`);
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`${name} must be a non-negative integer`);
  return n;
}

function envArg(pairs: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new UsageError(`--env expects KEY=VALUE (got "${pair}")`);
    env[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return env;
}

async function connect(home?: string): Promise<DaemonClient> {
  return DaemonClient.connect({ home });
}

async function resolveTarget(
  client: DaemonClient,
  options: Record<string, string | number | boolean | string[] | undefined>,
  rest: string[],
  needed: number,
  opts: { strict?: boolean } = {},
): Promise<{ id: string; args: string[] }> {
  const explicit = str(options.id, "--id");
  const args = [...rest];
  if (explicit) return { id: explicit, args };
  const sessions = await client.call("list", {});
  const named = args.length > needed && sessions.some((s) => s.id === args[0]);
  if (named) {
    const id = args.shift() as string;
    return { id, args };
  }
  if (opts.strict && args.length > needed) {
    throw new Error(
      sessions.length
        ? `No session "${args[0]}". Open sessions: ${sessions.map((s) => s.id).join(", ")}.`
        : `No session "${args[0]}" — nothing is open yet. Start one with \`playnice open\`.`,
    );
  }
  if (sessions.length === 1) return { id: sessions[0].id, args };
  const fallback = sessions.find((s) => s.id === "default");
  if (fallback) return { id: fallback.id, args };
  throw new UsageError(
    sessions.length
      ? `Several sessions are open (${sessions.map((s) => s.id).join(", ")}); pass --id <id> or put the id first.`
      : "No sessions open yet — start one with `playnice open`.",
  );
}

function snapshotOptions(options: Record<string, string | number | boolean | string[] | undefined>) {
  return {
    ansi: bool(options.ansi, "--ansi"),
    scrollback: num(options.scrollback, "--scrollback"),
    attrs: bool(options.attrs, "--attrs"),
    header: bool(options.header, "--header"),
    full: bool(options.full, "--full"),
  };
}

function actionOptions(options: Record<string, string | number | boolean | string[] | undefined>) {
  return {
    quietMs: num(options.settle, "--settle"),
    timeoutMs: num(options.timeout, "--timeout"),
    snapshot: snapshotOptions(options),
  };
}

function emitAction(action: ActionResult, options: Record<string, string | number | boolean | string[] | undefined>): void {
  const quiet = bool(options.quiet, "--quiet") === true;
  if (bool(options.json, "--json")) {
    printJson({
      changed: action.changed,
      settled: action.settled,
      waitedMs: action.waitedMs,
      snapshot: snapshotToJson(action.snapshot),
    });
    return;
  }
  const status = [
    action.changed ? "changed" : "unchanged",
    action.settled ? `settled ${Math.round(action.waitedMs)}ms` : "still drawing",
    `rev ${action.snapshot.revision}`,
  ].join(" · ");
  note(`${action.snapshot.session} · ${status}`);
  printSnapshot(action.snapshot, { quiet });
}

// ------------------------------------------------------------------ commands

async function cmdOpen(argv: string[], home: string | undefined): Promise<number> {
  if (wantsHelp(argv)) return printHelp("open"), 0;
  const { options, positionals } = parseArgs(argv, {
    ...globalSpecs,
    id: { type: "string", alias: "s" },
    name: { type: "string", alias: "n" },
    cols: { type: "number" },
    rows: { type: "number" },
    cwd: { type: "string" },
    "workdir": { type: "string" },
    env: { type: "strings", alias: "e" },
    scrollback: { type: "number" },
  });
  const command = positionals[0];
  const args = positionals.slice(1);
  const c = await connect(home);
  try {
    const result = await c.call("open", {
      id: str(options.id, "--id"),
      name: str(options.name, "--name"),
      command,
      args,
      cwd: str(options.cwd, "--cwd") ?? str(options.workdir, "--workdir"),
      cols: num(options.cols, "--cols"),
      rows: num(options.rows, "--rows"),
      env: envArg(list(options.env)),
      scrollback: num(options.scrollback, "--scrollback"),
    });
    printSnapshot(result.snapshot, { json: bool(options.json, "--json") === true, quiet: bool(options.quiet, "--quiet") === true });
    note(`session ${result.summary.id} · ${result.summary.cols}x${result.summary.rows} · pid ${result.summary.pid}`);
    return 0;
  } finally {
    c.close();
  }
}

async function cmdSend(argv: string[], home: string | undefined, mode: "send" | "type" | "paste"): Promise<number> {
  if (wantsHelp(argv)) return printHelp(mode === "send" ? "send" : mode), 0;
  const { options, positionals } = parseArgs(argv, actionSpecs);
  const c = await connect(home);
  try {
    const { id, args } = await resolveTarget(c, options, positionals, 1);
    const text = args.join(" ");
    if (!text && args.length === 0) throw new UsageError("nothing to send — pass the text in quotes");
    const params = { id, text, ...actionOptions(options) };
    const action =
      mode === "send"
        ? await c.call("send", { ...params, enter: bool(options.enter, "--enter") })
        : mode === "type"
          ? await c.call("type", params)
          : await c.call("paste", params);
    emitAction(action, options);
    return 0;
  } finally {
    c.close();
  }
}

async function cmdKey(argv: string[], home: string | undefined): Promise<number> {
  if (wantsHelp(argv)) return printHelp("key"), 0;
  const { options, positionals } = parseArgs(argv, { ...actionSpecs, times: { type: "number" } });
  const c = await connect(home);
  try {
    const { id, args } = await resolveTarget(c, options, positionals, 1);
    if (!args.length) throw new UsageError("no keys given — try `playnice key C-c`");
    const repeat = num(options.times, "--times") ?? 1;
    const keys = repeat > 1 ? Array.from({ length: repeat }, () => args).flat() : args;
    const action = await c.call("press", { id, keys, ...actionOptions(options) });
    emitAction(action, options);
    return 0;
  } finally {
    c.close();
  }
}

function mouseMods(options: Record<string, unknown>) {
  return {
    button: (str(options.button, "--button") as "left" | "middle" | "right" | undefined),
    shift: bool(options.shift, "--shift"),
    alt: bool(options.alt, "--alt"),
    ctrl: bool(options.ctrl, "--ctrl"),
  };
}

const mouseSpecs: OptionSpecs = {
  ...actionSpecs,
  button: { type: "string", alias: "b" },
  shift: { type: "boolean" },
  alt: { type: "boolean" },
  ctrl: { type: "boolean" },
};

async function cmdClick(argv: string[], home: string | undefined): Promise<number> {
  if (wantsHelp(argv)) return printHelp("click"), 0;
  const { options, positionals } = parseArgs(argv, { ...mouseSpecs, double: { type: "boolean" } });
  const c = await connect(home);
  try {
    const { id, args } = await resolveTarget(c, options, positionals, 2, { strict: true });
    const x = intArg(args[0], "x");
    const y = intArg(args[1], "y");
    const action = await c.call("click", {
      id,
      x,
      y,
      double: bool(options.double, "--double"),
      ...mouseMods(options),
      ...actionOptions(options),
    });
    emitAction(action, options);
    return 0;
  } finally {
    c.close();
  }
}

async function cmdDrag(argv: string[], home: string | undefined): Promise<number> {
  if (wantsHelp(argv)) return printHelp("drag"), 0;
  const { options, positionals } = parseArgs(argv, mouseSpecs);
  const c = await connect(home);
  try {
    const { id, args } = await resolveTarget(c, options, positionals, 4, { strict: true });
    const action = await c.call("drag", {
      id,
      x: intArg(args[0], "x1"),
      y: intArg(args[1], "y1"),
      x2: intArg(args[2], "x2"),
      y2: intArg(args[3], "y2"),
      ...mouseMods(options),
      ...actionOptions(options),
    });
    emitAction(action, options);
    return 0;
  } finally {
    c.close();
  }
}

async function cmdScroll(argv: string[], home: string | undefined): Promise<number> {
  if (wantsHelp(argv)) return printHelp("scroll"), 0;
  const { options, positionals } = parseArgs(argv, {
    ...mouseSpecs,
    up: { type: "boolean" },
    down: { type: "boolean" },
    count: { type: "number", alias: "n" },
  });
  const c = await connect(home);
  try {
    const { id, args } = await resolveTarget(c, options, positionals, 2, { strict: true });
    const direction = bool(options.up, "--up") ? "up" : "down";
    const action = await c.call("wheel", {
      id,
      x: intArg(args[0], "x"),
      y: intArg(args[1], "y"),
      direction,
      count: num(options.count, "--count") ?? 1,
      ...mouseMods(options),
      ...actionOptions(options),
    });
    emitAction(action, options);
    return 0;
  } finally {
    c.close();
  }
}

async function cmdSnap(argv: string[], home: string | undefined): Promise<number> {
  if (wantsHelp(argv)) return printHelp("snap"), 0;
  const { options, positionals } = parseArgs(argv, snapshotSpecs);
  const c = await connect(home);
  try {
    const { id } = await resolveTarget(c, options, positionals, 0, { strict: true });
    const snapshot = await c.call("snapshot", {
      id,
      ...snapshotOptions(options),
      ansi: bool(options.ansi, "--ansi"),
    });
    printSnapshot(snapshot, {
      json: bool(options.json, "--json") === true,
      ansi: bool(options.ansi, "--ansi") === true,
      quiet: bool(options.quiet, "--quiet") === true,
    });
    return 0;
  } finally {
    c.close();
  }
}

async function cmdShot(argv: string[], home: string | undefined): Promise<number> {
  if (wantsHelp(argv)) return printHelp("shot"), 0;
  const { options, positionals } = parseArgs(argv, {
    ...globalSpecs,
    id: { type: "string", alias: "s" },
    out: { type: "string", alias: "o" },
    scale: { type: "number" },
    "font-size": { type: "number" },
    padding: { type: "number" },
    cursor: { type: "boolean" },
    stdout: { type: "boolean" },
  });
  const c = await connect(home);
  try {
    const { id } = await resolveTarget(c, options, positionals, 0, { strict: true });
    const result = await c.call("screenshot", {
      id,
      scale: num(options.scale, "--scale"),
      fontSize: num(options["font-size"], "--font-size"),
      padding: num(options.padding, "--padding"),
      cursor: bool(options.cursor, "--cursor"),
    });
    const data = Buffer.from(result.png, "base64");
    if (bool(options.stdout, "--stdout")) {
      process.stdout.write(`${result.png}\n`);
      return 0;
    }
    const target = resolve(
      str(options.out, "--out") ??
        join(homeDir(), "screenshots", `${id}-${new Date().toISOString().replace(/[:.]/g, "-")}.png`),
    );
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
    if (bool(options.json, "--json")) {
      printJson({ path: target, bytes: data.byteLength, session: id });
    } else {
      process.stdout.write(`${target}\n`);
    }
    return 0;
  } finally {
    c.close();
  }
}

async function cmdWait(argv: string[], home: string | undefined): Promise<number> {
  if (wantsHelp(argv)) return printHelp("wait"), 0;
  const { options, positionals } = parseArgs(argv, {
    ...globalSpecs,
    id: { type: "string", alias: "s" },
    text: { type: "string" },
    for: { type: "string" },
    regex: { type: "string" },
    gone: { type: "string" },
    idle: { type: "number" },
    exit: { type: "boolean" },
    timeout: { type: "number" },
    "quiet-ms": { type: "number" },
  });
  const c = await connect(home);
  try {
    const { id } = await resolveTarget(c, options, positionals, 0, { strict: true });
    const quietMs = num(options["quiet-ms"], "--quiet-ms") ?? num(options.idle, "--idle");
    const result = await c.call(
      "wait",
      {
        id,
        text: str(options.text, "--text") ?? str(options.for, "--for"),
        regex: str(options.regex, "--regex"),
        gone: str(options.gone, "--gone"),
        quietMs,
        exit: bool(options.exit, "--exit"),
        timeoutMs: num(options.timeout, "--timeout"),
      },
      ((num(options.timeout, "--timeout") ?? 10_000) + 15_000),
    );
    if (bool(options.json, "--json")) {
      printJson({ met: result.met, waitedMs: result.waitedMs, reason: result.reason ?? null, snapshot: snapshotToJson(result.snapshot) });
    } else {
      note(
        result.met
          ? `${id}: condition met after ${result.waitedMs}ms`
          : `${id}: timed out after ${result.waitedMs}ms${result.reason === "exited" ? " (session exited)" : ""}`,
      );
      printSnapshot(result.snapshot, { quiet: bool(options.quiet, "--quiet") === true });
    }
    return result.met ? 0 : 1;
  } finally {
    c.close();
  }
}

async function cmdResize(argv: string[], home: string | undefined): Promise<number> {
  if (wantsHelp(argv)) return printHelp("resize"), 0;
  const { options, positionals } = parseArgs(argv, actionSpecs);
  const c = await connect(home);
  try {
    const { id, args } = await resolveTarget(c, options, positionals, 2, { strict: true });
    const action = await c.call("resize", {
      id,
      cols: intArg(args[0], "cols"),
      rows: intArg(args[1], "rows"),
      ...actionOptions(options),
    });
    emitAction(action, options);
    return 0;
  } finally {
    c.close();
  }
}

async function cmdClose(argv: string[], home: string | undefined): Promise<number> {
  if (wantsHelp(argv)) return printHelp("close"), 0;
  const { options, positionals } = parseArgs(argv, { ...globalSpecs, id: { type: "string", alias: "s" } });
  const c = await connect(home);
  try {
    const { id } = await resolveTarget(c, options, positionals, 0, { strict: true });
    const finalSnapshot = await c.call("snapshot", { id });
    const result = await c.call("close", { id });
    printSnapshot(finalSnapshot, { quiet: bool(options.quiet, "--quiet") === true, json: bool(options.json, "--json") === true });
    note(`session ${id} closed (exit ${result.summary.exitCode ?? "?"})`);
    return 0;
  } finally {
    c.close();
  }
}

async function cmdLs(argv: string[], home: string | undefined): Promise<number> {
  if (wantsHelp(argv)) return printHelp("ls"), 0;
  const { options } = parseArgs(argv, { ...globalSpecs });
  let c: DaemonClient;
  try {
    c = await DaemonClient.connect({ home, autoStart: false });
  } catch {
    if (bool(options.json, "--json")) printJson([]);
    else process.stdout.write("no sessions\n");
    return 0;
  }
  try {
    const sessions = await c.call("list", {});
    if (bool(options.json, "--json")) printJson(sessions);
    else process.stdout.write(`${formatSessionTable(sessions)}\n`);
    return 0;
  } finally {
    c.close();
  }
}

async function cmdRun(argv: string[], home: string | undefined): Promise<number> {
  if (wantsHelp(argv)) return printHelp("run"), 0;
  const { options, positionals } = parseArgs(argv, {
    ...globalSpecs,
    cols: { type: "number" },
    rows: { type: "number" },
    cwd: { type: "string" },
    env: { type: "strings", alias: "e" },
    timeout: { type: "number" },
  });
  if (!positionals.length) throw new UsageError("run needs a command, e.g. `playnice run -- ls -la`");
  const timeout = num(options.timeout, "--timeout") ?? 30_000;
  const c = await connect(home);
  let id: string | undefined;
  try {
    const opened = await c.call("open", {
      command: positionals[0],
      args: positionals.slice(1),
      cwd: str(options.cwd, "--cwd"),
      cols: num(options.cols, "--cols"),
      rows: num(options.rows, "--rows"),
      env: envArg(list(options.env)),
    });
    id = opened.summary.id;
    const result = await c.call("wait", { id, exit: true, timeoutMs: timeout }, timeout + 20_000);
    if (!result.met) note(`${id}: still running after ${timeout}ms; showing current screen`);
    printSnapshot(result.snapshot, {
      quiet: bool(options.quiet, "--quiet") === true,
      json: bool(options.json, "--json") === true,
    });
    if (!result.met) return 124;
    const code = result.snapshot.exitCode;
    return typeof code === "number" ? code : 0;
  } finally {
    if (id) {
      try {
        await c.call("close", { id });
      } catch {
        /* already gone */
      }
    }
    c.close();
  }
}

async function cmdDaemon(argv: string[], home: string | undefined): Promise<number> {
  const sub = argv[0] ?? "status";
  if (sub === "--help" || sub === "-h" || wantsHelp(argv)) return printHelp("daemon"), 0;
  if (sub === "log") {
    try {
      const text = readFileSync(logPath(home), "utf8").trimEnd().split("\n").slice(-60).join("\n");
      process.stdout.write(`${text}\n`);
    } catch {
      process.stdout.write("no daemon log yet\n");
    }
    return 0;
  }
  if (sub === "stop" || sub === "kill") {
    try {
      const c = await DaemonClient.connect({ home, autoStart: false });
      await c.call("shutdown", {});
      c.close();
      await waitForShutdown(home, 5000);
      process.stdout.write("playnice daemon stopped (all sessions closed)\n");
    } catch {
      process.stdout.write("playnice daemon is not running\n");
    }
    return 0;
  }
  if (sub === "status") {
    try {
      const c = await DaemonClient.connect({ home, autoStart: false });
      const info = await c.call("ping", {});
      if (bool(parseArgs(argv.slice(1), globalSpecs).options.json, "--json")) printJson(info);
      else {
        process.stdout.write(
          `running · pid ${info.pid} · v${info.version} · ${info.sessions} session(s) · ${Math.round(info.uptimeMs / 1000)}s uptime\n${info.home}\n${socketPath(home)}\n`,
        );
      }
      c.close();
      return 0;
    } catch {
      process.stdout.write("not running (it starts automatically on first use)\n");
      return 1;
    }
  }
  if (sub === "start") {
    const c = await DaemonClient.connect({ home });
    const info = await c.call("ping", {});
    process.stdout.write(`running · pid ${info.pid} · v${info.version}\n${info.home}\n`);
    c.close();
    return 0;
  }
  throw new UsageError(`unknown daemon subcommand: ${sub}`);
}

async function cmdMcp(argv: string[], home: string | undefined): Promise<number> {
  if (wantsHelp(argv)) return printHelp("mcp"), 0;
  const { runMcpServer } = await import("../mcp/server.js");
  await runMcpServer({ home });
  return 0;
}

// ---------------------------------------------------------------------- main

async function main(): Promise<number> {
  const { home, argv } = takeHome(process.argv.slice(2));
  const [command, ...rest] = argv;

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return 0;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (command === "help") {
    printHelp(rest[0]);
    return 0;
  }
  if (command === "completion") {
    process.stdout.write(`${Object.keys(HELP).join(" ")}\n`);
    return 0;
  }

  switch (command) {
    case "open":
      return cmdOpen(rest, home);
    case "send":
      return cmdSend(rest, home, "send");
    case "type":
      return cmdSend(rest, home, "type");
    case "paste":
      return cmdSend(rest, home, "paste");
    case "key":
      return cmdKey(rest, home);
    case "click":
      return cmdClick(rest, home);
    case "drag":
      return cmdDrag(rest, home);
    case "scroll":
    case "wheel":
      return cmdScroll(rest, home);
    case "snap":
    case "snapshot":
      return cmdSnap(rest, home);
    case "shot":
    case "screenshot":
      return cmdShot(rest, home);
    case "wait":
      return cmdWait(rest, home);
    case "resize":
      return cmdResize(rest, home);
    case "close":
      return cmdClose(rest, home);
    case "ls":
    case "list":
      return cmdLs(rest, home);
    case "run":
      return cmdRun(rest, home);
    case "daemon":
      return cmdDaemon(rest, home);
    case "mcp":
      return cmdMcp(rest, home);
    default:
      process.stderr.write(`playnice: unknown command "${command}"\n\n`);
      printHelp();
      return 2;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof UsageError) {
      process.stderr.write(`playnice: ${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`playnice: ${message}\n`);
    process.exitCode = 1;
  },
);
