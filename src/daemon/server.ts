import { appendFileSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { ensureHome, logPath, pidPath, socketPath, statePath } from "../core/paths.js";
import { SessionRegistry } from "../core/registry.js";
import { Session } from "../core/session.js";
import { VERSION } from "../core/version.js";
import type { SessionSummary, Snapshot } from "../core/types.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import type { DaemonRequest, DaemonResponse, DaemonInfo } from "./protocol.js";

export interface DaemonOptions {
  home: string;
  /** Exit when idle with no sessions. 0 disables. Default 12h. */
  idleMs?: number;
  log?: (message: string) => void;
  /** Called once close() has fully finished — the process must exit. */
  onClosed?: () => void;
}

const DEFAULT_IDLE_MS = 12 * 60 * 60 * 1000;

export class DaemonServer {
  readonly startedAt = Date.now();
  readonly registry = new SessionRegistry();
  private readonly clients = new Set<net.Socket>();
  private server?: net.Server;
  private idleTimer?: NodeJS.Timeout;
  private closing = false;

  constructor(private readonly options: DaemonOptions) {}

  private log(message: string): void {
    const line = `${new Date().toISOString()} ${message}\n`;
    if (this.options.log) this.options.log(message);
    else {
      try {
        appendFileSync(logPath(this.options.home), line);
      } catch {
        /* logging must never take the daemon down */
      }
    }
  }

  async listen(): Promise<void> {
    const home = ensureHome(this.options.home);
    const path = socketPath(home);

    await this.clearStaleSocket(path);

    const server = net.createServer((socket) => this.accept(socket));
    server.on("error", (error) => this.log(`server error: ${String(error)}`));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
    if (process.platform !== "win32") {
      try {
        const { chmodSync } = await import("node:fs");
        chmodSync(path, 0o600);
      } catch {
        /* best effort */
      }
    }

    try {
      writeFileSync(pidPath(home), `${process.pid}\n`);
      writeFileSync(
        statePath(home),
        `${JSON.stringify(
          { pid: process.pid, version: VERSION, protocol: PROTOCOL_VERSION, home, socket: path, startedAt: this.startedAt },
          null,
          2,
        )}\n`,
      );
    } catch (error) {
      this.log(`could not write state files: ${String(error)}`);
    }

    this.scheduleIdleCheck();
    this.log(`listening on ${path} (pid ${process.pid}, version ${VERSION})`);
  }

  private async clearStaleSocket(path: string): Promise<void> {
    if (process.platform === "win32") return;
    const { existsSync } = await import("node:fs");
    if (!existsSync(path)) return;
    const alive = await new Promise<boolean>((resolve) => {
      const probe = net.createConnection(path);
      probe.once("connect", () => {
        probe.destroy();
        resolve(true);
      });
      probe.once("error", () => resolve(false));
    });
    if (alive) {
      throw new Error(`another playnice daemon is already listening on ${path}`);
    }
    try {
      unlinkSync(path);
    } catch {
      /* ignore */
    }
  }

  private accept(socket: net.Socket): void {
    this.clients.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        void this.handleLine(line, socket);
      }
    });
    socket.on("error", () => this.clients.delete(socket));
    socket.on("close", () => this.clients.delete(socket));
    this.scheduleIdleCheck();
  }

  private async handleLine(line: string, socket: net.Socket): Promise<void> {
    let request: DaemonRequest;
    try {
      request = JSON.parse(line) as DaemonRequest;
    } catch {
      socket.write(`${JSON.stringify({ id: 0, ok: false, error: { message: "invalid JSON" } })}\n`);
      return;
    }
    const response: DaemonResponse = { id: request.id, ok: true };
    try {
      const result = await this.dispatch(request.method, request.params);
      response.result = result ?? null;
    } catch (error) {
      response.ok = false;
      response.error = {
        message: error instanceof Error ? error.message : String(error),
        code: (error as { code?: string }).code,
      };
      this.log(`${request.method} failed: ${response.error.message}`);
    }
    if (socket.destroyed) return;
    socket.write(`${JSON.stringify(response)}\n`);
    if (request.method === "shutdown") {
      // Let the response flush, then genuinely stop: a daemon that closes its
      // socket but keeps running is an invisible zombie holding ptys.
      setTimeout(() => void this.close(), 25);
    }
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "ping":
        return this.info();
      case "open": {
        const session = await this.registry.open(p as never);
        const snapshot = await session.snapshot({ scrollback: 0 });
        return { summary: session.summary(), snapshot };
      }
      case "list":
        return this.listSessions();
      case "snapshot": {
        const snapshot = await this.session(p).snapshot({
          scrollback: optionalInt(p.scrollback, "scrollback", 0, 100_000),
          attrs: optionalBool(p.attrs, "attrs"),
          header: optionalBool(p.header, "header"),
          full: optionalBool(p.full, "full"),
          ansi: optionalBool(p.ansi, "ansi"),
        });
        return snapshot;
      }
      case "screenshot": {
        const png = await this.session(p).screenshot({
          scale: optionalNumber(p.scale, "scale", 0.5, 8),
          fontSize: optionalNumber(p.fontSize, "fontSize", 6, 72),
          padding: optionalNumber(p.padding, "padding", 0, 200),
          fontFamily: Array.isArray(p.fontFamily) ? (p.fontFamily as string[]) : undefined,
          cursor: optionalBool(p.cursor, "cursor"),
        });
        return { png: png.toString("base64"), bytes: png.byteLength };
      }
      case "send": {
        const action = await this.session(p).send(requireString(p.text, "text"), actionOptions(p, {
          enter: optionalBool(p.enter, "enter"),
        }));
        return action;
      }
      case "type":
        return this.session(p).type(requireString(p.text, "text"), actionOptions(p));
      case "press": {
        const keys = Array.isArray(p.keys) ? p.keys.map(String) : [];
        if (!keys.length) throw new Error("press needs at least one key, e.g. [\"C-c\"]");
        return this.session(p).press(keys, actionOptions(p));
      }
      case "paste":
        return this.session(p).paste(requireString(p.text, "text"), actionOptions(p));
      case "click":
        return this.session(p).click(coordinate(p.x, "x"), coordinate(p.y, "y"), {
          ...actionOptions(p),
          button: mouseButton(p.button),
          double: optionalBool(p.double, "double"),
          mods: modifiers(p),
        });
      case "mouseDown":
        return this.session(p).mouseDown(coordinate(p.x, "x"), coordinate(p.y, "y"), {
          ...actionOptions(p),
          button: mouseButton(p.button),
          mods: modifiers(p),
        });
      case "mouseUp":
        return this.session(p).mouseUp(coordinate(p.x, "x"), coordinate(p.y, "y"), {
          ...actionOptions(p),
          button: mouseButton(p.button),
          mods: modifiers(p),
        });
      case "move":
        return this.session(p).moveMouse(coordinate(p.x, "x"), coordinate(p.y, "y"), {
          ...actionOptions(p),
          mods: modifiers(p),
        });
      case "drag":
        return this.session(p).drag(
          coordinate(p.x, "x"),
          coordinate(p.y, "y"),
          coordinate(p.x2, "x2"),
          coordinate(p.y2, "y2"),
          {
            ...actionOptions(p),
            button: mouseButton(p.button),
            mods: modifiers(p),
          },
        );
      case "wheel": {
        const direction = p.direction === "up" || p.direction === "down" ? p.direction : null;
        if (!direction) throw new Error('wheel needs direction: "up" or "down"');
        return this.session(p).wheel(
          coordinate(p.x, "x"),
          coordinate(p.y, "y"),
          direction,
          optionalInt(p.count, "count", 1, 100) ?? 1,
          actionOptions(p),
        );
      }
      case "resize":
        return this.session(p).resize(
          requireInt(p.cols, "cols", 1, 1000),
          requireInt(p.rows, "rows", 1, 500),
          actionOptions(p),
        );
      case "wait": {
        const session = this.session(p);
        const result = await session.wait({
          text: typeof p.text === "string" ? p.text : undefined,
          regex: typeof p.regex === "string" ? p.regex : undefined,
          gone: typeof p.gone === "string" ? p.gone : undefined,
          quietMs: optionalInt(p.quietMs, "quietMs", 0, 600_000),
          exit: optionalBool(p.exit, "exit"),
          timeoutMs: optionalInt(p.timeoutMs, "timeoutMs", 0, 600_000),
        });
        return result;
      }
      case "close": {
        const session = await this.registry.close(requireString(p.id, "id"));
        return { summary: session.summary() };
      }
      case "shutdown":
        return { ok: true };
      default:
        throw new Error(`unknown method: ${method}`);
    }
  }

  private listSessions(): SessionSummary[] {
    const sessions = this.registry.list();
    this.scheduleIdleCheck();
    return sessions;
  }

  private session(p: Record<string, unknown>): Session {
    return this.registry.get(requireString(p.id, "id"));
  }

  private info(): DaemonInfo {
    return {
      version: VERSION,
      protocol: PROTOCOL_VERSION,
      pid: process.pid,
      uptimeMs: Date.now() - this.startedAt,
      home: this.options.home,
      sessions: this.registry.list().length,
    };
  }

  /** Keep the daemon around while work is live, but do not leak it forever. */
  private scheduleIdleCheck(): void {
    const idleMs = this.options.idleMs ?? DEFAULT_IDLE_MS;
    if (idleMs <= 0 || this.closing) return;
    if (this.idleTimer) return;
    this.idleTimer = setTimeout(async () => {
      this.idleTimer = undefined;
      const busy = this.clients.size > 0 || this.registry.list().length > 0;
      if (busy) {
        this.scheduleIdleCheck();
        return;
      }
      this.log(`idle for ${idleMs}ms with no sessions; shutting down`);
      await this.close();
    }, idleMs);
    this.idleTimer.unref?.();
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    await this.registry.closeAll();
    for (const socket of this.clients) socket.destroy();
    this.clients.clear();
    if (this.server) {
      const server = this.server;
      this.server = undefined;
      // closeAllConnections() prevents close() from waiting on a client that
      // never goes away; the timeout covers anything older.
      (server as net.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      await Promise.race([
        new Promise<void>((resolve) => server.close(() => resolve())),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 1500);
          timer.unref?.();
        }),
      ]);
    }
    if (process.platform !== "win32") {
      try {
        unlinkSync(socketPath(this.options.home));
      } catch {
        /* already gone */
      }
    }
    try {
      unlinkSync(pidPath(this.options.home));
    } catch {
      /* already gone */
    }
    this.log("daemon stopped");
    this.options.onClosed?.();
  }
}

