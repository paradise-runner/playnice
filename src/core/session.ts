import { EventEmitter } from "node:events";
import ptyPkg from "node-pty";
import type { IPty } from "node-pty";
import { Screen } from "./screen.js";
import { encodeKeys, encodeText, bracketedPaste } from "./keys.js";
import { mouseClick, mouseDown, mouseMove, mouseUp, mouseWheel } from "./mouse.js";
import { buildSnapshot, renderAnsiFromModel } from "./snapshot.js";
import { renderPng, type ScreenshotOptions } from "./png.js";
import type {
  MouseButton,
  MouseModifiers,
  OpenOptions,
  SettleOptions,
  SessionSummary,
  Snapshot,
  SnapshotOptions,
  WaitResult,
  WaitSpec,
} from "./types.js";

const ptySpawn = (ptyPkg as unknown as typeof import("node-pty")).spawn;

/** ms of quiet that counts as "the app finished drawing". */
export const DEFAULT_QUIET_MS = 75;
/** How long an action waits for the app to stop drawing before giving up. */
export const DEFAULT_SETTLE_TIMEOUT_MS = 1500;
export const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
/**
 * A lone ESC is ambiguous: apps cannot tell "Escape" from the start of an
 * escape sequence, so vim and friends wait for a timeout before redrawing
 * (measured 38-180ms). Settling at the normal 75ms screenshots a stale screen.
 * Wait up to this long for the reaction, then settle normally.
 */
export const ESC_QUIET_MS = 350;
export const DEFAULT_COLS = 100;
export const DEFAULT_ROWS = 30;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface ActionResult {
  snapshot: Snapshot;
  /** Did the visible screen change because of this action? */
  changed: boolean;
  settled: boolean;
  waitedMs: number;
}

export interface ActionOptions extends SettleOptions {
  snapshot?: SnapshotOptions;
}

export interface SendOptions extends ActionOptions {
  /** Append Enter (CR) after the text. Default true. */
  enter?: boolean;
}

export interface ClickOptions extends ActionOptions {
  button?: MouseButton;
  mods?: MouseModifiers;
  double?: boolean;
}

export interface SessionEvents {
  output: [string];
  exit: [{ exitCode: number | null; signal: number | null }];
  title: [string];
}

interface ExitState {
  exitCode: number | null;
  signal: number | null;
}

/**
 * One live terminal: a pty plus the emulator that makes its output readable.
 *
 * Every method that changes the screen returns a snapshot of the *settled*
 * result, so an agent can act-then-look in a single call instead of polling.
 */
export class Session extends EventEmitter<SessionEvents> {
  readonly id: string;
  readonly name?: string;
  readonly command: string;
  readonly args: string[];
  readonly cwd: string;
  readonly createdAt = Date.now();
  readonly pid: number;

  private readonly pty: IPty;
  private readonly screen: Screen;
  private pendingWrites = 0;
  private idleWaiters: Array<() => void> = [];
  private lastOutputAt = Date.now();
  private lastInputAt = 0;
  private lastHash = "";
  private revision = 0;
  private readonly exitState: ExitState = { exitCode: null, signal: null };
  private outputSeen = false;
  /** When an input write ended with a lone ESC (see ESC_QUIET_MS). */
  private escSentAt = 0;
  private exited = false;
  private disposed = false;
  private paused = false;
  /** Last settle verdict, so a snapshot right after an action agrees with it. */
  private knownSettled = false;
  private knownSettledAt = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly onExitHooks: Array<() => void> = [];

