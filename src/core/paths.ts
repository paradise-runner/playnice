import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** State directory: sessions, socket, logs. Override with PLAYNICE_HOME. */
export function homeDir(): string {
  const fromEnv = process.env.PLAYNICE_HOME;
  return resolve(fromEnv && fromEnv.trim() ? fromEnv : join(homedir(), ".playnice"));
}

export function ensureHome(home = homeDir()): string {
  mkdirSync(home, { recursive: true });
  return home;
}

/** The daemon endpoint. Unix domain socket, or a named pipe on Windows. */
export function socketPath(home = homeDir()): string {
  if (process.platform === "win32") {
    const id = createHash("sha1").update(home).digest("hex").slice(0, 12);
    return `\\\\.\\pipe\\playnice-${id}`;
  }
  return join(home, "daemon.sock");
}

export function pidPath(home = homeDir()): string {
  return join(home, "daemon.pid");
}

export function statePath(home = homeDir()): string {
  return join(home, "daemon.json");
}

export function logPath(home = homeDir()): string {
  return join(home, "daemon.log");
}