// ------------------------------------------------------------------ validation

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`"${name}" must be a non-empty string`);
  }
  return value;
}

function requireInt(value: unknown, name: string, min: number, max: number): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || Math.round(n) !== n) {
    throw new Error(`"${name}" must be an integer`);
  }
  if (n < min || n > max) throw new Error(`"${name}" must be between ${min} and ${max}`);
  return n;
}

function optionalInt(value: unknown, name: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  return requireInt(value, name, min, max);
}

function optionalNumber(value: unknown, name: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new Error(`"${name}" must be a number`);
  if (n < min || n > max) throw new Error(`"${name}" must be between ${min} and ${max}`);
  return n;
}

function optionalBool(value: unknown, name: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new Error(`"${name}" must be a boolean`);
  return value;
}

function coordinate(value: unknown, name: string): number {
  return requireInt(value, name, 0, 1000);
}

function mouseButton(value: unknown): "left" | "middle" | "right" | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "left" || value === "middle" || value === "right") return value;
  throw new Error('"button" must be "left", "middle" or "right"');
}

function modifiers(p: Record<string, unknown>) {
  return {
    shift: optionalBool(p.shift, "shift"),
    alt: optionalBool(p.alt, "alt"),
    ctrl: optionalBool(p.ctrl, "ctrl"),
  };
}

function actionOptions(p: Record<string, unknown>, extra: { enter?: boolean } = {}) {
  const scrollback = optionalInt(p.scrollback, "scrollback", 0, 100_000);
  return {
    ...extra,
    quietMs: optionalInt(p.quietMs, "quietMs", 0, 60_000),
    timeoutMs: optionalInt(p.timeoutMs, "timeoutMs", 0, 120_000),
    snapshot: {
      scrollback,
      attrs: optionalBool(p.attrs, "attrs"),
      header: optionalBool(p.header, "header"),
      full: optionalBool(p.full, "full"),
    },
  };
}

/** Write the log line straight to stderr when running in the foreground. */
export function stderrLog(message: string): void {
  process.stderr.write(`${new Date().toISOString()} ${message}\n`);
}

export function writeStateSnapshot(home: string): void {
  try {
    writeFileSync(statePath(home), `${JSON.stringify({ pid: process.pid, version: VERSION }, null, 2)}\n`);
  } catch {
    /* ignore */
  }
}
