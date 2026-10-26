/**
 * playnice — playwright for terminals.
 *
 * Two layers:
 *  - `Session` owns a pty and an emulated screen; it is the library API.
 *  - `DaemonClient` talks to the background daemon that keeps sessions alive
 *    across CLI invocations and serves the MCP server.
 */

export { Session } from "./core/session.js";
export type { ActionResult, ActionOptions, ClickOptions, SendOptions } from "./core/session.js";
export { DEFAULT_QUIET_MS, DEFAULT_SETTLE_TIMEOUT_MS, DEFAULT_WAIT_TIMEOUT_MS } from "./core/session.js";

export { Screen, styleOf, styleTokens, sgrFor } from "./core/screen.js";
export type { ScreenCell, ScreenLine, ScreenModel } from "./core/screen.js";

export {
  buildSnapshot,
  renderHeader,
  renderText,
  renderAnsiFromModel,
  snapshotToJson,
  changedRows,
  findInLines,
} from "./core/snapshot.js";
export type { BuildSnapshotInput, RenderOptions } from "./core/snapshot.js";

export { renderPng, colorToCss, DEFAULT_THEME } from "./core/png.js";
export type { ScreenshotOptions, Theme } from "./core/png.js";

export { encodeKeys, encodeText, parseKey, bracketedPaste, unescape } from "./core/keys.js";
export type { KeyModes, ParsedKey } from "./core/keys.js";

export {
  mouseClick,
  mouseDown,
  mouseMove,
  mouseUp,
  mouseWheel,
} from "./core/mouse.js";

export { SessionRegistry, SessionError } from "./core/registry.js";
export { DaemonClient, daemonAlive } from "./daemon/client.js";
export type { ClientOptions } from "./daemon/client.js";
export { DaemonServer } from "./daemon/server.js";
export type { DaemonOptions } from "./daemon/server.js";
export { homeDir, socketPath } from "./core/paths.js";
export { VERSION } from "./core/version.js";

export * from "./core/types.js";
