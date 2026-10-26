import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureHome, homeDir, socketPath, statePath } from "../core/paths.js";
import { VERSION } from "../core/version.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import type { DaemonApi, DaemonMethod, DaemonRequest, DaemonResponse } from "./protocol.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface ClientOptions {
  home?: string;
  /** Start a daemon if none is running. Default true. */
  autoStart?: boolean;
  /** How long to wait for the daemon to come up. Default 15s. */
  startTimeoutMs?: number;
}

/**
 * Thin, typed client for the playnice daemon.
 *
 * The daemon owns the ptys, so sessions survive across CLI invocations and are
 * shared between the CLI and the MCP server.
 */
export class DaemonClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = "";
  private closed = false;

  private constructor(
    private readonly socket: net.Socket,
    readonly info: { home: string },
  ) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("close", () => this.failAll(new Error("playnice daemon connection closed")));
    socket.on("error", (error) => this.failAll(error));
  }

  static async connect(options: ClientOptions = {}): Promise<DaemonClient> {
    const home = ensureHome(options.home ?? homeDir());
    const path = socketPath(home);
    const existing = await tryConnect(path);

    if (existing) {
      const client = new DaemonClient(existing, { home });
      const info = await client.ping();
      if (info && info.version === VERSION && info.protocol === PROTOCOL_VERSION) return client;

      // A daemon from a different build would quietly serve stale behaviour.
      if (options.autoStart === false || !info) {
        if (info) return client;
        client.close();
        await waitForGone(path, 1500);
      } else {
        try {
          await client.call("shutdown", {}, 3000);
        } catch {
          /* it may be too confused to answer */
        }
        client.close();
        await waitForGone(path, 4000);
      }
    } else if (options.autoStart === false) {
      throw new Error("playnice daemon is not running");
    }

    const deadline = Date.now() + (options.startTimeoutMs ?? 15_000);
    let spawned = false;
    while (Date.now() < deadline) {
      try {
        const socket = await openSocket(path);
        return new DaemonClient(socket, { home });
      } catch {
        if (!spawned) spawned = await tryStartDaemon(home);
        await sleep(25);
      }
    }
    throw new Error(
      `playnice: could not start the daemon. Run \`playnice daemon log\` or check ${join(home, "daemon.log")}.`,
    );
  }

  call<K extends DaemonMethod>(
    method: K,
    params: DaemonApi[K]["params"],
    timeoutMs = 120_000,
  ): Promise<DaemonApi[K]["result"]> {
    if (this.closed) return Promise.reject(new Error("playnice daemon client is closed"));
    const id = this.nextId++;
    const request: DaemonRequest = { id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`playnice: ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      this.socket.write(`${JSON.stringify(request)}\n`);
    });
  }

  /** Ping without throwing; undefined when the daemon is unreachable. */
  async ping(): Promise<DaemonApi["ping"]["result"] | undefined> {
    try {
      return await this.call("ping", {}, 2000);
    } catch {
      return undefined;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.end();
    this.socket.destroy();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) break;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let response: DaemonResponse;
      try {
        response = JSON.parse(line) as DaemonResponse;
      } catch {
        continue;
      }
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      if (response.ok) pending.resolve(response.result);
      else {
        const error = new Error(response.error?.message ?? "playnice daemon error");
        if (response.error?.code) (error as Error & { code?: string }).code = response.error.code;
        pending.reject(error);
      }
    }
  }

  private failAll(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function openSocket(path: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    const onError = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      resolve(socket);
    });
  });
}

async function tryConnect(path: string): Promise<net.Socket | undefined> {
  try {
    return await openSocket(path);
  } catch {
    return undefined;
  }
}

/** Poll until nothing answers on the socket (i.e. the daemon is really gone). */
export async function waitForGone(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const socket = await tryConnect(path);
    if (!socket) return true;
    socket.destroy();
    await sleep(25);
  }
  return false;
}

/** Wait for `playnice daemon stop` to take effect before returning. */
export async function waitForShutdown(home = homeDir(), timeoutMs = 5000): Promise<boolean> {
  return waitForGone(socketPath(home), timeoutMs);
}

const DAEMON_ENTRY = fileURLToPath(new URL("./main.js", import.meta.url));
const LOCK_STALE_MS = 10_000;

/**
 * Spawn the daemon, guarding against two clients racing to do it (which would
 * leave one of them listening on an unlinked socket: invisible but alive).
 */
async function tryStartDaemon(home: string): Promise<boolean> {
  ensureHome(home);
  const lock = join(home, "starting.lock");
  try {
    const fd = openSync(lock, "wx");
    writeFileSync(fd, `${process.pid}\n`);
    closeSync(fd);
  } catch {
    // Someone else is starting it; let them, unless the lock is stale.
    let age = 0;
    try {
      age = Date.now() - statSync(lock).mtimeMs;
    } catch {
      return false;
    }
    if (age < LOCK_STALE_MS) return false;
    try {
      unlinkSync(lock);
    } catch {
      return false;
    }
    return tryStartDaemon(home);
  }

  try {
    await reapStaleDaemon(home);
    if (!existsSync(DAEMON_ENTRY)) {
      throw new Error(
        `playnice ${VERSION} is not built: ${DAEMON_ENTRY} is missing. Run \`npm run build\`.`,
      );
    }
    const child = spawn(process.execPath, [DAEMON_ENTRY, "--home", home], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, PLAYNICE_HOME: home },
    });
    child.unref();
  } finally {
    const timer = setTimeout(() => {
      try {
        unlinkSync(lock);
      } catch {
        /* already gone */
      }
    }, 5000);
    timer.unref?.();
  }
  return true;
}

/** A pid recorded in daemon.json that is alive but not answering is a zombie. */
async function reapStaleDaemon(home: string): Promise<void> {
  const path = socketPath(home);
  if (await tryConnect(path)) return;
  let pid: number | undefined;
  try {
    const state = JSON.parse(readFileSync(statePath(home), "utf8")) as { pid?: number; home?: string };
    if (state.home && state.home !== home) return;
    pid = state.pid;
  } catch {
    return;
  }
  if (!pid || pid === process.pid) return;
  try {
    process.kill(pid, 0);
  } catch {
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
      await sleep(50);
    }
  } catch {
    /* it is already gone */
  }
}

/** True when a daemon is answering on this machine. */
export async function daemonAlive(home = homeDir()): Promise<boolean> {
  const socket = await tryConnect(socketPath(home));
  if (!socket) return false;
  socket.destroy();
  return true;
}