  private constructor(opts: OpenOptions & { id: string }) {
    super();
    this.id = opts.id;
    this.name = opts.name;
    const env = buildEnv(opts.env);
    const command = opts.command?.trim() || process.env.SHELL || "/bin/sh";
    const args = opts.args ?? (opts.command ? [] : ["-i"]);
    this.command = command;
    this.args = args;
    this.cwd = opts.cwd || process.cwd();

    try {
      this.pty = ptySpawn(command, args, {
        name: "xterm-256color",
        cols: opts.cols ?? DEFAULT_COLS,
        rows: opts.rows ?? DEFAULT_ROWS,
        cwd: this.cwd,
        env,
        // Keep the pty alive through a closed stdin; the daemon owns the fd.
        handleFlowControl: false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not start ${command} in ${this.cwd}: ${message}. Check that the command exists and is executable.`,
      );
    }
    this.pid = this.pty.pid;

    this.screen = new Screen({
      cols: opts.cols ?? DEFAULT_COLS,
      rows: opts.rows ?? DEFAULT_ROWS,
      scrollback: opts.scrollback ?? 2000,
    });

    this.pty.onData((data) => {
      this.outputSeen = true;
      this.lastOutputAt = Date.now();
      this.pendingWrites++;
      this.applyBackpressure();
      this.screen.write(data).then(() => {
        this.pendingWrites--;
        this.applyBackpressure();
        if (this.pendingWrites === 0 && this.idleWaiters.length) {
          const waiters = this.idleWaiters;
          this.idleWaiters = [];
          for (const wake of waiters) wake();
        }
        this.emit("output", data);
      });
    });

    this.pty.onExit(({ exitCode, signal }) => {
      this.exited = true;
      this.exitState.exitCode = exitCode;
      this.exitState.signal = signal ?? null;
      this.lastOutputAt = Date.now();
      for (const hook of this.onExitHooks.splice(0)) hook();
      this.emit("exit", { exitCode, signal: signal ?? null });
    });
  }

  static async open(opts: OpenOptions & { id: string }): Promise<Session> {
    const session = new Session(opts);
    // Wait for the app to say something before calling it settled: a slow
    // program (docker, node with imports, ssh) is silent for a while, and
    // acting on a blank screen is the classic flaky-TUI-test failure.
    await session.waitForFirstOutput(2500);
    const settle = await session.settle({ quietMs: 120, timeoutMs: 3000 });
    session.knownSettled = settle.settled;
    session.knownSettledAt = Date.now();
    return session;
  }

  // ---------------------------------------------------------------- lifecycle

  get isExited(): boolean {
    return this.exited;
  }

  get exitCode(): number | null {
    return this.exitState.exitCode;
  }

  get signal(): number | null {
    return this.exitState.signal;
  }

  get cols(): number {
    return this.screen.cols;
  }

  get rows(): number {
    return this.screen.rows;
  }

  get lastActivityAt(): number {
    return Math.max(this.lastOutputAt, this.lastInputAt, this.createdAt);
  }

  /** ms since anything happened — our own input counts, so a snapshot taken
   *  right after a keystroke correctly reports settled=false. */
  get quietMs(): number {
    return Date.now() - Math.max(this.lastOutputAt, this.lastInputAt);
  }

  /** ms since the app last wrote to the screen (used for "idle" in listings). */
  get idleMs(): number {
    return Date.now() - this.lastOutputAt;
  }

  get altScreen(): boolean {
    return this.screen.altScreen;
  }

  summary(): SessionSummary {
    const model = this.screen.read(0);
    return {
      id: this.id,
      name: this.name,
      command: this.command,
      args: this.args,
      cwd: this.cwd,
      cols: model.cols,
      rows: model.rows,
      altScreen: model.altScreen,
      exited: this.exited,
      exitCode: this.exitState.exitCode,
      pid: this.pid,
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
      idleFor: Math.round(this.idleMs / 100) / 10,
      title: model.title || undefined,
    };
  }

  /** Resolve as soon as the child writes anything (or exits, or times out). */
  async waitForFirstOutput(timeoutMs = 2500): Promise<boolean> {
    if (this.outputSeen) return true;
    return new Promise((resolve) => {
      let done = false;
      const finish = (value: boolean) => {
        if (done) return;
        done = true;
        this.off("output", onOutput);
        this.off("exit", onExit);
        clearTimeout(timer);
        resolve(value);
      };
      const onOutput = () => finish(true);
      const onExit = () => finish(false);
      const timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref?.();
      this.on("output", onOutput);
      this.on("exit", onExit);
      // Re-check: output may have arrived between the first check and now.
      if (this.outputSeen) finish(true);
    });
  }

  /** Resolve once the child process exits (or the timeout elapses). */
  waitForExit(timeoutMs = DEFAULT_WAIT_TIMEOUT_MS): Promise<boolean> {
    if (this.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (value: boolean) => {
        if (done) return;
        done = true;
        resolve(value);
      };
      this.onExitHooks.push(() => finish(true));
      const timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref?.();
      this.onExitHooks.push(() => clearTimeout(timer));
    });
  }

  /**
   * Terminate the child. Kept separate from the registry so a closed session
   * can still be snapshotted one last time.
   */
  async close(): Promise<void> {
    if (!this.exited) {
      try {
        this.pty.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      const exited = await this.waitForExit(1200);
      if (!exited) {
        try {
          this.pty.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        await this.waitForExit(800);
      }
    }
    await this.flush(500);
    this.disposed = true;
    this.screen.dispose();
  }

  // ------------------------------------------------------------------- writes

  write(data: string): void {
    if (this.exited) throw new Error(`Session ${this.id} has exited; nothing to write to.`);
    if (!data) return;
    this.lastInputAt = Date.now();
    if (data.endsWith("\x1b")) this.escSentAt = this.lastInputAt;
    this.pty.write(data);
  }

  /** Type literal text. Newlines become real Enter presses unless bracketed. */
  async type(text: string, opts: ActionOptions = {}): Promise<ActionResult> {
    return this.act(() => this.write(encodeText(text, this.inputModes())), opts);
  }

  /** Type text and press Enter. The common "run this command" action. */
  async send(text: string, opts: SendOptions = {}): Promise<ActionResult> {
    const enter = opts.enter !== false;
    return this.act(() => {
      this.write(encodeText(text, this.inputModes()));
      if (enter) this.write("\r");
    }, opts);
  }

  /** Press named keys: `["C-c"]`, `["Up", "Enter"]`, `["Escape"]`. */
  async press(keys: string[], opts: ActionOptions = {}): Promise<ActionResult> {
    return this.act(() => this.write(encodeKeys(keys, this.inputModes())), opts);
  }

  /** Force a bracketed paste, regardless of whether the text needs it. */
  async paste(text: string, opts: ActionOptions = {}): Promise<ActionResult> {
    const payload = this.screen.bracketedPaste ? bracketedPaste(text) : encodeText(text, this.inputModes());
    return this.act(() => this.write(payload), opts);
  }

  async click(x: number, y: number, opts: ClickOptions = {}): Promise<ActionResult> {
    const button = opts.button ?? "left";
    return this.act(
      () => this.write(mouseClick(x, y, button, opts.mods, opts.double)),
      opts,
    );
  }

  async mouseDown(x: number, y: number, opts: ClickOptions = {}): Promise<ActionResult> {
    return this.act(() => this.write(mouseDown(x, y, opts.button ?? "left", opts.mods)), opts);
  }

  async mouseUp(x: number, y: number, opts: ClickOptions = {}): Promise<ActionResult> {
    return this.act(() => this.write(mouseUp(x, y, opts.button ?? "left", opts.mods)), opts);
  }

  async moveMouse(x: number, y: number, opts: ClickOptions = {}): Promise<ActionResult> {
    return this.act(() => this.write(mouseMove(x, y, null, opts.mods)), opts);
  }

  async wheel(x: number, y: number, direction: "up" | "down", count = 1, opts: ActionOptions = {}): Promise<ActionResult> {
    return this.act(() => {
      for (let i = 0; i < Math.max(1, count); i++) this.write(mouseWheel(x, y, direction));
    }, opts);
  }

  /** Press, move and release — for drag-select, slider and reorder interactions. */
  async drag(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    opts: ClickOptions = {},
  ): Promise<ActionResult> {
    return this.act(() => {
      const button = opts.button ?? "left";
      this.write(mouseDown(x1, y1, button, opts.mods));
      const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / 2));
      for (let step = 1; step <= steps; step++) {
        const x = Math.round(x1 + ((x2 - x1) * step) / steps);
        const y = Math.round(y1 + ((y2 - y1) * step) / steps);
        this.write(mouseMove(x, y, button, opts.mods));
      }
      this.write(mouseUp(x2, y2, button, opts.mods));
    }, opts);
  }

  async resize(cols: number, rows: number, opts: ActionOptions = {}): Promise<ActionResult> {
    return this.act(() => {
      this.lastInputAt = Date.now();
      this.screen.resize(cols, rows);
      this.pty.resize(cols, rows);
    }, opts);
  }

  private inputModes() {
    return {
      applicationCursorKeys: this.screen.applicationCursorKeys,
      bracketedPaste: this.screen.bracketedPaste,
    };
  }

  /**
   * Run an action, wait for the app to stop drawing, and snapshot the result.
   * Actions are serialized per session so concurrent tool calls cannot
   * interleave keystrokes.
   */
  async act(mutate: () => void, opts: ActionOptions = {}): Promise<ActionResult> {
    return this.enqueue(async () => {
      const before = this.currentHash();
      mutate();
      const settle = await this.settle(opts);
      this.knownSettled = settle.settled;
      this.knownSettledAt = Date.now();
      const snapshot = await this.snapshot({ ...(opts.snapshot ?? {}), settled: settle.settled });
      return {
        snapshot,
        changed: snapshot.hash !== before,
        settled: settle.settled,
        waitedMs: settle.waitedMs,
      };
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  // ------------------------------------------------------------------ reading

  /** Wait until nothing has happened for `quietMs` — no output and no input we
   *  just sent, so an action always gets a chance to produce its reaction. */
  async settle(opts: SettleOptions = {}): Promise<{ settled: boolean; quietMs: number; waitedMs: number }> {
    const start = Date.now();
    const quiet = opts.quietMs ?? DEFAULT_QUIET_MS;
    // A bare ESC ending this action leaves the app waiting to see whether more
    // bytes follow. Hold off on "settled" until it reacts (or the window ends).
    const escAction = this.escSentAt >= start;
    let reacted = false;
    const timeout = Math.max(opts.timeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS, quiet);
    for (;;) {
      await this.flush(Math.max(500, timeout));
      const now = Date.now();
      const silent = now - Math.max(this.lastOutputAt, this.lastInputAt);
      if (escAction && !reacted && this.lastOutputAt >= this.escSentAt) reacted = true;
      const threshold = escAction && !reacted ? Math.max(quiet, ESC_QUIET_MS) : quiet;
      if (quiet <= 0) return { settled: true, quietMs: silent, waitedMs: now - start };
      if (this.exited) return { settled: true, quietMs: silent, waitedMs: now - start };
      if (silent >= threshold) return { settled: true, quietMs: silent, waitedMs: now - start };
      if (now - start >= Math.max(timeout, threshold)) {
        return { settled: false, quietMs: silent, waitedMs: now - start };
      }
      await sleep(Math.min(Math.max(threshold - silent, 1), 15));
    }
  }

  /** Snapshot the current screen. Waits for queued parser work first. */
  async snapshot(options: SnapshotOptions & { ansi?: boolean; settled?: boolean } = {}): Promise<Snapshot> {
    await this.flush(2000);
    const model = this.screen.read(options.scrollback ?? 0);
    if (model.hash !== this.lastHash) {
      this.lastHash = model.hash;
      this.revision++;
    }
    const quiet = this.quietMs;
    // Prefer the verdict from the settle() that just ran; fall back to the
    // generic "has it been quiet long enough" heuristic.
    const fresh = Date.now() - this.knownSettledAt < 500;
    const settled =
      options.settled ?? (this.exited || quiet >= DEFAULT_QUIET_MS || (this.knownSettled && fresh));
    const snapshot = buildSnapshot({
      session: this.id,
      model,
      settled,
      quietMs: quiet,
      revision: this.revision,
      exited: this.exited,
      exitCode: this.exitState.exitCode,
      signal: this.exitState.signal,
      options,
      ansi: options.ansi,
    });
    if (options.ansi) snapshot.ansi = renderAnsiFromModel(model, snapshot);
    return snapshot;
  }

  /** Snapshot without going through the action queue (used by wait loops). */
  private async peek(): Promise<Snapshot> {
    return this.snapshot();
  }

  /** Render the current screen to a PNG. */
  async screenshot(options: ScreenshotOptions = {}): Promise<Buffer> {
    await this.flush(2000);
    const model = this.screen.read(0);
    return renderPng(model, options);
  }

  /**
   * Wait for a condition on the screen. All supplied conditions must hold.
   * Returns the last snapshot either way — a timeout is data, not a crash.
   */
  async wait(spec: WaitSpec): Promise<WaitResult> {
    const timeout = spec.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    const start = Date.now();
    const regex = spec.regex ? new RegExp(spec.regex) : undefined;
    const quietMs = spec.quietMs;

    for (;;) {
      const snapshot = await this.peek();
      const haystack = snapshot.lines.join("\n");
      const checks: boolean[] = [];
      if (spec.text !== undefined) checks.push(haystack.includes(spec.text));
      if (regex) checks.push(regex.test(haystack));
      if (spec.gone !== undefined) checks.push(!haystack.includes(spec.gone));
      if (quietMs !== undefined) checks.push(this.quietMs >= quietMs);
      if (spec.exit) checks.push(this.exited);
      if (spec.predicate) checks.push(spec.predicate(snapshot));

      const elapsed = Date.now() - start;
      if (checks.length && checks.every(Boolean)) {
        return { met: true, waitedMs: elapsed, snapshot };
      }
      if (this.exited && !spec.exit) {
        return { met: checks.length === 0, waitedMs: elapsed, reason: "exited", snapshot };
      }
      if (elapsed >= timeout) {
        return { met: false, waitedMs: elapsed, reason: "timeout", snapshot };
      }
      await sleep(20);
    }
  }

  // ------------------------------------------------------------------- helpers

  private currentHash(): string {
    return this.screen.read(0).hash;
  }

  /** Resolve when the terminal parser has consumed everything received so far. */
  private async flush(timeoutMs = 2000): Promise<boolean> {
    if (this.pendingWrites === 0) return true;
    const deadline = Date.now() + timeoutMs;
    while (this.pendingWrites > 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        this.idleWaiters.push(resolve);
        const t = setTimeout(resolve, Math.max(5, Math.min(50, deadline - Date.now())));
        t.unref?.();
      });
    }
    return this.pendingWrites === 0;
  }

  /** Pause the pty when the emulator falls behind, so a runaway command cannot
   *  exhaust memory. */
  private applyBackpressure(): void {
    if (!this.paused && this.pendingWrites > 4000) {
      this.paused = true;
      try {
        this.pty.pause();
      } catch {
        /* ignore */
      }
    } else if (this.paused && this.pendingWrites < 500) {
      this.paused = false;
      try {
        this.pty.resume();
      } catch {
        /* ignore */
      }
    }
  }
}

function buildEnv(extra: Record<string, string> | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.TERM_PROGRAM = "playnice";
  env.PLAYNICE = "1";
  delete env.OLDPWD;
  if (extra) Object.assign(env, extra);
  return env;
}
