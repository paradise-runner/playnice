import type {
  MouseButton,
  OpenOptions,
  SessionSummary,
  SettleOptions,
  Snapshot,
  SnapshotOptions,
  WaitResult,
  WaitSpec,
} from "../core/types.js";
import type { ActionResult } from "../core/session.js";
import type { ScreenshotOptions } from "../core/png.js";

export const PROTOCOL_VERSION = 1;

export interface DaemonRequest {
  id: number;
  method: string;
  params?: unknown;
}

export interface DaemonResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: { message: string; code?: string };
}

export interface DaemonInfo {
  version: string;
  protocol: number;
  pid: number;
  uptimeMs: number;
  home: string;
  sessions: number;
}

export interface ActionParams extends SettleOptions {
  id: string;
  snapshot?: SnapshotOptions;
}

export interface MouseParams extends ActionParams {
  x: number;
  y: number;
  button?: MouseButton;
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
  double?: boolean;
}

export interface OkResult {
  ok: true;
}

/** Typed surface shared by the daemon dispatcher and the client. */
export interface DaemonApi {
  ping: { params: Record<string, never> | undefined; result: DaemonInfo };
  open: { params: OpenOptions & { id?: string }; result: { summary: SessionSummary; snapshot: Snapshot } };
  list: { params: Record<string, never> | undefined; result: SessionSummary[] };
  snapshot: { params: { id: string } & SnapshotOptions & { ansi?: boolean }; result: Snapshot };
  screenshot: { params: { id: string } & ScreenshotOptions; result: { png: string; bytes: number } };
  send: { params: ActionParams & { text: string; enter?: boolean }; result: ActionResult };
  type: { params: ActionParams & { text: string }; result: ActionResult };
  press: { params: ActionParams & { keys: string[] }; result: ActionResult };
  paste: { params: ActionParams & { text: string }; result: ActionResult };
  click: { params: MouseParams; result: ActionResult };
  mouseDown: { params: MouseParams; result: ActionResult };
  mouseUp: { params: MouseParams; result: ActionResult };
  move: { params: MouseParams; result: ActionResult };
  drag: { params: MouseParams & { x2: number; y2: number }; result: ActionResult };
  wheel: { params: MouseParams & { direction: "up" | "down"; count?: number }; result: ActionResult };
  resize: { params: ActionParams & { cols: number; rows: number }; result: ActionResult };
  wait: { params: { id: string } & WaitSpec; result: WaitResult };
  close: { params: { id: string }; result: { summary: SessionSummary } };
  shutdown: { params: Record<string, never> | undefined; result: OkResult };
}

export type DaemonMethod = keyof DaemonApi;
