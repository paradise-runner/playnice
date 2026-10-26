#!/usr/bin/env node
import { ensureHome, homeDir } from "../core/paths.js";
import { VERSION } from "../core/version.js";
import { DaemonServer, stderrLog } from "./server.js";

/** Entry point for the background daemon (`playnice mcp`/CLI spawn it). */

interface Args {
  home: string;
  idleMs?: number;
  foreground: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { home: homeDir(), foreground: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--home" || arg === "--dir") args.home = argv[++i] ?? args.home;
    else if (arg === "--idle-ms") args.idleMs = Number(argv[++i]);
    else if (arg === "--foreground" || arg === "-f") args.foreground = true;
    else if (arg === "--version" || arg === "-v") {
      process.stdout.write(`${VERSION}\n`);
      process.exit(0);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
ensureHome(args.home);
const log = args.foreground ? stderrLog : undefined;
let exiting = false;
const exit = () => {
  if (exiting) return;
  exiting = true;
  process.exit(0);
};
const server = new DaemonServer({ home: args.home, idleMs: args.idleMs, log, onClosed: exit });

process.on("uncaughtException", (error) => {
  const message = `uncaught exception: ${error.stack ?? error.message}`;
  log?.(message);
  try {
    process.stderr.write(`${message}\n`);
  } catch {
    /* ignore */
  }
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  const message = `unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`;
  log?.(message);
});

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  log?.(`received ${signal}; closing sessions`);
  try {
    await server.close();
  } finally {
    exit();
  }
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGHUP", () => void shutdown("SIGHUP"));

try {
  await server.listen();
} catch (error) {
  const message = `failed to start: ${error instanceof Error ? error.message : String(error)}`;
  log?.(message);
  process.exitCode = 1;
}
